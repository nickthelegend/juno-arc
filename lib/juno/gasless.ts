import "server-only";

import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseSignature,
  recoverTypedDataAddress,
  stringToBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";

import { junoLaunchpadAbi, junoTokenAbi } from "./abi";
import { CallerError } from "./api";
import { publicClient } from "./client";
import { InsufficientLiquidityError, fetchPoolSnapshot, quoteTrade, uiToWei, weiToUi } from "./launchpad";
import { memoAddress, memoLine, memoLive, postMemoId, wrapInMemo } from "./memo";
import { chainId, requireLaunchpad, usdcAddress } from "./network";
import { relay, relayerAddress } from "./relayer";
import { withRetry } from "./rpc";
import { describeReceipt, explainFailure, type SubmitResult } from "./tx";

/**
 * Gasless buys: the buyer signs, Juno's relayer pays the gas.
 *
 * USDC on Arc is Circle's FiatToken, which implements EIP-3009. The buyer signs
 * one EIP-712 `ReceiveWithAuthorization` (domain "USDC" / "2" / chain / 0x3600…)
 * that lets *only the launchpad* pull exactly `quoteIn` from them, with a nonce
 * the launchpad derives from the whole trade:
 *
 *   nonce = keccak256(abi.encode(keccak256("JunoBuy"), chainid, launchpad,
 *                                token, buyer, quoteIn, minBaseOut, deadline, salt))
 *
 * so the signature authorises this buy and nothing else — a different coin,
 * size, slippage floor or deadline is a different nonce and fails. The relayer
 * submits `buyWithAuthorization`; the coin and any refund go to the buyer. A
 * wallet whose only asset is USDC that just arrived (a Gateway mint, a CCTP
 * transfer) can buy without first holding gas — on Arc gas is USDC too, but the
 * buyer needs none of it for this.
 */

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function usdcDomain(chain: number, usdc: Address) {
  return { name: "USDC", version: "2", chainId: chain, verifyingContract: getAddress(usdc) } as const;
}

/** The launchpad's `buyNonce`, computed off chain. Pure; checked against the contract in the tests. */
export function buyNonce(params: {
  chainId: number;
  launchpad: Address;
  token: Address;
  buyer: Address;
  quoteIn: bigint;
  minBaseOut: bigint;
  deadline: bigint;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        keccak256(stringToBytes("JunoBuy")),
        BigInt(params.chainId),
        getAddress(params.launchpad),
        getAddress(params.token),
        getAddress(params.buyer),
        params.quoteIn,
        params.minBaseOut,
        params.deadline,
        params.salt,
      ],
    ),
  );
}

export type BuyIntent = {
  token: Address;
  buyer: Address;
  /** USDC base units (6 decimals), as a decimal string. */
  quoteIn: string;
  /** Token base units (18 decimals), as a decimal string. */
  minBaseOut: string;
  /** Unix seconds; also the authorization's `validBefore`. */
  deadline: number;
  salt: Hex;
};

/** The typed data a buyer signs for `intent`. Pure. */
export function buyTypedData(intent: BuyIntent, ctx: { chainId: number; launchpad: Address; usdc: Address }) {
  const nonce = buyNonce({
    chainId: ctx.chainId,
    launchpad: ctx.launchpad,
    token: intent.token,
    buyer: intent.buyer,
    quoteIn: BigInt(intent.quoteIn),
    minBaseOut: BigInt(intent.minBaseOut),
    deadline: BigInt(intent.deadline),
    salt: intent.salt,
  });
  return {
    domain: usdcDomain(ctx.chainId, ctx.usdc),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: intent.buyer,
      to: getAddress(ctx.launchpad),
      value: intent.quoteIn,
      validAfter: "0",
      validBefore: String(intent.deadline),
      nonce,
    },
  };
}

/** How long a signed intent is good for. */
const INTENT_SECONDS = 5 * 60;

export async function buildBuyIntent(request: { token: Address; owner: Address; amountIn: number; slippageBps?: number }) {
  const relayer = relayerAddress();
  if (!relayer) throw new CallerError("Gasless buys are off on this server (no relayer key)", 503);
  if (!(request.amountIn > 0)) throw new CallerError("Amount must be greater than zero");
  const snapshot = await fetchPoolSnapshot(request.token);
  if (!snapshot) throw new CallerError("This coin has no pool on this network", 404);
  if (snapshot.curve.graduated || snapshot.curve.complete) {
    throw new CallerError("Gasless buys are for coins still on their curve", 409);
  }
  const quoteIn = uiToWei(request.amountIn, 6);
  const balance = await withRetry(() =>
    publicClient().readContract({ address: usdcAddress(), abi: erc20Abi, functionName: "balanceOf", args: [request.owner] }),
  );
  if (balance < quoteIn) throw new CallerError(`This wallet holds ${weiToUi(balance, 6)} USDC; the buy needs ${request.amountIn}`, 409);

  const quote = await quoteTrade({ snapshot, side: "buy", amountIn: request.amountIn, amountInRaw: quoteIn, slippageBps: request.slippageBps ?? 100 }).catch(
    (error: unknown) => {
      if (error instanceof InsufficientLiquidityError) throw new CallerError("This curve cannot fill that size. Try a smaller amount.");
      throw error;
    },
  );
  if (quote.raw.amountOut === 0n) throw new CallerError("That amount is too small to trade");
  // A buy that would complete the curve refunds part of its input; a relayed buy
  // pulls exactly `quoteIn` first, so it is kept to buys that fit.
  if (quote.raw.amountIn > 0n && quote.amountUsed + 1e-6 < request.amountIn) {
    throw new CallerError("That buy would fill the curve; buy it with a signed transaction instead", 409);
  }

  const launchpad = requireLaunchpad();
  const intent: BuyIntent = {
    token: snapshot.token,
    buyer: request.owner,
    quoteIn: quoteIn.toString(),
    minBaseOut: quote.raw.minimumAmountOut.toString(),
    deadline: Math.floor(Date.now() / 1000) + INTENT_SECONDS,
    salt: keccak256(toHex(`${request.owner}:${snapshot.token}:${quoteIn}:${Date.now()}:${Math.random()}`)),
  };
  return {
    typedData: buyTypedData(intent, { chainId: chainId(), launchpad, usdc: usdcAddress() }),
    intent,
    quote: { amountOut: quote.amountOut, minimumAmountOut: quote.minimumAmountOut, price: snapshot.price, fee: quote.fee, priceImpact: quote.priceImpact },
    relayer,
  };
}

/** Read an intent from JSON, field by field. Pure. */
export function intentFromJson(raw: unknown): BuyIntent {
  const o = (raw ?? {}) as Record<string, unknown>;
  const address = (v: unknown, name: string) => {
    if (typeof v !== "string" || !isAddress(v)) throw new CallerError(`intent.${name} must be an address`);
    return getAddress(v);
  };
  const units = (v: unknown, name: string) => {
    if ((typeof v !== "string" && typeof v !== "number") || !/^\d+$/.test(String(v))) throw new CallerError(`intent.${name} must be whole base units`);
    return String(v);
  };
  if (typeof o.salt !== "string" || !isHex(o.salt) || o.salt.length !== 66) throw new CallerError("intent.salt must be bytes32");
  const deadline = Number(o.deadline);
  if (!Number.isInteger(deadline) || deadline <= 0) throw new CallerError("intent.deadline must be unix seconds");
  return {
    token: address(o.token, "token"),
    buyer: address(o.buyer, "buyer"),
    quoteIn: units(o.quoteIn, "quoteIn"),
    minBaseOut: units(o.minBaseOut, "minBaseOut"),
    deadline,
    salt: o.salt as Hex,
  };
}

/** The relayer submits a signed intent: `buyWithAuthorization`, through Memo where it runs. */
export async function submitRelayedBuy(body: { intent: unknown; signature: unknown }): Promise<SubmitResult & { gasless: true; relayer: Address; memoTagged: boolean }> {
  const relayer = relayerAddress();
  if (!relayer) throw new CallerError("Gasless buys are off on this server (no relayer key)", 503);
  const intent = intentFromJson(body.intent);
  const signature = typeof body.signature === "string" && isHex(body.signature) ? (body.signature as Hex) : null;
  if (!signature) throw new CallerError("signature must be the buyer's signature of the typed data");
  if (intent.deadline <= Math.floor(Date.now() / 1000)) throw new CallerError("This intent expired. Ask for a fresh one.", 409);

  const launchpad = requireLaunchpad();
  const typed = buyTypedData(intent, { chainId: chainId(), launchpad, usdc: usdcAddress() });
  // Checked here so a bad signature never costs the relayer gas.
  const signer = await recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: {
      ...typed.message,
      value: BigInt(typed.message.value),
      validAfter: 0n,
      validBefore: BigInt(typed.message.validBefore),
    },
    signature,
  }).catch(() => null);
  if (!signer || signer !== intent.buyer) throw new CallerError("The authorization isn't signed by the buyer", 400);

  const { v, r, s, yParity } = parseSignature(signature);
  const data = encodeFunctionData({
    abi: junoLaunchpadAbi,
    functionName: "buyWithAuthorization",
    args: [
      intent.token,
      intent.buyer,
      BigInt(intent.quoteIn),
      BigInt(intent.minBaseOut),
      BigInt(intent.deadline),
      intent.salt,
      0n,
      BigInt(intent.deadline),
      Number(v ?? BigInt(27 + (yParity ?? 0))),
      r,
      s,
    ],
  });

  let call: { to: Address; data: Hex } = { to: launchpad, data };
  let memoTagged = false;
  const memo = memoAddress();
  if (memo && (await memoLive())) {
    const symbol = await withRetry(() => publicClient().readContract({ address: intent.token, abi: junoTokenAbi, functionName: "symbol" })).catch(() => null);
    const line = memoLine({ action: "buy", symbol, amount: `${weiToUi(BigInt(intent.quoteIn), 6)} USDC` });
    call = wrapInMemo({ memo, target: launchpad, data, memoId: postMemoId(intent.token), line });
    memoTagged = true;
  }

  // Estimated first: a doomed relay is refused with the reason, at no cost.
  let estimate: bigint;
  try {
    estimate = await publicClient().estimateGas({ account: relayer, to: call.to, data: call.data });
  } catch (error) {
    throw new CallerError(explainFailure(error), 422);
  }
  const sent = await relay({ ...call, gas: (estimate * 13n) / 10n + 30_000n });
  if (sent.receipt.status !== "success") {
    throw new CallerError(`The relayed buy reverted. It is on-chain as ${sent.hash}.`, 422);
  }
  const described = await describeReceipt(sent.receipt, intent.buyer, sent.confirmMs);
  return { ...described, gasless: true, relayer, memoTagged };
}
