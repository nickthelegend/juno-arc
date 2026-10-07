import { decodeAbiParameters, type Hex } from "viem";

/**
 * Chainlink CCIP message ids, read from a send's receipt.
 *
 * The Router's `ccipSend` returns the id, but a signed transaction's return
 * value is not in its receipt — the OnRamp's `CCIPMessageSent` event is. Arc's
 * lanes run OnRamp 2.0.0, which indexes the id (topic 3); OnRamp 1.6 carries it
 * inside the message header in the data. Both are read. Pure.
 */

/** `CCIPMessageSent(uint64 indexed destChainSelector, address indexed sender, bytes32 indexed messageId, …)` — OnRamp 2.0.0. */
export const CCIP_MESSAGE_SENT_V2: Hex = "0x371bc2ff0a006f4ef863b1d27a065d4e9f938b6d883eb154572b4aea593b32cc";
/** `CCIPMessageSent(uint64 indexed destChainSelector, uint64 indexed sequenceNumber, EVM2AnyRampMessage message)` — OnRamp 1.6. */
export const CCIP_MESSAGE_SENT_V16: Hex = "0x192442a2b2adb6a7948f097023cb6b57d29d3a7a5dd33e6666d33c39cc456f32";

export function ccipMessageIdsIn(logs: ReadonlyArray<{ topics: readonly Hex[]; data: Hex }>): Hex[] {
  const ids: Hex[] = [];
  for (const log of logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    if (topic0 === CCIP_MESSAGE_SENT_V2 && log.topics[3]) {
      ids.push(log.topics[3] as Hex);
    } else if (topic0 === CCIP_MESSAGE_SENT_V16) {
      try {
        // The message is a dynamic tuple: an offset word, then the header (messageId first).
        const [offset] = decodeAbiParameters([{ type: "uint256" }], log.data);
        const start = 2 + Number(offset) * 2;
        ids.push(`0x${log.data.slice(start, start + 64)}` as Hex);
      } catch {
        // Not the shape expected: skip rather than report a wrong id.
      }
    }
  }
  return ids;
}
