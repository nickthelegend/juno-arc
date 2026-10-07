import { encodeFunctionData, getAddress, keccak256, parseAbi, stringToBytes, toHex, type Address, type Hex } from "viem";

import { publicClient } from "./client";
import { deployment } from "./network";

/**
 * Arc's Memo extension: a payment that says what it was for.
 *
 * `Memo.memo(target, data, memoId, memoData)` calls `target` with `data` *as
 * the transaction's EOA sender* (Arc's CallFrom precompile), then emits
 * `Memo(sender, target, callDataHash, memoId, memo, memoIndex)`. So a buy sent
 * through Memo is still the buyer's own buy — the launchpad sees the buyer as
 * `msg.sender`, pulls the buyer's approved USDC and pays the buyer — and the
 * chain also records, indexed, which post the money went to.
 *
 * Juno tags every curve buy and sell with `memoId = keccak256("juno:post:" +
 * token)` (the token is the post) and a readable line such as
 * `"juno buy $MARINA 25 USDC"`. Anyone can follow a post's money with one
 * `eth_getLogs` on Memo filtered by that id.
 *
 * Memo needs the transaction's sender to be an EOA and forwards no value, so
 * approvals and anything payable stay plain calls. Whether the node executes
 * CallFrom is probed, not assumed (`memoLive`): where it doesn't, trades go out
 * as plain calls and say so (`memo.tagged: false`).
 */

export const memoAbi = parseAbi([
  "function memo(address target, bytes data, bytes32 memoId, bytes memo)",
  "event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)",
  "error CallFailed(bytes returnData)",
]);

/** `Memo.CallFailed(bytes)` — Memo wraps the target's revert in it. */
export const MEMO_CALL_FAILED: Hex = "0xed1966a2";

/** The memo id that ties a payment to a Juno post (the post's coin). */
export function postMemoId(token: string): Hex {
  return keccak256(stringToBytes(`juno:post:${token.toLowerCase()}`));
}

/** The human-readable line stored with the payment. Kept short: it is calldata. */
export function memoLine(parts: { action: string; symbol?: string | null; amount?: string | null }): string {
  const symbol = parts.symbol ? ` $${parts.symbol.replace(/^\$/, "")}` : "";
  const amount = parts.amount ? ` ${parts.amount}` : "";
  return `juno ${parts.action}${symbol}${amount}`.slice(0, 120);
}

/** A call, re-addressed to Memo with its tag. Pure. */
export function wrapInMemo(params: {
  memo: Address;
  target: Address;
  data: Hex;
  memoId: Hex;
  line: string;
}): { to: Address; data: Hex } {
  return {
    to: getAddress(params.memo),
    data: encodeFunctionData({
      abi: memoAbi,
      functionName: "memo",
      args: [getAddress(params.target), params.data, params.memoId, toHex(stringToBytes(params.line))],
    }),
  };
}

export function memoAddress(): Address | null {
  return deployment().memo;
}

/*
 * The probe.
 *
 * An `eth_call` of Memo wrapping a USDC transfer that must fail as the caller
 * (0x…dEaD sending a billion USDC it does not have). Where CallFrom runs, the
 * transfer is attempted *as that caller* and its "exceeds balance" revert
 * comes back wrapped in Memo's `CallFailed(bytes)` — proof the inner call ran
 * with the right sender. Anything else (no code at Memo, a precompile that
 * isn't there, a node that answers success without executing it) is "not live".
 * Read once per process and cached; it is a single `eth_call`.
 */
const PROBE_FROM: Address = "0x000000000000000000000000000000000000dEaD";
let probe: Promise<boolean> | null = null;
let probedAt = 0;
const PROBE_TTL_MS = 10 * 60_000;

export function memoProbeCall(memo: Address, usdc: Address): { to: Address; data: Hex; from: Address } {
  const transfer = encodeFunctionData({
    abi: parseAbi(["function transfer(address to, uint256 value) returns (bool)"]),
    functionName: "transfer",
    args: ["0x0000000000000000000000000000000000000001", 1_000_000_000_000_000n],
  });
  const wrapped = wrapInMemo({ memo, target: usdc, data: transfer, memoId: keccak256(stringToBytes("juno:probe")), line: "probe" });
  return { ...wrapped, from: PROBE_FROM };
}

/** Did the probe's revert carry the inner call's own revert, wrapped by Memo? */
export function probeRevertProvesCallFrom(revertData: string | null | undefined): boolean {
  if (!revertData || !revertData.toLowerCase().startsWith(MEMO_CALL_FAILED)) return false;
  // CallFailed(bytes) with a non-empty payload: the selector, offset, length > 0.
  const body = revertData.slice(10);
  if (body.length < 128) return false;
  const length = BigInt(`0x${body.slice(64, 128)}`);
  return length > 0n;
}

function revertDataOf(error: unknown): string | null {
  let found: string | null = null;
  const visit = (e: unknown, depth: number) => {
    if (!e || depth > 8 || found) return;
    const data = (e as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x")) found = data;
    else if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") {
      found = (data as { data: string }).data;
    }
    const raw = (e as { raw?: unknown }).raw;
    if (!found && typeof raw === "string" && raw.startsWith("0x")) found = raw;
    visit((e as { cause?: unknown }).cause, depth + 1);
  };
  visit(error, 0);
  if (!found) {
    // Some transports only carry it in the message.
    const match = /(0xed1966a2[0-9a-fA-F]*)/.exec(String((error as Error)?.message ?? ""));
    if (match) found = match[1];
  }
  return found;
}

/** Whether Memo-wrapped calls execute on this network's node. Cached; never throws. */
export function memoLive(): Promise<boolean> {
  if (probe && Date.now() - probedAt < PROBE_TTL_MS) return probe;
  const memo = memoAddress();
  if (!memo) return Promise.resolve(false);
  probedAt = Date.now();
  const call = memoProbeCall(memo, deployment().usdc);
  probe = publicClient()
    .call({ account: call.from, to: call.to, data: call.data })
    .then(() => false)
    .catch((error: unknown) => probeRevertProvesCallFrom(revertDataOf(error)));
  // A transport failure must not pin "not live" for ten minutes.
  probe.then((live) => {
    if (!live) probedAt = Date.now() - PROBE_TTL_MS + 30_000;
  });
  return probe;
}

/** For tests. */
export function resetMemoProbe(): void {
  probe = null;
  probedAt = 0;
}
