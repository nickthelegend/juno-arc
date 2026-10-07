// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {JunoToken} from "./JunoToken.sol";
import {
    CCIPTypes,
    ICCIPTokenPoolFactory,
    ICCIPRegistryModuleOwnerCustom,
    ICCIPTokenAdminRegistry,
    ICCIPTokenPool
} from "./interfaces/ICCIP.sol";

/// @title JunoCrossChain
/// @notice Turns a graduated Juno post coin into a Chainlink CCIP Cross-Chain
/// Token in one call by its creator, using Arc's own CCIP infrastructure:
///
///   1. Chainlink's TokenPoolFactory (2.0.0 on Arc) deploys a BurnMintTokenPool
///      for the coin from Chainlink's *published* pool bytecode — this contract
///      only accepts init code whose hash matches it, so the pool is always
///      Chainlink's audited code, never something a creator wrote;
///   2. the pool is named on the token (`JunoToken.setCCIPPool`), which lets it
///      burn what leaves Arc and re-mint only what came back;
///   3. RegistryModuleOwnerCustom registers this contract as the token's admin
///      in the TokenAdminRegistry (it is the token's `getCCIPAdmin()`), and the
///      pool is set there, so CCIP's OnRamp/OffRamp route the coin through it;
///   4. remote chains (Base, Ethereum, …) are wired with rate limits that are
///      always on and capped at 10% of supply per bucket.
///
/// The creator stays in charge: only they can enable, add chains or change
/// limits for their coin, and `handOver` passes the pool, the registry admin
/// role and the token's CCIP admin to them outright, after which this contract
/// has no say at all. It has no owner and holds no funds.
contract JunoCrossChain {
    /// @notice Juno tokens have 18 decimals on Arc and on every remote chain.
    uint8 public constant TOKEN_DECIMALS = 18;
    /// @notice A rate-limit bucket can hold at most 10% of the one-billion supply.
    uint128 public constant MAX_CAPACITY = 100_000_000 ether;

    address public immutable launchpad;
    ICCIPTokenPoolFactory public immutable factory;
    ICCIPRegistryModuleOwnerCustom public immutable registryModule;
    ICCIPTokenAdminRegistry public immutable tokenAdminRegistry;
    /// @notice keccak256 of Chainlink's published BurnMintTokenPool 2.0.0
    /// creation code (npm chainlink contracts-ccip 2.0.0, bytecode/v2_0_0/burn_mint_token_pool.bin).
    bytes32 public immutable poolInitCodeHash;

    mapping(address token => address pool) public poolOf;
    /// @notice Set when the creator has taken over the pool and the registry role.
    mapping(address token => bool) public handedOver;

    event CrossChainEnabled(address indexed token, address indexed pool, address indexed creator, uint256 remoteChains);
    event ChainsUpdated(address indexed token, uint64[] removed, uint64[] added);
    event RateLimitsUpdated(address indexed token, uint256 count);
    event HandedOver(address indexed token, address indexed to);

    error NotJunoToken();
    error NotCreator();
    error NotGraduated();
    error AlreadyEnabled();
    error NotEnabled();
    error IsHandedOver();
    error WrongPoolCode();
    error NotCCIPAdmin();
    error BadRateLimit();
    error BadRemote();

    constructor(
        address launchpad_,
        ICCIPTokenPoolFactory factory_,
        ICCIPRegistryModuleOwnerCustom registryModule_,
        ICCIPTokenAdminRegistry tokenAdminRegistry_,
        bytes32 poolInitCodeHash_
    ) {
        launchpad = launchpad_;
        factory = factory_;
        registryModule = registryModule_;
        tokenAdminRegistry = tokenAdminRegistry_;
        poolInitCodeHash = poolInitCodeHash_;
    }

    modifier onlyCreator(address token) {
        _checkCreator(token);
        _;
    }

    /// @notice Make a graduated coin cross-chain. One transaction from the creator.
    /// @param poolInitCode Chainlink's BurnMintTokenPool 2.0.0 creation code (checked by hash).
    /// @param remotes Chains to wire now (may be empty; add them later with `applyChainUpdates`).
    /// Every entry must name the remote pool and token addresses explicitly.
    function enable(address token, bytes calldata poolInitCode, CCIPTypes.RemoteTokenPoolInfo[] calldata remotes)
        external
        onlyCreator(token)
        returns (address pool)
    {
        if (!JunoToken(token).graduated()) revert NotGraduated();
        if (poolOf[token] != address(0)) revert AlreadyEnabled();
        if (keccak256(poolInitCode) != poolInitCodeHash) revert WrongPoolCode();
        if (JunoToken(token).getCCIPAdmin() != address(this)) revert NotCCIPAdmin();
        for (uint256 i; i < remotes.length; ++i) {
            if (remotes[i].remotePoolAddress.length == 0 || remotes[i].remoteTokenAddress.length == 0) {
                revert BadRemote();
            }
            _checkLimit(remotes[i].rateLimiterConfig);
        }

        pool = factory.deployTokenPoolWithExistingToken(
            token,
            TOKEN_DECIMALS,
            CCIPTypes.PoolType.BURN_MINT,
            remotes,
            poolInitCode,
            address(0),
            bytes32(uint256(uint160(token))),
            address(this)
        );
        poolOf[token] = pool;
        ICCIPTokenPool(pool).acceptOwnership();

        JunoToken(token).setCCIPPool(pool);
        registryModule.registerAdminViaGetCCIPAdmin(token);
        tokenAdminRegistry.acceptAdminRole(token);
        tokenAdminRegistry.setPool(token, pool);

        emit CrossChainEnabled(token, pool, msg.sender, remotes.length);
    }

    /// @notice Add or remove remote chains for the coin's pool.
    function applyChainUpdates(address token, uint64[] calldata remove, CCIPTypes.ChainUpdate[] calldata add)
        external
        onlyCreator(token)
    {
        ICCIPTokenPool pool = _managedPool(token);
        uint64[] memory added = new uint64[](add.length);
        for (uint256 i; i < add.length; ++i) {
            if (add[i].remotePoolAddresses.length == 0 || add[i].remoteTokenAddress.length == 0) revert BadRemote();
            _checkLimit(add[i].outboundRateLimiterConfig);
            _checkLimit(add[i].inboundRateLimiterConfig);
            added[i] = add[i].remoteChainSelector;
        }
        pool.applyChainUpdates(remove, add);
        emit ChainsUpdated(token, remove, added);
    }

    /// @notice Change the rate limits on wired chains (still always on, still capped).
    function setRateLimits(address token, ICCIPTokenPool.RateLimitConfigArgs[] calldata args)
        external
        onlyCreator(token)
    {
        ICCIPTokenPool pool = _managedPool(token);
        for (uint256 i; i < args.length; ++i) {
            _checkLimit(args[i].outboundRateLimiterConfig);
            _checkLimit(args[i].inboundRateLimiterConfig);
        }
        pool.setRateLimitConfig(args);
        emit RateLimitsUpdated(token, args.length);
    }

    /// @notice Give the creator (or whoever they name) full control: the pool's
    /// ownership, the TokenAdminRegistry admin role and the token's CCIP admin.
    /// Each is a two-step transfer the recipient completes on the respective
    /// contract (`acceptOwnership`, `acceptAdminRole`, `acceptCCIPAdmin`).
    function handOver(address token, address to) external onlyCreator(token) {
        ICCIPTokenPool pool = _managedPool(token);
        handedOver[token] = true;
        pool.transferOwnership(to);
        tokenAdminRegistry.transferAdminRole(token, to);
        JunoToken(token).transferCCIPAdmin(to);
        emit HandedOver(token, to);
    }

    /// @notice Everything the app shows about a coin's cross-chain status.
    function status(address token)
        external
        view
        returns (address pool, bool enabled, bool isHandedOver, uint64[] memory chains, uint256 bridgedOut)
    {
        pool = poolOf[token];
        enabled = pool != address(0);
        isHandedOver = handedOver[token];
        if (enabled) chains = ICCIPTokenPool(pool).getSupportedChains();
        bridgedOut = JunoToken(token).bridgedOut();
    }

    function _managedPool(address token) internal view returns (ICCIPTokenPool) {
        address pool = poolOf[token];
        if (pool == address(0)) revert NotEnabled();
        if (handedOver[token]) revert IsHandedOver();
        return ICCIPTokenPool(pool);
    }

    function _checkCreator(address token) internal view {
        if (token.code.length == 0) revert NotJunoToken();
        // A token from somewhere else could claim any creator; only the launchpad's are served.
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("launchpad()"));
        if (!ok || data.length != 32 || abi.decode(data, (address)) != launchpad) revert NotJunoToken();
        if (msg.sender != JunoToken(token).creator()) revert NotCreator();
    }

    function _checkLimit(CCIPTypes.RateLimiterConfig calldata c) internal pure {
        if (!c.isEnabled || c.capacity == 0 || c.capacity > MAX_CAPACITY || c.rate == 0 || c.rate >= c.capacity) {
            revert BadRateLimit();
        }
    }
}
