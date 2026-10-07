import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ARC_USDC,
  ccipMessageUrl,
  chainId,
  deployment,
  deploymentFrom,
  explorer,
  launchpadAddress,
  launchpadDeployBlock,
  network,
  networkKey,
  parseDeploymentJson,
  requireLaunchpad,
  resetDeploymentCache,
  rpcEndpoint,
  usingPublicRpc,
} from "@/lib/juno/network";

/**
 * Which Arc Juno talks to. The rules worth pinning: a missing or mistyped
 * variable lands on testnet, never on real money; addresses come from the
 * deployment record, and an absent record leaves features off instead of
 * pointing them at the zero address; CCIP chain selectors survive JSON.
 */

const KEYS = ["NEXT_PUBLIC_ARC_NETWORK", "ARC_RPC_URL", "NEXT_PUBLIC_ARC_RPC_URL", "JUNO_DEPLOYMENT_FILE"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetDeploymentCache();
});

function record(content: object): string {
  const dir = mkdtempSync(path.join(tmpdir(), "juno-deploy-"));
  const file = path.join(dir, "arc.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

describe("network", () => {
  it("is testnet unless mainnet is asked for by name", () => {
    for (const value of [undefined, "", "Mainnet", "main", "testnet"]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_ARC_NETWORK;
      else process.env.NEXT_PUBLIC_ARC_NETWORK = value;
      expect(network(), `NEXT_PUBLIC_ARC_NETWORK=${value}`).toBe("testnet");
    }
    expect(chainId()).toBe(5042002);
    expect(networkKey()).toBe("arc-testnet");
    expect(explorer.tx("0xabc")).toBe("https://explorer.testnet.arc.io/tx/0xabc");
  });

  it("switches every derived value together on mainnet", () => {
    process.env.NEXT_PUBLIC_ARC_NETWORK = "mainnet";
    expect(network()).toBe("mainnet");
    expect(chainId()).toBe(5042);
    expect(networkKey()).toBe("arc");
    expect(explorer.address("0xabc")).toBe("https://explorer.arc.io/address/0xabc");
  });

  it("prefers a dedicated RPC and says when it is on the public one", () => {
    delete process.env.ARC_RPC_URL;
    delete process.env.NEXT_PUBLIC_ARC_RPC_URL;
    expect(usingPublicRpc()).toBe(true);
    expect(rpcEndpoint()).toBe("https://rpc.testnet.arc.io");
    process.env.ARC_RPC_URL = "http://127.0.0.1:8910";
    expect(usingPublicRpc()).toBe(false);
    expect(rpcEndpoint()).toBe("http://127.0.0.1:8910");
  });

  it("links CCIP messages to Chainlink's explorer", () => {
    expect(ccipMessageUrl("0x12")).toBe("https://ccip.chain.link/msg/0x12");
  });
});

describe("deployment record", () => {
  it("leaves every Juno address null without a record, and says so when one is required", () => {
    process.env.JUNO_DEPLOYMENT_FILE = "/nonexistent/arc.json";
    expect(launchpadAddress()).toBeNull();
    expect(() => requireLaunchpad()).toThrow(/No Juno launchpad/);
    expect(deployment().usdc).toBe(ARC_USDC);
  });

  it("reads addresses checksummed, the deploy block as a bigint, and falls back to Arc's own contracts", () => {
    process.env.JUNO_DEPLOYMENT_FILE = record({
      chainId: 5042002,
      launchpad: "0x1c75b3f897ad80a1a6fb32f864cc845aabcc657e",
      deployBlock: 66009523,
    });
    expect(launchpadAddress()).toBe("0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E");
    expect(launchpadDeployBlock()).toBe(66009523n);
    // Circle's and Chainlink's testnet addresses when the record omits them.
    expect(deployment().tokenMessengerV2).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
    expect(deployment().ccipRouter).toBe("0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8");
  });

  it("keeps a CCIP chain selector exact (it doesn't fit a double)", () => {
    const raw = parseDeploymentJson('{"ccipChainSelector":3034092155422581607,"chainId":5042002}');
    expect(raw.ccipChainSelector).toBe("3034092155422581607");
    expect(raw.chainId).toBe(5042002);
    expect(deploymentFrom(raw, "testnet").ccipChainSelector).toBe("3034092155422581607");
  });

  it("refuses the zero address as a deployed contract", () => {
    const d = deploymentFrom({ launchpad: "0x0000000000000000000000000000000000000000" }, "mainnet");
    expect(d.launchpad).toBeNull();
    expect(d.chainId).toBe(5042);
    expect(d.tokenMessengerV2).toBe("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
  });
});
