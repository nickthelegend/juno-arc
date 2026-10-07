/**
 * Send a graduated Juno coin from Arc to another chain over Chainlink CCIP.
 *
 *   npm run ccip:send -- --token 0x… --to base-sepolia --amount 1000              # quote the fee, send nothing
 *   npm run ccip:send -- --token 0x… --to base-sepolia --amount 1000 --yes
 *   npm run ccip:send -- --latest --to ethereum-sepolia --amount all --receiver 0x… --yes
 *
 * The coin must be a CCIP Cross-Chain Token (its creator ran `JunoCrossChain.enable` after
 * graduation) and its pool must be wired to the destination (`npm run ccip:remote` deploys the
 * other side and prints the Arc-side wiring). Then:
 *
 *   1. approve the Arc CCIP Router to take the coin (only when the allowance is short), and
 *   2. `Router.ccipSend(destSelector, { receiver, data: 0x, tokenAmounts: [{coin, amount}],
 *      feeToken: address(0), extraArgs: GenericExtraArgsV2{gasLimit: 0, allowOutOfOrderExecution: true} })`
 *      with `value = Router.getFee(...)` (+1% for a fee tick): the CCIP fee is paid in Arc's
 *      native USDC, so the sender holds nothing but USDC and the coin.
 *
 * The coin is burned on Arc by its BurnMintTokenPool and minted on the destination by the
 * remote pool. The message id is read from the OnRamp's `CCIPMessageSent` in the receipt and
 * printed with its https://ccip.chain.link/msg/<id> link; follow it with `npm run ccip:status`.
 *
 * Options:
 *   --token <address> | --latest
 *   --to <lane>          base-sepolia | ethereum-sepolia | polygon-amoy (testnet), base | ethereum | polygon
 *                        (mainnet), or a chain selector. Default: Base (Sepolia on testnet).
 *   --amount N | all     tokens to send (18 decimals)
 *   --receiver <addr>    who receives it on the destination (default: the sender)
 *   --yes                send it (otherwise quote only)
 *   --allow-mainnet      required on Arc mainnet: this moves real tokens and pays a real fee
 *
 * Signs with JUNO_SCRIPT_PRIVATE_KEY or `.juno/launcher.key`. Arc network from
 * NEXT_PUBLIC_ARC_NETWORK, addresses from the deployment record (JUNO_DEPLOYMENT_FILE).
 */

import { encodeFunctionData, formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";

import { junoCrossChainAbi, junoTokenAbi } from "../lib/juno/abi";
import { ccipLanes, type CcipLane } from "../lib/juno/arc";
import { ccipMessageIdsIn } from "../lib/juno/ccip-events";
import { ccipMessageUrl, crossChainAddress, deployment, localFork, network } from "../lib/juno/network";
import { ccipPoolReadAbi, ccipRouterAbi, ccipTokenMessage } from "./lib/ccip";
import {
  amount,
  arg,
  flag,
  header,
  line,
  links,
  nativeUsdc,
  refuseMainnetWithoutFlag,
  requireBalance,
  resolveToken,
  run,
  scriptAccount,
  scriptReader,
  send,
} from "./lib/cli";

/** Gas for the approval and the send, on top of the CCIP fee: native (18-dec) USDC. */
const GAS_ALLOWANCE = 5n * 10n ** 16n; // $0.05

const ZERO = /^0x0{40}$/i;

function laneFrom(raw: string): CcipLane {
  const lanes = ccipLanes(network());
  const wanted = raw.trim().toLowerCase();
  const lane = lanes.find(
    (l) => l.selector === wanted || l.name.toLowerCase() === wanted || l.name.toLowerCase().replace(/\s+/g, "-") === wanted,
  );
  if (!lane) {
    throw new Error(
      `"${raw}" is not a CCIP lane from Arc ${network()}. One of: ${lanes
        .map((l) => `${l.name.toLowerCase().replace(/\s+/g, "-")} (${l.selector})`)
        .join(", ")}`,
    );
  }
  if (!lane.evm) throw new Error(`${lane.name} needs a non-EVM receiver; send to it with Chainlink's tools.`);
  return lane;
}

async function main() {
  refuseMainnetWithoutFlag("Sending a coin over CCIP");
  const token = await resolveToken();
  const lane = laneFrom(arg("to", network() === "mainnet" ? "base" : "base-sepolia")!);
  const selector = BigInt(lane.selector);

  const router = deployment().ccipRouter;
  if (!router) throw new Error(`No CCIP router is recorded for Arc ${network()}.`);
  const cc = crossChainAddress();
  if (!cc) throw new Error(`No JunoCrossChain is recorded for Arc ${network()} (${deployment().source ?? "no deployment file"}).`);

  const account = scriptAccount();
  header(account.address);
  const reader = scriptReader();

  const [symbol, pool] = await Promise.all([
    reader.readContract({ address: token, abi: junoTokenAbi, functionName: "symbol" }).catch(() => "?"),
    reader.readContract({ address: cc, abi: junoCrossChainAbi, functionName: "poolOf", args: [token] }),
  ]);
  line("token", `${token} ($${symbol})`);
  line("lane", `Arc ${network()} → ${lane.name} (selector ${lane.selector})`);
  line("router", router);
  if (ZERO.test(pool)) {
    throw new Error("This coin is not a CCIP Cross-Chain Token yet: its creator enables it after graduation (JunoCrossChain.enable).");
  }
  line("Arc pool", links.address(pool));

  const [routerSupports, poolSupports] = await Promise.all([
    reader.readContract({ address: router, abi: ccipRouterAbi, functionName: "isChainSupported", args: [selector] }),
    reader.readContract({ address: pool, abi: ccipPoolReadAbi, functionName: "isSupportedChain", args: [selector] }),
  ]);
  if (!routerSupports) throw new Error(`Arc's CCIP Router has no lane to ${lane.name}.`);
  if (!poolSupports) {
    throw new Error(
      `This coin's pool is not wired to ${lane.name} yet. Deploy its pool there with npm run ccip:remote, then wire it (the script prints the call).`,
    );
  }

  // Size it.
  const held = await reader.readContract({ address: token, abi: junoTokenAbi, functionName: "balanceOf", args: [account.address] });
  line("holding", amount(held, 18, symbol));
  const rawAmount = arg("amount");
  if (!rawAmount) throw new Error("Pass --amount N (tokens) or --amount all.");
  const value = rawAmount === "all" ? held : parseUnits(rawAmount, 18);
  if (value <= 0n) throw new Error("Nothing to send: the amount is zero.");
  if (value > held) throw new Error(`That is more than this wallet holds (${formatUnits(held, 18)}).`);

  const receiverArg = arg("receiver");
  if (receiverArg && !isAddress(receiverArg)) throw new Error(`--receiver ${receiverArg} is not an address`);
  const receiver: Address = receiverArg ? getAddress(receiverArg) : account.address;

  // The outbound bucket caps what can leave per refill; say so before the Router refuses.
  const buckets = await reader
    .readContract({ address: pool, abi: ccipPoolReadAbi, functionName: "getCurrentRateLimiterState", args: [selector, false] })
    .catch(() => null);
  if (buckets) {
    const [outbound] = buckets;
    line("outbound limit", `${formatUnits(outbound.tokens, 18)} of ${formatUnits(outbound.capacity, 18)} available, refills ${formatUnits(outbound.rate, 18)}/s`);
    if (outbound.isEnabled && value > outbound.tokens) {
      throw new Error(`The lane's outbound rate limit has ${formatUnits(outbound.tokens, 18)} available right now; send less or wait.`);
    }
  }

  const message = ccipTokenMessage({ token, amount: value, receiver });
  const fee = await reader.readContract({ address: router, abi: ccipRouterAbi, functionName: "getFee", args: [selector, message] });
  // 1% over the quote so a fee tick between quote and send doesn't revert.
  const feeValue = fee + fee / 100n;
  line("amount", amount(value, 18, symbol));
  line("receiver", `${receiver} on ${lane.name}`);
  line("CCIP fee", `${nativeUsdc(fee)} (sending ${nativeUsdc(feeValue)}, paid in Arc's native USDC)`);

  const allowance = await reader.readContract({
    address: token,
    abi: junoTokenAbi,
    functionName: "allowance",
    args: [account.address, router],
  });
  const needsApproval = allowance < value;

  if (!flag("yes")) {
    console.log(`\nQuote only.${needsApproval ? " Sending will approve the Router first." : ""} Add --yes to send.`);
    return;
  }

  // The fee is native USDC (18-dec), on top of the gas.
  await requireBalance(account.address, GAS_ALLOWANCE + feeValue, "the CCIP fee and gas");

  if (needsApproval) {
    await send(account, {
      to: token,
      data: encodeFunctionData({ abi: junoTokenAbi, functionName: "approve", args: [router, value] }),
      value: 0n,
      label: `Allowing Chainlink's CCIP Router to take ${formatUnits(value, 18)} $${symbol}`,
    });
  }
  const receipt = await send(account, {
    to: router,
    data: encodeFunctionData({ abi: ccipRouterAbi, functionName: "ccipSend", args: [selector, message] }),
    value: feeValue,
    label: `Sending it to ${lane.name} over Chainlink CCIP`,
  });

  const ids = ccipMessageIdsIn(receipt.logs);
  console.log("\nSent.\n");
  line("tx", links.tx(receipt.transactionHash));
  if (ids.length === 0) {
    line("message id", "not found in the receipt (no CCIPMessageSent from a known OnRamp version)");
  }
  for (const id of ids) {
    line("message id", id);
    line("track", ccipMessageUrl(id));
  }
  if (localFork()) {
    console.log("\nThis send happened on a local fork: no Chainlink DON sees it, so it will never reach the explorer or the destination.");
  } else if (ids[0]) {
    console.log(`\nStatus: npm run ccip:status -- --id ${ids[0]}`);
  }
}

run(main);
