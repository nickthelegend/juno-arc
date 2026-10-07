// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

import {JunoLaunchpad} from "../../src/JunoLaunchpad.sol";
import {JunoToken} from "../../src/JunoToken.sol";
import {JunoSwapRouter} from "../../src/JunoSwapRouter.sol";
import {JunoCrossChain} from "../../src/JunoCrossChain.sol";
import {UniswapV2Graduator} from "../../src/graduators/UniswapV2Graduator.sol";
import {IUniswapV2Factory} from "../../src/interfaces/IUniswapV2.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ICircle.sol";
import {
    CCIPTypes,
    ICCIPTokenPoolFactory,
    ICCIPRegistryModuleOwnerCustom,
    ICCIPTokenAdminRegistry,
    ICCIPTokenPool
} from "../../src/interfaces/ICCIP.sol";
import {Artifacts} from "../../script/lib/Artifacts.sol";
import {PresetFixtures} from "../fixtures/PresetFixtures.sol";

interface IUSDC {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function name() external view returns (string memory);
    function version() external view returns (string memory);
}

interface IMemo {
    event Memo(
        address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex
    );

    function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external;
}

interface IGatewayWallet {
    function deposit(address token, uint256 value) external;
    function availableBalance(address token, address depositor) external view returns (uint256);
}

/// Juno end to end on a fork of **Arc testnet**, against Circle's and
/// Chainlink's live contracts — nothing mocked, nothing broadcast:
///
///  - Circle USDC (0x3600…, EIP-712 "USDC"/"2"): launch, a relayed EIP-3009 buy,
///    fill, graduate into Uniswap's published v2 factory, trade the pair;
///  - Arc Memo (0x5294…e505): a buy tagged with the post id through Memo, the
///    launchpad still seeing the buyer (CallFrom);
///  - Circle CCTP V2 (TokenMessengerV2 0x8FE6…2DAA): the creator's fees burned
///    on Arc for Base Sepolia;
///  - Circle Gateway (GatewayWallet 0x0077…19B9): a buyer's USDC parked in
///    their unified balance;
///  - Chainlink CCIP 2.0 (TokenPoolFactory 0xdC6b…2dB5, RegistryModuleOwnerCustom,
///    TokenAdminRegistry, Router 0xdE4E…eab8 / OnRamp 2.0.0): the graduated coin
///    enabled as a Cross-Chain Token in one call, then a real `ccipSend` of it to
///    Base Sepolia, fee paid in native USDC, burned by its pool on Arc.
///
///   FORK_TESTS=1 forge test --network arc --match-path test/fork/ArcTestnetFork.t.sol -vv
///
/// `--network arc` is Circle's Arc Foundry: it executes Arc's native-USDC and
/// CallFrom precompiles, which plain forge cannot.
contract ArcTestnetForkTest is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address internal constant MEMO = 0x5294E9927c3306DcBaDb03fe70b92e01cCede505;
    address internal constant GATEWAY_WALLET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    address internal constant CCIP_ROUTER = 0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8;
    address internal constant CCIP_FACTORY = 0xdC6b0980d1B3661adf889b85554555C4AFFf2dB5;
    address internal constant CCIP_MODULE = 0x524B83ae8208490151339c626fd0E35b964483e3;
    address internal constant CCIP_REGISTRY = 0xd3e461C55676B10634a5F81b747c324B85686Dd1;
    uint64 internal constant BASE_SEPOLIA = 10344971235874465080;
    uint32 internal constant BASE_CCTP_DOMAIN = 6;

    JunoLaunchpad internal launchpad;
    UniswapV2Graduator internal graduator;
    JunoSwapRouter internal router;
    JunoCrossChain internal cc;
    IUniswapV2Factory internal v2;
    bytes internal poolCode;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    uint256 internal buyerKey = 0xA11CE;
    address internal buyer = vm.addr(0xA11CE);
    address internal relayer = makeAddr("relayer");
    address internal whale = makeAddr("whale");

    function setUp() public {
        if (vm.envOr("FORK_TESTS", uint256(0)) != 1) vm.skip(true);
        vm.createSelectFork(vm.envOr("ARC_TESTNET_RPC", string("https://rpc.testnet.arc.io")));
        assertEq(block.chainid, 5042002);

        v2 = IUniswapV2Factory(
            Artifacts.create(abi.encodePacked(Artifacts.uniswap(Artifacts.V2_FACTORY), abi.encode(owner)), "v2")
        );
        poolCode = Artifacts.ccip("v2_0_0/burn_mint_token_pool");
        vm.startPrank(owner);
        launchpad = new JunoLaunchpad(owner, 2_000, USDC, ITokenMessengerV2(TOKEN_MESSENGER), 100_000e6);
        graduator = new UniswapV2Graduator(address(launchpad), v2, Artifacts.v2PairInitCodeHash());
        launchpad.setGraduator(graduator);
        cc = new JunoCrossChain(
            address(launchpad),
            ICCIPTokenPoolFactory(CCIP_FACTORY),
            ICCIPRegistryModuleOwnerCustom(CCIP_MODULE),
            ICCIPTokenAdminRegistry(CCIP_REGISTRY),
            keccak256(poolCode)
        );
        launchpad.setCrossChain(address(cc));
        vm.stopPrank();
        router = new JunoSwapRouter(v2);

        // Native USDC (18 decimals) is the same balance the ERC-20 at 0x3600… reports with 6.
        vm.deal(creator, 100 ether);
        vm.deal(whale, 20_000 ether);
        vm.deal(relayer, 5 ether);
    }

    function _launch() internal returns (address token) {
        PresetFixtures.Fixture memory f = PresetFixtures.get(0); // content preset, $1k → $25k FDV
        JunoLaunchpad.LaunchParams memory lp = f.params;
        lp.quote = USDC;
        lp.name = "Sunset over Dubai Marina";
        lp.symbol = "MARINA";
        lp.uri = "ipfs://bafkreigh2akiscaildcmarina";
        vm.prank(creator);
        token = launchpad.launch(lp, 0, 0);
    }

    function _fillAndGraduate(address token) internal {
        uint256 size = launchpad.getPool(token).migrationQuoteThreshold * 2;
        vm.startPrank(whale);
        IUSDC(USDC).approve(address(launchpad), size);
        launchpad.buy(token, size, 0, whale, block.timestamp);
        vm.stopPrank();
        launchpad.graduate(token);
    }

    function test_usdcIsCirclesWithItsEip712Domain() public view {
        assertEq(IUSDC(USDC).name(), "USDC");
        assertEq(IUSDC(USDC).version(), "2");
        assertEq(IUSDC(USDC).balanceOf(whale), 20_000e6, "native 18-dec balance seen as 6-dec ERC-20");
    }

    /// A buyer whose USDC just landed (Gateway mint, CCTP, a transfer) and who holds
    /// nothing else signs once; the relayer submits and pays the USDC gas.
    function test_relayedBuy_onArcUsdc() public {
        address token = _launch();
        vm.prank(whale);
        IUSDC(USDC).transfer(buyer, 25e6);
        uint256 deadline = block.timestamp + 120;
        (uint256 quoted,,,) = launchpad.quoteBuy(token, 25e6);
        bytes32 nonce = launchpad.buyNonce(token, buyer, 25e6, quoted, deadline, "post:marina");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IUSDC(USDC).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        IUSDC(USDC).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), buyer, address(launchpad), 25e6, 0, deadline, nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);
        vm.prank(relayer, relayer);
        (uint256 out,) =
            launchpad.buyWithAuthorization(token, buyer, 25e6, quoted, deadline, "post:marina", 0, deadline, v, r, s);
        assertEq(out, quoted);
        assertEq(JunoToken(token).balanceOf(buyer), quoted);
        assertEq(IUSDC(USDC).balanceOf(buyer), 0);
    }

    /// A buy sent through Arc's Memo, tagged with the post: the launchpad sees
    /// the buyer (CallFrom) and the Memo event carries the post id.
    function test_memoTaggedBuy() public {
        address token = _launch();
        vm.prank(whale);
        IUSDC(USDC).transfer(buyer, 10e6);
        vm.prank(buyer, buyer);
        IUSDC(USDC).approve(address(launchpad), 10e6);
        bytes32 tag = keccak256(abi.encodePacked("juno:post:", token));
        vm.recordLogs();
        vm.prank(buyer, buyer); // Memo needs an EOA transaction
        IMemo(MEMO).memo(
            address(launchpad),
            abi.encodeCall(JunoLaunchpad.buy, (token, 10e6, 0, buyer, block.timestamp)),
            tag,
            bytes("juno buy MARINA $10")
        );
        assertGt(JunoToken(token).balanceOf(buyer), 0, "the buyer got the coin");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == MEMO && logs[i].topics[0] == IMemo.Memo.selector && logs[i].topics[3] == tag) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), buyer);
                seen = true;
            }
        }
        assertTrue(seen, "Memo event tagged with the post");
    }

    function test_graduatesIntoPublishedUniswapV2_andTrades() public {
        address token = _launch();
        _fillAndGraduate(token);
        JunoLaunchpad.Pool memory p = launchpad.getPool(token);
        assertTrue(p.graduated);
        assertEq(v2.getPair(token, USDC), p.venue);
        vm.deal(buyer, 10 ether);
        vm.startPrank(buyer);
        IUSDC(USDC).approve(address(router), 10e6);
        uint256 out = router.swapExactTokens(USDC, token, 10e6, 1, buyer, block.timestamp);
        vm.stopPrank();
        assertGt(out, 0);
    }

    /// Creator fees out through Circle's real CCTP V2 TokenMessengerV2 on Arc.
    function test_creatorFeesToBaseThroughCctp() public {
        address token = _launch();
        vm.startPrank(whale);
        IUSDC(USDC).approve(address(launchpad), 1_000e6);
        launchpad.buy(token, 1_000e6, 0, whale, block.timestamp);
        vm.stopPrank();
        uint256 fees = launchpad.getPool(token).creatorFees;
        uint256 held = IUSDC(USDC).balanceOf(address(launchpad));

        vm.prank(creator);
        uint256 sent = launchpad.claimCreatorFeesCrossChain(
            token, BASE_CCTP_DOMAIN, bytes32(uint256(uint160(creator))), 0, 2000
        );
        assertEq(sent, fees);
        assertEq(IUSDC(USDC).balanceOf(address(launchpad)), held - fees, "burned on Arc by CCTP");
    }

    /// A buyer parks USDC in Circle Gateway's unified balance from Arc.
    function test_gatewayDeposit() public {
        vm.deal(buyer, 50 ether);
        vm.startPrank(buyer, buyer);
        IUSDC(USDC).approve(GATEWAY_WALLET, 20e6);
        IGatewayWallet(GATEWAY_WALLET).deposit(USDC, 20e6);
        vm.stopPrank();
        assertEq(IGatewayWallet(GATEWAY_WALLET).availableBalance(USDC, buyer), 20e6);
    }

    /// The headline: a graduated post coin becomes a CCIP Cross-Chain Token
    /// through Arc's own CCIP admin contracts, and a holder sends it to Base
    /// Sepolia through Chainlink's real router, paying the fee in USDC.
    function test_cct_enableOnArcAndSendToBaseSepolia() public {
        address token = _launch();
        _fillAndGraduate(token);

        CCIPTypes.RemoteTokenPoolInfo[] memory remotes = new CCIPTypes.RemoteTokenPoolInfo[](1);
        remotes[0].remoteChainSelector = BASE_SEPOLIA;
        // The Base Sepolia side (scripts/ccip-remote.ts deploys it); any address stands in here.
        remotes[0].remotePoolAddress = abi.encode(address(0xBA5E9001));
        remotes[0].remoteTokenAddress = abi.encode(address(0xBA5E7070));
        remotes[0].poolType = CCIPTypes.PoolType.BURN_MINT;
        remotes[0].remoteChainConfig.remoteTokenDecimals = 18;
        remotes[0].rateLimiterConfig = CCIPTypes.RateLimiterConfig(true, 50_000_000 ether, 13_000 ether);

        vm.prank(creator);
        address pool = cc.enable(token, poolCode, remotes);
        assertEq(ICCIPTokenAdminRegistry(CCIP_REGISTRY).getPool(token), pool, "registered in Arc's TokenAdminRegistry");
        assertEq(ICCIPTokenPool(pool).typeAndVersion(), "BurnMintTokenPool 2.0.0");
        assertTrue(ICCIPTokenPool(pool).isSupportedChain(BASE_SEPOLIA));

        uint256 amount = 1_000_000 ether;
        uint256 supply = JunoToken(token).totalSupply();
        Client.EVMTokenAmount[] memory tokens = new Client.EVMTokenAmount[](1);
        tokens[0] = Client.EVMTokenAmount({token: token, amount: amount});
        Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
            receiver: abi.encode(whale),
            data: "",
            tokenAmounts: tokens,
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: 0, allowOutOfOrderExecution: true})),
            feeToken: address(0)
        });
        uint256 fee = IRouterClient(CCIP_ROUTER).getFee(BASE_SEPOLIA, m);
        assertGt(fee, 0);
        assertLt(fee, 5 ether, "under $5 of native USDC");

        vm.startPrank(whale, whale);
        JunoToken(token).approve(CCIP_ROUTER, amount);
        bytes32 id = IRouterClient(CCIP_ROUTER).ccipSend{value: fee}(BASE_SEPOLIA, m);
        vm.stopPrank();
        assertTrue(id != bytes32(0));
        assertEq(JunoToken(token).totalSupply(), supply - amount, "burned on Arc by the pool");
        assertEq(JunoToken(token).bridgedOut(), amount);
        emit log_named_bytes32("CCIP message id", id);
        emit log_named_uint("fee (native USDC wei)", fee);
    }
}
