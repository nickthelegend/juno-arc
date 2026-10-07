/**
 * Where a Chainlink CCIP message is: sent, committed, executed — or failed.
 *
 *   npm run ccip:status -- --id 0x…                       # Chainlink's CCIP explorer
 *   npm run ccip:status -- --tx 0x…                       # the message ids an Arc send emitted, then their status
 *   npm run ccip:status -- --id 0x… --dest-rpc https://sepolia.base.org [--blocks 20000] [--offramp 0x…]
 *   npm run ccip:status -- --id 0x… --watch               # poll until it is executed or failed
 *
 * Reads Chainlink's public CCIP explorer API (`https://ccip.chain.link/api/h/atlas/message/<id>`,
 * the data behind https://ccip.chain.link/msg/<id>). With `--dest-rpc` it also scans the
 * destination chain for the OffRamp's `ExecutionStateChanged` with this message id (OffRamp 1.6
 * and 2.0 shapes), which proves execution without trusting the explorer.
 *
 * `@chainlink/ccip-sdk` was considered and not added: it installs ~240 MB of multi-chain
 * dependencies (Solana, Sui, TON, Aptos, ethers) with open npm-audit findings into a Next.js app,
 * for what is one HTTP read and one log scan here.
 *
 * Read-only: signs nothing and needs no key.
 */

import { createPublicClient, decodeAbiParameters, http, isHex, toEventSelector, type Hex } from "viem";

import { ccipMessageIdsIn } from "../lib/juno/ccip-events";
import { ccipMessageUrl } from "../lib/juno/network";
import { CCIP_EXPLORER_API } from "./lib/ccip";
import { arg, flag, header, line, numberArg, run, scriptReader } from "./lib/cli";

/** `Internal.MessageExecutionState`. */
const EXECUTION_STATE = ["untouched", "in progress", "success", "failure"] as const;

/** OffRamp 1.6: state is the 5th field, after an un-indexed messageHash. */
const EXEC_V16 = toEventSelector(
  "ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed sequenceNumber, bytes32 indexed messageId, bytes32 messageHash, uint8 state, bytes returnData, uint256 gasUsed)",
);
/** OffRamp 2.0: state is the first un-indexed field. */
const EXEC_V20 = toEventSelector(
  "ExecutionStateChanged(uint64 indexed sourceChainSelector, uint64 indexed messageNumber, bytes32 indexed messageId, uint8 state, bytes returnData)",
);

type ExplorerMessage = {
  messageId?: string;
  state?: number | string | null;
  sourceNetworkName?: string | null;
  destNetworkName?: string | null;
  sendTransactionHash?: string | null;
  sendTimestamp?: string | null;
  commitTransactionHash?: string | null;
  blessTransactionHash?: string | null;
  receiptTransactionHash?: string | null;
  receiptTimestamp?: string | null;
  sender?: string | null;
  receiver?: string | null;
};

type Summary = { phase: string; final: boolean };

/** One word for where the message is, from the explorer's fields. */
function phaseOf(message: ExplorerMessage): Summary {
  if (typeof message.state === "number") {
    const state = EXECUTION_STATE[message.state] ?? String(message.state);
    if (state === "success") return { phase: "executed (success)", final: true };
    if (state === "failure") return { phase: "executed (FAILED — can be manually executed from the explorer)", final: true };
    if (state === "in progress") return { phase: "executing", final: false };
  } else if (typeof message.state === "string" && message.state) {
    return { phase: message.state, final: /success|fail/i.test(message.state) };
  }
  if (message.receiptTransactionHash) return { phase: "executed", final: true };
  if (message.blessTransactionHash) return { phase: "committed and blessed — waiting for execution", final: false };
  if (message.commitTransactionHash) return { phase: "committed — waiting for RMN blessing / execution", final: false };
  return { phase: "sent — waiting for source finality and commit", final: false };
}

async function explorer(id: Hex): Promise<ExplorerMessage | null> {
  const res = await fetch(`${CCIP_EXPLORER_API}/${id}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) throw new Error("Could not reach https://ccip.chain.link.");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // The API answers 500 "Message not found" for an id it has not indexed (yet).
    if (/not found/i.test(body)) return null;
    throw new Error(`ccip.chain.link answered ${res.status}: ${body.slice(0, 160)}`);
  }
  return (await res.json()) as ExplorerMessage;
}

async function destinationScan(id: Hex, rpc: string): Promise<void> {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 3, timeout: 20_000 }) });
  const chainId = await client.getChainId();
  const latest = await client.getBlockNumber();
  const span = BigInt(numberArg("blocks", 20_000)!);
  const chunk = BigInt(numberArg("chunk", 2_000)!);
  const offramp = arg("offramp") as Hex | undefined;
  const from = latest > span ? latest - span : 0n;
  console.log(`\nScanning chain ${chainId} blocks ${from}–${latest} for ExecutionStateChanged(${id})…`);
  for (let start = from; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
    const logs = await client.request({
      method: "eth_getLogs",
      params: [
        {
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          ...(offramp ? { address: offramp } : {}),
          topics: [[EXEC_V16, EXEC_V20], null, null, id],
        },
      ],
    });
    for (const log of logs as Array<{ topics: Hex[]; data: Hex; address: Hex; transactionHash: Hex; blockNumber: Hex }>) {
      const v16 = log.topics[0].toLowerCase() === EXEC_V16.toLowerCase();
      const state = v16
        ? decodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes" }, { type: "uint256" }], log.data)[1]
        : decodeAbiParameters([{ type: "uint8" }, { type: "bytes" }], log.data)[0];
      line("OffRamp", `${log.address} (${v16 ? "1.6" : "2.0"})`);
      line("state", EXECUTION_STATE[state] ?? String(state));
      line("dest tx", `${log.transactionHash} (block ${BigInt(log.blockNumber)})`);
      return;
    }
  }
  line("OffRamp", `no ExecutionStateChanged for this id in the last ${span} blocks (not executed yet, or widen --blocks)`);
}

async function idsToCheck(): Promise<Hex[]> {
  // `--id 0x…`, or the id on its own.
  const id = arg("id") ?? process.argv.slice(2).find((a) => /^0x[0-9a-fA-F]{64}$/.test(a) && a !== arg("tx"));
  if (id) {
    if (!isHex(id) || id.length !== 66) throw new Error(`--id ${id} is not a 32-byte message id`);
    return [id as Hex];
  }
  const tx = arg("tx");
  if (tx) {
    if (!isHex(tx) || tx.length !== 66) throw new Error(`--tx ${tx} is not a transaction hash`);
    header();
    const receipt = await scriptReader().getTransactionReceipt({ hash: tx as Hex });
    const ids = ccipMessageIdsIn(receipt.logs);
    if (ids.length === 0) throw new Error(`${tx} emitted no CCIPMessageSent on this Arc network.`);
    return ids;
  }
  throw new Error("Pass --id <messageId>, or --tx <Arc send tx hash>.");
}

async function main() {
  const ids = await idsToCheck();
  const destRpc = arg("dest-rpc");
  const watch = flag("watch");

  for (const id of ids) {
    console.log("");
    line("message id", id);
    line("explorer", ccipMessageUrl(id));
    let final = false;
    for (let attempt = 0; ; attempt++) {
      const message = await explorer(id);
      if (!message) {
        line("status", "not indexed by the CCIP explorer yet (it appears a minute or so after the send)");
      } else {
        const { phase, final: done } = phaseOf(message);
        final = done;
        line("status", phase);
        if (attempt === 0) {
          if (message.sourceNetworkName || message.destNetworkName) {
            line("lane", `${message.sourceNetworkName ?? "?"} → ${message.destNetworkName ?? "?"}`);
          }
          if (message.sendTransactionHash) line("send tx", `${message.sendTransactionHash}${message.sendTimestamp ? ` at ${message.sendTimestamp}` : ""}`);
          if (message.commitTransactionHash) line("commit tx", message.commitTransactionHash);
        }
        if (message.receiptTransactionHash) {
          line("dest tx", `${message.receiptTransactionHash}${message.receiptTimestamp ? ` at ${message.receiptTimestamp}` : ""}`);
        }
      }
      if (!watch || final) break;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    if (destRpc) await destinationScan(id, destRpc);
  }
}

run(main);
