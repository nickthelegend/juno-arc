// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MockV3Aggregator} from "@chainlink/local/src/data-feeds/MockV3Aggregator.sol";

import {JunoBase} from "./JunoBase.t.sol";
import {JunoTrackers} from "../src/JunoTrackers.sol";

/// Trackers marked against a Chainlink feed (Chainlink Local's MockV3Aggregator
/// here; the real Arc mainnet feeds in test/fork/ArcMainnetFeeds.t.sol).
contract JunoTrackersTest is JunoBase {
    bytes32 internal constant BTC = keccak256("BTC/USD");
    JunoTrackers internal trackers;
    MockV3Aggregator internal btc;

    function setUp() public override {
        super.setUp();
        vm.warp(1_760_000_000);
        btc = new MockV3Aggregator(8, 60_000e8);
        trackers = new JunoTrackers(owner, launchpad);
        vm.prank(owner);
        trackers.setFeed(BTC, address(btc), 86_400 + 3_600, true);
    }

    function _tracker() internal returns (address token, uint256 units) {
        vm.prank(creator);
        token = launchpad.launch(params(address(usdc), USDC_START, uniformWeights()), 0, 0);
        (uint256 nav,) = trackers.price(BTC);
        // one token stands for whatever fraction of a BTC its opening price buys
        units = (trackers.tokenPriceUsdE18(token) * 1e18) / nav;
    }

    function test_price_normalizesTo18Decimals() public view {
        (uint256 p, uint256 at) = trackers.price(BTC);
        assertEq(p, 60_000e18);
        assertEq(at, block.timestamp);
    }

    function test_curvePrice_inUsd() public {
        vm.prank(creator);
        address token = launchpad.launch(params(address(usdc), USDC_START, contentWeights()), 0, 0);
        // $1k FDV over one billion tokens: $0.000001 a token.
        assertApproxEqRel(trackers.tokenPriceUsdE18(token), 1e12, 1e15);
    }

    function test_track_thenMark() public {
        (address token, uint256 units) = _tracker();
        vm.prank(creator);
        trackers.track(token, BTC, units, 200);

        JunoTrackers.Mark memory m = trackers.mark(token);
        assertEq(m.navUsdE18, 60_000e18);
        assertApproxEqRel(m.impliedUsdE18, 60_000e18, 1e14);
        assertFalse(m.stale);
        assertTrue(m.withinBand);

        // BTC drops 5%: the tracker now sits ~5.3% rich, outside its 2% band.
        btc.updateAnswer(57_000e8);
        m = trackers.mark(token);
        assertGt(m.premiumBps, 500);
        assertFalse(m.withinBand);
    }

    function test_mark_reportsStaleNeverAPrice() public {
        (address token, uint256 units) = _tracker();
        vm.prank(creator);
        trackers.track(token, BTC, units, 200);
        vm.warp(block.timestamp + 2 days);
        JunoTrackers.Mark memory m = trackers.mark(token);
        assertTrue(m.stale);
        assertEq(m.navUsdE18, 0);
        assertFalse(m.withinBand);
    }

    function test_track_guards() public {
        (address token, uint256 units) = _tracker();
        vm.prank(alice);
        vm.expectRevert(JunoTrackers.NotCreator.selector);
        trackers.track(token, BTC, units, 200);

        vm.prank(creator);
        vm.expectRevert(JunoTrackers.UnknownFeed.selector);
        trackers.track(token, keccak256("AAPL/USD"), units, 200);

        // A "BTC tracker" that opens at twice BTC's price is refused.
        vm.prank(creator);
        vm.expectPartialRevert(JunoTrackers.OffFeed.selector);
        trackers.track(token, BTC, units / 2, 200);

        btc.updateAnswer(0);
        vm.prank(creator);
        vm.expectRevert(JunoTrackers.BadAnswer.selector);
        trackers.track(token, BTC, units, 200);

        btc.updateAnswer(60_000e8);
        vm.warp(block.timestamp + 3 days);
        vm.prank(creator);
        vm.expectPartialRevert(JunoTrackers.StaleFeed.selector);
        trackers.track(token, BTC, units, 200);
    }

    function test_onlyOwnerCuratesFeeds() public {
        vm.prank(alice);
        vm.expectRevert();
        trackers.setFeed(BTC, address(0xBAD), 1, true);
    }
}
