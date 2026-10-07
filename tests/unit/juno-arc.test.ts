import { readFileSync } from "node:fs";

import {
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { junoLaunchpadAbi } from "@/lib/juno/abi";
import { ccipLanes, cctpDestinations, gatewaySources } from "@/lib/juno/arc";
import { CCIP_MESSAGE_SENT_V16, CCIP_MESSAGE_SENT_V2, ccipMessageIdsIn } from "@/lib/juno/ccip-events";
import { CCIP_POOL_INIT_CODE, CCIP_POOL_INIT_CODE_HASH } from "@/lib/juno/ccip-pool-code";
import { DEFAULT_LANE_LIMIT, GENERIC_EXTRA_ARGS_V2_TAG, ccipRouterAbi, ccipTokenMessage, chainUpdatesFor, genericExtraArgsV2 } from "@/lib/juno/ccip";
import { crossChainClaimCall, maxFeeFor as cctpMaxFee, mintRecipientFor } from "@/lib/juno/cctp";
import { MAX_FEED_AGE_SECONDS, feedIdOf, feedNameOf, readingFrom } from "@/lib/juno/chainlink";
import { RECEIVE_WITH_AUTHORIZATION_TYPES, buyNonce, buyTypedData, intentFromJson as buyIntentFromJson } from "@/lib/juno/gasless";
import { BURN_INTENT_DOMAIN, BURN_INTENT_TYPES, buildBurnIntent, intentFromJson, intentToJson, maxFeeFor, type GatewayNetwork } from "@/lib/juno/gateway";
import { MEMO_CALL_FAILED, memoAbi, memoLine, postMemoId, probeRevertProvesCallFrom, wrapInMemo } from "@/lib/juno/memo";

const USDC: Address = "0x3600000000000000000000000000000000000000";
const LAUNCHPAD: Address = "0x1C75B3F897AD80a1A6fb32f864Cc845aabcC657E";
const TOKEN: Address = "0xF09947Ef14CBa630fd47eE5Ecc8A25a840b0679C";

/* ------------------------------------------------------------------ */
/* Circle Gateway                                                      */
/* ------------------------------------------------------------------ */

const gateway: GatewayNetwork = {
  apiUrl: "https://gateway-api-testnet.circle.com",
  wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  arcDomain: 26,
  arcUsdc: USDC,
  sources: gatewaySources("testnet"),
};

describe("Circle Gateway burn intents", () => {
  const depositor = privateKeyToAccount(generatePrivateKey());
  const salt = keccak256(stringToBytes("salt")) as Hex;

  it("builds an intent to Arc, through Circle's minter, as Arc's USDC, signer = depositor", () => {
    const intent = buildBurnIntent(gateway, { sourceDomain: 6, depositor: depositor.address, recipient: depositor.address, value: 25_000_000n, salt });
    expect(intent.spec.destinationDomain).toBe(26);
    expect(intent.spec.sourceContract).toBe(`0x000000000000000000000000${gateway.wallet.slice(2).toLowerCase()}`);
    expect(intent.spec.destinationContract).toBe(`0x000000000000000000000000${gateway.minter.slice(2).toLowerCase()}`);
    expect(intent.spec.sourceToken).toBe("0x000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e");
    expect(intent.spec.destinationToken).toBe(`0x000000000000000000000000${USDC.slice(2)}`);
    expect(intent.spec.sourceSigner).toBe(intent.spec.sourceDepositor);
    expect(intent.spec.destinationCaller).toBe(`0x${"0".repeat(64)}`);
    expect(intent.maxFee).toBe(maxFeeFor(6, 25_000_000n));
  });

  it("caps the fee at the source's gas fee + 25%, the 0.005% transfer fee and a cent", () => {
    expect(maxFeeFor(6, 100_000_000n)).toBe(12_500n + 5_000n + 10_000n);
    expect(maxFeeFor(0, 0n)).toBe(1_250_000n + 10_000n); // Ethereum's gas fee is the big one
    expect(maxFeeFor(999, 0n)).toBe(1_250_000n + 10_000n); // unknown domain: the conservative default
  });

  it("refuses unknown sources and sizes outside 0 < value ≤ 10,000 USDC", () => {
    expect(() => buildBurnIntent(gateway, { sourceDomain: 99, depositor: depositor.address, recipient: depositor.address, value: 1n, salt })).toThrow(/sourceDomain/);
    expect(() => buildBurnIntent(gateway, { sourceDomain: 6, depositor: depositor.address, recipient: depositor.address, value: 0n, salt })).toThrow(/amount/);
    expect(() => buildBurnIntent(gateway, { sourceDomain: 6, depositor: depositor.address, recipient: depositor.address, value: 10_000_000_001n, salt })).toThrow(/amount/);
  });

  it("round-trips through JSON and refuses an intent Juno would not have built", () => {
    const intent = buildBurnIntent(gateway, { sourceDomain: 26, depositor: depositor.address, recipient: depositor.address, value: 1_000_000n, salt });
    const json = intentToJson(intent);
    expect(intentFromJson(gateway, JSON.parse(JSON.stringify(json)))).toEqual(intent);
    const otherMinter = { ...json, spec: { ...json.spec, destinationContract: `0x${"11".repeat(32)}` } };
    expect(() => intentFromJson(gateway, otherMinter)).toThrow(/destinationContract/);
    const greedy = { ...json, maxFee: (intent.maxFee + 1n).toString() };
    expect(() => intentFromJson(gateway, greedy)).toThrow(/maxFee/);
    const relayed = { ...json, spec: { ...json.spec, destinationCaller: `0x${"22".repeat(32)}` } };
    expect(() => intentFromJson(gateway, relayed)).toThrow(/destinationCaller/);
  });

  it("is signed as EIP-712 GatewayWallet v1 and recovers to the depositor", async () => {
    const intent = buildBurnIntent(gateway, { sourceDomain: 6, depositor: depositor.address, recipient: depositor.address, value: 3_000_000n, salt });
    const signature = await depositor.signTypedData({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: intent });
    const signer = await recoverTypedDataAddress({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: intent, signature });
    expect(signer).toBe(depositor.address);
  });
});

/* ------------------------------------------------------------------ */
/* Gasless buys (EIP-3009)                                             */
/* ------------------------------------------------------------------ */

describe("gasless buy intents", () => {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const intent = {
    token: TOKEN,
    buyer: buyer.address,
    quoteIn: "25000000",
    minBaseOut: "1000000000000000000000",
    deadline: 1_900_000_000,
    salt: keccak256(stringToBytes("post:marina")),
  };

  it("derives the launchpad's nonce: keccak(abi.encode(keccak('JunoBuy'), chainid, launchpad, token, buyer, quoteIn, minBaseOut, deadline, salt))", () => {
    const nonce = buyNonce({ chainId: 5042002, launchpad: LAUNCHPAD, token: TOKEN, buyer: buyer.address, quoteIn: 25_000_000n, minBaseOut: 10n ** 21n, deadline: 1_900_000_000n, salt: intent.salt });
    const expected = keccak256(
      encodeAbiParameters(
        parseAbiParams("bytes32,uint256,address,address,address,uint256,uint256,uint256,bytes32"),
        [keccak256(stringToBytes("JunoBuy")), 5042002n, LAUNCHPAD, TOKEN, buyer.address, 25_000_000n, 10n ** 21n, 1_900_000_000n, intent.salt],
      ),
    );
    expect(nonce).toBe(expected);
    // Any change to the trade is a different nonce, so a signature authorises exactly one buy.
    expect(buyNonce({ chainId: 5042002, launchpad: LAUNCHPAD, token: TOKEN, buyer: buyer.address, quoteIn: 25_000_001n, minBaseOut: 10n ** 21n, deadline: 1_900_000_000n, salt: intent.salt })).not.toBe(nonce);
    expect(buyNonce({ chainId: 5042, launchpad: LAUNCHPAD, token: TOKEN, buyer: buyer.address, quoteIn: 25_000_000n, minBaseOut: 10n ** 21n, deadline: 1_900_000_000n, salt: intent.salt })).not.toBe(nonce);
  });

  it("asks for ReceiveWithAuthorization on Circle USDC (\"USDC\" / \"2\"), to the launchpad only, valid until the deadline", async () => {
    const typed = buyTypedData(intent, { chainId: 5042002, launchpad: LAUNCHPAD, usdc: USDC });
    expect(typed.domain).toEqual({ name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC });
    expect(typed.primaryType).toBe("ReceiveWithAuthorization");
    expect(typed.types).toBe(RECEIVE_WITH_AUTHORIZATION_TYPES);
    expect(typed.message).toMatchObject({ from: buyer.address, to: LAUNCHPAD, value: "25000000", validAfter: "0", validBefore: "1900000000" });
    const message = { ...typed.message, value: 25_000_000n, validAfter: 0n, validBefore: 1_900_000_000n };
    const signature = await buyer.signTypedData({ domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message });
    expect(await recoverTypedDataAddress({ domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message, signature })).toBe(buyer.address);
  });

  it("reads an intent back field by field", () => {
    expect(buyIntentFromJson(JSON.parse(JSON.stringify(intent)))).toEqual(intent);
    expect(() => buyIntentFromJson({ ...intent, quoteIn: "1.5" })).toThrow(/quoteIn/);
    expect(() => buyIntentFromJson({ ...intent, salt: "0x12" })).toThrow(/salt/);
    expect(() => buyIntentFromJson({ ...intent, buyer: "nobody" })).toThrow(/buyer/);
  });

  // Against the deployed launchpad on the local Arc fork, when one is running (scripts/arc-fork.sh).
  const forkRpc = process.env.JUNO_FORK_RPC ?? "http://127.0.0.1:8910";
  const forkLaunchpad = readForkLaunchpad();
  it.skipIf(!forkLaunchpad)("matches launchpad.buyNonce on the Arc fork", async () => {
    const client = createPublicClient({ transport: http(forkRpc, { timeout: 5_000 }) });
    const chainId = await client.getChainId().catch(() => null);
    if (chainId !== 5042002) return; // no fork answering: nothing to compare against
    const onchain = await client.readContract({
      address: forkLaunchpad!,
      abi: junoLaunchpadAbi,
      functionName: "buyNonce",
      args: [TOKEN, buyer.address, 25_000_000n, 10n ** 21n, 1_900_000_000n, intent.salt],
    });
    const typed = buyTypedData(intent, { chainId, launchpad: forkLaunchpad!, usdc: USDC });
    expect(typed.message.nonce).toBe(onchain);
  });
});

/* ------------------------------------------------------------------ */
/* CCTP V2 creator fee claims                                          */
/* ------------------------------------------------------------------ */

describe("CCTP cross-chain claims", () => {
  const base = cctpDestinations("testnet").find((d) => d.domain === 6)!;
  const solana = cctpDestinations("testnet").find((d) => d.domain === 5)!;

  it("lists Arc's CCTP destinations and never Arc itself", () => {
    expect(base.name).toBe("Base Sepolia");
    expect(cctpDestinations("mainnet").find((d) => d.domain === 6)?.name).toBe("Base");
    expect(cctpDestinations("testnet").some((d) => d.domain === 26)).toBe(false);
  });

  it("left-pads an EVM recipient to bytes32 and takes a raw 32-byte account for Solana", () => {
    const evm = "0x1111111111111111111111111111111111111111";
    expect(mintRecipientFor(evm, base)).toBe(`0x000000000000000000000000${evm.slice(2)}`);
    expect(() => mintRecipientFor(evm, solana)).toThrow(/Solana account/);
    // The System Program id is 32 zero bytes; a real-looking account round-trips to 32 bytes.
    expect(mintRecipientFor("11111111111111111111111111111111", solana)).toBe(`0x${"00".repeat(32)}`);
    expect(mintRecipientFor("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", solana)).toBe(
      "0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61",
    );
    expect(() => mintRecipientFor("not-base58-0OIl", solana)).toThrow(/not a Solana account/);
    const account = `0x${"ab".repeat(32)}`;
    expect(mintRecipientFor(account, solana)).toBe(account);
    expect(() => mintRecipientFor(account, base)).toThrow(/not an EVM address/);
  });

  it("caps the fee: none for standard, Iris's bps rounded up + 20% + a cent for fast", () => {
    expect(cctpMaxFee(1_000_000n, 0)).toBe(0n);
    // 1 bp of 100 USDC = 10,000 units; +20% = 12,000; + 10,000.
    expect(cctpMaxFee(100_000_000n, 1)).toBe(22_000n);
    // Fractional bps round up, never down.
    expect(cctpMaxFee(1_000_000n, 1.3)).toBe(130n + 26n + 10_000n);
  });

  it("encodes claimCreatorFeesCrossChain(token, domain, recipient, maxFee, threshold)", () => {
    const recipient = mintRecipientFor("0x2222222222222222222222222222222222222222", base);
    const call = crossChainClaimCall({ launchpad: LAUNCHPAD, token: TOKEN, destinationDomain: 6, mintRecipient: recipient, maxFee: 0n, finalityThreshold: 2000, destinationName: "Base Sepolia" });
    expect(call.to).toBe(LAUNCHPAD);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: junoLaunchpadAbi, data: call.data });
    expect(decoded.functionName).toBe("claimCreatorFeesCrossChain");
    expect(decoded.args).toEqual([TOKEN, 6, recipient, 0n, 2000]);
  });
});

/* ------------------------------------------------------------------ */
/* Arc Memo                                                            */
/* ------------------------------------------------------------------ */

describe("Arc Memo tags", () => {
  it("ids a post by keccak256('juno:post:' + lowercase token)", () => {
    expect(postMemoId(TOKEN)).toBe(keccak256(stringToBytes(`juno:post:${TOKEN.toLowerCase()}`)));
    expect(postMemoId(TOKEN.toLowerCase())).toBe(postMemoId(TOKEN));
  });

  it("writes a short readable line", () => {
    expect(memoLine({ action: "buy", symbol: "MARINA", amount: "25 USDC" })).toBe("juno buy $MARINA 25 USDC");
    expect(memoLine({ action: "sell", symbol: "$MARINA" })).toBe("juno sell $MARINA");
  });

  it("wraps a call as Memo.memo(target, data, memoId, memo) without changing what it does", () => {
    const inner = "0xdeadbeef" as Hex;
    const wrapped = wrapInMemo({ memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505", target: LAUNCHPAD, data: inner, memoId: postMemoId(TOKEN), line: "juno buy $X 1 USDC" });
    expect(wrapped.to).toBe("0x5294E9927c3306DcBaDb03fe70b92e01cCede505");
    const decoded = decodeFunctionData({ abi: memoAbi, data: wrapped.data });
    expect(decoded.functionName).toBe("memo");
    expect(decoded.args[0]).toBe(LAUNCHPAD);
    expect(decoded.args[1]).toBe(inner);
    expect(decoded.args[2]).toBe(postMemoId(TOKEN));
    expect(Buffer.from((decoded.args[3] as string).slice(2), "hex").toString()).toBe("juno buy $X 1 USDC");
  });

  it("counts Memo live only when the probe's revert carries the inner call's own revert", () => {
    const innerError = `0x08c379a0${encodeAbiParameters([{ type: "string" }], ["ERC20: transfer amount exceeds balance"]).slice(2)}` as Hex;
    const wrapped = `${MEMO_CALL_FAILED}${encodeAbiParameters([{ type: "bytes" }], [innerError]).slice(2)}`;
    expect(probeRevertProvesCallFrom(wrapped)).toBe(true);
    const emptyInner = `${MEMO_CALL_FAILED}${encodeAbiParameters([{ type: "bytes" }], ["0x"]).slice(2)}`;
    expect(probeRevertProvesCallFrom(emptyInner)).toBe(false);
    expect(probeRevertProvesCallFrom(innerError)).toBe(false);
    expect(probeRevertProvesCallFrom(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Chainlink CCIP                                                      */
/* ------------------------------------------------------------------ */

describe("CCIP Cross-Chain Token sends", () => {
  it("ships Chainlink's BurnMintTokenPool 2.0.0 code, hash-checked", () => {
    expect(keccak256(CCIP_POOL_INIT_CODE)).toBe(CCIP_POOL_INIT_CODE_HASH);
    expect(CCIP_POOL_INIT_CODE_HASH).toBe("0xdb3e7b4a67fbe75c634f0b65d08717c3c77fd5e7e081f75727edd355a9ceec03");
  });

  it("builds a token-only message: ABI-encoded receiver, no data, fee in native USDC, GenericExtraArgsV2", () => {
    const receiver = "0x3333333333333333333333333333333333333333";
    const message = ccipTokenMessage({ token: TOKEN, amount: 10n ** 24n, receiver });
    expect(decodeAbiParameters([{ type: "address" }], message.receiver)[0]).toBe(getAddress(receiver));
    expect(message.data).toBe("0x");
    expect(message.feeToken).toBe("0x0000000000000000000000000000000000000000");
    expect(message.tokenAmounts).toEqual([{ token: TOKEN, amount: 10n ** 24n }]);
    expect(message.extraArgs.slice(0, 10)).toBe(GENERIC_EXTRA_ARGS_V2_TAG);
    expect(decodeAbiParameters([{ type: "uint256" }, { type: "bool" }], `0x${message.extraArgs.slice(10)}`)).toEqual([0n, true]);
    expect(genericExtraArgsV2(200_000n, false).length).toBe(2 + 8 + 128);
    expect(ccipRouterAbi.some((i) => i.type === "function" && i.name === "ccipSend")).toBe(true);
  });

  it("wires a lane with always-on limits under JunoCrossChain's 100M cap", () => {
    const [update] = chainUpdatesFor([{ selector: "10344971235874465080", remotePool: "0x00000000000000000000000000000000ba5e9001", remoteToken: "0x00000000000000000000000000000000ba5e7070" }]);
    expect(update.remoteChainSelector).toBe(10344971235874465080n);
    expect(decodeAbiParameters([{ type: "address" }], update.remotePoolAddresses[0])[0]).toBe(getAddress("0x00000000000000000000000000000000ba5e9001"));
    expect(update.outboundRateLimiterConfig).toEqual(DEFAULT_LANE_LIMIT);
    expect(DEFAULT_LANE_LIMIT.isEnabled).toBe(true);
    expect(DEFAULT_LANE_LIMIT.capacity).toBeLessThanOrEqual(100_000_000n * 10n ** 18n);
    expect(DEFAULT_LANE_LIMIT.rate).toBeLessThan(DEFAULT_LANE_LIMIT.capacity);
    expect(ccipLanes("testnet")[0]).toEqual({ selector: "10344971235874465080", name: "Base Sepolia", evm: true });
  });

  it("reads the message id from OnRamp 2.0's CCIPMessageSent (topic 3) and OnRamp 1.6's header", () => {
    const id = `0x${"ab".repeat(32)}` as Hex;
    const v2 = { topics: [CCIP_MESSAGE_SENT_V2, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, id] as Hex[], data: "0x" as Hex };
    expect(ccipMessageIdsIn([v2])).toEqual([id]);
    const id16 = `0x${"cd".repeat(32)}` as Hex;
    const header = encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "tuple", components: [{ type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }] }, { type: "address" }, { type: "bytes" }] }],
      [[[id16, 1n, 2n, 3n, 4n], "0x0000000000000000000000000000000000000001", "0x"]],
    );
    expect(ccipMessageIdsIn([{ topics: [CCIP_MESSAGE_SENT_V16], data: header }])).toEqual([id16]);
    expect(ccipMessageIdsIn([{ topics: [`0x${"11".repeat(32)}`], data: "0x" }])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Chainlink Data Feeds                                                */
/* ------------------------------------------------------------------ */

describe("Chainlink feed readings", () => {
  const now = 1_800_000_000;
  const address = "0xa109B535C70C8Be9995be64Bb6751AcDB27e03De" as Address;

  it("scales by the feed's decimals and reports age", () => {
    const r = readingFrom("BTC/USD", address, [5n, 8_306_175_576_611n, 0n, BigInt(now - 600), 5n], 8, now)!;
    expect(r.priceUsd).toBeCloseTo(83_061.75576611, 6);
    expect(r.ageSeconds).toBe(600);
    expect(r.stale).toBe(false);
    expect(r.feedId).toBe(feedIdOf("BTC/USD"));
  });

  it("calls a reading past the heartbeat + 1h stale, and refuses a non-positive or unfinished answer", () => {
    expect(readingFrom("BTC/USD", address, [5n, 1n, 0n, BigInt(now - MAX_FEED_AGE_SECONDS - 1), 5n], 8, now)!.stale).toBe(true);
    expect(readingFrom("BTC/USD", address, [5n, 0n, 0n, BigInt(now), 5n], 8, now)).toBeNull();
    expect(readingFrom("BTC/USD", address, [5n, -1n, 0n, BigInt(now), 5n], 8, now)).toBeNull();
    expect(readingFrom("BTC/USD", address, [6n, 1n, 0n, BigInt(now), 5n], 8, now)).toBeNull();
  });

  it("names a feed from its name or its JunoTrackers id", () => {
    expect(feedNameOf("ETH/USD")).toBe("ETH/USD");
    expect(feedNameOf(feedIdOf("PAXG/USD"))).toBe("PAXG/USD");
    expect(feedNameOf("AAPL/USD")).toBeNull();
  });
});

function parseAbiParams(list: string) {
  return list.split(",").map((type) => ({ type }));
}

function readForkLaunchpad(): Address | null {
  try {
    const text = readFileSync(".fork/arc-fork.json", "utf8");
    const match = /"launchpad":\s*"(0x[0-9a-fA-F]{40})"/.exec(text);
    return match ? getAddress(match[1]) : null;
  } catch {
    return null;
  }
}

