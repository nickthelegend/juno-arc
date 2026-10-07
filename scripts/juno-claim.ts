/**
 * Claim a creator's accrued trading fees from the Juno launchpad on Arc —
 * to a wallet on Arc, or straight to another chain through Circle CCTP V2.
 *
 *   npm run juno:claim -- --token 0x…                       # show what is claimable
 *   npm run juno:claim -- --token 0x… --yes                 # claim it to the script wallet on Arc
 *   npm run juno:claim -- --latest --to 0x… --yes
 *   npm run juno:claim -- --token 0x… --domain 6 --yes      # burn on Arc, mint on Base Sepolia
 *   npm run juno:claim -- --token 0x… --domain 0 --recipient 0x… --fast --yes
 *
 * Options:
 *   --token <address> | --latest
 *   --to <address>          same-chain claim: who on Arc receives the USDC (default: the creator)
 *   --domain <n>            cross-chain claim: the CCTP V2 destination domain (Base 6, Ethereum 0,
 *                           Arbitrum 3, OP 2, Avalanche 1, Polygon 7, …; Arc itself, 26, is refused)
 *   --recipient <address>   who receives it on the destination (default: the creator's address)
 *   --fast                  Circle's fast transfer (finality threshold 1000; max fee read from Iris).
 *                           Default is the standard transfer: threshold 2000, max fee 0.
 *   --max-fee <USDC>        override the max fee Circle may take (must be below the amount)
 *   --yes                   send it
 *
 * The cross-chain claim is `claimCreatorFeesCrossChain(token, domain, bytes32(recipient), maxFee,
 * threshold)`: the launchpad burns the fees through Circle's TokenMessengerV2 and Circle mints
 * them on the destination once Iris attests (minutes for standard, seconds for fast). Check
 * progress with `GET {iris}/v2/messages/26?transactionHash=0x…` (printed below).
 *
 * Only the coin's creator can claim, so this signs with the same script key `juno:launch` used.
 * Built the way `POST /api/juno/tx/claim` builds it.
 *
 * Imports only `lib/juno` modules without `server-only`, which throws outside
 * Next's bundler — see `scripts/lib/cli.ts`.
 */

import { encodeFunctionData, getAddress, isAddress, pad, parseUnits, type Hex } from "viem";

import { junoLaunchpadAbi } from "../lib/juno/abi";
import { cctpDestinations, irisApiUrl } from "../lib/juno/arc";
import {
  buildClaimCreatorFeesCall,
  fetchCreatorFees,
  fetchPoolSnapshot,
  invalidatePoolSnapshot,
  type ContractCall,
} from "../lib/juno/launchpad";
import { ARC_CCTP_DOMAIN, deployment, isMainnet, localFork, network } from "../lib/juno/network";
import {
  amount,
  arg,
  flag,
  header,
  launchpadEvents,
  line,
  links,
  numberArg,
  requireBalance,
  resolveToken,
  run,
  scriptAccount,
  send,
} from "./lib/cli";

const FAST_FINALITY = 1000;
const STANDARD_FINALITY = 2000;

/** Iris's minimum fee for a threshold, in basis points of the amount (may be fractional). */
async function irisFeeBps(destinationDomain: number, threshold: number): Promise<number | null> {
  try {
    const res = await fetch(`${irisApiUrl(network())}/v2/burn/USDC/fees/${ARC_CCTP_DOMAIN}/${destinationDomain}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ finalityThreshold?: number; minimumFee?: number }>;
    const row = Array.isArray(rows) ? rows.find((r) => Number(r.finalityThreshold) === threshold) : undefined;
    return row && Number.isFinite(Number(row.minimumFee)) ? Number(row.minimumFee) : null;
  } catch {
    return null;
  }
}

/** The fee in bps rounded up, plus a fifth of headroom and a cent — what the app allows (`lib/juno/cctp.ts`). */
function maxFeeFor(value: bigint, feeBps: number): bigint {
  if (!(feeBps > 0)) return 0n;
  const centiBps = BigInt(Math.ceil(feeBps * 100));
  const fee = (value * centiBps + 999_999n) / 1_000_000n;
  return fee + fee / 5n + 10_000n;
}

async function main() {
  const token = await resolveToken();
  const account = scriptAccount();
  header(account.address);

  const domainArg = arg("domain");
  const crossChain = domainArg !== undefined;
  const toArg = arg("to");
  if (toArg && !isAddress(toArg)) throw new Error(`--to ${toArg} is not an address`);
  if (toArg && crossChain) throw new Error("--to is for a claim on Arc; a cross-chain claim takes --recipient");
  const to = toArg ? getAddress(toArg) : account.address;

  const snapshot = await fetchPoolSnapshot(token);
  if (!snapshot) throw new Error(`${token} has no pool on this launchpad`);
  const { pool, quote } = snapshot;

  line("token", token);
  line("creator", pool.creator);
  line("claimable", amount(pool.creatorFees, quote.decimals, quote.symbol));
  line("claimed so far", amount(pool.creatorFeesClaimed, quote.decimals, quote.symbol));

  if (pool.creator !== account.address) {
    throw new Error(`Only the creator (${pool.creator}) can claim; this key is ${account.address}.`);
  }
  if (pool.creatorFees === 0n) {
    console.log("\nNothing to claim yet.");
    return;
  }

  let call: ContractCall;
  let destinationName = "Arc";
  let irisHint: string | null = null;
  if (crossChain) {
    const domain = Number(domainArg);
    if (!Number.isInteger(domain) || domain < 0) throw new Error(`--domain ${domainArg} is not a CCTP domain number`);
    if (domain === ARC_CCTP_DOMAIN) throw new Error("Domain 26 is Arc itself; claim on Arc without --domain.");
    const destination = cctpDestinations(network()).find((d) => d.domain === domain);
    if (!destination) {
      throw new Error(
        `CCTP can't send to domain ${domain} from Arc ${network()}. One of: ${cctpDestinations(network())
          .map((d) => `${d.domain} (${d.name})`)
          .join(", ")}`,
      );
    }
    if (!destination.evm) throw new Error(`${destination.name} needs a 32-byte recipient; claim there with the app.`);
    if (!deployment().tokenMessengerV2) throw new Error("No CCTP TokenMessengerV2 is recorded for this network.");
    destinationName = destination.name;

    const recipientArg = arg("recipient");
    if (recipientArg && !isAddress(recipientArg)) throw new Error(`--recipient ${recipientArg} is not an address`);
    const recipient = recipientArg ? getAddress(recipientArg) : account.address;
    const mintRecipient = pad(recipient, { size: 32 }).toLowerCase() as Hex;

    const fast = flag("fast");
    const threshold = fast ? FAST_FINALITY : STANDARD_FINALITY;
    let maxFee: bigint;
    const maxFeeArg = numberArg("max-fee");
    if (maxFeeArg !== undefined) {
      maxFee = parseUnits(String(maxFeeArg), quote.decimals);
    } else {
      const bps = await irisFeeBps(domain, threshold);
      if (fast && bps === null) throw new Error("Circle's fast-transfer fee could not be read from Iris; drop --fast or pass --max-fee.");
      maxFee = maxFeeFor(pool.creatorFees, bps ?? 0);
      line("Iris fee", bps === null ? "not reported (standard transfer: max fee 0)" : `${bps} bps at threshold ${threshold}`);
    }
    if (maxFee >= pool.creatorFees) {
      throw new Error(
        `The max fee (${amount(maxFee, quote.decimals, "USDC")}) must be below the amount (${amount(pool.creatorFees, quote.decimals, "USDC")}). Wait for more fees or use the standard transfer.`,
      );
    }

    line("destination", `${destination.name} (CCTP domain ${domain})`);
    line("recipient", `${recipient} (bytes32 ${mintRecipient})`);
    line("transfer", `${fast ? "fast" : "standard"} — finality threshold ${threshold}, max fee ${amount(maxFee, quote.decimals, "USDC")}`);
    call = {
      to: snapshot.launchpad,
      data: encodeFunctionData({
        abi: junoLaunchpadAbi,
        functionName: "claimCreatorFeesCrossChain",
        args: [token, domain, mintRecipient, maxFee, threshold],
      }),
      value: 0n,
      label: `Sending your fees to ${destination.name} through Circle CCTP`,
    };
    irisHint = `${irisApiUrl(network())}/v2/messages/${ARC_CCTP_DOMAIN}?transactionHash=`;
  } else {
    call = buildClaimCreatorFeesCall({ token, to, launchpad: snapshot.launchpad });
  }

  if (!flag("yes")) {
    console.log(`\nAdd --yes to claim to ${crossChain ? destinationName : to}.`);
    return;
  }

  await requireBalance(account.address, 10n ** 16n, "the claim's gas");
  const receipt = await send(account, call);
  const events = launchpadEvents(receipt, snapshot.launchpad);

  invalidatePoolSnapshot(token);
  const after = await fetchCreatorFees(token).catch(() => null);
  console.log("\nClaimed.\n");
  line("tx", links.tx(receipt.transactionHash));
  for (const event of events) {
    // A cross-chain claim also emits CreatorFeesClaimed, paid to TokenMessengerV2 for the burn.
    if (event.eventName === "CreatorFeesClaimed" && !crossChain) {
      line("paid", `${amount(event.args.amount, quote.decimals, quote.symbol)} to ${event.args.to} on Arc`);
    }
    if (event.eventName === "CreatorFeesBridged") {
      line(
        "burned",
        `${amount(event.args.amount, quote.decimals, quote.symbol)} on Arc for ${destinationName} (max fee ${amount(event.args.maxFee, quote.decimals, quote.symbol)})`,
      );
      line("mint to", `${event.args.mintRecipient} on CCTP domain ${event.args.destinationDomain}`);
    }
  }
  line("remaining", after ? `${after.quoteAmount} ${quote.symbol}` : "?");
  if (irisHint && localFork()) {
    console.log(`\nThis burn happened on a local fork, so Iris will never attest it; on Arc ${network()} the status is at\n  ${irisHint}<tx hash>`);
  } else if (irisHint) {
    console.log(
      `\nCircle mints it on ${destinationName} once Iris attests the burn${isMainnet() ? "" : " (testnet)"}. Status:\n  ${irisHint}${receipt.transactionHash}`,
    );
  }
}

run(main);
