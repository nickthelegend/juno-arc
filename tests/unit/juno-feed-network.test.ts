import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("viem", async (original) => ({
  ...await original<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: calls.read }),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); calls.read.mockReset(); });
it("reads the public feed when hosted on mainnet", async () => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "mainnet");
  vi.stubEnv("ARC_MAINNET_RPC_URL", "https://rpc.mainnet.arc.io");
  const now = BigInt(Math.floor(Date.now() / 1000));
  calls.read.mockImplementation(async ({ functionName }) => functionName === "decimals" ? 8 : [1n, 100000000n, now, now, 1n]);
  const { usdcPeg } = await import("@/lib/juno/chainlink");
  expect(await usdcPeg()).toMatchObject({ priceUsd: 1, stale: false });
  expect(calls.read).toHaveBeenCalledTimes(2);
});
it("retains the hosted-testnet guard", async () => {
  vi.stubEnv("NEXT_PUBLIC_ARC_NETWORK", "testnet");
  vi.stubEnv("ARC_MAINNET_RPC_URL", "https://rpc.mainnet.arc.io");
  const { usdcPeg } = await import("@/lib/juno/chainlink");
  expect(await usdcPeg()).toBeNull();
  expect(calls.read).not.toHaveBeenCalled();
});
