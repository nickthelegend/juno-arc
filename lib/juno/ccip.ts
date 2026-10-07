import "server-only";

import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

import { junoCrossChainAbi, junoTokenAbi } from "./abi";
import { CallerError } from "./api";
import { ccipLaneName, ccipLanes, type CcipLane } from "./arc";
import { CCIP_POOL_INIT_CODE, CCIP_POOL_INIT_CODE_HASH } from "./ccip-pool-code";
import { publicClient } from "./client";
import { fetchPoolSnapshot, uiToWei, weiToUi, type ContractCall } from "./launchpad";
import { CCIP_EXPLORER, crossChainAddress, deployment, network } from "./network";
import { withRetry } from "./rpc";
import { prepare, type UnsignedTransaction } from "./tx";

/**
 * Chainlink CCIP Cross-Chain Tokens for graduated Juno coins.
 *
 * After graduation a creator can make their coin a CCT in one transaction:
 * `JunoCrossChain.enable` deploys Chainlink's own BurnMintTokenPool 2.0.0
 * (through Arc's TokenPoolFactory, from the published creation code shipped in
 * `ccip-pool-code.ts`, which the contract checks by hash), names it on the
 * token, and registers it in Arc's TokenAdminRegistry. Remote chains are wired
 * with `applyChainUpdates` once the coin's pool exists there
 * (`scripts/ccip-remote.ts` deploys it on Base Sepolia). Any holder can then
 * send the coin over a lane with the Router's `ccipSend`, paying the CCIP fee
 * in native USDC — the coin is burned on Arc and minted on the other side.
 *
 * USDC itself is not a CCIP token on Arc (it moves through CCTP and Gateway);
 * CCIP carries the coins.
 */

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
  "function typeAndVersion() view returns (string)",
]);

const registryAbi = parseAbi(["function getPool(address token) view returns (address)"]);

/** `Client.GenericExtraArgsV2` tag. */
export const GENERIC_EXTRA_ARGS_V2_TAG: Hex = "0x181dcf10";

/** Token-only transfer: no receiver gas, out-of-order execution allowed (what CCTs on new lanes require). */
export function genericExtraArgsV2(gasLimit = 0n, allowOutOfOrderExecution = true): Hex {
  return concatHex([
    GENERIC_EXTRA_ARGS_V2_TAG,
    encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [gasLimit, allowOutOfOrderExecution]),
  ]);
}

/** The CCIP message that sends `amount` of `token` to `receiver` on an EVM lane. Pure. */
export function ccipTokenMessage(params: { token: Address; amount: bigint; receiver: Address }) {
  return {
    receiver: encodeAbiParameters([{ type: "address" }], [getAddress(params.receiver)]),
    data: "0x" as Hex,
    tokenAmounts: [{ token: getAddress(params.token), amount: params.amount }],
    feeToken: "0x0000000000000000000000000000000000000000" as Address,
    extraArgs: genericExtraArgsV2(),
  };
}

/** The pool code JunoCrossChain will accept, checked against the deployment record. */
export function poolInitCode(): Hex {
  if (keccak256(CCIP_POOL_INIT_CODE) !== CCIP_POOL_INIT_CODE_HASH) {
    throw new Error("lib/juno/ccip-pool-code.ts is corrupt: its keccak256 does not match");
  }
  const recorded = deployment().ccipPoolInitCodeHash;
  if (recorded && recorded.toLowerCase() !== CCIP_POOL_INIT_CODE_HASH) {
    throw new Error(`The deployment's ccipPoolInitCodeHash (${recorded}) is not the pool code this server ships`);
  }
  return CCIP_POOL_INIT_CODE;
}

function requireCrossChain(): Address {
  const cc = crossChainAddress();
  if (!cc) throw new CallerError("Cross-chain coins are not configured on this server (no JunoCrossChain)", 503);
  return cc;
}

function requireRouter(): Address {
  const router = deployment().ccipRouter;
  if (!router) throw new CallerError("No CCIP router is recorded for this network", 503);
  return router;
}

function laneFor(selector: string): CcipLane {
  const lane = ccipLanes(network()).find((l) => l.selector === selector);
  if (!lane) {
    throw new CallerError(
      `"${selector}" is not a CCIP lane from Arc ${network()}. One of: ${ccipLanes(network())
        .map((l) => `${l.selector} (${l.name})`)
        .join(", ")}`,
    );
  }
  return lane;
}

type Bucket = { tokens: number; capacity: number; rate: number; isEnabled: boolean };
const bucket = (b: { tokens: bigint; capacity: bigint; rate: bigint; isEnabled: boolean }): Bucket => ({
  tokens: weiToUi(b.tokens, 18),
  capacity: weiToUi(b.capacity, 18),
  rate: weiToUi(b.rate, 18),
  isEnabled: b.isEnabled,
});

function bytesToAddress(value: Hex): string {
  if (value.length === 66) {
    try {
      return getAddress(decodeAbiParameters([{ type: "address" }], value)[0]);
    } catch {
      return value;
    }
  }
  return value;
}

export type CcipStatus = {
  token: Address;
  enabled: boolean;
  pool: Address | null;
  handedOver: boolean;
  chains: Array<{
    selector: string;
    name: string | null;
    remoteToken: string;
    remotePools: string[];
    outbound: Bucket | null;
    inbound: Bucket | null;
  }>;
  bridgedOut: number;
  ccipAdmin: Address | null;
  registryPool: Address | null;
  graduated: boolean;
  canEnable: boolean;
  lanes: CcipLane[];
  crossChain: Address | null;
  router: Address | null;
  explorer: string;
};

/** Everything the coin page shows about a coin's CCIP status. */
export async function ccipStatus(tokenRaw: string): Promise<CcipStatus> {
  if (!isAddress(tokenRaw)) throw new CallerError("Not an Arc address: token");
  const token = getAddress(tokenRaw);
  const cc = requireCrossChain();
  const client = publicClient();
  const snapshot = await fetchPoolSnapshot(token);
  if (!snapshot) throw new CallerError("This coin has no pool on this network", 404);

  const [status, ccipAdmin, registryPool] = await Promise.all([
    withRetry(() => client.readContract({ address: cc, abi: junoCrossChainAbi, functionName: "status", args: [token] })),
    withRetry(() => client.readContract({ address: token, abi: junoTokenAbi, functionName: "getCCIPAdmin" })).catch(() => null),
    (async () => {
      const registry = deployment().ccipTokenAdminRegistry;
      if (!registry) return null;
      const pool = await withRetry(() => client.readContract({ address: registry, abi: registryAbi, functionName: "getPool", args: [token] }));
      return /^0x0+$/.test(pool) ? null : getAddress(pool);
    })().catch(() => null),
  ]);
  const [pool, enabled, handedOver, chainIds, bridgedOut] = status;

  const chains = enabled
    ? await Promise.all(
        chainIds.map(async (selector) => {
          const [remoteToken, remotePools, limits] = await Promise.all([
            withRetry(() => client.readContract({ address: pool, abi: ccipPoolReadAbi, functionName: "getRemoteToken", args: [selector] })),
            withRetry(() => client.readContract({ address: pool, abi: ccipPoolReadAbi, functionName: "getRemotePools", args: [selector] })),
            withRetry(() =>
              client.readContract({ address: pool, abi: ccipPoolReadAbi, functionName: "getCurrentRateLimiterState", args: [selector, false] }),
            ).catch(() => null),
          ]);
          return {
            selector: selector.toString(),
            name: ccipLaneName(network(), selector),
            remoteToken: bytesToAddress(remoteToken),
            remotePools: remotePools.map(bytesToAddress),
            outbound: limits ? bucket(limits[0]) : null,
            inbound: limits ? bucket(limits[1]) : null,
          };
        }),
      )
    : [];

  return {
    token,
    enabled,
    pool: enabled ? getAddress(pool) : null,
    handedOver,
    chains,
    bridgedOut: weiToUi(bridgedOut, 18),
    ccipAdmin: ccipAdmin ? getAddress(ccipAdmin) : null,
    registryPool,
    graduated: snapshot.curve.graduated,
    canEnable: snapshot.curve.graduated && !enabled,
    lanes: ccipLanes(network()),
    crossChain: cc,
    router: deployment().ccipRouter,
    explorer: CCIP_EXPLORER,
  };
}

async function requireCreatorOf(token: Address, creator: Address) {
  const snapshot = await fetchPoolSnapshot(token);
  if (!snapshot) throw new CallerError("This coin has no pool on this network", 404);
  if (snapshot.pool.creator !== creator) throw new CallerError("Only the coin's creator can change its CCIP setup", 403);
  return snapshot;
}

/** `JunoCrossChain.enable(token, poolCode, [])`: the coin becomes a CCT on Arc. */
export async function buildCcipEnable(request: { token: Address; creator: Address }): Promise<UnsignedTransaction[]> {
  const cc = requireCrossChain();
  const snapshot = await requireCreatorOf(request.token, request.creator);
  if (!snapshot.curve.graduated) throw new CallerError("A coin goes cross-chain after it graduates", 409);
  const pool = await withRetry(() => publicClient().readContract({ address: cc, abi: junoCrossChainAbi, functionName: "poolOf", args: [request.token] }));
  if (!/^0x0+$/.test(pool)) throw new CallerError("This coin is already a CCIP Cross-Chain Token", 409);
  const call: ContractCall = {
    to: cc,
    data: encodeFunctionData({ abi: junoCrossChainAbi, functionName: "enable", args: [request.token, poolInitCode(), []] }),
    value: 0n,
    label: "Making it a Chainlink CCIP Cross-Chain Token",
  };
  return prepare(request.creator, [call]);
}

/** Rate limits for a lane: always on, capped by JunoCrossChain at 100M tokens per bucket. */
export const DEFAULT_LANE_LIMIT = { isEnabled: true, capacity: 50_000_000n * 10n ** 18n, rate: 13_000n * 10n ** 18n } as const;

export type LaneUpdate = { selector: string; remotePool: Address; remoteToken: Address; capacity?: number; rate?: number };

/** The `applyChainUpdates` arguments for remote pools on EVM lanes. Pure. */
export function chainUpdatesFor(adds: LaneUpdate[]) {
  return adds.map((add) => {
    const limit =
      add.capacity !== undefined && add.rate !== undefined
        ? { isEnabled: true, capacity: uiToWei(add.capacity, 18), rate: uiToWei(add.rate, 18) }
        : DEFAULT_LANE_LIMIT;
    return {
      remoteChainSelector: BigInt(add.selector),
      remotePoolAddresses: [encodeAbiParameters([{ type: "address" }], [getAddress(add.remotePool)])],
      remoteTokenAddress: encodeAbiParameters([{ type: "address" }], [getAddress(add.remoteToken)]),
      outboundRateLimiterConfig: limit,
      inboundRateLimiterConfig: limit,
    };
  });
}

/** Wire (or unwire) remote chains on the coin's pool, through JunoCrossChain. */
export async function buildCcipChains(request: {
  token: Address;
  creator: Address;
  add: LaneUpdate[];
  remove?: string[];
}): Promise<UnsignedTransaction[]> {
  const cc = requireCrossChain();
  await requireCreatorOf(request.token, request.creator);
  for (const add of request.add) {
    const lane = laneFor(add.selector);
    if (!lane.evm) throw new CallerError(`${lane.name} is not an EVM lane; wire it with Chainlink's tools`);
  }
  const remove = (request.remove ?? []).map((selector) => BigInt(laneFor(selector).selector));
  const call: ContractCall = {
    to: cc,
    data: encodeFunctionData({
      abi: junoCrossChainAbi,
      functionName: "applyChainUpdates",
      args: [request.token, remove, chainUpdatesFor(request.add)],
    }),
    value: 0n,
    label: `Wiring ${request.add.map((a) => ccipLaneName(network(), a.selector)).join(", ") || "CCIP lanes"}`,
  };
  return prepare(request.creator, [call]);
}

export type CcipSendBuild = {
  steps: UnsignedTransaction[];
  fee: { usdc: number; wei: string };
  lane: CcipLane;
  receiver: Address;
  amount: number;
  explorer: string;
};

/**
 * Send `amount` of a coin over a CCIP lane: an approval of the Router when
 * needed, then `ccipSend` with the fee in native USDC (18-dec `value`).
 */
export async function buildCcipSend(request: {
  token: Address;
  owner: Address;
  amount: number;
  destination: string;
  receiver?: Address;
}): Promise<CcipSendBuild> {
  const router = requireRouter();
  const cc = requireCrossChain();
  const lane = laneFor(request.destination);
  if (!lane.evm) throw new CallerError(`${lane.name} needs a non-EVM receiver; send to it with Chainlink's tools`);
  if (!(request.amount > 0)) throw new CallerError("Amount must be greater than zero");
  const client = publicClient();

  const pool = await withRetry(() => client.readContract({ address: cc, abi: junoCrossChainAbi, functionName: "poolOf", args: [request.token] }));
  if (/^0x0+$/.test(pool)) throw new CallerError("This coin is not a CCIP Cross-Chain Token yet; its creator enables it after graduation", 409);
  const supported = await withRetry(() =>
    client.readContract({ address: pool, abi: ccipPoolReadAbi, functionName: "isSupportedChain", args: [BigInt(lane.selector)] }),
  );
  if (!supported) throw new CallerError(`This coin's pool is not wired to ${lane.name} yet`, 409);

  const amount = uiToWei(request.amount, 18);
  const balance = await withRetry(() =>
    client.readContract({ address: request.token, abi: junoTokenAbi, functionName: "balanceOf", args: [request.owner] }),
  );
  if (balance < amount) throw new CallerError(`This wallet holds ${weiToUi(balance, 18)} of the coin`, 409);

  const receiver = request.receiver ?? request.owner;
  const message = ccipTokenMessage({ token: request.token, amount, receiver });
  const fee = await withRetry(() =>
    client.readContract({ address: router, abi: ccipRouterAbi, functionName: "getFee", args: [BigInt(lane.selector), message] }),
  );
  // 1% over the quote so a fee tick between build and send doesn't revert; the Router keeps what is sent.
  const value = fee + fee / 100n;

  const calls: ContractCall[] = [];
  const allowance = await withRetry(() =>
    client.readContract({ address: request.token, abi: junoTokenAbi, functionName: "allowance", args: [request.owner, router] }),
  );
  if (allowance < amount) {
    calls.push({
      to: request.token,
      data: encodeFunctionData({ abi: junoTokenAbi, functionName: "approve", args: [router, maxUint256] }),
      value: 0n,
      label: "Allowing Chainlink's CCIP Router to take the coin",
    });
  }
  calls.push({
    to: router,
    data: encodeFunctionData({ abi: ccipRouterAbi, functionName: "ccipSend", args: [BigInt(lane.selector), message] }),
    value,
    label: `Sending it to ${lane.name} over Chainlink CCIP`,
  });

  return {
    steps: await prepare(request.owner, calls),
    fee: { usdc: weiToUi(value, 18), wei: value.toString() },
    lane,
    receiver,
    amount: request.amount,
    explorer: CCIP_EXPLORER,
  };
}

export type CcipMessageStatus = {
  messageId: Hex;
  state: string | null;
  sourceChain: string | null;
  destChain: string | null;
  receiptTransactionHash: string | null;
  url: string;
};

/** A message's status from Chainlink's CCIP explorer API (public, best effort). */
export async function ccipMessageStatus(messageId: Hex): Promise<CcipMessageStatus> {
  const url = `${CCIP_EXPLORER}/msg/${messageId}`;
  const empty = { messageId, state: null, sourceChain: null, destChain: null, receiptTransactionHash: null, url };
  try {
    const res = await fetch(`${CCIP_EXPLORER}/api/h/atlas/message/${messageId}`, { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (!res.ok) return empty;
    const json = (await res.json()) as Record<string, unknown>;
    return {
      messageId,
      state: typeof json.state === "number" ? ["unknown", "in flight", "success", "failed"][json.state] ?? String(json.state) : (json.state as string) ?? null,
      sourceChain: (json.sourceNetworkName as string) ?? null,
      destChain: (json.destNetworkName as string) ?? null,
      receiptTransactionHash: (json.receiptTransactionHash as string) ?? null,
      url,
    };
  } catch {
    return empty;
  }
}
