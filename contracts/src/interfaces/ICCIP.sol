// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev ABI-compatible slices of Chainlink CCIP 2.0 — the versions Arc runs
/// (TokenPoolFactory 2.0.0, RegistryModuleOwnerCustom 1.6.0, TokenAdminRegistry
/// 1.5.0, OnRamp 2.0.0, read with `typeAndVersion()` on 2026-10-07). Declared
/// here rather than imported so Juno's build doesn't compile the whole CCIP tree;
/// the tests run them against Chainlink's published bytecode.
library CCIPTypes {
    struct RateLimiterConfig {
        bool isEnabled;
        uint128 capacity;
        uint128 rate;
    }

    /// @dev TokenPool.ChainUpdate
    struct ChainUpdate {
        uint64 remoteChainSelector;
        bytes[] remotePoolAddresses;
        bytes remoteTokenAddress;
        RateLimiterConfig outboundRateLimiterConfig;
        RateLimiterConfig inboundRateLimiterConfig;
    }

    /// @dev TokenPoolFactory.PoolType
    enum PoolType {
        BURN_MINT,
        LOCK_RELEASE
    }

    /// @dev TokenPoolFactory.RemoteChainConfig
    struct RemoteChainConfig {
        address remotePoolFactory;
        address remoteRouter;
        address remoteRMNProxy;
        address remoteLockBox;
        uint8 remoteTokenDecimals;
    }

    /// @dev TokenPoolFactory.RemoteTokenPoolInfo
    struct RemoteTokenPoolInfo {
        uint64 remoteChainSelector;
        bytes remotePoolAddress;
        bytes remotePoolInitCode;
        RemoteChainConfig remoteChainConfig;
        PoolType poolType;
        bytes remoteTokenAddress;
        bytes remoteTokenInitCode;
        RateLimiterConfig rateLimiterConfig;
    }
}

interface ICCIPTokenPoolFactory {
    function typeAndVersion() external view returns (string memory);

    function getStaticConfig()
        external
        view
        returns (address rmnProxy, address tokenAdminRegistry, address registryModuleOwnerCustom, address ccipRouter);

    function deployTokenPoolWithExistingToken(
        address token,
        uint8 localTokenDecimals,
        CCIPTypes.PoolType localPoolType,
        CCIPTypes.RemoteTokenPoolInfo[] calldata remoteTokenPools,
        bytes calldata tokenPoolInitCode,
        address lockBox,
        bytes32 salt,
        address futureOwner
    ) external returns (address poolAddress);
}

interface ICCIPRegistryModuleOwnerCustom {
    function registerAdminViaGetCCIPAdmin(address token) external;
}

interface ICCIPTokenAdminRegistry {
    struct TokenConfig {
        address administrator;
        address pendingAdministrator;
        address tokenPool;
    }

    function acceptAdminRole(address localToken) external;
    function setPool(address localToken, address pool) external;
    function transferAdminRole(address localToken, address newAdmin) external;
    function getPool(address token) external view returns (address);
    function getTokenConfig(address token) external view returns (TokenConfig memory);
}

interface ICCIPTokenPool {
    struct RateLimitConfigArgs {
        uint64 remoteChainSelector;
        bool fastFinality;
        CCIPTypes.RateLimiterConfig outboundRateLimiterConfig;
        CCIPTypes.RateLimiterConfig inboundRateLimiterConfig;
    }

    function owner() external view returns (address);
    function acceptOwnership() external;
    function transferOwnership(address to) external;
    function getToken() external view returns (address);
    function getSupportedChains() external view returns (uint64[] memory);
    function isSupportedChain(uint64 remoteChainSelector) external view returns (bool);
    function getRemoteToken(uint64 remoteChainSelector) external view returns (bytes memory);
    function getRemotePools(uint64 remoteChainSelector) external view returns (bytes[] memory);
    function applyChainUpdates(uint64[] calldata remoteChainSelectorsToRemove, CCIPTypes.ChainUpdate[] calldata chainsToAdd)
        external;
    function setRateLimitConfig(RateLimitConfigArgs[] calldata rateLimitConfigArgs) external;
    function typeAndVersion() external view returns (string memory);
}
