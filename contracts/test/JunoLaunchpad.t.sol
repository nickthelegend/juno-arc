// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {JunoBase} from "./JunoBase.t.sol";
import {JunoLaunchpad} from "../src/JunoLaunchpad.sol";
import {JunoToken} from "../src/JunoToken.sol";
import {IJunoGraduator} from "../src/interfaces/IJunoGraduator.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {MockPair} from "./mocks/MockUniswapV2.sol";
import {CircleUSDC} from "./utils/CircleUSDC.sol";

contract JunoLaunchpadTest is JunoBase {
    /* -------------------------------------------------------------- */
    /* Launch                                                         */
    /* -------------------------------------------------------------- */

    function test_launch_mintsFullSupplyAndLocksPair() public {
        address token = launchUsdc();
        JunoToken t = JunoToken(token);
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);

        assertEq(t.totalSupply(), launchpad.TOTAL_SUPPLY());
        assertEq(t.balanceOf(address(launchpad)), launchpad.TOTAL_SUPPLY());
        assertEq(t.creator(), creator);
        assertEq(t.tokenURI(), "ipfs://bafkreigh2akiscaildc");
        assertEq(p.creator, creator);
        assertEq(p.venue, t.pair());
        assertTrue(p.venue != address(0), "pair created at launch");
        assertEq(p.sqrtPriceX96, USDC_START);
        assertEq(p.quoteReserve, 0);
        assertGt(p.migrationQuoteThreshold, 0);
        // The builder targets 99% of supply for curve + migration; 1% is the buffer.
        assertApproxEqRel(p.baseReserve + p.migrationBase, 990_000_000 ether, 1e14);
        assertEq(p.baseReserve + p.migrationBase + p.leftover, launchpad.TOTAL_SUPPLY());
        assertEq(launchpad.tokenCount(), 1);
        assertEq(launchpad.tokens(0), token);
    }

    function test_launch_predictsAddress() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        address predicted = launchpad.predictToken(creator, lp.name, lp.symbol, lp.uri);
        vm.prank(creator);
        address token = launchpad.launch(lp, 0, 0);
        assertEq(token, predicted);

        // The next launch from the same creator lands somewhere new.
        address next = launchpad.predictToken(creator, lp.name, lp.symbol, lp.uri);
        assertTrue(next != token);
        vm.prank(creator);
        assertEq(launchpad.launch(lp, 0, 0), next);
    }

    function test_launch_withFirstBuy() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        vm.prank(creator);
        address token = launchpad.launch(lp, 100e6, 1);
        assertGt(JunoToken(token).balanceOf(creator), 0);
        assertGt(launchpad.getPool(token).quoteReserve, 0);
    }

    /// Arc's native balance is USDC with 18 decimals; the launchpad takes the
    /// 6-decimal ERC-20 face only, so a launch can't be paid in native value.
    function test_launch_isNotPayable() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        (bool ok,) = address(launchpad).call{value: 1 ether}(
            abi.encodeCall(JunoLaunchpad.launch, (lp, 0, 0))
        );
        assertFalse(ok, "payable launch");
        (ok,) = address(launchpad).call{value: 1}("");
        assertFalse(ok, "stray native value");
    }

    /// Every curve's raise is capped, so no single pool can pool more USDC than allowed.
    function test_launch_rejectsRaiseAboveCap() public {
        vm.prank(owner);
        launchpad.setMaxRaise(1_000e6);
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        vm.prank(creator);
        vm.expectPartialRevert(JunoLaunchpad.RaiseTooLarge.selector);
        launchpad.launch(lp, 0, 0);

        uint256 limit = launchpad.MAX_RAISE_LIMIT();
        vm.prank(owner);
        vm.expectRevert(JunoLaunchpad.BadValue.selector);
        launchpad.setMaxRaise(limit + 1);
        vm.prank(alice);
        vm.expectRevert();
        launchpad.setMaxRaise(1);
    }

    /// A curve with no venue could fill and then neither trade nor graduate,
    /// holding everyone's quote for good. Refused at launch, before any buy.
    function test_launch_rejectsNoGraduator() public {
        vm.prank(owner);
        launchpad.setGraduator(IJunoGraduator(address(0)));
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        vm.prank(creator);
        vm.expectRevert(JunoLaunchpad.NoGraduator.selector);
        launchpad.launch(lp, 0, 0);
    }

    function test_launch_rejectsUnknownQuote() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(0xBEEF), USDC_START, contentWeights());
        vm.prank(creator);
        vm.expectRevert(JunoLaunchpad.QuoteNotAllowed.selector);
        launchpad.launch(lp, 0, 0);
    }

    function test_launch_rejectsBadFees() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        lp.endFeeBps = 10; // below the 25 bps floor
        vm.prank(creator);
        vm.expectRevert(JunoLaunchpad.BadFees.selector);
        launchpad.launch(lp, 0, 0);

        lp = params(address(usdc), USDC_START, contentWeights());
        lp.endFeeBps = lp.startFeeBps + 1;
        vm.prank(creator);
        vm.expectRevert(JunoLaunchpad.BadFees.selector);
        launchpad.launch(lp, 0, 0);
    }

    function test_launch_rejectsNonIncreasingCurve() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        lp.curve[5].sqrtPriceX96 = lp.curve[4].sqrtPriceX96;
        vm.prank(creator);
        vm.expectRevert(JunoLaunchpad.BadCurve.selector);
        launchpad.launch(lp, 0, 0);
    }

    function test_launch_rejectsZeroLiquidity() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        lp.curve[3].liquidity = 0;
        vm.prank(creator);
        vm.expectRevert(JunoLaunchpad.BadCurve.selector);
        launchpad.launch(lp, 0, 0);
    }

    function test_launch_rejectsOversizedCurve() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        for (uint256 i; i < 16; ++i) {
            lp.curve[i].liquidity = lp.curve[i].liquidity * 2;
        }
        vm.prank(creator);
        vm.expectPartialRevert(JunoLaunchpad.SupplyExceeded.selector);
        launchpad.launch(lp, 0, 0);
    }

    function test_launch_rejectsBadMetadata() public {
        JunoLaunchpad.LaunchParams memory lp = params(address(usdc), USDC_START, contentWeights());
        lp.symbol = "";
        vm.prank(creator);
        vm.expectRevert(JunoLaunchpad.BadMetadata.selector);
        launchpad.launch(lp, 0, 0);
    }

    /* -------------------------------------------------------------- */
    /* Trading                                                        */
    /* -------------------------------------------------------------- */

    function test_buy_movesPriceAndAccruesFees() public {
        address token = launchUsdc();
        (uint256 out, uint256 paid) = buy(alice, token, 1_000e6);
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);

        assertEq(paid, 1_000e6);
        assertEq(JunoToken(token).balanceOf(alice), out);
        assertGt(p.sqrtPriceX96, USDC_START);
        // 9% launch fee, 20% of it to the protocol: $90 of a $1,000 buy, $18 / $72.
        uint256 fee = 90e6;
        assertEq(p.quoteReserve, 1_000e6 - fee);
        assertEq(launchpad.protocolFees(address(usdc)), 18e6);
        assertEq(p.creatorFees, 72e6);
        assertEq(usdc.balanceOf(address(launchpad)), owed(token));
    }

    function test_buy_matchesQuote() public {
        address token = launchUsdc();
        (uint256 quotedOut, uint256 quotedPaid, uint256 fee,) = launchpad.quoteBuy(token, 2_500e6);
        (uint256 out, uint256 paid) = buy(alice, token, 2_500e6);
        assertEq(out, quotedOut);
        assertEq(paid, quotedPaid);
        assertGt(fee, 0);
    }

    function test_buy_emitsTrade() public {
        address token = launchUsdc();
        (uint256 quotedOut,,,) = launchpad.quoteBuy(token, 10e6);
        vm.expectEmit(true, true, false, false, address(launchpad));
        emit JunoLaunchpad.Trade(token, alice, true, quotedOut, 10e6, 0, 0, 0);
        buy(alice, token, 10e6);
    }

    function test_buy_slippage() public {
        address token = launchUsdc();
        (uint256 quotedOut,,,) = launchpad.quoteBuy(token, 10e6);
        vm.prank(alice);
        vm.expectPartialRevert(JunoLaunchpad.Slippage.selector);
        launchpad.buy(token, 10e6, quotedOut + 1, alice, block.timestamp);
    }

    function test_buy_deadline() public {
        address token = launchUsdc();
        vm.prank(alice);
        vm.expectRevert(JunoLaunchpad.Expired.selector);
        launchpad.buy(token, 1e6, 0, alice, block.timestamp - 1);
    }

    function test_buy_needsAllowance() public {
        address token = launchUsdc();
        address carol = makeAddr("carol");
        CircleUSDC.mint(carol, 10e6);
        vm.prank(carol);
        vm.expectRevert();
        launchpad.buy(token, 10e6, 0, carol, block.timestamp);
    }

    function test_sell_roundTripLosesOnlyFees() public {
        address token = launchUsdc();
        vm.warp(block.timestamp + 1 hours); // resting fee: 1%
        uint256 before = usdc.balanceOf(alice);
        buy(alice, token, 1_000e6);
        sellAll(alice, token);
        uint256 lost = before - usdc.balanceOf(alice);
        // Two 1% fees, about $19.90 on $1,000, and never a profit from rounding.
        assertGt(lost, 0);
        assertApproxEqRel(lost, 19.9e6, 1e16);
        assertEq(JunoToken(token).balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(launchpad)), owed(token));
    }

    function test_sell_needsNoApproval() public {
        address token = launchUsdc();
        buy(alice, token, 10e6);
        assertEq(JunoToken(token).allowance(alice, address(launchpad)), 0);
        uint256 out = sellAll(alice, token);
        assertGt(out, 0);
    }

    function test_sell_cannotGoBelowStart() public {
        address token = launchUsdc();
        buy(alice, token, 10e6);
        uint256 balance = JunoToken(token).balanceOf(alice);
        // Bob has tokens only via transfer; the curve cannot pay out more than it took in.
        vm.prank(alice);
        JunoToken(token).transfer(bob, balance);
        buy(creator, token, 1e6);
        uint256 creatorBalance = JunoToken(token).balanceOf(creator);
        vm.prank(creator);
        JunoToken(token).transfer(bob, creatorBalance);

        uint256 all = JunoToken(token).balanceOf(bob);
        vm.prank(bob);
        launchpad.sell(token, all, 0, bob, block.timestamp);
        // Back at the start, give or take the few wei of rounding that always favour the pool.
        assertApproxEqAbs(launchpad.getPool(token).sqrtPriceX96, USDC_START, 16);
        assertGe(launchpad.getPool(token).sqrtPriceX96, USDC_START);

        // Nothing left to sell into.
        buy(alice, token, 1e6);
        uint256 more = JunoToken(token).balanceOf(alice) * 2;
        deal(token, alice, more);
        vm.prank(alice);
        vm.expectRevert(JunoLaunchpad.InsufficientLiquidity.selector);
        launchpad.sell(token, more, 0, alice, block.timestamp);
    }

    function test_fees_decayToRestingFee() public {
        address token = launchUsdc();
        assertEq(launchpad.currentFeePpm(token), 90_000);
        vm.warp(block.timestamp + 300);
        uint256 mid = launchpad.currentFeePpm(token);
        assertLt(mid, 90_000);
        assertGt(mid, 10_000);
        // Exponential: halfway through the decay is the geometric mean, 3%.
        assertApproxEqRel(mid, 30_000, 2e16);
        vm.warp(block.timestamp + 600);
        assertEq(launchpad.currentFeePpm(token), 10_000);
    }

    /* -------------------------------------------------------------- */
    /* Completion and graduation                                      */
    /* -------------------------------------------------------------- */

    function test_complete_partialFillRefunds() public {
        address token = launchUsdc();
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);
        uint256 plenty = p.migrationQuoteThreshold * 2;

        uint256 before = usdc.balanceOf(alice);
        (uint256 out, uint256 paid) = buy(alice, token, plenty);
        p = launchpad.getPool(token);

        assertTrue(p.complete);
        assertLt(paid, plenty);
        assertEq(before - usdc.balanceOf(alice), paid, "unused quote came back");
        assertApproxEqAbs(p.baseReserve, 0, 1e6);
        assertApproxEqRel(out, launchpad.TOTAL_SUPPLY() - p.migrationBase - p.leftover, 1e12);
        assertApproxEqRel(p.quoteReserve, p.migrationQuoteThreshold, 1e12);
        assertEq(usdc.balanceOf(address(launchpad)), owed(token));

        vm.prank(bob);
        vm.expectRevert(JunoLaunchpad.CurveComplete.selector);
        launchpad.buy(token, 1e6, 0, bob, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(JunoLaunchpad.CurveComplete.selector);
        launchpad.sell(token, 1 ether, 0, alice, block.timestamp);
    }

    function test_pairLockedUntilGraduation() public {
        address token = launchUsdc();
        buy(alice, token, 10e6);
        address pair = JunoToken(token).pair();
        vm.prank(alice);
        vm.expectRevert(JunoToken.PairLocked.selector);
        JunoToken(token).transfer(pair, 1);
    }

    function test_graduate() public {
        address token = launchUsdc();
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);
        buy(alice, token, p.migrationQuoteThreshold * 2);

        address unfinished = launchUsdc();
        vm.expectRevert(JunoLaunchpad.CurveNotComplete.selector);
        launchpad.graduate(unfinished);

        p = launchpad.getPool(token);
        uint256 supplyBefore = JunoToken(token).totalSupply();
        (address venue, uint256 liquidity) = launchpad.graduate(token);
        JunoLaunchpad.Pool memory after_ = launchpad.getPool(token);

        assertEq(venue, p.venue);
        assertGt(liquidity, 0);
        assertTrue(after_.graduated);
        assertTrue(JunoToken(token).graduated());
        assertEq(MockPair(venue).balanceOf(graduator.LOCK()), liquidity, "LP locked");
        assertEq(JunoToken(token).balanceOf(address(launchpad)), 0, "nothing left behind");
        assertEq(JunoToken(token).totalSupply(), supplyBefore - p.baseReserve - p.leftover);
        assertEq(usdc.balanceOf(venue), p.quoteReserve);
        assertEq(usdc.balanceOf(address(launchpad)), owed(token), "fees stay claimable");

        // The AMM opens at the price the curve finished on.
        uint256 curveTop = (uint256(after_.sqrtPriceX96) * after_.sqrtPriceX96) >> 96;
        uint256 ammPrice = (usdc.balanceOf(venue) << 96) / JunoToken(token).balanceOf(venue);
        assertApproxEqRel(ammPrice, curveTop, 1e13);

        // And tokens now move freely into it.
        vm.prank(alice);
        JunoToken(token).transfer(venue, 1 ether);

        vm.expectRevert(JunoLaunchpad.AlreadyGraduated.selector);
        launchpad.graduate(token);
    }

    function test_graduate_survivesDonatedPair() public {
        address token = launchUsdc();
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);
        // Someone creates the pair early and makes its reserves one-sided.
        address created = factory.createPair(token, address(usdc));
        assertEq(created, p.venue, "the pair lands where the token was locked");
        vm.startPrank(bob);
        usdc.transfer(p.venue, 5e6);
        MockPair(p.venue).sync();
        vm.stopPrank();

        buy(alice, token, p.migrationQuoteThreshold * 2);
        (, uint256 liquidity) = launchpad.graduate(token);
        assertGt(liquidity, 0);
    }

    function test_launch_locksPairWithoutDeployingIt() public {
        address token = launchUsdc();
        address venue = launchpad.getPool(token).venue;
        assertEq(venue.code.length, 0, "no pair deployed at launch");
        assertEq(factory.getPair(token, address(usdc)), address(0));
        assertEq(JunoToken(token).pair(), venue);

        buy(alice, token, launchpad.getPool(token).migrationQuoteThreshold * 2);
        (address graduatedInto,) = launchpad.graduate(token);
        assertEq(graduatedInto, venue, "graduation deploys it exactly where it was locked");
        assertGt(venue.code.length, 0);
    }


    /* -------------------------------------------------------------- */
    /* Fee claims                                                     */
    /* -------------------------------------------------------------- */

    function test_claimCreatorFees() public {
        address token = launchUsdc();
        buy(alice, token, 100e6);
        uint256 accrued = launchpad.getPool(token).creatorFees;
        assertGt(accrued, 0);

        vm.prank(alice);
        vm.expectRevert(JunoLaunchpad.NotCreator.selector);
        launchpad.claimCreatorFees(token, alice);

        uint256 before = usdc.balanceOf(creator);
        vm.prank(creator);
        launchpad.claimCreatorFees(token, creator);
        assertEq(usdc.balanceOf(creator) - before, accrued);
        assertEq(launchpad.getPool(token).creatorFees, 0);
        assertEq(launchpad.getPool(token).creatorFeesClaimed, accrued);

        vm.prank(creator);
        vm.expectRevert(JunoLaunchpad.ZeroAmount.selector);
        launchpad.claimCreatorFees(token, creator);
    }

    function test_claimProtocolFees_onlyOwner() public {
        address token = launchUsdc();
        buy(alice, token, 100e6);
        vm.prank(alice);
        vm.expectRevert();
        launchpad.claimProtocolFees(address(usdc), alice);

        uint256 accrued = launchpad.protocolFees(address(usdc));
        vm.prank(owner);
        launchpad.claimProtocolFees(address(usdc), owner);
        assertEq(usdc.balanceOf(owner), accrued);
    }

    function test_protocolShareIsFixedAtLaunch() public {
        address token = launchUsdc();
        vm.prank(owner);
        launchpad.setProtocolShare(0);
        assertEq(launchpad.getPool(token).protocolShareBps, PROTOCOL_SHARE_BPS);
        vm.prank(owner);
        vm.expectRevert(JunoLaunchpad.BadFees.selector);
        launchpad.setProtocolShare(5_001);
    }

    /* -------------------------------------------------------------- */
    /* Presets                                                        */
    /* -------------------------------------------------------------- */

    /// @dev Front-loaded liquidity should absorb an opening order with less
    /// price movement than a back-loaded content curve.
    function test_thinNameIsDeeperAtTheOpen() public {
        vm.startPrank(creator);
        address content = launchpad.launch(params(address(usdc), USDC_START, contentWeights()), 0, 0);
        address thin = launchpad.launch(params(address(usdc), USDC_START, thinNameWeights()), 0, 0);
        vm.stopPrank();

        (,,, uint160 contentAfter) = launchpad.quoteBuy(content, 500e6);
        (,,, uint160 thinAfter) = launchpad.quoteBuy(thin, 500e6);
        assertLt(thinAfter, contentAfter);
    }

    /* -------------------------------------------------------------- */
    /* Fuzz                                                           */
    /* -------------------------------------------------------------- */

    function testFuzz_buyThenSellNeverProfits(uint256 amount, uint256 warp) public {
        address token = launchUsdc();
        amount = bound(amount, 1e4, launchpad.getPool(token).migrationQuoteThreshold / 2);
        warp = bound(warp, 0, 2 hours);
        vm.warp(block.timestamp + warp);

        uint256 before = usdc.balanceOf(alice);
        buy(alice, token, amount);
        sellAll(alice, token);
        assertLe(usdc.balanceOf(alice), before);
        assertEq(usdc.balanceOf(address(launchpad)), owed(token));
    }

    function testFuzz_splitBuysMatchOneBuy(uint256 amount, uint8 parts) public {
        address token = launchUsdc();
        vm.warp(block.timestamp + 1 hours);
        amount = bound(amount, 1e6, launchpad.getPool(token).migrationQuoteThreshold / 2);
        parts = uint8(bound(parts, 2, 8));

        (uint256 single,,,) = launchpad.quoteBuy(token, amount);
        uint256 total;
        uint256 slice = amount / parts;
        for (uint256 i; i < parts; ++i) {
            (uint256 out,) = buy(alice, token, slice);
            total += out;
        }
        // Path independence up to rounding, which always favours the pool.
        assertLe(total, single);
        assertApproxEqRel(total, single, 1e15);
    }

    function testFuzz_sellsNeverDrainBelowOwed(uint256 a, uint256 b) public {
        address token = launchUsdc();
        uint256 cap = launchpad.getPool(token).migrationQuoteThreshold / 4;
        a = bound(a, 1e4, cap);
        b = bound(b, 1e4, cap);
        buy(alice, token, a);
        buy(bob, token, b);
        sellAll(alice, token);
        sellAll(bob, token);
        assertGe(usdc.balanceOf(address(launchpad)), owed(token));
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);
        assertGe(p.sqrtPriceX96, USDC_START);
    }
}

contract CurveMathTest is JunoBase {
    function testFuzz_quoteInThenBaseInReturnsToStart(uint128 liquidity, uint96 quoteIn) public pure {
        liquidity = uint128(bound(liquidity, 1e18, 1e30));
        quoteIn = uint96(bound(quoteIn, 1, 1e15));
        uint160 start = USDC_START;
        uint160 up = CurveMath.nextSqrtPriceFromQuoteIn(start, liquidity, quoteIn);
        uint256 baseOut = CurveMath.baseDelta(start, up, liquidity, false);
        uint160 down = CurveMath.nextSqrtPriceFromBaseIn(up, liquidity, baseOut);
        // Selling back what was bought can never land below where it started.
        assertGe(down, start);
        uint256 quoteBack = CurveMath.quoteDelta(down, up, liquidity, false);
        assertLe(quoteBack, quoteIn);
    }

    function test_deltasAreSymmetric() public pure {
        uint160 a = USDC_START;
        uint160 b = uint160((uint256(a) * 11) / 10);
        uint128 l = 1e24;
        assertEq(CurveMath.baseDelta(a, b, l, false), CurveMath.baseDelta(b, a, l, false));
        assertEq(CurveMath.quoteDelta(a, b, l, true), CurveMath.quoteDelta(b, a, l, true));
        assertGe(CurveMath.baseDelta(a, b, l, true), CurveMath.baseDelta(a, b, l, false));
    }
}
