// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {Pool} from "@chainlink/contracts-ccip/contracts/libraries/Pool.sol";

import {JunoBase} from "./JunoBase.t.sol";
import {JunoToken} from "../src/JunoToken.sol";
import {JunoCrossChain} from "../src/JunoCrossChain.sol";
import {
    CCIPTypes,
    ICCIPTokenPoolFactory,
    ICCIPRegistryModuleOwnerCustom,
    ICCIPTokenAdminRegistry,
    ICCIPTokenPool
} from "../src/interfaces/ICCIP.sol";
import {Artifacts} from "../script/lib/Artifacts.sol";

interface IPoolV1 {
    function lockOrBurn(Pool.LockOrBurnInV1 calldata lockOrBurnIn)
        external
        returns (Pool.LockOrBurnOutV1 memory);
    function releaseOrMint(Pool.ReleaseOrMintInV1 calldata releaseOrMintIn)
        external
        returns (Pool.ReleaseOrMintOutV1 memory);
}

interface ITokenAdminRegistryOwner {
    function addRegistryModule(address module) external;
}

interface IRemoteFactory {
    function deployTokenAndTokenPool(
        CCIPTypes.RemoteTokenPoolInfo[] calldata remoteTokenPools,
        uint8 localTokenDecimals,
        CCIPTypes.PoolType localPoolType,
        bytes memory tokenInitCode,
        bytes calldata tokenPoolInitCode,
        address lockBox,
        bytes32 salt,
        address futureOwner
    ) external returns (address, address);
}

/// @dev CrossChainToken 2.0's BaseERC20.ConstructorParams.
struct CCTParams {
    string name;
    string symbol;
    uint256 maxSupply;
    uint256 preMint;
    address preMintRecipient;
    uint8 decimals;
    address ccipAdmin;
}

interface IERC20Lite {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @dev RMN that never curses (the local stand-in for Arc's RMN proxy).
contract NoCurseRMN {
    function isCursed() external pure returns (bool) {
        return false;
    }

    function isCursed(bytes16) external pure returns (bool) {
        return false;
    }
}

/// A Juno post coin becomes a CCIP Cross-Chain Token and moves Arc → Base →
/// Arc, on Chainlink Local's router with Chainlink's *published* CCIP 2.0
/// bytecode for everything else: TokenAdminRegistry 1.5.0 and
/// RegistryModuleOwnerCustom 1.6.0 (the versions Arc runs), TokenPoolFactory
/// 2.0.0, BurnMintTokenPool 2.0.0 and, on the "Base" side, CrossChainToken
/// 2.0.0 deployed through that chain's own factory — the same calls
/// `scripts/ccip-remote.ts` makes on Base Sepolia.
///
/// The lane is driven the way CCIP drives it: the OnRamp hands the pool the
/// tokens and calls `lockOrBurn`; the OffRamp on the other side calls
/// `releaseOrMint` with the source pool's data. Chainlink Local's router
/// answers `getOnRamp`/`isOffRamp` for both.
contract JunoCrossChainTest is JunoBase {
    uint64 internal constant ARC = 3034092155422581607; // Arc testnet selector
    uint64 internal constant BASE = 10344971235874465080; // Base Sepolia selector
    address internal constant ON_RAMP = address(1234567890); // Chainlink Local's answer to getOnRamp
    address internal constant OFF_RAMP = address(0x0FF0);

    CCIPLocalSimulator internal sim;
    address internal router;
    address internal rmn;
    JunoCrossChain internal cc;
    bytes internal poolCode;

    // Arc's CCIP admin contracts (published bytecode)
    address internal registry;
    address internal module;
    address internal factory_;
    // "Base"'s
    address internal remoteRegistry;
    address internal remoteModule;
    address internal remoteFactory;

    function setUp() public override {
        super.setUp();
        sim = new CCIPLocalSimulator();
        (, router,,,,,) = _raw();
        rmn = address(new NoCurseRMN());
        poolCode = Artifacts.ccip("v2_0_0/burn_mint_token_pool");

        (registry, module, factory_) = _ccipStack();
        (remoteRegistry, remoteModule, remoteFactory) = _ccipStack();

        cc = new JunoCrossChain(
            address(launchpad),
            ICCIPTokenPoolFactory(factory_),
            ICCIPRegistryModuleOwnerCustom(module),
            ICCIPTokenAdminRegistry(registry),
            keccak256(poolCode)
        );
        vm.prank(owner);
        launchpad.setCrossChain(address(cc));
    }

    function _raw() internal view returns (uint64, address, address, address, address, address, address) {
        (bool ok, bytes memory data) = address(sim).staticcall(abi.encodeWithSignature("configuration()"));
        require(ok);
        return abi.decode(data, (uint64, address, address, address, address, address, address));
    }

    function _ccipStack() internal returns (address tar, address mod, address fac) {
        tar = Artifacts.create(Artifacts.ccip("v1_5_0/token_admin_registry"), "TokenAdminRegistry");
        mod = Artifacts.create(
            abi.encodePacked(Artifacts.ccip("v1_6_0/registry_module_owner_custom"), abi.encode(tar)),
            "RegistryModuleOwnerCustom"
        );
        ITokenAdminRegistryOwner(tar).addRegistryModule(mod);
        fac = Artifacts.create(
            abi.encodePacked(Artifacts.ccip("v2_0_0/token_pool_factory"), abi.encode(tar, mod, rmn, router)),
            "TokenPoolFactory"
        );
    }

    function _graduatedCoin() internal returns (address token) {
        token = launchUsdc();
        buy(alice, token, launchpad.getPool(token).migrationQuoteThreshold * 2);
        launchpad.graduate(token);
    }

    function _limit(uint128 capacity) internal pure returns (CCIPTypes.RateLimiterConfig memory) {
        return CCIPTypes.RateLimiterConfig({isEnabled: true, capacity: capacity, rate: capacity / 3600});
    }

    /// The remote side: CrossChainToken + BurnMintTokenPool through "Base"'s own
    /// factory, pointed at the Arc coin and pool. Returns the remote token and pool.
    function _deployRemote(address arcToken, address arcPool) internal returns (address token, address pool) {
        CCIPTypes.RemoteTokenPoolInfo[] memory remotes = new CCIPTypes.RemoteTokenPoolInfo[](1);
        remotes[0].remoteChainSelector = ARC;
        remotes[0].remotePoolAddress = abi.encode(arcPool);
        remotes[0].remoteTokenAddress = abi.encode(arcToken);
        remotes[0].poolType = CCIPTypes.PoolType.BURN_MINT;
        remotes[0].remoteChainConfig.remoteTokenDecimals = 18;
        remotes[0].rateLimiterConfig = _limit(50_000_000 ether);
        // CrossChainToken 2.0: (name, symbol, maxSupply, preMint, preMintRecipient, decimals, ccipAdmin), burnMintRoleAdmin, owner
        bytes memory tokenInit = abi.encodePacked(
            Artifacts.ccip("v2_0_0/cross_chain_token"),
            abi.encode(
                CCTParams({
                    name: JunoToken(arcToken).name(),
                    symbol: JunoToken(arcToken).symbol(),
                    maxSupply: 0,
                    preMint: 0,
                    preMintRecipient: address(0),
                    decimals: 18,
                    ccipAdmin: remoteFactory
                }),
                remoteFactory,
                creator
            )
        );
        vm.prank(creator);
        (token, pool) = IRemoteFactory(remoteFactory).deployTokenAndTokenPool(
            remotes, 18, CCIPTypes.PoolType.BURN_MINT, tokenInit, poolCode, address(0), bytes32("juno"), creator
        );
        vm.prank(creator);
        ICCIPTokenPool(pool).acceptOwnership();
    }

    function _enable(address token) internal returns (address pool) {
        CCIPTypes.RemoteTokenPoolInfo[] memory none = new CCIPTypes.RemoteTokenPoolInfo[](0);
        vm.prank(creator);
        pool = cc.enable(token, poolCode, none);
    }

    function _wire(address token, address remoteToken, address remotePool) internal {
        CCIPTypes.ChainUpdate[] memory add = new CCIPTypes.ChainUpdate[](1);
        add[0].remoteChainSelector = BASE;
        add[0].remotePoolAddresses = new bytes[](1);
        add[0].remotePoolAddresses[0] = abi.encode(remotePool);
        add[0].remoteTokenAddress = abi.encode(remoteToken);
        add[0].outboundRateLimiterConfig = _limit(50_000_000 ether);
        add[0].inboundRateLimiterConfig = _limit(50_000_000 ether);
        vm.prank(creator);
        cc.applyChainUpdates(token, new uint64[](0), add);
    }

    /// Source side of a lane: the OnRamp moves the tokens into the pool and calls lockOrBurn.
    function _send(address pool, address token, address from, address to, uint64 dest, uint256 amount)
        internal
        returns (bytes memory destPoolData)
    {
        vm.prank(from);
        IERC20Lite(token).transfer(pool, amount);
        vm.prank(ON_RAMP);
        Pool.LockOrBurnOutV1 memory out = IPoolV1(pool).lockOrBurn(
            Pool.LockOrBurnInV1({
                receiver: abi.encode(to), remoteChainSelector: dest, originalSender: from, amount: amount, localToken: token
            })
        );
        return out.destPoolData;
    }

    /// Destination side: the OffRamp calls releaseOrMint with the source pool's address and data.
    function _receive(address pool, address token, address from, address to, uint64 source, address sourcePool, uint256 amount, bytes memory data)
        internal
        returns (uint256)
    {
        vm.prank(OFF_RAMP);
        return IPoolV1(pool).releaseOrMint(
            Pool.ReleaseOrMintInV1({
                originalSender: abi.encode(from),
                remoteChainSelector: source,
                receiver: to,
                sourceDenominatedAmount: amount,
                localToken: token,
                sourcePoolAddress: abi.encode(sourcePool),
                sourcePoolData: data,
                offchainTokenData: ""
            })
        ).destinationAmount;
    }

    /* -------------------------------------------------------------- */

    function test_enable_registersTheCoinWithCCIPInOneCall() public {
        address token = _graduatedCoin();
        assertEq(JunoToken(token).getCCIPAdmin(), address(cc), "launched with JunoCrossChain as CCIP admin");

        address pool = _enable(token);

        assertEq(ICCIPTokenPool(pool).typeAndVersion(), "BurnMintTokenPool 2.0.0");
        assertEq(ICCIPTokenPool(pool).getToken(), token);
        assertEq(ICCIPTokenPool(pool).owner(), address(cc));
        assertEq(JunoToken(token).ccipPool(), pool);
        assertEq(ICCIPTokenAdminRegistry(registry).getPool(token), pool, "pool set in the TokenAdminRegistry");
        ICCIPTokenAdminRegistry.TokenConfig memory c = ICCIPTokenAdminRegistry(registry).getTokenConfig(token);
        assertEq(c.administrator, address(cc));
        assertEq(cc.poolOf(token), pool);
    }

    function test_lane_arcToBaseAndBack() public {
        address token = _graduatedCoin();
        address arcPool = _enable(token);
        (address baseToken, address basePool) = _deployRemote(token, arcPool);
        _wire(token, baseToken, basePool);

        uint256 arcSupply = JunoToken(token).totalSupply();
        uint256 amount = 1_000_000 ether;

        // Arc → Base: burned on Arc, minted on Base.
        bytes memory data = _send(arcPool, token, alice, bob, BASE, amount);
        assertEq(JunoToken(token).totalSupply(), arcSupply - amount, "burned on Arc");
        assertEq(JunoToken(token).bridgedOut(), amount);
        uint256 minted = _receive(basePool, baseToken, alice, bob, ARC, arcPool, amount, data);
        assertEq(minted, amount);
        assertEq(IERC20Lite(baseToken).balanceOf(bob), amount, "bob holds the coin on Base");

        // Base → Arc: burned on Base, re-minted on Arc within what left.
        data = _send(basePool, baseToken, bob, carol(), ARC, 400_000 ether);
        assertEq(IERC20Lite(baseToken).totalSupply(), 600_000 ether);
        _receive(arcPool, token, bob, carol(), BASE, basePool, 400_000 ether, data);
        assertEq(JunoToken(token).balanceOf(carol()), 400_000 ether);
        assertEq(JunoToken(token).bridgedOut(), 600_000 ether);
        assertEq(
            JunoToken(token).totalSupply() + IERC20Lite(baseToken).totalSupply(), arcSupply, "supply conserved across chains"
        );
    }

    /// A message claiming to come from a pool that isn't wired is refused by the pool.
    function test_lane_refusesUnknownSourcePool() public {
        address token = _graduatedCoin();
        address arcPool = _enable(token);
        (address baseToken, address basePool) = _deployRemote(token, arcPool);
        _wire(token, baseToken, basePool);
        _send(arcPool, token, alice, bob, BASE, 10 ether);
        vm.prank(OFF_RAMP);
        vm.expectRevert();
        IPoolV1(arcPool).releaseOrMint(
            Pool.ReleaseOrMintInV1({
                originalSender: abi.encode(bob),
                remoteChainSelector: BASE,
                receiver: bob,
                sourceDenominatedAmount: 10 ether,
                localToken: token,
                sourcePoolAddress: abi.encode(address(0xBAD)),
                sourcePoolData: abi.encode(uint256(18)),
                offchainTokenData: ""
            })
        );
    }

    /// Rate limits are always on: more than a bucket holds is refused on the way out.
    function test_lane_rateLimited() public {
        address token = _graduatedCoin();
        address arcPool = _enable(token);
        (address baseToken, address basePool) = _deployRemote(token, arcPool);
        _wire(token, baseToken, basePool);
        uint256 tooMuch = 50_000_000 ether + 1;
        deal(token, alice, tooMuch);
        vm.prank(alice);
        IERC20Lite(token).transfer(arcPool, tooMuch);
        vm.prank(ON_RAMP);
        vm.expectRevert();
        IPoolV1(arcPool).lockOrBurn(
            Pool.LockOrBurnInV1({
                receiver: abi.encode(bob), remoteChainSelector: BASE, originalSender: alice, amount: tooMuch, localToken: token
            })
        );
    }

    function test_enable_guards() public {
        address token = launchUsdc();
        CCIPTypes.RemoteTokenPoolInfo[] memory none = new CCIPTypes.RemoteTokenPoolInfo[](0);

        vm.prank(creator);
        vm.expectRevert(JunoCrossChain.NotGraduated.selector);
        cc.enable(token, poolCode, none);

        buy(alice, token, launchpad.getPool(token).migrationQuoteThreshold * 2);
        launchpad.graduate(token);

        vm.prank(alice);
        vm.expectRevert(JunoCrossChain.NotCreator.selector);
        cc.enable(token, poolCode, none);

        bytes memory other = Artifacts.ccip("v2_0_0/burn_from_mint_token_pool");
        vm.prank(creator);
        vm.expectRevert(JunoCrossChain.WrongPoolCode.selector);
        cc.enable(token, other, none);

        CCIPTypes.RemoteTokenPoolInfo[] memory loose = new CCIPTypes.RemoteTokenPoolInfo[](1);
        loose[0].remoteChainSelector = BASE;
        loose[0].remotePoolAddress = abi.encode(address(0x1));
        loose[0].remoteTokenAddress = abi.encode(address(0x2));
        loose[0].rateLimiterConfig = CCIPTypes.RateLimiterConfig(false, 0, 0);
        vm.prank(creator);
        vm.expectRevert(JunoCrossChain.BadRateLimit.selector);
        cc.enable(token, poolCode, loose);
        loose[0].rateLimiterConfig = _limit(cc.MAX_CAPACITY() + 1);
        vm.prank(creator);
        vm.expectRevert(JunoCrossChain.BadRateLimit.selector);
        cc.enable(token, poolCode, loose);

        _enable(token);
        vm.prank(creator);
        vm.expectRevert(JunoCrossChain.AlreadyEnabled.selector);
        cc.enable(token, poolCode, none);
    }

    function test_onlyJunoTokens() public {
        CCIPTypes.RemoteTokenPoolInfo[] memory none = new CCIPTypes.RemoteTokenPoolInfo[](0);
        vm.expectRevert(JunoCrossChain.NotJunoToken.selector);
        cc.enable(address(usdc), poolCode, none);
    }

    function test_handOver_givesTheCreatorEverything() public {
        address token = _graduatedCoin();
        address pool = _enable(token);
        vm.prank(creator);
        cc.handOver(token, creator);

        vm.startPrank(creator);
        ICCIPTokenPool(pool).acceptOwnership();
        ICCIPTokenAdminRegistry(registry).acceptAdminRole(token);
        JunoToken(token).acceptCCIPAdmin();
        vm.stopPrank();

        assertEq(ICCIPTokenPool(pool).owner(), creator);
        assertEq(ICCIPTokenAdminRegistry(registry).getTokenConfig(token).administrator, creator);
        assertEq(JunoToken(token).getCCIPAdmin(), creator);

        CCIPTypes.ChainUpdate[] memory add = new CCIPTypes.ChainUpdate[](0);
        vm.prank(creator);
        vm.expectRevert(JunoCrossChain.IsHandedOver.selector);
        cc.applyChainUpdates(token, new uint64[](0), add);
    }

    function test_status() public {
        address token = _graduatedCoin();
        address arcPool = _enable(token);
        (address baseToken, address basePool) = _deployRemote(token, arcPool);
        _wire(token, baseToken, basePool);
        _send(arcPool, token, alice, bob, BASE, 5 ether);
        (address pool, bool enabled, bool handed, uint64[] memory chains, uint256 out) = cc.status(token);
        assertEq(pool, arcPool);
        assertTrue(enabled);
        assertFalse(handed);
        assertEq(chains.length, 1);
        assertEq(chains[0], BASE);
        assertEq(out, 5 ether);
    }

    function carol() internal pure returns (address) {
        return address(0xCA201);
    }
}
