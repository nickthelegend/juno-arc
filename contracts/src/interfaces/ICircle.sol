// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev EIP-3009 on Arc's USDC (0x3600…0000, EIP-712 domain "USDC" / "2") and EURC.
/// `receiveWithAuthorization` may only be called by the payee, so a relayer
/// can never redirect a signed authorization to someone else.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/// @dev Circle CCTP V2 TokenMessengerV2 (Arc is domain 26).
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}
