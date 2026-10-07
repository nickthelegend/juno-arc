// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {JunoLaunchpad} from "../../src/JunoLaunchpad.sol";
import {JunoTrackers, IAggregatorV3} from "../../src/JunoTrackers.sol";
import {UniswapV2Graduator} from "../../src/graduators/UniswapV2Graduator.sol";
import {IUniswapV2Factory} from "../../src/interfaces/IUniswapV2.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ICircle.sol";
import {CurveMath} from "../../src/libraries/CurveMath.sol";
import {Artifacts} from "../../script/lib/Artifacts.sol";

/// Tracker coins against Chainlink's live Data Feeds on a fork of **Arc
/// mainnet** (nothing broadcast). Arc testnet has no feed list, which is why
/// trackers are a mainnet feature and this suite forks mainnet.
///
///   FORK_TESTS=1 forge test --network arc --match-path test/fork/ArcMainnetFeeds.t.sol -vv
contract ArcMainnetFeedsTest is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant BTC_USD = 0xa109B535C70C8Be9995be64Bb6751AcDB27e03De;
    address internal constant ETH_USD = 0x50FCDD99D6762D1C170DC6A9111db944AEE6D364;
    address internal constant PAXG_USD = 0xD7a3C3E82867e606f21A1fEa9b38cF4f34B96D2a;
    address internal constant EUR_USD = 0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D;
    bytes32 internal constant BTC = keccak256("BTC/USD");
    bytes32 internal constant PAXG = keccak256("PAXG/USD");

    JunoLaunchpad internal launchpad;
    JunoTrackers internal trackers;
    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");

    function setUp() public {
        if (vm.envOr("FORK_TESTS", uint256(0)) != 1) vm.skip(true);
        vm.createSelectFork(vm.envOr("ARC_MAINNET_RPC", string("https://rpc.mainnet.arc.io")));
        assertEq(block.chainid, 5042);
        IUniswapV2Factory v2 = IUniswapV2Factory(
            Artifacts.create(abi.encodePacked(Artifacts.uniswap(Artifacts.V2_FACTORY), abi.encode(owner)), "v2")
        );
        vm.startPrank(owner);
        launchpad = new JunoLaunchpad(owner, 2_000, USDC, ITokenMessengerV2(address(0)), 100_000e6);
        launchpad.setGraduator(new UniswapV2Graduator(address(launchpad), v2, Artifacts.v2PairInitCodeHash()));
        trackers = new JunoTrackers(owner, launchpad);
        trackers.setFeed(BTC, BTC_USD, 86_400 + 3_600, true);
        trackers.setFeed(PAXG, PAXG_USD, 86_400 + 3_600, true);
        vm.stopPrank();
    }

    function test_liveFeedsAreFreshAndSane() public view {
        address[4] memory feeds = [BTC_USD, ETH_USD, PAXG_USD, EUR_USD];
        for (uint256 i; i < feeds.length; ++i) {
            (uint80 id, int256 answer,, uint256 updatedAt, uint80 answeredIn) = IAggregatorV3(feeds[i]).latestRoundData();
            assertGt(answer, 0, IAggregatorV3(feeds[i]).description());
            assertGe(answeredIn, id);
            assertEq(IAggregatorV3(feeds[i]).decimals(), 8);
            assertLe(block.timestamp - updatedAt, 86_400 + 3_600, "within heartbeat");
        }
        (uint256 btc,) = trackers.price(BTC);
        assertGt(btc, 1_000e18, "BTC above $1,000");
    }

    /// A BTC tracker: a tight-nav curve opened at 1 token = 1e-11 BTC (so one
    /// billion tokens open near $1k FDV, like every Juno launch, well inside the
    /// raise cap) against the live feed, recorded on chain and marked.
    function test_btcTracker_launchTrackMark() public {
        (uint256 btc,) = trackers.price(BTC);
        uint256 units = 1e7; // 1e-11 BTC per token, 1e18-scaled
        // Open the curve at the feed's price: USD/token = btc * 1e-6; raw price = USD * 1e6 / 1e18.
        uint256 usdPerTokenE18 = (btc * units) / 1e18;
        // sqrt(raw price) in Q96 with raw = usdPerTokenE18 * 1e6 / 1e18 / 1e18 (quote units per base wei)
        uint160 start = uint160(_sqrt((usdPerTokenE18 * 1e6 * (1 << 96)) / 1e36 * (1 << 96)));
        JunoLaunchpad.LaunchParams memory lp = _tightNav(start);
        vm.prank(creator);
        address token = launchpad.launch(lp, 0, 0);

        vm.prank(creator);
        trackers.track(token, BTC, units, 300);
        JunoTrackers.Mark memory m = trackers.mark(token);
        assertFalse(m.stale);
        assertEq(m.navUsdE18, btc);
        assertApproxEqRel(m.impliedUsdE18, btc, 1e15, "opens on the feed");
        assertTrue(m.withinBand);
        emit log_named_decimal_uint("BTC/USD (Chainlink, Arc mainnet)", m.navUsdE18, 18);
        emit log_named_int("premium bps", m.premiumBps);
    }

    function test_refusesATrackerOpenedOffTheFeed() public {
        JunoLaunchpad.LaunchParams memory lp = _tightNav(79_228_162_514_264_337_593); // $1k FDV
        vm.prank(creator);
        address token = launchpad.launch(lp, 0, 0);
        vm.prank(creator);
        vm.expectPartialRevert(JunoTrackers.OffFeed.selector);
        trackers.track(token, PAXG, 1e18, 300); // "one ounce of gold per token" at $0.000001
    }

    /// A 1.5x uniform curve over sixteen ranges, sized like the app's tight-nav preset.
    function _tightNav(uint160 start) internal pure returns (JunoLaunchpad.LaunchParams memory p) {
        p.name = "Bitcoin tracker";
        p.symbol = "jBTC";
        p.uri = "ipfs://tracker";
        p.quote = USDC;
        p.preset = 3;
        p.sqrtStartPriceX96 = start;
        uint160[17] memory s;
        s[0] = start;
        for (uint256 i; i < 16; ++i) {
            s[i + 1] = uint160((uint256(s[i]) * 10_1274) / 10_0000); // 1.5^(1/32) per range in sqrt price
        }
        uint256 unit = 1e18;
        uint256 base;
        uint256 quote;
        for (uint256 i; i < 16; ++i) {
            base += CurveMath.baseDelta(s[i], s[i + 1], uint128(unit), true);
            quote += CurveMath.quoteDelta(s[i], s[i + 1], uint128(unit), true);
        }
        uint256 total = base + CurveMath.baseForQuoteAt(quote, s[16]);
        uint256 l = (unit * 990_000_000 ether) / total;
        for (uint256 i; i < 16; ++i) {
            p.curve[i] = JunoLaunchpad.Segment({sqrtPriceX96: s[i + 1], liquidity: uint128(l)});
        }
        p.startFeeBps = 100;
        p.endFeeBps = 100;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
