import "server-only";

import { encodeFunctionData, getAddress, isAddress, isHex, pad, parseEventLogs, type Address, type Hex } from "viem";

import { junoLaunchpadAbi } from "./abi";
import { CallerError } from "./api";
import { cctpDestinations, cctpDomainName, irisApiUrl, type CctpDomain } from "./arc";
import { publicClient } from "./client";
import { fetchPoolSnapshot, weiToUi, type ContractCall } from "./launchpad";
import { ARC_CCTP_DOMAIN, deployment, launchpadAddress, network } from "./network";
import { prepare, type UnsignedTransaction } from "./tx";

/**
 * Creator fees out of Arc through Circle CCTP V2.
 *
 * A creator's accrued USDC fees can be claimed to another chain in one
 * transaction: `JunoLaunchpad.claimCreatorFeesCrossChain` burns them through
 * Circle's TokenMessengerV2 on Arc (domain 26) with the creator's chosen
 * recipient on the destination; once Circle's Iris service attests the burn,
 * anyone can mint it there (`MessageTransmitterV2.receiveMessage`).
 *
 *  - fast (finality threshold 1000): Circle's fast-transfer fee applies, read
 *    from Iris and capped with a margin as `maxFee`;
 *  - standard (2000): `maxFee` is Iris's standard minimum, normally 0.
 * The launchpad requires `maxFee < amount`, so a claim smaller than the fee is
 * refused before anyone signs.
 */

export const FAST_FINALITY = 1000;
export const STANDARD_FINALITY = 2000;

let fetchImpl: typeof fetch | null = null;
/** Tests: replace the network Iris is called over. */
export function configureIrisForTests(impl: typeof fetch | null): void {
  fetchImpl = impl;
}

async function iris(path: string): Promise<{ status: number; json: unknown }> {
  const res = await (fetchImpl ?? fetch)(`${irisApiUrl(network())}${path}`, {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Iris's minimum fee, in basis points of the amount, for a finality threshold. Null when Iris didn't say. */
export async function cctpFeeBps(destinationDomain: number, finalityThreshold: number): Promise<number | null> {
  const { status, json } = await iris(`/v2/burn/USDC/fees/${ARC_CCTP_DOMAIN}/${destinationDomain}`).catch(() => ({ status: 0, json: null }));
  if (status !== 200 || !Array.isArray(json)) return null;
  const row = (json as Array<{ finalityThreshold?: number; minimumFee?: number }>).find(
    (r) => Number(r.finalityThreshold) === finalityThreshold,
  );
  return row && Number.isFinite(Number(row.minimumFee)) ? Number(row.minimumFee) : null;
}

/** The most the creator lets Circle take: the fee in bps, rounded up, plus a fifth of headroom and a cent. Pure. */
export function maxFeeFor(amount: bigint, feeBps: number): bigint {
  if (!(feeBps > 0)) return 0n;
  // Basis points can be fractional (e.g. 1.3): work in hundredths of a bp.
  const centiBps = BigInt(Math.ceil(feeBps * 100));
  const fee = (amount * centiBps + 999_999n) / 1_000_000n;
  return fee + fee / 5n + 10_000n;
}

/** A recipient on the destination as CCTP's bytes32: an EVM address left-padded, or 32 raw bytes (Solana). Pure. */
export function mintRecipientFor(recipient: string, destination: CctpDomain): Hex {
  if (isAddress(recipient)) {
    if (!destination.evm) throw new CallerError(`${destination.name} needs a 32-byte recipient, not an EVM address`);
    return pad(getAddress(recipient), { size: 32 }).toLowerCase() as Hex;
  }
  if (isHex(recipient) && recipient.length === 66) {
    if (destination.evm && !/^0x0{24}/i.test(recipient)) throw new CallerError("That recipient is not an EVM address");
    return recipient.toLowerCase() as Hex;
  }
  throw new CallerError("recipient must be an address (or a 32-byte hex account for Solana)");
}

export type CrossChainClaimBuild = {
  steps: UnsignedTransaction[];
  cctp: {
    destinationDomain: number;
    destination: string;
    amount: number;
    maxFee: number;
    finalityThreshold: number;
    mintRecipient: Hex;
    tokenMessenger: Address | null;
  };
};

/** The pure call: `claimCreatorFeesCrossChain(token, domain, recipient, maxFee, threshold)`. */
export function crossChainClaimCall(params: {
  launchpad: Address;
  token: Address;
  destinationDomain: number;
  mintRecipient: Hex;
  maxFee: bigint;
  finalityThreshold: number;
  destinationName: string;
}): ContractCall {
  return {
    to: params.launchpad,
    data: encodeFunctionData({
      abi: junoLaunchpadAbi,
      functionName: "claimCreatorFeesCrossChain",
      args: [params.token, params.destinationDomain, params.mintRecipient, params.maxFee, params.finalityThreshold],
    }),
    value: 0n,
    label: `Sending your fees to ${params.destinationName} through Circle CCTP`,
  };
}

export async function buildCrossChainClaim(request: {
  creator: Address;
  token: Address;
  destinationDomain: number;
  recipient?: string;
  fast?: boolean;
}): Promise<CrossChainClaimBuild> {
  const destination = cctpDestinations(network()).find((d) => d.domain === request.destinationDomain);
  if (!destination) {
    throw new CallerError(
      `CCTP can't send to domain ${request.destinationDomain} from Arc ${network()}. One of: ${cctpDestinations(network())
        .map((d) => `${d.domain} (${d.name})`)
        .join(", ")}`,
    );
  }
  const snapshot = await fetchPoolSnapshot(request.token);
  if (!snapshot) throw new CallerError("This coin has no pool on this network", 404);
  if (snapshot.pool.creator !== request.creator) throw new CallerError("Only the creator can claim this coin's fees", 403);
  const amount = snapshot.pool.creatorFees;
  if (amount === 0n) throw new CallerError("Nothing to claim yet");

  const finalityThreshold = request.fast ? FAST_FINALITY : STANDARD_FINALITY;
  const feeBps = await cctpFeeBps(destination.domain, finalityThreshold);
  if (request.fast && feeBps === null) {
    throw new CallerError("Circle's fast-transfer fee could not be read from Iris; try the standard transfer", 503);
  }
  const maxFee = maxFeeFor(amount, feeBps ?? 0);
  if (maxFee >= amount) {
    throw new CallerError(
      `These fees (${weiToUi(amount, 6)} USDC) don't cover Circle's ${request.fast ? "fast " : ""}transfer fee yet. Claim on Arc, or wait for more.`,
    );
  }
  const mintRecipient = mintRecipientFor(request.recipient ?? request.creator, destination);
  const steps = await prepare(request.creator, [
    crossChainClaimCall({
      launchpad: snapshot.launchpad,
      token: snapshot.token,
      destinationDomain: destination.domain,
      mintRecipient,
      maxFee,
      finalityThreshold,
      destinationName: destination.name,
    }),
  ]);
  return {
    steps,
    cctp: {
      destinationDomain: destination.domain,
      destination: destination.name,
      amount: weiToUi(amount, 6),
      maxFee: weiToUi(maxFee, 6),
      finalityThreshold,
      mintRecipient,
      tokenMessenger: deployment().tokenMessengerV2,
    },
  };
}

export type CctpStatus = {
  status: "pending" | "complete" | "unknown";
  attestation?: Hex;
  message?: Hex;
  destinationDomain: number | null;
  destination: string | null;
  /** Why the answer is what it is, when Iris did not simply say. */
  note?: string;
  iris: string;
};

/** A CCTP burn's attestation status from Circle's Iris. */
export async function cctpStatus(hash: Hex): Promise<CctpStatus> {
  const base = irisApiUrl(network());
  // What our own chain says the burn was, so a burn Iris hasn't seen is "pending", not "unknown".
  let burned: { destinationDomain: number } | null = null;
  const launchpad = launchpadAddress();
  const receipt = await publicClient().getTransactionReceipt({ hash }).catch(() => null);
  if (receipt && launchpad) {
    const [event] = parseEventLogs({
      abi: junoLaunchpadAbi,
      eventName: "CreatorFeesBridged",
      logs: receipt.logs.filter((log) => getAddress(log.address) === launchpad),
    });
    if (event) burned = { destinationDomain: Number(event.args.destinationDomain) };
  }
  const name = (domain: number | null) => (domain === null ? null : cctpDomainName(network(), domain));

  const { status, json } = await iris(`/v2/messages/${ARC_CCTP_DOMAIN}?transactionHash=${hash}`).catch(() => ({ status: 0, json: null }));
  const messages = (json as { messages?: Array<Record<string, unknown>> } | null)?.messages;
  const first = Array.isArray(messages) ? messages[0] : undefined;
  if (status === 200 && first) {
    const decoded = first.decodedMessage as { destinationDomain?: string | number } | undefined;
    const domain = decoded?.destinationDomain !== undefined ? Number(decoded.destinationDomain) : (burned?.destinationDomain ?? null);
    const complete = first.status === "complete" && typeof first.attestation === "string" && first.attestation !== "PENDING";
    return {
      status: complete ? "complete" : "pending",
      ...(complete ? { attestation: first.attestation as Hex } : {}),
      ...(typeof first.message === "string" && first.message.startsWith("0x") ? { message: first.message as Hex } : {}),
      destinationDomain: domain,
      destination: name(domain),
      iris: base,
    };
  }
  if (burned) {
    return {
      status: "pending",
      destinationDomain: burned.destinationDomain,
      destination: name(burned.destinationDomain),
      note: "The burn is on Arc; Circle's Iris has not published an attestation for it yet.",
      iris: base,
    };
  }
  return { status: "unknown", destinationDomain: null, destination: null, note: "Neither Arc nor Iris knows this as a CCTP burn.", iris: base };
}
