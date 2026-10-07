import { describe, expect, it } from "vitest";
import { erc20Abi, multicall3Abi } from "viem";

import { publicClient } from "@/lib/juno/client";
import { usdcQuote } from "@/lib/juno/launchpad";
import { chain, chainId, isMainnet, rpcEndpoint } from "@/lib/juno/network";
import { unlessThrottled } from "../helpers/throttle";

/**
 * Live reads against Arc. Nothing is signed and nothing moves.
 *
 * These pin the facts every other part of Juno assumes without checking: that
 * the RPC it is pointed at is the chain it thinks it is, that Multicall3 is
 * where viem expects it (every coin page batches its reads through it), and
 * that the USDC Juno offers as a quote token is a real six-decimal token.
 */

const onTestnet = !isMainnet();

describe("arc: the chain Juno is pointed at", () => {
  it.skipIf(!onTestnet)("answers as Arc testnet, chain 5042002", async () => {
    await unlessThrottled("chain id", async () => {
      expect(chainId()).toBe(5042002);
      expect(await publicClient().getChainId()).toBe(5042002);
    });
  });

  it("agrees with the configured chain over raw JSON-RPC too", async () => {
    await unlessThrottled("raw eth_chainId", async () => {
      const response = await fetch(rpcEndpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const body = (await response.json()) as { result?: string; error?: { message: string } };
      if (body.error) throw new Error(body.error.message);
      expect(Number(body.result)).toBe(chain().id);
    });
  });

  it("is producing blocks now", async () => {
    await unlessThrottled("latest block", async () => {
      const block = await publicClient().getBlock({ blockTag: "latest" });
      const ageSeconds = Date.now() / 1000 - Number(block.timestamp);
      // Arc blocks are sub-second (a local fork mines every second). A head minutes old is a stuck endpoint.
      expect(ageSeconds).toBeLessThan(120);
      expect(block.number).toBeGreaterThan(0n);
    });
  });
});

describe("arc: Multicall3", () => {
  const multicall = chain().contracts?.multicall3?.address;

  it("is configured for this chain", () => {
    expect(multicall, "viem's chain definition has no multicall3").toBeDefined();
  });

  it("has code at its canonical address", async () => {
    await unlessThrottled("multicall3 code", async () => {
      const code = await publicClient().getCode({ address: multicall! });
      expect(code && code.length > 2, `no contract at ${multicall}`).toBe(true);
    });
  });

  it("answers a batched read", async () => {
    await unlessThrottled("multicall", async () => {
      const [timestamp, balance] = await publicClient().multicall({
        contracts: [
          { address: multicall!, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
          { address: multicall!, abi: multicall3Abi, functionName: "getEthBalance", args: [multicall!] },
        ],
        allowFailure: false,
      });
      // Both answered from one eth_call, and the chain's clock is now.
      expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(120);
      expect(balance).toBeGreaterThanOrEqual(0n);
    });
  });
});

describe("arc: the USDC Juno quotes in", () => {
  it("is a six-decimal token called USDC", async () => {
    await unlessThrottled("usdc metadata", async () => {
      const [decimals, symbol] = await publicClient().multicall({
        contracts: [
          { address: usdcQuote().address, abi: erc20Abi, functionName: "decimals" },
          { address: usdcQuote().address, abi: erc20Abi, functionName: "symbol" },
        ],
        allowFailure: false,
      });
      expect(decimals).toBe(usdcQuote().decimals);
      expect(symbol).toMatch(/USDC/);
    });
  });
});
