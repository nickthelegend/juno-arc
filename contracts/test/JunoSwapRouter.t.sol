// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {JunoBase} from "./JunoBase.t.sol";
import {JunoLaunchpad} from "../src/JunoLaunchpad.sol";
import {JunoSwapRouter} from "../src/JunoSwapRouter.sol";
import {JunoToken} from "../src/JunoToken.sol";
import {UniswapV2Graduator} from "../src/graduators/UniswapV2Graduator.sol";
import {IUniswapV2Factory} from "../src/interfaces/IUniswapV2.sol";
import {ITokenMessengerV2} from "../src/interfaces/ICircle.sol";
import {Artifacts} from "../script/lib/Artifacts.sol";

interface IRouter02 {
    function factory() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// Trading a coin after it graduates on Arc: Uniswap's own published v2
/// factory and Router02 (deployed from the npm uniswap v2-core and v2-periphery's
/// build artifacts, exactly as the deploy script does), a real pair made by
/// graduation against real Circle USDC, and Juno's router in between.
contract JunoSwapRouterTest is JunoBase {
    IUniswapV2Factory internal v2;
    IRouter02 internal router02;
    JunoSwapRouter internal router;

    function setUp() public override {
        super.setUp();
        v2 = IUniswapV2Factory(
            Artifacts.create(abi.encodePacked(Artifacts.uniswap(Artifacts.V2_FACTORY), abi.encode(owner)), "v2 factory")
        );
        // Router02 with no WETH: on Arc, USDC is the gas token and the ERC-20 at 0x3600…, nothing to wrap.
        router02 = IRouter02(
            Artifacts.create(
                abi.encodePacked(Artifacts.uniswap(Artifacts.V2_ROUTER02), abi.encode(address(v2), address(0))),
                "router02"
            )
        );

        vm.startPrank(owner);
        launchpad = new JunoLaunchpad(
            owner, PROTOCOL_SHARE_BPS, address(usdc), ITokenMessengerV2(address(messenger)), MAX_RAISE
        );
        graduator = new UniswapV2Graduator(address(launchpad), v2, Artifacts.v2PairInitCodeHash());
        launchpad.setGraduator(graduator);
        vm.stopPrank();
        router = new JunoSwapRouter(v2);

        address[3] memory traders = [alice, bob, creator];
        for (uint256 i; i < traders.length; ++i) {
            vm.startPrank(traders[i]);
            usdc.approve(address(launchpad), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _graduated() internal returns (address token, address pair) {
        token = launchUsdc();
        buy(bob, token, launchpad.getPool(token).migrationQuoteThreshold * 2);
        (pair,) = launchpad.graduate(token);
    }

    function test_publishedFactory_hasTheCanonicalInitCodeHash() public view {
        assertEq(Artifacts.v2PairInitCodeHash(), Artifacts.UNISWAP_V2_PAIR_INIT_CODE_HASH);
        assertEq(router02.factory(), address(v2));
    }

    function test_buy_paysWhatItQuoted() public {
        (address token, address pair) = _graduated();
        (uint256 quoted,,) = router.quote(address(usdc), token, 10e6);
        uint256 before = JunoToken(token).balanceOf(alice);

        vm.prank(alice);
        uint256 out = router.swapExactTokens(address(usdc), token, 10e6, quoted, alice, block.timestamp);

        assertEq(out, quoted);
        assertEq(JunoToken(token).balanceOf(alice) - before, quoted);
        assertEq(pair, v2.getPair(token, address(usdc)));
        _assertRouterHoldsNothing(token);
    }

    function test_sell_paysUsdcAndNeedsAnAllowance() public {
        (address token,) = _graduated();
        uint256 held = JunoToken(token).balanceOf(bob) / 10;

        vm.prank(bob);
        vm.expectRevert();
        router.swapExactTokens(token, address(usdc), held, 0, bob, block.timestamp);

        (uint256 quoted,,) = router.quote(token, address(usdc), held);
        vm.startPrank(bob);
        JunoToken(token).approve(address(router), held);
        uint256 before = usdc.balanceOf(bob);
        uint256 out = router.swapExactTokens(token, address(usdc), held, quoted, bob, block.timestamp);
        vm.stopPrank();

        assertEq(out, quoted);
        assertEq(usdc.balanceOf(bob) - before, quoted);
        _assertRouterHoldsNothing(token);
    }

    /// Uniswap's own Router02 trades the same pair: the coin is a normal v2 market on Arc.
    function test_router02_tradesTheGraduatedPair() public {
        (address token,) = _graduated();
        address[] memory path = new address[](2);
        path[0] = address(usdc);
        path[1] = token;
        uint256[] memory expected = router02.getAmountsOut(25e6, path);
        (uint256 quoted,,) = router.quote(address(usdc), token, 25e6);
        assertEq(expected[1], quoted, "both routers price the pair the same");

        vm.startPrank(alice);
        usdc.approve(address(router02), 25e6);
        uint256[] memory amounts = router02.swapExactTokensForTokens(25e6, quoted, path, alice, block.timestamp);
        vm.stopPrank();
        assertEq(amounts[1], quoted);
        assertEq(JunoToken(token).balanceOf(alice), quoted);
    }

    function testFuzz_roundTripLosesOnlyFees(uint256 amount) public {
        (address token,) = _graduated();
        amount = bound(amount, 0.01e6, 500e6);
        vm.startPrank(alice);
        uint256 bought = router.swapExactTokens(address(usdc), token, amount, 0, alice, block.timestamp);
        JunoToken(token).approve(address(router), bought);
        uint256 back = router.swapExactTokens(token, address(usdc), bought, 0, alice, block.timestamp);
        vm.stopPrank();
        assertLt(back, amount, "never profits");
        // Two 0.3% fees, plus rounding (one USDC base unit at the small end).
        assertApproxEqAbs(back, (amount * 997 * 997) / 1_000_000, (amount / 1_000) + 2);
    }

    function test_slippageAndDeadline() public {
        (address token,) = _graduated();
        (uint256 quoted,,) = router.quote(address(usdc), token, 1e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(JunoSwapRouter.Slippage.selector, quoted, quoted + 1));
        router.swapExactTokens(address(usdc), token, 1e6, quoted + 1, alice, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(JunoSwapRouter.Expired.selector);
        router.swapExactTokens(address(usdc), token, 1e6, 0, alice, block.timestamp - 1);

        vm.prank(alice);
        vm.expectRevert(JunoSwapRouter.ZeroAmount.selector);
        router.swapExactTokens(address(usdc), token, 0, 0, alice, block.timestamp);
    }

    function test_noPairBeforeGraduation() public {
        address token = launchUsdc();
        vm.prank(alice);
        vm.expectRevert(JunoSwapRouter.NoPair.selector);
        router.swapExactTokens(address(usdc), token, 1e6, 0, alice, block.timestamp);
    }

    function test_refusesNativeValue() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function _assertRouterHoldsNothing(address token) internal view {
        assertEq(JunoToken(token).balanceOf(address(router)), 0, "no coin left");
        assertEq(usdc.balanceOf(address(router)), 0, "no USDC left");
    }
}
