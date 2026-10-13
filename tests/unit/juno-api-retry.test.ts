import { describe, expect, it, vi } from "vitest";

import { isRpcBusy, junoJson, junoRead, retryWhenBusy } from "@/lib/juno/api";

describe("retryWhenBusy", () => {
  it("waits out an RPC refusal and returns the answer", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("HTTP request failed. Status: 429"))
      .mockResolvedValueOnce("ok");
    await expect(retryWhenBusy(run, [1, 1])).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error that is not the RPC being busy", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("execution reverted: Slippage"));
    await expect(retryWhenBusy(run, [1, 1])).rejects.toThrow("Slippage");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up after its budget and surfaces the refusal", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("Too Many Requests"));
    await expect(retryWhenBusy(run, [1, 1])).rejects.toThrow("Too Many Requests");
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe("junoRead", () => {
  it("answers 503 with a sentence only once the retries are spent", async () => {
    const response = await junoRead(() => Promise.reject(new Error("rate limit")));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/rate-limiting/);
  }, 10_000);

  it("classifies refusals, not faults", () => {
    expect(isRpcBusy(new Error("Connection rate limits exceeded"))).toBe(true);
    expect(isRpcBusy(new Error("duplicate key value violates unique constraint"))).toBe(false);
  });
});


describe("junoJson headers", () => {
  it("preserves Headers and tuple entries alongside mobile CORS defaults", () => {
    for (const headers of [new Headers({ "Retry-After": "3" }), [["Retry-After", "3"]] as [string, string][]]) {
      const response = junoJson({ error: "busy" }, { status: 503, headers });
      expect(response.headers.get("retry-after")).toBe("3");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("content-type")).toContain("application/json");
    }
  });
});
