// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {JunoLaunchpad} from "../src/JunoLaunchpad.sol";
import {UniswapV2Graduator} from "../src/graduators/UniswapV2Graduator.sol";
import {JunoSwapRouter} from "../src/JunoSwapRouter.sol";
import {JunoCrossChain} from "../src/JunoCrossChain.sol";
import {JunoTrackers} from "../src/JunoTrackers.sol";
import {IUniswapV2Factory} from "../src/interfaces/IUniswapV2.sol";
import {ITokenMessengerV2} from "../src/interfaces/ICircle.sol";
import {
    ICCIPTokenPoolFactory, ICCIPRegistryModuleOwnerCustom, ICCIPTokenAdminRegistry
} from "../src/interfaces/ICCIP.sol";
import {Artifacts} from "./lib/Artifacts.sol";

/// @title Deploy
/// @notice Deploys Juno to Arc — testnet (5042002) or mainnet (5042), picked by
/// the RPC's chain id; `scripts/deploy.sh testnet|mainnet` is the front door.
///
/// What lands, in order:
///   1. Uniswap v2: Arc has no Uniswap deployment, so Uniswap's own *published*
///      UniswapV2Factory and UniswapV2Router02 (npm uniswap/v2-core 1.0.1 and
///      uniswap/v2-periphery build artifacts) are deployed byte for byte. The
///      pairs carry Uniswap's canonical init code hash (0x96e8ac42…845f), so any
///      v2 tooling finds them. Router02's WETH slot is zero: on Arc USDC is both
///      the gas token and the ERC-20 at 0x3600…0000, so there is nothing to wrap.
///      Skipped when UNISWAP_V2_FACTORY names an existing factory.
///   2. JunoLaunchpad (USDC quote, CCTP V2 TokenMessengerV2 for cross-chain fee
///      claims, a per-curve raise cap) and its UniswapV2Graduator.
///   3. JunoCrossChain: CCIP Cross-Chain Token enablement through Arc's
///      TokenPoolFactory / RegistryModuleOwnerCustom / TokenAdminRegistry, pinned
///      to Chainlink's published BurnMintTokenPool 2.0.0 bytecode.
///   4. JunoSwapRouter (trades graduated coins) and JunoTrackers (Chainlink Data
///      Feeds marks; feeds registered on mainnet, where they exist).
///
/// Environment (all optional): DEPLOYER_PRIVATE_KEY (or --account/--sender),
/// JUNO_OWNER, JUNO_PROTOCOL_SHARE_BPS (default 2000), JUNO_MAX_RAISE_USDC
/// (default 100000), UNISWAP_V2_FACTORY, JUNO_REGISTER_FEEDS (default: on
/// mainnet only), JUNO_DEPLOYMENT_OUT (default ../deployments/arc-<network>.json).
/// Mainnet also requires JUNO_CONFIRM_MAINNET=yes.
contract Deploy is Script {
    uint256 internal constant ARC_MAINNET = 5042;
    uint256 internal constant ARC_TESTNET = 5042002;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;

    struct Net {
        string name;
        address tokenMessenger;
        address ccipRouter;
        address ccipFactory;
        address ccipRegistryModule;
        address ccipTokenAdminRegistry;
        uint64 ccipChainSelector;
        uint32 cctpDomain;
        address gatewayWallet;
        address gatewayMinter;
        address memo;
    }

    struct Deployment {
        uint256 chainId;
        address deployer;
        address owner;
        uint16 protocolShareBps;
        uint256 maxRaise;
        address launchpad;
        address graduator;
        address swapRouter;
        address crossChain;
        address trackers;
        address uniswapV2Factory;
        address uniswapV2Router02;
        bool uniswapDeployed;
        bytes32 pairInitCodeHash;
        bytes32 ccipPoolInitCodeHash;
        uint256 feedsRegistered;
        uint256 deployBlock;
    }

    error NoSigner();
    error WrongChain(uint256 chainId);
    error MainnetNotConfirmed();
    error NoCode(string what, address at);
    error BadUsdc();
    error BadProtocolShare(uint256 bps);
    error PostCheck(string what);

    function net(uint256 chainId) internal pure returns (Net memory n) {
        if (chainId == ARC_MAINNET) {
            n.name = "mainnet";
            n.tokenMessenger = 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
            n.ccipRouter = 0xB79791184973589c38e114D43Eb8E4588C283A18;
            n.ccipFactory = 0x7CcFb2Fa43637b4858Cb1269CF0d64a99e8C668a;
            n.ccipRegistryModule = 0x3201a20D2a33820C0DaC8Bc93C4819755C2a8c7F;
            n.ccipTokenAdminRegistry = 0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29;
            n.ccipChainSelector = 6370580034781731079;
            n.gatewayWallet = 0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE;
            n.gatewayMinter = 0x2222222d7164433c4C09B0b0D809a9b52C04C205;
        } else if (chainId == ARC_TESTNET) {
            n.name = "testnet";
            n.tokenMessenger = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
            n.ccipRouter = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
            n.ccipFactory = 0xdC6b0980d1B3661adf889b85554555C4AFFf2dB5;
            n.ccipRegistryModule = 0x524B83ae8208490151339c626fd0E35b964483e3;
            n.ccipTokenAdminRegistry = 0xd3e461C55676B10634a5F81b747c324B85686Dd1;
            n.ccipChainSelector = 3034092155422581607;
            n.gatewayWallet = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
            n.gatewayMinter = 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B;
        } else {
            revert WrongChain(chainId);
        }
        n.cctpDomain = 26;
        n.memo = 0x5294E9927c3306DcBaDb03fe70b92e01cCede505;
    }

    function run() external returns (Deployment memory d) {
        d.chainId = block.chainid;
        Net memory n = net(d.chainId);
        bool mainnet = d.chainId == ARC_MAINNET;
        if (mainnet && keccak256(bytes(vm.envOr("JUNO_CONFIRM_MAINNET", string("")))) != keccak256("yes")) {
            revert MainnetNotConfirmed();
        }

        // ---- Checks, before anything is sent -------------------------------
        _requireCode("USDC", USDC);
        if (IERC20Metadata(USDC).decimals() != 6) revert BadUsdc();
        _requireCode("TokenMessengerV2", n.tokenMessenger);
        _requireCode("CCIP TokenPoolFactory", n.ccipFactory);
        _requireCode("CCIP RegistryModuleOwnerCustom", n.ccipRegistryModule);
        _requireCode("CCIP TokenAdminRegistry", n.ccipTokenAdminRegistry);
        // The factory must be the one wired to this registry and module.
        (, address tar, address mod,) = ICCIPTokenPoolFactory(n.ccipFactory).getStaticConfig();
        if (tar != n.ccipTokenAdminRegistry || mod != n.ccipRegistryModule) revert PostCheck("ccip factory config");

        uint256 share = _envUint("JUNO_PROTOCOL_SHARE_BPS", 2_000);
        if (share > 5_000) revert BadProtocolShare(share);
        // forge-lint: disable-next-line(unsafe-typecast)
        d.protocolShareBps = uint16(share);
        d.maxRaise = _envUint("JUNO_MAX_RAISE_USDC", 100_000) * 1e6;
        d.uniswapV2Factory = _envAddress("UNISWAP_V2_FACTORY", address(0));
        d.ccipPoolInitCodeHash = keccak256(Artifacts.ccip("v2_0_0/burn_mint_token_pool"));
        bytes memory factoryCode = Artifacts.uniswap(Artifacts.V2_FACTORY);
        bytes memory routerCode = Artifacts.uniswap(Artifacts.V2_ROUTER02);
        d.pairInitCodeHash = Artifacts.v2PairInitCodeHash();
        if (d.pairInitCodeHash != Artifacts.UNISWAP_V2_PAIR_INIT_CODE_HASH) revert PostCheck("v2 init code hash");

        // ---- Signer --------------------------------------------------------
        uint256 key = _privateKey();
        if (key != 0) {
            vm.startBroadcast(key);
        } else {
            if (msg.sender == DEFAULT_SENDER) revert NoSigner();
            vm.startBroadcast();
        }
        (, d.deployer,) = vm.readCallers();
        d.owner = _envAddress("JUNO_OWNER", d.deployer);
        d.deployBlock = block.number;

        // ---- 1. Uniswap v2, from Uniswap's published bytecode ---------------
        if (d.uniswapV2Factory == address(0)) {
            // feeToSetter: whoever owns Juno. The v2 protocol fee stays off unless they turn it on.
            d.uniswapV2Factory = Artifacts.create(abi.encodePacked(factoryCode, abi.encode(d.owner)), "UniswapV2Factory");
            d.uniswapV2Router02 = Artifacts.create(
                abi.encodePacked(routerCode, abi.encode(d.uniswapV2Factory, address(0))), "UniswapV2Router02"
            );
            d.uniswapDeployed = true;
        } else {
            _requireCode("UNISWAP_V2_FACTORY", d.uniswapV2Factory);
            d.uniswapV2Router02 = _envAddress("UNISWAP_V2_ROUTER02", address(0));
        }

        // ---- 2. Launchpad and graduator --------------------------------------
        JunoLaunchpad launchpad = new JunoLaunchpad(
            d.deployer, d.protocolShareBps, USDC, ITokenMessengerV2(n.tokenMessenger), d.maxRaise
        );
        UniswapV2Graduator graduator =
            new UniswapV2Graduator(address(launchpad), IUniswapV2Factory(d.uniswapV2Factory), d.pairInitCodeHash);
        launchpad.setGraduator(graduator);

        // ---- 3. CCIP Cross-Chain Tokens --------------------------------------
        JunoCrossChain crossChain = new JunoCrossChain(
            address(launchpad),
            ICCIPTokenPoolFactory(n.ccipFactory),
            ICCIPRegistryModuleOwnerCustom(n.ccipRegistryModule),
            ICCIPTokenAdminRegistry(n.ccipTokenAdminRegistry),
            d.ccipPoolInitCodeHash
        );
        launchpad.setCrossChain(address(crossChain));

        // ---- 4. Router and trackers -------------------------------------------
        d.swapRouter = address(new JunoSwapRouter(IUniswapV2Factory(d.uniswapV2Factory)));
        JunoTrackers trackers = new JunoTrackers(d.deployer, launchpad);
        if (vm.envOr("JUNO_REGISTER_FEEDS", mainnet)) d.feedsRegistered = _registerFeeds(trackers);

        if (d.owner != d.deployer) {
            launchpad.transferOwnership(d.owner);
            trackers.transferOwnership(d.owner);
        }
        vm.stopBroadcast();

        d.launchpad = address(launchpad);
        d.graduator = address(graduator);
        d.crossChain = address(crossChain);
        d.trackers = address(trackers);

        // ---- Post-checks ------------------------------------------------------
        if (launchpad.usdc() != USDC || !launchpad.allowedQuote(USDC)) revert PostCheck("usdc");
        if (address(launchpad.graduator()) != d.graduator) revert PostCheck("graduator");
        if (launchpad.crossChain() != d.crossChain) revert PostCheck("crossChain");
        if (address(launchpad.tokenMessenger()) != n.tokenMessenger) revert PostCheck("tokenMessenger");

        _write(d, n);
        _log(d, n);
    }

    /// @dev Chainlink Data Feeds on Arc mainnet (reference-data-directory feeds-arc-mainnet.json, 2026-10-07):
    /// 8 decimals, 24h heartbeat; trusted for heartbeat + 1h.
    function _registerFeeds(JunoTrackers trackers) internal returns (uint256 count) {
        string[10] memory names =
            ["BTC/USD", "ETH/USD", "SOL/USD", "LINK/USD", "PAXG/USD", "EUR/USD", "JPY/USD", "AVAX/USD", "XRP/USD", "BNB/USD"];
        address[10] memory feeds = [
            0xa109B535C70C8Be9995be64Bb6751AcDB27e03De,
            0x50FCDD99D6762D1C170DC6A9111db944AEE6D364,
            0x2d04D354f5fDaE3De723df475745B0a9B4edf90C,
            0xD37600AB06758356F0f5eE607299204785bF8c3a,
            0xD7a3C3E82867e606f21A1fEa9b38cF4f34B96D2a,
            0xDd5B15443cd733D3966a50a3E48cB7DF9Fb5DE0D,
            0xF9Fc1C20C82d774A3787845E73E41BCbF7F38F25,
            0xf17C0EdcAA28371e9c8012D7699bF40ECF0F58d1,
            0xFFb04Fba8384e0a53Ee9975F9164905030F5ea29,
            0x00d1516C06e030Ef2142478ce14CEbce2De81771
        ];
        for (uint256 i; i < names.length; ++i) {
            if (feeds[i].code.length == 0) continue; // a fork of a chain without the feed
            trackers.setFeed(keccak256(bytes(names[i])), feeds[i], 86_400 + 3_600, true);
            count++;
        }
    }

    function _write(Deployment memory d, Net memory n) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", d.chainId);
        vm.serializeString(k, "network", n.name);
        vm.serializeAddress(k, "deployer", d.deployer);
        vm.serializeAddress(k, "owner", d.owner);
        vm.serializeBool(k, "ownershipPending", d.owner != d.deployer);
        vm.serializeUint(k, "protocolShareBps", d.protocolShareBps);
        vm.serializeUint(k, "maxRaiseUnits", d.maxRaise);
        vm.serializeAddress(k, "launchpad", d.launchpad);
        vm.serializeAddress(k, "graduator", d.graduator);
        vm.serializeAddress(k, "swapRouter", d.swapRouter);
        vm.serializeAddress(k, "crossChain", d.crossChain);
        vm.serializeAddress(k, "trackers", d.trackers);
        vm.serializeUint(k, "feedsRegistered", d.feedsRegistered);
        vm.serializeAddress(k, "uniswapV2Factory", d.uniswapV2Factory);
        vm.serializeAddress(k, "uniswapV2Router02", d.uniswapV2Router02);
        vm.serializeBool(k, "uniswapDeployedFromPublishedBytecode", d.uniswapDeployed);
        vm.serializeBytes32(k, "uniswapV2PairInitCodeHash", d.pairInitCodeHash);
        vm.serializeBytes32(k, "ccipPoolInitCodeHash", d.ccipPoolInitCodeHash);
        vm.serializeAddress(k, "usdc", USDC);
        vm.serializeAddress(k, "tokenMessengerV2", n.tokenMessenger);
        vm.serializeUint(k, "cctpDomain", n.cctpDomain);
        vm.serializeAddress(k, "gatewayWallet", n.gatewayWallet);
        vm.serializeAddress(k, "gatewayMinter", n.gatewayMinter);
        vm.serializeAddress(k, "memo", n.memo);
        vm.serializeAddress(k, "ccipRouter", n.ccipRouter);
        vm.serializeUint(k, "ccipChainSelector", n.ccipChainSelector);
        vm.serializeAddress(k, "ccipTokenPoolFactory", n.ccipFactory);
        vm.serializeAddress(k, "ccipRegistryModuleOwnerCustom", n.ccipRegistryModule);
        vm.serializeAddress(k, "ccipTokenAdminRegistry", n.ccipTokenAdminRegistry);
        string memory json = vm.serializeUint(k, "deployBlock", d.deployBlock);

        bool dryRun = vm.isContext(VmSafe.ForgeContext.ScriptDryRun);
        string memory path = vm.envOr(
            "JUNO_DEPLOYMENT_OUT", string.concat(vm.projectRoot(), "/../deployments/arc-", n.name, ".json")
        );
        if (dryRun) path = string.concat(path, ".dry-run");
        vm.writeJson(json, path);
        console.log("Wrote", path);
    }

    function _log(Deployment memory d, Net memory n) internal pure {
        console.log("");
        console.log("Network              ", n.name);
        console.log("JunoLaunchpad        ", d.launchpad);
        console.log("UniswapV2Graduator   ", d.graduator);
        console.log("JunoCrossChain (CCIP)", d.crossChain);
        console.log("JunoSwapRouter       ", d.swapRouter);
        console.log("JunoTrackers         ", d.trackers);
        console.log("UniswapV2Factory     ", d.uniswapV2Factory);
        console.log("UniswapV2Router02    ", d.uniswapV2Router02);
        console.log("Owner                ", d.owner);
        if (d.owner != d.deployer) console.log("  pending: the owner must call acceptOwnership() on the launchpad and trackers");
    }

    function _envAddress(string memory name, address fallback_) internal view returns (address) {
        string memory raw = vm.envOr(name, string(""));
        return bytes(raw).length == 0 ? fallback_ : vm.parseAddress(raw);
    }

    function _envUint(string memory name, uint256 fallback_) internal view returns (uint256) {
        string memory raw = vm.envOr(name, string(""));
        return bytes(raw).length == 0 ? fallback_ : vm.parseUint(raw);
    }

    function _privateKey() internal view returns (uint256) {
        string memory raw = vm.envOr("DEPLOYER_PRIVATE_KEY", string(""));
        if (bytes(raw).length == 0) return 0;
        if (bytes(raw).length == 64) raw = string.concat("0x", raw);
        return vm.parseUint(raw);
    }

    function _requireCode(string memory what, address at) internal view {
        if (at.code.length == 0) revert NoCode(what, at);
    }
}
