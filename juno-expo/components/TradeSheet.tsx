import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Modal, Platform, TextInput } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import styled from "styled-components/native";

import { PegChip } from "./ArcKit";
import { GatewayTopUp } from "./Gateway";
import { SpeedReceipt } from "./SpeedReceipt";
import { quickBuySizes } from "../lib/quick-sizes";
import { Tappable } from "./Press";
import { Button, Caption, Col, Label, Row } from "./kit";
import { sameAddress } from "../lib/address";
import { ApiError, CIRCLE_FAUCET_URL, confirmMsOf, juno, onTestnet, type Coin, type MemoTag } from "../lib/api";
import { money, tokens } from "../lib/useApi";
import { useWallet } from "../lib/wallet";
import { theme } from "../theme";

/**
 * Buy and sell, with a numpad.
 *
 * A system keyboard is the wrong control here. It covers half the screen —
 * including the quote the person is deciding on — offers characters an amount
 * cannot contain, and moves its decimal key by locale. A purpose-built pad
 * keeps the number, the quote and the button visible at once, which is the
 * whole decision in one view.
 *
 * ## The quote is fetched, not computed
 *
 * The amount could be multiplied by the last price, and that estimate would be
 * wrong in exactly the way that matters: a bonding curve moves as it fills, so
 * a large order does not clear at spot. The server quotes against the live
 * curve and returns the transaction built against that same quote, so what is
 * shown is what gets signed.
 *
 * Debounced, because a quote is an RPC round trip and typing "125" should not
 * cost three of them.
 *
 * ## Saying so afterwards
 *
 * Juno is a social app and a trade was the one thing you could not talk about:
 * the comment box here attaches your words to the fill, with the side and the
 * transaction hash on the row. That is what makes it an announcement rather
 * than a boast — anyone reading it can check it on an explorer.
 *
 * ## Arc
 *
 * Everything is in dollars: curves are quoted in USDC, and gas is paid in the
 * same USDC (about a tenth of a cent). A receipt on Arc is final, so the sheet
 * goes straight from "Confirming" to a receipt that leads with the measured
 * time — the buy is final before you scroll to the next post. With Juno's
 * relayer configured, a buy can be paid with a signature instead of gas
 * (EIP-3009 `receiveWithAuthorization`, relayed as `buyWithAuthorization`), and
 * a wallet short of USDC on Arc can top up from Circle Gateway in place.
 *
 * Posted only after the transaction lands, and a failure to post says so
 * without pretending the trade failed. The two are different events and only
 * one of them moved money.
 */

/** A sell is a fraction of what you hold; absolute sizes mean nothing there. */
const QUICK_SELL = [0.25, 0.5, 0.75, 1];
/** Exact-out sizes, in tokens. Every Juno coin is minted with a one-billion supply. */
const QUICK_TOKENS = [100_000, 1_000_000, 10_000_000, 50_000_000];

/**
 * USDC kept back for gas off the top of a Max buy.
 *
 * Arc charges gas in USDC, from the same balance the buy spends: a curve buy
 * costs about a tenth of a cent, and an approval plus a buy about twice that.
 * A cent covers either with room; holding back less is how a Max buy ends up
 * unable to pay for itself.
 */
const GAS_RESERVE_USDC = 0.01;

/**
 * How much life a built swap must have left to be signed without a rebuild.
 *
 * Every swap carries a deadline and reverts on-chain with `Expired` after it,
 * having spent its gas to say so. Signing, submitting and waiting for the
 * receipt takes a few seconds on a good connection and more on a bad one.
 */
const DEADLINE_MARGIN_S = 20;

/**
 * The move the size suggester searches against.
 *
 * One percent of *curve* movement — not one percent of total cost. On a pool
 * whose fee is 48 bps the two differ by half the budget, and only one of them
 * grows with the order.
 */
const IMPACT_BUDGET = 0.01;

/**
 * How long the pre-sign refresh is allowed to take.
 *
 * Shorter than the client's default, because this one has somewhere to fall
 * back to. Waiting the full forty-five seconds for a refresh would spend most
 * of the deadline the refresh exists to protect.
 */
const REQUOTE_MS = 12_000;

type Stage = "entry" | "confirming" | "done";

export function TradeSheet({
  coin,
  side: initialSide,
  onClose,
  onDone,
  holding = null,
  quoteBalance = null,
  initialAmount = "",
  onFilled,
  onCommented,
  onFunded,
}: {
  coin: Coin;
  side: "buy" | "sell";
  onClose: () => void;
  onDone: () => void;
  /** Coin balance, for a sell. Null when unknown. */
  holding?: number | null;
  /** Quote-token balance, for a buy. Null when unknown. */
  quoteBalance?: number | null;
  /** Juno's faucet or Circle Gateway sent USDC from inside the sheet: re-read the balances passed in. */
  onFunded?: () => void;
  /**
   * Pre-filled amount, for a buy opened from somewhere that already knows the
   * size — a recurring-buy contribution. Editable: it is a starting point, not
   * a lock, because the whole point of signing each one is that you can change
   * your mind about this week.
   */
  initialAmount?: string;
  /**
   * A swap **confirmed**, with the quote amount that was spent or received and
   * the hash of the transaction that did it.
   *
   * Fires on the receipt, not on the sheet closing. Anything that records a
   * fill has to hang off this and only this: a callback on close would count a
   * trade that errored, and one on submit would count a transaction that never
   * made it into a block.
   */
  onFilled?: (quoteAmount: number, txHash: string) => void;
  /** An announcement was posted alongside the fill. */
  onCommented?: () => void;
}) {
  const wallet = useWallet();
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
  const [amount, setAmount] = useState(initialAmount);
  /**
   * The share of the holding a sell pill chose (0.25 … 1), or null when the
   * amount was typed. Sent in place of the amount so the server names it
   * exactly from the chain: the amount shown is rounded, and "100%" sold as
   * that rounded number left dust behind. Anything that changes the amount
   * by hand clears it.
   */
  const [fraction, setFraction] = useState<number | null>(null);
  /** Set the amount, and whether it came from a sell pill's share. */
  const setSize = useCallback((text: string, share: number | null = null) => {
    setAmount(text);
    setFraction(share);
  }, []);
  /**
   * Buy an exact number of tokens rather than spend an exact amount.
   *
   * The trader names what they want to hold and the curve names the price;
   * the transaction is capped at a maximum spend instead of guarded by a
   * minimum out. Buys on the curve only — a sell already names its token
   * amount exactly.
   */
  const [exact, setExact] = useState(false);
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof juno.buildSwap>> | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stage, setStage] = useState<Stage>("entry");
  const [error, setError] = useState<string | null>(null);
  /** Juno's faucet, asked from inside the sheet: busy, what arrived, or why not. */
  const [funding, setFunding] = useState(false);
  const [funded, setFunded] = useState<string | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  /** Which step is signing or landing, when there is more than one. */
  const [progress, setProgress] = useState<string | null>(null);
  /** This buy was the one that filled the curve. */
  const [filledCurve, setFilledCurve] = useState(false);
  /** How long the last step took from broadcast to receipt, when the server measured it. */
  const [confirmedInMs, setConfirmedInMs] = useState<number | null>(null);
  /** Signing on this device, measured here: from the first signature asked for to the first send. */
  const [signedInMs, setSignedInMs] = useState<number | null>(null);
  /** How the trade was tagged with its post through Arc Memo, when the server said. */
  const [memo, setMemo] = useState<MemoTag | null>(null);
  const [explorerUrl, setExplorerUrl] = useState<string | null>(null);
  /** Pay with an EIP-3009 signature; Juno's relayer pays the gas. */
  const [gasless, setGasless] = useState(false);
  /** The trade that landed was relayed. */
  const [relayed, setRelayed] = useState(false);
  /** When the chain confirmed it — shown beside the hash on the receipt. */
  const [landedAt, setLandedAt] = useState<Date | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  /**
   * The largest buy that stays inside a 1% move of the curve.
   *
   * Binary-searched server-side against the same `swapQuote` the transaction
   * is built with, on *curve* impact with the fee excluded — a fee is a flat
   * percentage and does not grow with size, so including it would make the
   * answer mostly a constant and give the same number on a deep curve as a
   * thin one. This is the figure that actually distinguishes Juno's four
   * presets from each other, and until now it existed only in an endpoint.
   */
  const [suggestion, setSuggestion] = useState<
    { amountIn: number; curveImpact: number; ceilingReached: boolean } | null
  >(null);
  const [suggesting, setSuggesting] = useState(false);
  /** When the quote on screen was built. Kept for the "quoted Ns ago" read. */
  const quotedAt = useRef(0);

  /**
   * Graduated into its Uniswap v2 pair: traded through Juno's router, and the
   * curve-shaped parts of this sheet (the size suggester, the fill-the-curve
   * note, Memo tagging, the gasless buy) do not apply.
   */
  const onPair = coin.curve.graduated;
  const offCurve = onPair;
  const value = Number(amount || "0");
  const valid = Number.isFinite(value) && value > 0;
  const exactOut = side === "buy" && exact && !offCurve;
  const unit = side === "buy" && !exactOut ? coin.quote.symbol : coin.symbol;
  /** What the balance is counted in — never the exact-out token. */
  const balanceUnit = side === "buy" ? coin.quote.symbol : coin.symbol;
  const rate = coin.quoteUsdRate;

  /**
   * What the wallet can actually spend on this side.
   *
   * Null rather than zero when it is not known — a balance that failed to load
   * and a genuinely empty wallet are different, and only one of them should
   * stop someone trying.
   */
  const balance = useMemo(() => {
    if (side === "sell") return holding;
    return quoteBalance;
  }, [side, holding, quoteBalance]);

  /*
   * Why this trade cannot go through, decided before anything is signed.
   *
   * The server builds a transaction for any amount, and the chain refuses one
   * the wallet cannot pay for — which reached the person as a raw revert.
   * These are the refusals worth saying in words, with where to fix them.
   * Unknown balances are not checked: a read that failed is not "empty".
   */
  // Where to get more is a testnet answer; on mainnet there is no faucet to
  // send anyone to, and pointing at one would be wrong.
  const testnet = onTestnet();
  const arc = juno.arc();
  /** Juno's relayer can submit an EIP-3009 buy for this wallet. Curve buys only. */
  const gaslessOffered = arc?.relayer?.available === true && side === "buy" && !offCurve && !exact;
  const useGasless = gasless && gaslessOffered;
  /**
   * The reference, said before signing rather than only on the coin page.
   *
   * A tracker's curve can run away from the price it is meant to follow, and
   * the band exists for exactly that moment. Buying above it pays a premium
   * the reference does not support; a reference that has gone stale means the
   * band cannot be checked at all, which is a different warning.
   */
  const navWarning = useMemo((): string | null => {
    const nav = coin.nav;
    if (!nav) return null;
    // "BTC/USD" → "BTC": what the tracker follows, in a trader's words.
    const label = nav.feed.split("/")[0] || nav.feed;
    if (nav.state === "stale") {
      return `${label}'s price is stale, so this curve can't be checked against it right now.`;
    }
    if (nav.deviation === null) return null;
    const reference = "Chainlink price";
    if (nav.withinBand === false) {
      const above = nav.deviation > 0;
      return `This curve is ${Math.abs(nav.deviation * 100).toFixed(1)}% ${above ? "above" : "below"} ${label}'s ${reference}, outside its ${
        nav.bandBps / 100
      }% band.${side === "buy" && above ? " A buy here pays more than the reference." : ""}${
        side === "sell" && !above ? " A sell here gets less than the reference." : ""
      }`;
    }
    /*
     * Inside the band now — but this trade may not be.
     *
     * The curve's price after a trade is not in the quote; its average price is
     * (spot over one minus the curve's impact, fee excluded). A buy's average
     * is never above where it leaves the price, nor a sell's below, so when
     * even the average is outside the band the trade certainly is — which is
     * the moment the band exists for, and it is said before signing.
     */
    const impact = quoting ? undefined : quote?.quote.curveImpact;
    if (impact === undefined || !(impact > 0) || impact >= 1) return null;
    const average = side === "buy" ? (1 + nav.deviation) / (1 - impact) - 1 : (1 + nav.deviation) * (1 - impact) - 1;
    if (Math.abs(average) <= nav.bandBps / 10_000) return null;
    return side === "buy"
      ? `On average this buy pays ${(average * 100).toFixed(1)}% above ${label}'s ${reference}, outside its ${
          nav.bandBps / 100
        }% band — a premium the reference does not support. A smaller buy stays closer to it.`
      : `On average this sell gets ${(Math.abs(average) * 100).toFixed(1)}% below ${label}'s ${reference}, outside its ${
          nav.bandBps / 100
        }% band — less than the reference supports. A smaller sell stays closer to it.`;
  }, [coin.nav, side, quote, quoting]);

  // What this trade takes out of the wallet. For an exact-out buy that is only
  // known once quoted, and the bound that matters is the most it may cost.
  const spend = exactOut ? (quote?.quote.maximumAmountIn ?? null) : value;
  const blocker = useMemo((): { text: string; url?: string; gas?: boolean; short?: number } | null => {
    if (!valid) return null;
    if (balance !== null && spend !== null && spend > balance) {
      if (side === "sell") return { text: `You hold ${tokens(balance)} ${coin.symbol}.` };
      return {
        text: `You have ${money(balance, "USD", { compact: false })} USDC on Arc.${testnet ? " Get testnet USDC below." : ""}`,
        short: spend - balance,
      };
    }
    // Gas is paid in USDC from the same balance a buy spends — unless the buy
    // is relayed, when Juno's relayer pays it.
    const spending = side === "buy" ? (spend ?? 0) : 0;
    if (!useGasless && quoteBalance !== null && quoteBalance - spending < GAS_RESERVE_USDC / 2) {
      return {
        gas: true,
        text:
          spending > 0
            ? `Leave about $${GAS_RESERVE_USDC} of USDC for gas.`
            : `You need a little USDC for gas (about $0.001).${testnet ? " Get testnet USDC below." : ""}`,
        short: GAS_RESERVE_USDC,
      };
    }
    return null;
  }, [valid, balance, spend, side, coin.symbol, testnet, quoteBalance, useGasless]);

  /*
   * Short of USDC on testnet: Juno's faucet, right here, and Circle's for
   * more. The first trade used to send people to another tab for it; this
   * keeps a newcomer in the one sheet from "Create a wallet" to "Done".
   */
  const offerFaucet = testnet && !!wallet.address && side === "buy" && (blocker?.short ?? 0) > 0;
  /** Circle Gateway can cover the shortfall from USDC held on other chains. */
  const offerGateway = !!wallet.address && side === "buy" && (blocker?.short ?? 0) > 0 && arc?.gateway?.available !== false;

  const fund = async () => {
    if (!wallet.address || funding) return;
    setFunding(true);
    setFundError(null);
    try {
      const result = await juno.faucet(wallet.address);
      setFunded(`$${tokens(result.amount)} of testnet USDC arrived from Juno's faucet.`);
      onFunded?.();
    } catch (caught) {
      setFundError(
        `${caught instanceof Error ? caught.message.replace(/[.!]?$/, ".") : "Juno's faucet did not answer."} Circle's faucet works too.`,
      );
    } finally {
      setFunding(false);
    }
  };

  const usdEquivalent = useMemo(() => {
    if (!valid) return null;
    const live = quote?.quoteUsdRate ?? rate ?? 1;
    if (side === "buy" && !exactOut) return money(value * live, "USD", { compact: false });
    return coin.priceUsd > 0 ? money(value * coin.priceUsd, coin.marketCapCurrency, { compact: false }) : null;
  }, [valid, value, side, exactOut, quote?.quoteUsdRate, rate, coin.priceUsd, coin.marketCapCurrency]);

  // An amount the wallet cannot cover is refused in words above; quoting it
  // would spend a round trip on a transaction nobody can sign.
  const overBalance = valid && balance !== null && !exactOut && value > balance;
  /** What the build is asked for: an exact receive, a share of the holding, or an amount. */
  const sellShare = side === "sell" ? fraction : null;
  const sizeArgs = exactOut
    ? { amountOut: value }
    : sellShare !== null
      ? { sellFraction: sellShare }
      : { amountIn: value };
  /** The hint's size is more than this wallet holds to sell. */
  const sellsAll =
    side === "sell" && suggestion !== null && holding !== null && holding > 0 && holding < suggestion.amountIn;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `sizeArgs` is rebuilt every render from `value`, `exactOut` and `sellShare`, which are listed
  useEffect(() => {
    if (!valid || !wallet.address || overBalance) {
      setQuote(null);
      setQuoting(false);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const built = await juno.buildSwap({
          token: coin.address,
          owner: wallet.address!,
          side,
          ...sizeArgs,
        });
        if (!cancelled) {
          setQuote(built);
          quotedAt.current = Date.now();
        }
      } catch (caught) {
        if (!cancelled) {
          setQuote(null);
          setError(caught instanceof Error ? caught.message : "Could not quote this trade");
        }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [amount, valid, value, side, exactOut, sellShare, coin.address, wallet.address, overBalance]);

  useEffect(() => {
    let cancelled = false;
    setSuggestion(null);
    // The suggester walks the curve; after a graduation there is none.
    if (offCurve) return;
    setSuggesting(true);
    juno
      .depth(coin.address, side, IMPACT_BUDGET)
      .then((result) => {
        if (cancelled) return;
        setSuggestion(
          result.suggestion
            ? {
                amountIn: result.suggestion.amountIn,
                curveImpact: result.suggestion.curveImpact,
                ceilingReached: result.suggestion.ceilingReached,
              }
            : null,
        );
      })
      // No suggestion is a fine outcome and gets no error copy: the pill
      // simply does not appear. It is a convenience, not the trade.
      .catch(() => (cancelled ? undefined : setSuggestion(null)))
      .finally(() => (cancelled ? undefined : setSuggesting(false)));
    return () => {
      cancelled = true;
    };
  }, [coin.address, side, offCurve]);

  const press = useCallback((key: string) => {
    setError(null);
    setTxHash(null);
    setLandedAt(null);
    setFraction(null);
    setAmount((current) => {
      if (key === "back") return current.slice(0, -1);
      if (key === ".") return current.includes(".") ? current : current === "" ? "0." : `${current}.`;
      // No leading zeros: "05" is not an amount anyone meant to type.
      const next = current === "0" ? key : current + key;
      const [, decimals = ""] = next.split(".");
      if (decimals.length > 9) return current;
      return next;
    });
  }, []);

  async function confirm() {
    if (!quote) return;
    setStage("confirming");
    setError(null);
    try {
      const address = wallet.address ?? (await wallet.connect());
      if (!address) throw new Error("No wallet available");

      if (useGasless) {
        /*
         * Pay with a signature. The server quotes and builds an EIP-3009
         * `ReceiveWithAuthorization` for exactly this buy (its nonce commits
         * to the token, size, minimum out and deadline); the device signs it
         * as typed data, and Juno's relayer submits `buyWithAuthorization`,
         * paying the USDC gas. Tokens and any refund go to this wallet.
         */
        setProgress("Signing the authorisation…");
        const started = performance.now();
        const intent = await juno.buyIntent({ token: coin.address, owner: address, amountIn: value });
        const signature = await wallet.signTypedData(intent.typedData);
        setSignedInMs(Math.round(performance.now() - started));
        setProgress("Juno's relayer is submitting it…");
        const result = await juno.buyRelayed({ intent: intent.intent, signature });
        setConfirmedInMs(confirmMsOf(result));
        setMemo(result.memo ?? null);
        setExplorerUrl(result.explorerUrl ?? null);
        setRelayed(true);
        setFilledCurve(!!result.completed?.some((token) => sameAddress(token, coin.address)));
        setTxHash(result.hash);
        setLandedAt(new Date());
        setStage("done");
        onFilled?.(value, result.hash);
        await postNote(address, result.hash);
        return;
      }

      /*
       * Rebuild the quote, every time, right before signing.
       *
       * A built swap carries a deadline and a nonce. Past the deadline the
       * contract reverts it with `Expired`, gas spent; a nonce another trade
       * has since used makes it unsendable. And the curve moves as it fills,
       * so a minute-old quote is quoting a price nobody would get now. One
       * extra quote costs a call this sheet already makes on every keystroke;
       * a stale build costs the trade. The rebuilt quote replaces the visible
       * one before signing, so what is signed is what the sheet shows.
       */
      const fresh = await juno
        .buildSwap(
          {
            token: coin.address,
            owner: address,
            side,
            ...sizeArgs,
          },
          REQUOTE_MS,
        )
        // A refresh that times out is not a reason to refuse the trade while
        // the quote on screen still has comfortable life left — failing here
        // would turn a slow endpoint into a failed buy. Past that margin the
        // old build would only revert, so it is refused here instead. A
        // refusal *from the server* — the curve filled a moment ago — is an
        // answer, not a slow endpoint, and signing the old build would only
        // spend gas to hear it again from the chain.
        .catch((caught: unknown) => {
          if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500) throw caught;
          return null;
        });
      const stillValid = quote.window.deadline - Date.now() / 1000 > DEADLINE_MARGIN_S;
      const live = fresh ?? (stillValid ? quote : null);
      if (!live) {
        throw new Error("The quote expired and a fresh one did not arrive. Try again.");
      }
      if (fresh) {
        setQuote(fresh);
        quotedAt.current = Date.now();
      }

      let signingFrom: number | null = null;
      let signedIn: number | null = null;
      const results = await wallet.signAndSubmit(live.steps, (step) => {
        if (step.phase === "signing" && signingFrom === null) signingFrom = performance.now();
        if (step.phase === "submitting" && signingFrom !== null && signedIn === null) {
          signedIn = Math.round(performance.now() - signingFrom);
        }
        // One step needs no running commentary; an approval then a buy does,
        // or the second wait looks like the first one hanging.
        if (step.total > 1) setProgress(`${step.label}… (${step.index + 1}/${step.total})`);
      });
      setSignedInMs(signedIn);
      const last = results[results.length - 1];
      const landed = last.hash;
      setConfirmedInMs(confirmMsOf(last));
      setMemo(last.memo ?? live.memo ?? null);
      setExplorerUrl(last.explorerUrl ?? null);
      setRelayed(false);
      setFilledCurve(results.some((result) => result.completed?.some((token) => sameAddress(token, coin.address))));
      setTxHash(landed);
      setLandedAt(new Date());
      setStage("done");
      // What was spent: on an exact-out buy, the cost the curve named.
      onFilled?.(exactOut ? (live.quote.amountIn ?? value) : value, landed);

      await postNote(address, landed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The trade failed");
      setStage("entry");
    } finally {
      setProgress(null);
    }
  }

  /**
   * The announcement, if one was written. Its failure is reported on its own
   * line: the trade is already on chain and saying "the trade failed" here
   * would be false.
   */
  async function postNote(address: string, landed: string) {
    const body = note.trim();
    if (!body) return;
    try {
      await juno.addComment({ token: coin.address, wallet: address, body, side, txHash: landed });
      setNote("");
      onCommented?.();
    } catch (caught) {
      setNoteError(
        caught instanceof Error
          ? `The trade landed; your note did not post: ${caught.message}`
          : "The trade landed; your note did not post.",
      );
    }
  }

  const receiving = useMemo(() => {
    if (!quote) return null;
    return side === "buy"
      ? `${tokens(quote.quote.amountOut)} ${coin.symbol}`
      : money(quote.quote.amountOut, "USD", { compact: false });
  }, [quote, side, coin.symbol]);

  /**
   * The quick sizes: $1, $5, $10, $25 on a buy (USDC is dollars), shares of
   * the holding on a sell. Max is everything spendable less a cent for gas —
   * unless the buy is relayed, when the relayer pays it.
   */
  const quickSizes = useMemo((): Array<{ label: string; amount: number | null; share: number | null }> => {
    if (side === "sell") {
      return QUICK_SELL.map((share) => ({
        label: `${share * 100}%`,
        // Null when the balance is unknown: a percentage of an unknown number
        // is not a number, and the pill is disabled rather than guessing.
        amount: balance === null ? null : balance * share,
        share,
      }));
    }
    if (exactOut) return QUICK_TOKENS.map((size) => ({ label: tokens(size), amount: size, share: null }));
    return quickBuySizes({ spendable: balance === null ? null : useGasless ? balance : balance - GAS_RESERVE_USDC });
  }, [side, exactOut, balance, useGasless]);

  const done = stage === "done" && txHash !== null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Scrim onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />

      <Sheet>
        <Grabber />

        <Row justify="space-between" align="center">
          <Row gap={8}>
            <SideTap
              $on={side === "buy"}
              $buy
              onPress={() => { setSide("buy"); setFraction(null); }}
              accessibilityRole="button"
              aria-selected={side === "buy"}
            >
              <SideText $on={side === "buy"} $buy>
                Buy
              </SideText>
            </SideTap>
            <SideTap
              $on={side === "sell"}
              $buy={false}
              onPress={() => { setSide("sell"); setFraction(null); }}
              accessibilityRole="button"
              aria-selected={side === "sell"}
            >
              <SideText $on={side === "sell"} $buy={false}>
                Sell
              </SideText>
            </SideTap>
          </Row>
          <Row gap={8} align="center">
          <PegChip />
          <Close onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <CloseMark>✕</CloseMark>
          </Close>
          </Row>
        </Row>

        {done ? (
          <Done>
            <DoneTitle>Done</DoneTitle>
            <Label muted style={{ textAlign: "center" }}>
              {side === "buy"
                ? `Bought ${receiving ?? ""}`
                : `Sold ${tokens(value)} ${coin.symbol} for ${receiving ?? ""}`}{" "}
              {onPair ? "on Uniswap v2" : "on its curve"}
              {relayed ? ", gas paid by Juno's relayer" : ""}.
            </Label>
            {/* The measured time — which on Arc is the finality — the Memo
                tag, and the gas in USDC: the receipt that says why this runs
                on Arc. */}
            {txHash ? (
              <SpeedReceipt
                txHash={txHash}
                confirmMs={confirmedInMs}
                signedInMs={signedInMs}
                memo={memo}
                explorerUrl={explorerUrl}
                gasless={relayed}
                curveTrade={!onPair}
              />
            ) : null}
            {filledCurve ? (
              <Label muted style={{ textAlign: "center" }}>
                That buy filled the curve. It can graduate into its Uniswap v2 pair now — anyone can send it on from the
                coin&rsquo;s page.
              </Label>
            ) : null}
            {noteError ? <ErrorText>{noteError}</ErrorText> : null}
            <Receipt>
              tx {txHash!.slice(0, 8)}…{txHash!.slice(-6)}
              {landedAt
                ? ` · ${landedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : ""}
            </Receipt>
            <Button label="Done" onPress={onDone} style={{ marginTop: 16, alignSelf: "stretch" }} />
          </Done>
        ) : (
          <>
            {/* The field, the token it is denominated in, and what you have to
                spend — the three things the number has to be read against, in
                one box. */}
            <Field $live={valid}>
              <Col gap={2} style={{ flex: 1 }}>
                <AmountRow>
                  <AmountValue numberOfLines={1}>{amount || "0"}</AmountValue>
                  <Caret />
                </AmountRow>
                <Caption>{usdEquivalent ? `~${usdEquivalent}` : " "}</Caption>
              </Col>
              <Col gap={4} style={{ alignItems: "flex-end" }}>
                {/* On a curve buy the chip is the switch: spend an exact amount
                    of the quote token, or receive an exact number of tokens. */}
                <Tappable
                  onPress={() => {
                    if (side !== "buy" || offCurve) return;
                    setExact((on) => !on);
                    setSize("");
                    setQuote(null);
                    setError(null);
                  }}
                  to={0.95}
                  // Only a switch on a curve buy; anywhere else it is a label,
                  // and a label should not take focus.
                  disabled={!(side === "buy" && !offCurve)}
                  accessibilityRole={side === "buy" && !offCurve ? "button" : undefined}
                  accessibilityLabel={
                    side === "buy" && !offCurve
                      ? exactOut
                        ? `Buying an exact number of ${coin.symbol}. Switch to spending ${coin.quote.symbol}`
                        : `Spending ${coin.quote.symbol}. Switch to buying an exact number of ${coin.symbol}`
                      : undefined
                  }
                >
                  <TokenChip>
                    <TokenDot />
                    <TokenText>{unit}</TokenText>
                    {side === "buy" && !offCurve ? <TokenText>⇅</TokenText> : null}
                  </TokenChip>
                </Tappable>
                <Caption>
                  Balance:{" "}
                  {balance === null
                    ? "—"
                    : side === "buy"
                      ? money(balance, "USD", { compact: false })
                      : `${tokens(balance)} ${balanceUnit}`}
                </Caption>
              </Col>
            </Field>

            <Row gap={8}>
              {quickSizes.map((preset) => (
                <Quick
                  key={preset.label}
                  testID="quick-amount"
                  disabled={preset.amount === null}
                  // A size is a button to a screen reader too; without the role
                  // these read as plain text that happened to be tappable.
                  accessibilityRole="button"
                  aria-disabled={preset.amount === null}
                  onPress={() =>
                    preset.amount === null
                      ? undefined
                      : setSize(trimTrailingZeros(preset.amount), preset.share)
                  }
                >
                  <QuickLabel $off={preset.amount === null} numberOfLines={1}>
                    {preset.label}
                  </QuickLabel>
                </Quick>
              ))}
            </Row>

            {/* How much this curve will take before it moves.
                A bonding curve's whole character is how it absorbs size, and
                that number was invisible in the one place a trader is deciding
                on size. */}
            {suggesting && !exactOut ? (
              <Depth>
                <Caption>Measuring what this curve will take…</Caption>
              </Depth>
            ) : suggestion && !exactOut ? (
              /* A seller can only sell what they hold. When that is less than
                 the curve would take inside the budget, the useful answer is
                 about their holding, and every smaller sale moves it less. */
              sellsAll ? (
                <Tappable onPress={() => setSize(trimTrailingZeros(holding!), 1)} to={0.98}>
                  <Depth>
                    <Col gap={2} style={{ flex: 1 }}>
                      <Label style={{ fontWeight: "700" }}>
                        All {tokens(holding!)} {unit} you hold
                      </Label>
                      <Caption>
                        Selling all of it moves the curve less than {IMPACT_BUDGET * 100}%.
                      </Caption>
                    </Col>
                    <UseIt>Use</UseIt>
                  </Depth>
                </Tappable>
              ) : (
                <Tappable
                  onPress={() => setSize(trimTrailingZeros(suggestion.amountIn))}
                  to={0.98}
                >
                  <Depth>
                    <Col gap={2} style={{ flex: 1 }}>
                      <Label style={{ fontWeight: "700" }}>
                        {side === "buy" ? money(suggestion.amountIn, "USD", { compact: false }) : `${tokens(suggestion.amountIn)} ${unit}`} moves it{" "}
                        {(suggestion.curveImpact * 100).toFixed(2)}%
                      </Label>
                      <Caption>
                        {suggestion.ceilingReached
                          ? side === "sell"
                            ? `Everything the curve has sold, sold back, stays under ${IMPACT_BUDGET * 100}%.`
                            : `Everything this curve can still fill stays under ${IMPACT_BUDGET * 100}%.`
                          : `The most you can ${side} before the curve moves ${IMPACT_BUDGET * 100}%.`}
                      </Caption>
                    </Col>
                    <UseIt>Use</UseIt>
                  </Depth>
                </Tappable>
              )
            ) : null}

            {/* Network fee, and the curve's own cost beside it. They are
                different things and a trader deciding on size needs the second
                one: the fee does not grow with the order, the curve does. */}
            <Line>
              <Row gap={6}>
                <Label muted>Trading fee</Label>
                <Info />
              </Row>
              <Mono_>
                {quote
                  ? // `money` keeps small fees legible ($0.0₄48) where four
                    // fixed decimals rounded a real fee on a small buy to 0.0000.
                    money(quote.quote.fee, "USD", { compact: false })
                  : quoting
                    ? "…"
                    : "—"}
              </Mono_>
            </Line>
            {/* How far the trade moves the price, with the fee left out: the
                fee has its own row above. Showing the total here counted the
                fee twice, and made a $1 buy "move" a curve more than the
                size the hint quotes for 1%. */}
            <Line>
              <Label muted>Price impact</Label>
              <Mono_
                $warn={(quote?.quote.curveImpact ?? 0) > 0.02}
              >
                {quote ? `${(quote.quote.curveImpact * 100).toFixed(2)}%` : quoting ? "…" : "—"}
              </Mono_>
            </Line>

            {/* What the curve will actually give you, quoted rather than
                multiplied out from spot. Blank rather than instructional when
                there is no amount yet: the caret in the field is already
                saying "type here", and a second voice saying it sat between
                two rows of figures where a figure belongs. */}
            <Receive>
              {quoting
                ? onPair
                  ? "Quoting its Uniswap v2 pair…"
                  : "Quoting against the curve…"
                : exactOut && quote?.quote.amountIn !== undefined
                  ? `Costs ${money(quote.quote.amountIn, "USD", { compact: false })} · at most ${money(
                      quote.quote.maximumAmountIn ?? quote.quote.amountIn,
                      "USD",
                      { compact: false },
                    )}`
                  : receiving
                    ? `You'll receive ${receiving}`
                    : " "}
            </Receive>
            {onPair ? (
              <Caption style={{ textAlign: "center" }}>
                Fills against {coin.symbol}&rsquo;s Uniswap v2 pair — the curve&rsquo;s reserves, locked there for good.
                The pair keeps 0.3% of what goes in.
              </Caption>
            ) : null}

            {/* A buy bigger than what is left on the curve fills it and gets
                the rest back in the same transaction. Said before signing,
                with the exact size, rather than discovered on the receipt. */}
            {side === "buy" && !offCurve && !exactOut && quote && !quoting && quote.quote.amountUsed < value * (1 - 1e-9) ? (
              <FillNote>
                <HintText>
                  {`This fills the curve: it uses ${money(quote.quote.amountUsed, "USD", { compact: false })} and refunds the rest in the same transaction.`}
                </HintText>
                {/* A hair over what is left, so fee decay between now and the
                    block cannot leave the last range unfilled; the excess is
                    refunded. Once the size is that, the link has nothing left
                    to do — offering it again read as a tap that failed. */}
                {value > leftOnCurve(quote.quote.amountUsed) * (1 + 1e-9) ? (
                  <LinkTap
                    onPress={() => setSize(trimTrailingZeros(leftOnCurve(quote.quote.amountUsed)))}
                    accessibilityRole="button"
                    accessibilityLabel="Buy only what's left on the curve"
                  >
                    <LinkText>Buy only what's left</LinkText>
                  </LinkTap>
                ) : null}
              </FillNote>
            ) : null}

            {/* Pay with a signature instead of gas: shown only when Juno's
                relayer is configured. */}
            {gaslessOffered ? (
              <Tappable
                onPress={() => setGasless((on) => !on)}
                to={0.98}
                accessibilityRole="switch"
                aria-checked={gasless}
                accessibilityLabel="Pay with signature, no gas"
              >
                <Gasless $on={gasless} testID="gasless-toggle">
                  <Check $on={gasless}>{gasless ? <CheckMark>✓</CheckMark> : null}</Check>
                  <Col gap={2} style={{ flex: 1 }}>
                    <Label style={{ fontWeight: "800" }}>Pay with signature — no gas</Label>
                    <Caption>
                      Sign an EIP-3009 USDC authorisation; Juno&rsquo;s relayer submits the buy and pays the gas.
                    </Caption>
                  </Col>
                </Gasless>
              </Tappable>
            ) : null}

            {/* The announcement. Optional, and never the default — a trade is
                not a post unless you say so. */}
            <Note>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Add a comment..."
                placeholderTextColor={theme.colors.faint}
                maxLength={280}
                style={{
                  flex: 1,
                  fontSize: theme.type.body.size,
                  color: theme.colors.text,
                }}
              />
            </Note>

            {/* No wallet means no quote — the button used to sit disabled
                with nothing saying why. Creating one is the next step. */}
            {!wallet.address ? (
              <Button
                label="Create a wallet to trade"
                tall
                onPress={() => void wallet.connect()}
                style={{ alignSelf: "stretch" }}
              />
            ) : (
              <Button
                label={
                  stage === "confirming"
                    ? "Confirming…"
                    : blocker
                      ? `Not enough ${side === "sell" && !blocker.gas ? coin.symbol : "USDC"}`
                      : side === "buy"
                        ? useGasless
                          ? "Sign and buy — no gas"
                          : "Buy"
                        : "Sell"
                }
                variant={side === "buy" ? "lime" : "sell"}
                tall
                onPress={confirm}
                loading={stage === "confirming" || wallet.signing}
                disabled={!quote || quoting || !!blocker}
                style={{ alignSelf: "stretch" }}
              />
            )}

            {offerGateway && wallet.address ? (
              <GatewayTopUp address={wallet.address} short={blocker?.short ?? 0} onLanded={() => onFunded?.()} />
            ) : null}
            {offerFaucet ? (
              <Row gap={8}>
                <Button
                  label="Get testnet USDC"
                  variant="ink"
                  onPress={() => void fund()}
                  loading={funding}
                  style={{ flex: 1 }}
                />
                <Button
                  label="Circle faucet"
                  variant="quiet"
                  onPress={() => void Linking.openURL(CIRCLE_FAUCET_URL)}
                  style={{ flex: 1 }}
                />
              </Row>
            ) : null}
            {funded ? <HintText>{funded}</HintText> : null}
            {fundError ? <ErrorText>{fundError}</ErrorText> : null}

            {/* The button is a spinner while this runs, so the step it is
                on has to be said beside it rather than on it. */}
            {stage === "confirming" && progress ? <HintText>{progress}</HintText> : null}
            {navWarning && !blocker ? <WarnText>{navWarning}</WarnText> : null}
            {!blocker && !error && stage === "entry" ? (
              <HintText testID="finality-note">
                {useGasless
                  ? "No gas: the relayer pays it. Final on Arc in under a second."
                  : `Gas ≈ $0.001, paid in USDC. Final on Arc in under a second — before you scroll to the next post.`}
              </HintText>
            ) : null}
            {blocker ? (
              <HintText>
                {blocker.text}
                {blocker.url ? (
                  <HintLink onPress={() => void Linking.openURL(blocker.url!)}>{"  "}Open faucet</HintLink>
                ) : null}
              </HintText>
            ) : null}
            {error ? <ErrorText>{error}</ErrorText> : null}

            <Pad>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"].map((key) => (
                <Key
                  key={key}
                  onPress={() => press(key)}
                  accessibilityRole="button"
                  accessibilityLabel={key === "back" ? "Delete" : key}
                >
                  <KeyLabel>{key === "back" ? "⌫" : key}</KeyLabel>
                </Key>
              ))}
            </Pad>
          </>
        )}
      </Sheet>
    </Modal>
  );
}

/**
 * A size as a typed amount rather than a float's decimal expansion.
 *
 * `20 / 114.03` is `0.17539244058581952`, which is not something anyone typed
 * and reads as noise in a field. Six significant figures is more precision
 * than any curve quote needs and still exact enough that the dollar figure
 * beside it rounds to the preset.
 */
/** The size that buys exactly what is left on the curve, with a 0.05% margin. */
function leftOnCurve(amountUsed: number): number {
  return amountUsed * 1.0005 + 1e-6;
}

/**
 * A size for the input field, to six significant digits — rounded *down*.
 *
 * `toPrecision` rounds to nearest, and a spend amount rounded up can exceed
 * the balance it was computed from: Max on $999,999.99 became $1,000,000 and
 * the sheet then refused it for not leaving gas. An amount the app proposes
 * must never be more than the person has.
 */
function trimTrailingZeros(value: number): string {
  if (!(value > 0) || !Number.isFinite(value)) return "0";
  const magnitude = Math.floor(Math.log10(value));
  const factor = 10 ** (5 - magnitude);
  const floored = Math.floor(value * factor) / factor;
  return String(Number(floored.toPrecision(6)));
}

function Info() {
  return (
    <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
      <Circle cx={8} cy={8} r={6.6} stroke={theme.colors.faint} strokeWidth={1.6} />
      <Path d="M8 7.2v4" stroke={theme.colors.faint} strokeWidth={1.8} strokeLinecap="round" />
      <Circle cx={8} cy={4.9} r={0.95} fill={theme.colors.faint} />
    </Svg>
  );
}

const Gasless = styled.View<{ $on: boolean }>`
  flex-direction: row;
  align-items: center;
  gap: ${(p) => p.theme.space(3)}px;
  padding: ${(p) => p.theme.space(3)}px;
  border-radius: ${(p) => p.theme.radius.md}px;
  border-width: 1.5px;
  border-color: ${(p) => (p.$on ? p.theme.colors.ink : p.theme.colors.line)};
  background-color: ${(p) => (p.$on ? p.theme.colors.limeSoft : p.theme.colors.surface)};
`;

const Check = styled.View<{ $on: boolean }>`
  width: 22px;
  height: 22px;
  border-radius: 7px;
  border-width: 2px;
  border-color: ${(p) => (p.$on ? p.theme.colors.ink : p.theme.colors.lineStrong)};
  background-color: ${(p) => (p.$on ? p.theme.colors.ink : "transparent")};
  align-items: center;
  justify-content: center;
`;

const CheckMark = styled.Text`
  font-size: 13px;
  font-weight: 900;
  color: ${(p) => p.theme.colors.lime};
`;

const WarnText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  line-height: 19px;
  font-weight: 600;
  color: ${(p) => p.theme.colors.neg};
  text-align: center;
`;

const Receipt = styled.Text`
  margin-top: 6px;
  font-size: 12px;
  font-family: ${Platform.OS === "ios" ? "Menlo" : "monospace"};
  color: ${(p) => p.theme.colors.muted};
  text-align: center;
`;

const HintText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  line-height: 19px;
  color: ${(p) => p.theme.colors.muted};
  text-align: center;
`;

const FillNote = styled.View`
  align-items: center;
  gap: 2px;
  padding: ${(p) => p.theme.space(2)}px ${(p) => p.theme.space(3)}px;
  margin-top: ${(p) => p.theme.space(1)}px;
  border-radius: ${(p) => p.theme.radius.md}px;
  background-color: ${(p) => p.theme.colors.limeSoft};
`;

const HintLink = styled.Text`
  font-weight: 800;
  color: ${(p) => p.theme.colors.focus};
`;

const Scrim = styled.Pressable`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(18, 21, 14, 0.45);
`;

const Sheet = styled.View`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* A Modal renders over the whole window on web, not inside the app's
     phone-width frame — so the sheet holds the same width itself. */
  max-width: 480px;
  margin-horizontal: auto;
  background-color: ${(p) => p.theme.colors.surface};
  border-top-left-radius: ${(p) => p.theme.radius.xl}px;
  border-top-right-radius: ${(p) => p.theme.radius.xl}px;
  padding: ${(p) => p.theme.space(4)}px;
  padding-bottom: ${(p) => p.theme.space(8)}px;
  gap: ${(p) => p.theme.space(3)}px;
`;

const Grabber = styled.View`
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background-color: ${(p) => p.theme.colors.line};
  align-self: center;
`;

const SideTap = styled.Pressable<{ $on: boolean; $buy: boolean }>`
  padding: 9px 18px;
  border-radius: ${(p) => p.theme.radius.md}px;
  background-color: ${(p) =>
    !p.$on ? "transparent" : p.$buy ? p.theme.colors.lime : p.theme.colors.negSoft};
`;

const SideText = styled.Text<{ $on: boolean; $buy: boolean }>`
  font-size: ${(p) => p.theme.type.lead.size}px;
  font-weight: 800;
  letter-spacing: ${(p) => p.theme.type.lead.tracking}px;
  color: ${(p) =>
    !p.$on ? p.theme.colors.faint : p.$buy ? p.theme.colors.onLime : p.theme.colors.neg};
`;

const Close = styled.Pressable`
  width: 32px;
  height: 32px;
  border-radius: 16px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
  align-items: center;
  justify-content: center;
`;

const CloseMark = styled.Text`
  font-size: ${(p) => p.theme.type.body.size}px;
  color: ${(p) => p.theme.colors.muted};
`;

const Field = styled.View<{ $live: boolean }>`
  flex-direction: row;
  align-items: center;
  gap: ${(p) => p.theme.space(3)}px;
  padding: ${(p) => p.theme.space(4)}px;
  border-radius: ${(p) => p.theme.radius.lg}px;
  border-width: 1.5px;
  border-color: ${(p) => (p.$live ? p.theme.colors.ink : p.theme.colors.line)};
  background-color: ${(p) => p.theme.colors.surface};
`;

const AmountRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 2px;
`;

const AmountValue = styled.Text`
  font-size: ${(p) => p.theme.type.heading.size}px;
  line-height: ${(p) => p.theme.type.heading.height}px;
  letter-spacing: ${(p) => p.theme.type.heading.tracking}px;
  font-weight: 800;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.text};
`;

/* The caret. The pad is the keyboard, so the field never takes focus and
   never draws one of its own — without this the box reads as a label. */
const Caret = styled.View`
  width: 2px;
  height: ${(p) => p.theme.type.heading.size}px;
  background-color: ${(p) => p.theme.colors.focus};
  margin-left: 2px;
`;

const TokenChip = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const TokenDot = styled.View`
  width: 14px;
  height: 14px;
  border-radius: 7px;
  background-color: ${(p) => p.theme.colors.ink};
`;

const TokenText = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 800;
  color: ${(p) => p.theme.colors.text};
`;

const Depth = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${(p) => p.theme.space(3)}px;
  padding: ${(p) => p.theme.space(3)}px;
  border-radius: ${(p) => p.theme.radius.md}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const UseIt = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 800;
  color: ${(p) => p.theme.colors.focus};
`;

const Line = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const Mono_ = styled.Text<{ $warn?: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => (p.$warn ? p.theme.colors.neg : p.theme.colors.text)};
`;

const Receive = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 600;
  color: ${(p) => p.theme.colors.text};
  min-height: 18px;
`;

const Note = styled.View`
  flex-direction: row;
  align-items: center;
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-vertical: 12px;
  border-radius: ${(p) => p.theme.radius.md}px;
  border-width: ${(p) => p.theme.hairline}px;
  border-color: ${(p) => p.theme.colors.line};
  background-color: ${(p) => p.theme.colors.surface};
`;

const Quick = styled.Pressable`
  flex: 1;
  padding-vertical: ${(p) => p.theme.space(3)}px;
  border-radius: ${(p) => p.theme.radius.md}px;
  border-width: ${(p) => p.theme.hairline}px;
  border-color: ${(p) => p.theme.colors.line};
  align-items: center;
`;

const QuickLabel = styled.Text<{ $off?: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  text-align: center;
  color: ${(p) => (p.$off ? p.theme.colors.faint : p.theme.colors.text)};
`;

const Pad = styled.View`
  flex-direction: row;
  flex-wrap: wrap;
`;

const Key = styled.Pressable`
  width: 33.33%;
  padding-vertical: ${(p) => p.theme.space(3)}px;
  align-items: center;
`;

const KeyLabel = styled.Text`
  font-size: ${(p) => p.theme.type.heading.size}px;
  font-weight: 500;
  color: ${(p) => p.theme.colors.text};
`;

const Done = styled.View`
  align-items: center;
  gap: ${(p) => p.theme.space(2)}px;
  padding-vertical: ${(p) => p.theme.space(6)}px;
`;

const DoneTitle = styled.Text`
  font-size: ${(p) => p.theme.type.heading.size}px;
  font-weight: 800;
  color: ${(p) => p.theme.colors.pos};
`;

const LinkTap = styled.Pressable`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  margin-top: ${(p) => p.theme.space(2)}px;
`;

const LinkText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.focus};
`;

const ErrorText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  color: ${(p) => p.theme.colors.neg};
  text-align: center;
`;
