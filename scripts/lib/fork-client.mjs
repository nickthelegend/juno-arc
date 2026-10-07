// A thin client for driving Juno's API against the local Arc fork the way the app does:
// the API builds unsigned transactions, a local key signs them, the API submits them.
// Used by scripts/e2e-fork.mjs and scripts/seed-fork.mjs. Keys here are throwaway keys
// generated per run and funded with anvil_setBalance — fork only.

import { createPublicClient, http, numberToHex, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const API = (process.env.JUNO_API_URL || "http://127.0.0.1:8911").replace(/\/$/, "");
export const RPC = process.env.ARC_RPC_URL || "http://127.0.0.1:8910";

export const fork = createPublicClient({ transport: http(RPC, { timeout: 60_000 }) });

/** Refuse anything but a local node: these scripts send real transactions. */
export async function assertLocalFork() {
  const host = new URL(RPC).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`refusing to run against ${RPC}: fork scripts only talk to a local node`);
  }
  const chainId = await fork.getChainId();
  if (chainId !== 5042002) throw new Error(`the node on ${RPC} is chain ${chainId}, not an Arc testnet fork (5042002)`);
  return chainId;
}

export function freshAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

/** Give `address` `usdc` USDC on the fork: Arc's native balance is USDC (18 decimals). */
export async function fund(address, usdc) {
  await fork.request({ method: "anvil_setBalance", params: [address, numberToHex(parseEther(String(usdc)))] });
}

export class ApiError extends Error {
  constructor(status, body, path) {
    super(`${path} → ${status}: ${body?.error ?? JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 300) };
  }
  if (!res.ok) throw new ApiError(res.status, json, `${method} ${path}`);
  return json;
}

export const get = (path) => api("GET", path);
export const post = (path, body) => api("POST", path, body);

/** Sign each built step with `account` and submit it, in order. Returns the SubmitResults. */
export async function signAndSubmit(account, steps, log = () => {}) {
  const results = [];
  for (const step of steps) {
    const r = step.request;
    const signed = await account.signTransaction({
      type: "eip1559",
      chainId: r.chainId,
      to: r.to,
      data: r.data,
      value: BigInt(r.value),
      nonce: r.nonce,
      gas: BigInt(r.gas),
      maxFeePerGas: BigInt(r.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(r.maxPriorityFeePerGas),
    });
    const result = await post("/api/juno/tx/submit", { signed });
    log(step.label, result);
    results.push(result);
  }
  return results;
}

/** Sign the server's typed data (decimal-string uint256s become bigints, as viem wants). */
export async function signTyped(account, typedData) {
  const bigints = (fields, value) => {
    const out = { ...value };
    for (const field of fields) {
      const t = field.type;
      if (/^u?int\d*$/.test(t) && out[field.name] !== undefined) out[field.name] = BigInt(out[field.name]);
      else if (typedData.types[t] && out[field.name]) out[field.name] = bigints(typedData.types[t], out[field.name]);
    }
    return out;
  };
  const message = bigints(typedData.types[typedData.primaryType], typedData.message);
  return account.signTypedData({ domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message });
}
