/**
 * Chainlink CCIP pieces the ccip:* scripts share.
 *
 * `lib/juno/ccip.ts` is `server-only` (it builds the API's transactions), and
 * `server-only` throws outside Next's bundler — see `./cli.ts`. The handful of
 * pure helpers the scripts need are mirrored here, byte for byte the same
 * encodings: the Router's message, GenericExtraArgsV2 and the pool's
 * `ChainUpdate`. Lanes, selectors and message-id decoding come from the pure
 * `lib/juno/arc.ts` and `lib/juno/ccip-events.ts`.
 */

import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

export const ccipRouterAbi = parseAbi([
  "struct EVMTokenAmount { address token; uint256 amount; }",
  "struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }",
  "function getFee(uint64 destinationChainSelector, EVM2AnyMessage message) view returns (uint256 fee)",
  "function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message) payable returns (bytes32)",
  "function isChainSupported(uint64 chainSelector) view returns (bool)",
]);

export const ccipPoolReadAbi = parseAbi([
  "struct TokenBucket { uint128 tokens; uint32 lastUpdated; bool isEnabled; uint128 capacity; uint128 rate; }",
  "function getCurrentRateLimiterState(uint64 remoteChainSelector, bool fastFinality) view returns (TokenBucket outbound, TokenBucket inbound)",
  "function getRemoteToken(uint64 remoteChainSelector) view returns (bytes)",
  "function getRemotePools(uint64 remoteChainSelector) view returns (bytes[])",
  "function isSupportedChain(uint64 remoteChainSelector) view returns (bool)",
  "function getSupportedChains() view returns (uint64[])",
  "function getToken() view returns (address)",
  "function typeAndVersion() view returns (string)",
]);

/** `Client.GenericExtraArgsV2` tag. */
export const GENERIC_EXTRA_ARGS_V2_TAG: Hex = "0x181dcf10";

/** Token-only transfer: no receiver gas, out-of-order execution allowed (what CCTs on new lanes require). */
export function genericExtraArgsV2(gasLimit = 0n, allowOutOfOrderExecution = true): Hex {
  return concatHex([
    GENERIC_EXTRA_ARGS_V2_TAG,
    encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [gasLimit, allowOutOfOrderExecution]),
  ]);
}

/** The CCIP message that sends `amount` of `token` to `receiver` on an EVM lane, fee in native USDC. */
export function ccipTokenMessage(params: { token: Address; amount: bigint; receiver: Address }) {
  return {
    receiver: encodeAbiParameters([{ type: "address" }], [getAddress(params.receiver)]),
    data: "0x" as Hex,
    tokenAmounts: [{ token: getAddress(params.token), amount: params.amount }],
    feeToken: "0x0000000000000000000000000000000000000000" as Address,
    extraArgs: genericExtraArgsV2(),
  };
}

/** An EVM address as CCIP's `bytes` (abi.encode(address)). */
export function encodeAddress(address: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [getAddress(address)]);
}

/** A rate limit: always on, capacity ≤ 1e8 tokens (JunoCrossChain.MAX_CAPACITY), rate < capacity. */
export type RateLimit = { isEnabled: boolean; capacity: bigint; rate: bigint };

/** 50M tokens per bucket, refilling at 13k tokens a second — the app's default (`lib/juno/ccip.ts`). */
export const DEFAULT_LANE_LIMIT: RateLimit = { isEnabled: true, capacity: 50_000_000n * 10n ** 18n, rate: 13_000n * 10n ** 18n };

/** `TokenPool.ChainUpdate` for one remote EVM chain. */
export function chainUpdate(params: { selector: bigint; remotePool: Address; remoteToken: Address; limit?: RateLimit }) {
  const limit = params.limit ?? DEFAULT_LANE_LIMIT;
  return {
    remoteChainSelector: params.selector,
    remotePoolAddresses: [encodeAddress(params.remotePool)],
    remoteTokenAddress: encodeAddress(params.remoteToken),
    outboundRateLimiterConfig: limit,
    inboundRateLimiterConfig: limit,
  };
}

/** Arc's own CCIP chain selectors. */
export const ARC_CCIP_SELECTOR = { testnet: 3034092155422581607n, mainnet: 6370580034781731079n } as const;

/** Chainlink's CCIP explorer API for a message (public, best effort). */
export const CCIP_EXPLORER_API = "https://ccip.chain.link/api/h/atlas/message";
