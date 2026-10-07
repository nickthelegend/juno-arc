// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {JunoLaunchpad} from "./JunoLaunchpad.sol";
import {IUniswapV2Pair} from "./interfaces/IUniswapV2.sol";

/// @dev Chainlink Data Feeds' AggregatorV3Interface.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title JunoTrackers
/// @notice Tracker coins marked against Chainlink Data Feeds on Arc.
///
/// A tracker is a Juno coin launched on the flat `tight-nav` curve to follow an
/// asset Chainlink prices on Arc — BTC, ETH, SOL, LINK, PAXG (gold), EUR, JPY….
/// Its creator records, once, which feed it follows and how many units of the
/// asset one token stands for. From then on anyone can read, on chain, the
/// feed's price, what the coin's market implies the asset is worth, and the
/// premium between them — with the feed checked for a positive answer, a
/// finished round and staleness against its heartbeat. A stale feed is
/// reported as stale, never as a price.
///
/// This replaces the off-chain attestation the Monad build ran through
/// Chainlink CRE (CRE does not run on Arc mainnet): the comparison is now a
/// plain view over Chainlink's own on-chain feed.
///
/// The owner curates which feeds may be followed (a coin can't claim to track
/// "BTC" against a contract that isn't Chainlink's BTC/USD); that is its only
/// power. No funds are held here.
contract JunoTrackers is Ownable2Step {
    struct Feed {
        address aggregator;
        /// @dev Seconds after `updatedAt` the answer is still trusted (heartbeat plus margin).
        uint32 maxAge;
        bool allowed;
    }

    struct Tracker {
        bytes32 feedId;
        /// @dev Units of the asset one whole token stands for, 1e18-scaled.
        uint256 unitsPerTokenE18;
        /// @dev How far the market may sit from the feed and still be "in band".
        uint16 bandBps;
    }

    struct Mark {
        bytes32 feedId;
        /// @dev The feed's price of one unit of the asset, USD, 1e18-scaled. Zero when stale.
        uint256 navUsdE18;
        /// @dev What the coin's market says one unit is worth, USD, 1e18-scaled.
        uint256 impliedUsdE18;
        /// @dev implied / nav - 1, in basis points. Zero when stale.
        int256 premiumBps;
        uint256 updatedAt;
        bool stale;
        bool withinBand;
    }

    /// @notice Launch is allowed only within this distance of the feed (so a "BTC" tracker opens near BTC).
    uint16 public constant MAX_LAUNCH_BAND_BPS = 2_500;
    uint16 public constant MAX_BAND_BPS = 5_000;

    JunoLaunchpad public immutable launchpad;

    mapping(bytes32 feedId => Feed) public feeds;
    mapping(address token => Tracker) public trackers;
    bytes32[] public feedIds;

    event FeedSet(bytes32 indexed feedId, address aggregator, uint32 maxAge, bool allowed);
    event Tracked(address indexed token, bytes32 indexed feedId, uint256 unitsPerTokenE18, uint16 bandBps);

    error UnknownFeed();
    error StaleFeed(uint256 updatedAt);
    error BadAnswer();
    error NotCreator();
    error AlreadyTracked();
    error BadBand();
    error OffFeed(int256 premiumBps);

    constructor(address owner_, JunoLaunchpad launchpad_) Ownable(owner_) {
        launchpad = launchpad_;
    }

    /// @notice Allow (or retire) a Chainlink feed, e.g. `keccak256("BTC/USD")`.
    function setFeed(bytes32 feedId, address aggregator, uint32 maxAge, bool allowed) external onlyOwner {
        if (feeds[feedId].aggregator == address(0)) feedIds.push(feedId);
        feeds[feedId] = Feed(aggregator, maxAge, allowed);
        emit FeedSet(feedId, aggregator, maxAge, allowed);
    }

    function feedCount() external view returns (uint256) {
        return feedIds.length;
    }

    /// @notice Record what a coin tracks. Once, by its creator, while the feed
    /// is live and the coin's price is within `MAX_LAUNCH_BAND_BPS` of it.
    function track(address token, bytes32 feedId, uint256 unitsPerTokenE18, uint16 bandBps) external {
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);
        if (p.creator != msg.sender) revert NotCreator();
        if (trackers[token].feedId != bytes32(0)) revert AlreadyTracked();
        if (bandBps == 0 || bandBps > MAX_BAND_BPS || unitsPerTokenE18 == 0) revert BadBand();
        Feed memory f = feeds[feedId];
        if (!f.allowed) revert UnknownFeed();

        (uint256 nav, uint256 updatedAt) = price(feedId);
        if (block.timestamp - updatedAt > f.maxAge) revert StaleFeed(updatedAt);
        uint256 implied = Math.mulDiv(tokenPriceUsdE18(token), 1e18, unitsPerTokenE18);
        int256 premium = _premiumBps(implied, nav);
        if (_abs(premium) > MAX_LAUNCH_BAND_BPS) revert OffFeed(premium);

        trackers[token] = Tracker(feedId, unitsPerTokenE18, bandBps);
        emit Tracked(token, feedId, unitsPerTokenE18, bandBps);
    }

    /// @notice The feed's latest answer as USD per unit, 1e18-scaled, with the
    /// sanity checks every read gets (answer > 0, round complete). Staleness is
    /// the caller's call: `mark` reports it, `track` refuses it.
    function price(bytes32 feedId) public view returns (uint256 usdE18, uint256 updatedAt) {
        Feed memory f = feeds[feedId];
        if (f.aggregator == address(0)) revert UnknownFeed();
        (uint80 roundId, int256 answer,, uint256 updated, uint80 answeredInRound) =
            IAggregatorV3(f.aggregator).latestRoundData();
        if (answer <= 0 || updated == 0 || answeredInRound < roundId) revert BadAnswer();
        uint8 d = IAggregatorV3(f.aggregator).decimals();
        // forge-lint: disable-next-line(unsafe-typecast)
        usdE18 = d <= 18 ? uint256(answer) * 10 ** (18 - d) : uint256(answer) / 10 ** (d - 18);
        updatedAt = updated;
    }

    /// @notice A coin's price in USD per whole token, 1e18-scaled: the curve's
    /// price before graduation, the v2 pair's after. Assumes a 6-decimal quote
    /// (USDC/EURC on Arc) and an 18-decimal token.
    function tokenPriceUsdE18(address token) public view returns (uint256) {
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);
        if (p.graduated) {
            (uint112 r0, uint112 r1,) = IUniswapV2Pair(p.venue).getReserves();
            (uint256 base, uint256 quote) =
                IUniswapV2Pair(p.venue).token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            if (base == 0) return 0;
            // quote units (1e6) per base wei → USD (1e18) per token (1e18 wei)
            return Math.mulDiv(quote, 1e30, base);
        }
        // sqrtP² / 2^192 = quote units per base wei; × 1e18 wei per token × 1e12 to 1e18 scale.
        uint256 s = p.sqrtPriceX96;
        return Math.mulDiv(Math.mulDiv(s, s, 1 << 96), 1e30, 1 << 96);
    }

    /// @notice The tracker's mark: feed, implied, premium, freshness, band.
    function mark(address token) external view returns (Mark memory m) {
        Tracker memory t = trackers[token];
        if (t.feedId == bytes32(0)) revert UnknownFeed();
        m.feedId = t.feedId;
        m.impliedUsdE18 = Math.mulDiv(tokenPriceUsdE18(token), 1e18, t.unitsPerTokenE18);
        (uint256 nav, uint256 updatedAt) = price(t.feedId);
        m.updatedAt = updatedAt;
        m.stale = block.timestamp - updatedAt > feeds[t.feedId].maxAge;
        if (m.stale) return m;
        m.navUsdE18 = nav;
        m.premiumBps = _premiumBps(m.impliedUsdE18, nav);
        m.withinBand = _abs(m.premiumBps) <= t.bandBps;
    }

    function _premiumBps(uint256 implied, uint256 nav) internal pure returns (int256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return (int256(Math.mulDiv(implied, 10_000, nav)) - 10_000);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return x < 0 ? uint256(-x) : uint256(x);
    }
}
