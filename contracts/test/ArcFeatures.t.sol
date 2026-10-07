// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {JunoBase} from "./JunoBase.t.sol";
import {JunoLaunchpad} from "../src/JunoLaunchpad.sol";
import {JunoToken} from "../src/JunoToken.sol";
import {CircleUSDC} from "./utils/CircleUSDC.sol";

/// The Arc-native paths on the launchpad, against Circle's real FiatToken v2.2
/// code at Arc's USDC address:
///  - relayed buys from one EIP-3009 signature (Gateway-funded buyers hold no gas);
///  - creator fees out through CCTP V2 to another chain;
///  - the token's CCIP burn/mint bound.
contract ArcFeaturesTest is JunoBase {
    uint256 internal buyerKey = 0xB0B;
    address internal buyer = vm.addr(0xB0B);
    address internal relayer = makeAddr("relayer");

    function _signBuy(address token, uint256 quoteIn, uint256 minOut, uint256 deadline, bytes32 salt)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 nonce = launchpad.buyNonce(token, buyer, quoteIn, minOut, deadline, salt);
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                buyer,
                address(launchpad),
                quoteIn,
                0,
                deadline,
                nonce
            )
        );
        return vm.sign(buyerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    /* -------------------------------------------------------------- */
    /* EIP-3009 relayed buys                                          */
    /* -------------------------------------------------------------- */

    function test_relayedBuy_oneSignatureNoGasNoApproval() public {
        address token = launchUsdc();
        CircleUSDC.mint(buyer, 50e6);
        uint256 deadline = block.timestamp + 60;
        (uint256 quotedOut,,,) = launchpad.quoteBuy(token, 50e6);
        (uint8 v, bytes32 r, bytes32 s) = _signBuy(token, 50e6, quotedOut, deadline, "post-42");

        assertEq(usdc.allowance(buyer, address(launchpad)), 0, "no approval");
        assertEq(buyer.balance, 0, "no gas");
        vm.prank(relayer);
        (uint256 out, uint256 paid) =
            launchpad.buyWithAuthorization(token, buyer, 50e6, quotedOut, deadline, "post-42", 0, deadline, v, r, s);

        assertEq(out, quotedOut);
        assertEq(paid, 50e6);
        assertEq(JunoToken(token).balanceOf(buyer), out, "tokens to the buyer, not the relayer");
        assertEq(JunoToken(token).balanceOf(relayer), 0);
        assertEq(usdc.balanceOf(buyer), 0);
        assertEq(usdc.balanceOf(address(launchpad)), owed(token), "solvent");
    }

    /// The nonce binds the token, size, minimum and deadline: a relayer can't
    /// replay the signature into another coin or a worse price.
    function test_relayedBuy_signatureIsBoundToTheTrade() public {
        address token = launchUsdc();
        vm.prank(creator);
        address other = launchpad.launch(params(address(usdc), USDC_START, thinNameWeights()), 0, 0);
        CircleUSDC.mint(buyer, 50e6);
        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = _signBuy(token, 50e6, 1, deadline, "x");

        vm.startPrank(relayer);
        vm.expectRevert();
        launchpad.buyWithAuthorization(other, buyer, 50e6, 1, deadline, "x", 0, deadline, v, r, s);
        vm.expectRevert();
        launchpad.buyWithAuthorization(token, buyer, 50e6, 0, deadline, "x", 0, deadline, v, r, s);
        vm.expectRevert();
        launchpad.buyWithAuthorization(token, buyer, 40e6, 1, deadline, "x", 0, deadline, v, r, s);

        launchpad.buyWithAuthorization(token, buyer, 50e6, 1, deadline, "x", 0, deadline, v, r, s);
        // …and only once.
        vm.expectRevert();
        launchpad.buyWithAuthorization(token, buyer, 50e6, 1, deadline, "x", 0, deadline, v, r, s);
        vm.stopPrank();
    }

    /// A relayed buy that fills the curve refunds the unused USDC to the buyer.
    function test_relayedBuy_partialFillRefundsTheBuyer() public {
        address token = launchUsdc();
        uint256 size = launchpad.getPool(token).migrationQuoteThreshold * 2;
        CircleUSDC.mint(buyer, size);
        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = _signBuy(token, size, 0, deadline, "fill");
        vm.prank(relayer);
        (, uint256 paid) = launchpad.buyWithAuthorization(token, buyer, size, 0, deadline, "fill", 0, deadline, v, r, s);
        assertTrue(launchpad.getPool(token).complete);
        assertEq(usdc.balanceOf(buyer), size - paid, "refund to the buyer");
        assertEq(usdc.balanceOf(relayer), 0);
    }

    function test_relayedBuy_expired() public {
        address token = launchUsdc();
        CircleUSDC.mint(buyer, 5e6);
        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = _signBuy(token, 5e6, 0, deadline, "late");
        vm.warp(deadline + 1);
        vm.expectRevert(JunoLaunchpad.Expired.selector);
        launchpad.buyWithAuthorization(token, buyer, 5e6, 0, deadline, "late", 0, deadline, v, r, s);
    }

    /* -------------------------------------------------------------- */
    /* CCTP V2 cross-chain fee claims                                 */
    /* -------------------------------------------------------------- */

    function test_claimCrossChain_burnsThroughCctpToTheCreatorsWallet() public {
        address token = launchUsdc();
        buy(alice, token, 1_000e6);
        uint256 accrued = launchpad.getPool(token).creatorFees;
        bytes32 recipient = bytes32(uint256(uint160(creator)));

        vm.prank(creator);
        uint256 sent = launchpad.claimCreatorFeesCrossChain(token, 6, recipient, 0, 2000);

        assertEq(sent, accrued);
        (uint256 amount, uint32 domain, bytes32 mintRecipient, address burnToken,, uint256 maxFee, uint32 finality,) =
            messenger.last();
        assertEq(amount, accrued);
        assertEq(domain, 6, "Base");
        assertEq(mintRecipient, recipient);
        assertEq(burnToken, address(usdc));
        assertEq(maxFee, 0);
        assertEq(finality, 2000);
        assertEq(usdc.balanceOf(address(messenger)), accrued);
        assertEq(launchpad.getPool(token).creatorFees, 0);
        assertEq(launchpad.getPool(token).creatorFeesClaimed, accrued);
        assertEq(usdc.allowance(address(launchpad), address(messenger)), 0, "no lingering allowance");
        assertEq(usdc.balanceOf(address(launchpad)), owed(token), "solvent");
    }

    function test_claimCrossChain_guards() public {
        address token = launchUsdc();
        buy(alice, token, 100e6);
        bytes32 recipient = bytes32(uint256(uint160(creator)));

        vm.prank(alice);
        vm.expectRevert(JunoLaunchpad.NotCreator.selector);
        launchpad.claimCreatorFeesCrossChain(token, 6, recipient, 0, 2000);

        vm.startPrank(creator);
        vm.expectRevert(JunoLaunchpad.BadDestination.selector);
        launchpad.claimCreatorFeesCrossChain(token, 26, recipient, 0, 2000);
        vm.expectRevert(JunoLaunchpad.BadDestination.selector);
        launchpad.claimCreatorFeesCrossChain(token, 6, bytes32(0), 0, 2000);
        uint256 accrued = launchpad.getPool(token).creatorFees;
        vm.expectRevert(JunoLaunchpad.ZeroAmount.selector);
        launchpad.claimCreatorFeesCrossChain(token, 6, recipient, accrued, 1000);
        vm.stopPrank();
    }

    /* -------------------------------------------------------------- */
    /* CCIP burn/mint bound on the token                              */
    /* -------------------------------------------------------------- */

    function _graduated() internal returns (address token) {
        token = launchUsdc();
        buy(alice, token, launchpad.getPool(token).migrationQuoteThreshold * 2);
        launchpad.graduate(token);
    }

    function test_cct_poolOnlyAfterGraduationAndOnlyByAdmin() public {
        address token = launchUsdc();
        assertEq(JunoToken(token).getCCIPAdmin(), creator, "no JunoCrossChain set: the creator");
        vm.prank(creator);
        vm.expectRevert(JunoToken.NotGraduated.selector);
        JunoToken(token).setCCIPPool(address(0x9001));

        buy(alice, token, launchpad.getPool(token).migrationQuoteThreshold * 2);
        launchpad.graduate(token);
        vm.prank(alice);
        vm.expectRevert(JunoToken.OnlyCCIPAdmin.selector);
        JunoToken(token).setCCIPPool(address(0x9001));
        vm.prank(creator);
        JunoToken(token).setCCIPPool(address(0x9001));
        assertEq(JunoToken(token).ccipPool(), address(0x9001));
    }

    /// The pool can re-mint on Arc only what it burned on the way out.
    function test_cct_mintBoundedByBridgedOut() public {
        address token = _graduated();
        address pool = makeAddr("pool");
        vm.prank(creator);
        JunoToken(token).setCCIPPool(pool);
        JunoToken t = JunoToken(token);

        vm.prank(pool);
        vm.expectPartialRevert(JunoToken.ExceedsBridgedOut.selector);
        t.mint(alice, 1);

        uint256 supply = t.totalSupply();
        vm.prank(alice);
        t.transfer(pool, 1_000 ether);
        vm.prank(pool);
        t.burn(1_000 ether);
        assertEq(t.bridgedOut(), 1_000 ether);
        assertEq(t.totalSupply(), supply - 1_000 ether);

        vm.prank(pool);
        t.mint(bob, 600 ether);
        vm.prank(pool);
        vm.expectPartialRevert(JunoToken.ExceedsBridgedOut.selector);
        t.mint(bob, 400 ether + 1);
        vm.prank(pool);
        t.mint(bob, 400 ether);
        assertEq(t.totalSupply(), supply, "never above what launched");

        vm.prank(alice);
        vm.expectRevert(JunoToken.OnlyCCIPPool.selector);
        t.mint(alice, 1);
    }

    function test_cct_adminTransferIsTwoStep() public {
        address token = launchUsdc();
        JunoToken t = JunoToken(token);
        vm.prank(creator);
        t.transferCCIPAdmin(bob);
        assertEq(t.getCCIPAdmin(), creator);
        vm.prank(alice);
        vm.expectRevert(JunoToken.OnlyCCIPAdmin.selector);
        t.acceptCCIPAdmin();
        vm.prank(bob);
        t.acceptCCIPAdmin();
        assertEq(t.getCCIPAdmin(), bob);
    }
}
