// First, before viem: its hashing library reads `globalThis.crypto` once, at
// import, and keeps whatever it found. See `./polyfills`.
import "./polyfills";

import type React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { TransactionSerializableEIP1559 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { sameAddress } from "./address";
import { juno, type Address, type Hex, type SubmitResult, type TypedDataPayload, type UnsignedTransaction } from "./api";

/**
 * The wallet.
 *
 * Juno's transactions are built on the server and signed here. This module owns
 * that second half: it holds a key, turns the server's hex-encoded EIP-1559
 * requests into signed transactions, and hands the bytes back to be submitted.
 * The key never leaves the device, and what lands is an ordinary Arc
 * transaction anyone can check on Arc's explorer. Gas is paid in USDC — the
 * only token the wallet ever needs.
 *
 * ## The device key
 *
 * A secp256k1 key generated with viem and kept in the device keychain (in
 * `localStorage` on the web). It signs three things: transactions, EIP-191
 * messages (claiming a name), and EIP-712 typed data — the EIP-3009
 * authorisation behind a gasless buy, and a Circle Gateway burn intent.
 *
 * It is **not a simulation**: real signatures, real transactions on Arc
 * testnet. What it is not is a recoverable wallet — the key lives only on this
 * device unless the person exports it, which the profile's wallet tab offers
 * (and imports one back). The profile says exactly that rather than implying a
 * custody story it does not have.
 */

export type WalletMode = "local";

/** Something that can sign for exactly one address. */
export interface Signer {
  readonly address: Address;
  readonly mode: WalletMode;
  /** Sign a fully-specified EIP-1559 transaction; returns the serialised, signed bytes. */
  signTransaction(transaction: TransactionSerializableEIP1559): Promise<Hex>;
  /** EIP-191 `personal_sign` of UTF-8 text. */
  signMessage(message: string): Promise<Hex>;
  /** EIP-712 typed data: an EIP-3009 authorisation, a Gateway burn intent. */
  signTypedData(data: TypedDataPayload): Promise<Hex>;
}

/** Where a signer comes from, and where it goes when the person signs out. */
export interface SignerSource {
  readonly mode: WalletMode;
  /**
   * The signer this device already has, or null when it has none.
   *
   * Throws when the store could not be *read* — which is not the same as it
   * being empty, and must never be treated as permission to create a new key
   * over one that is merely locked.
   */
  restore(): Promise<Signer | null>;
  /** Make one. Only called after `restore` said there is none. */
  create(): Promise<Signer>;
  forget(): Promise<void>;
}

/** Where a multi-step submit has got to, for a button label or a status line. */
export type StepProgress = {
  index: number;
  total: number;
  label: string;
  phase: "signing" | "submitting";
};

/**
 * A batch that stopped part-way.
 *
 * Steps are submitted in order, so when a later one fails the earlier ones are
 * already on chain — an approval that went through before its buy did not.
 * That is a different outcome from "nothing happened", and the caller gets
 * the receipts that did land alongside the reason the next one did not.
 */
export class PartialSubmitError extends Error {
  readonly landed: SubmitResult[];
  constructor(message: string, landed: SubmitResult[]) {
    super(message);
    this.name = "PartialSubmitError";
    this.landed = landed;
  }
}

export type WalletState = {
  /** EIP-55 checksummed. */
  address: Address | null;
  mode: WalletMode;
  ready: boolean;
  /** True while a signature is being produced. */
  signing: boolean;
  /** Create or restore a wallet. Called when the user first needs one. */
  connect: () => Promise<Address>;
  disconnect: () => Promise<void>;
  /** Sign one server-built step. Returns the signed transaction, ready for `submit`. */
  signStep: (step: UnsignedTransaction) => Promise<Hex>;
  /**
   * Sign a plain-text message (EIP-191 `personal_sign`).
   *
   * Used to prove ownership of this wallet off-chain — claiming a name — where
   * a transaction would cost gas to say nothing the chain needs to know.
   */
  signMessage: (message: string) => Promise<Hex>;
  /** Sign EIP-712 typed data the server built (a gasless buy, a Gateway burn intent). */
  signTypedData: (data: TypedDataPayload) => Promise<Hex>;
  /** The device key, to back it up. Throws when there is none. */
  exportKey: () => Promise<Hex>;
  /** Replace the device key with this one (0x + 64 hex). The old key is gone unless it was exported. */
  importKey: (privateKey: string) => Promise<Address>;
  /**
   * Sign every step, then submit them in order, each after the last answered.
   *
   * Signed up front because the nonces are already fixed and consecutive, so
   * nothing about step two depends on step one having landed — and a signer
   * that refuses step two should refuse before step one is on chain, not
   * after. Submitted one at a time because the server waits for each receipt,
   * and the second step is only valid once the first has confirmed.
   */
  signAndSubmit: (
    steps: UnsignedTransaction[],
    onStep?: (progress: StepProgress) => void,
    /** Each step's receipt, the moment it lands — for screens that show them as they come. */
    onLanded?: (result: SubmitResult, step: { index: number; total: number; label: string }) => void,
  ) => Promise<SubmitResult[]>;
};

const WalletContext = createContext<WalletState | null>(null);

/* ------------------------------------------------------------------ */
/* The local device key                                                */
/* ------------------------------------------------------------------ */

/**
 * Keychain entry holding the local key.
 *
 * Its own name, so a key another Juno build kept on this device is never
 * picked up by accident.
 */
const LOCAL_KEY = "juno.arc.signer.v1";

/**
 * Where the key is kept: the keychain on a phone, `localStorage` on web.
 *
 * `expo-secure-store` ships an empty module for web, so every call threw and
 * the web build could never hold a wallet — likes, follows and trades all
 * failed at the first step without saying why. A testnet key in a browser's
 * storage is exactly as recoverable as one in a simulator's keychain, which
 * is to say not at all; the profile screen already says so.
 */
const store = {
  get: (key: string): Promise<string | null> =>
    Platform.OS === "web"
      ? Promise.resolve(globalThis.localStorage?.getItem(key) ?? null)
      : SecureStore.getItemAsync(key),
  set: (key: string, value: string): Promise<void> =>
    Platform.OS === "web"
      ? Promise.resolve(globalThis.localStorage?.setItem(key, value))
      : SecureStore.setItemAsync(key, value),
  remove: (key: string): Promise<void> =>
    Platform.OS === "web"
      ? Promise.resolve(globalThis.localStorage?.removeItem(key))
      : SecureStore.deleteItemAsync(key),
};

function localSigner(privateKey: Hex): Signer {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    mode: "local",
    signTransaction: (transaction) => account.signTransaction(transaction),
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (data) =>
      account.signTypedData({
        domain: normaliseDomain(data.domain),
        types: withoutDomainType(data.types),
        primaryType: data.primaryType,
        message: data.message,
      } as Parameters<typeof account.signTypedData>[0]),
  };
}

/**
 * The domain as viem wants it: `chainId` a number. Servers send it as a
 * number or a decimal string; either signs the same.
 */
function normaliseDomain(domain: Record<string, unknown>): Record<string, unknown> {
  const out = { ...domain };
  if (typeof out.chainId === "string") out.chainId = Number(out.chainId);
  return out;
}

/** viem derives `EIP712Domain` itself and refuses it in `types`. */
function withoutDomainType(types: TypedDataPayload["types"]): TypedDataPayload["types"] {
  const { EIP712Domain: _domain, ...rest } = types;
  return rest;
}

/** Read and replace the stored key: export and import on the profile's wallet tab. */
export async function readStoredKey(): Promise<Hex | null> {
  const stored = await store.get(LOCAL_KEY);
  return stored && /^0x[0-9a-fA-F]{64}$/.test(stored) ? (stored as Hex) : null;
}

/** A secp256k1 key generated on this device and kept in its keychain. */
export const localKeySource: SignerSource = {
  mode: "local",
  async restore() {
    const stored = await store.get(LOCAL_KEY);
    // A malformed entry is worth discarding rather than crashing the app on
    // boot; `create` overwrites it. A *failed read* throws above instead.
    if (!stored || !/^0x[0-9a-fA-F]{64}$/.test(stored)) return null;
    try {
      return localSigner(stored as Hex);
    } catch {
      return null;
    }
  },
  async create() {
    const key = generatePrivateKey();
    await store.set(LOCAL_KEY, key);
    return localSigner(key);
  },
  forget: () => store.remove(LOCAL_KEY),
};

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

/**
 * The server's JSON request, as viem wants it.
 *
 * Every quantity crosses the wire as hex so it survives JSON; viem's
 * serialiser wants bigints. `from` is not part of a signed transaction at all
 * — the signature determines it — so it is checked against the signer rather
 * than passed along.
 */
function toSerializable(step: UnsignedTransaction): TransactionSerializableEIP1559 {
  const { request } = step;
  return {
    type: "eip1559",
    chainId: request.chainId,
    to: request.to,
    data: request.data,
    value: BigInt(request.value),
    nonce: request.nonce,
    gas: BigInt(request.gas),
    maxFeePerGas: BigInt(request.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(request.maxPriorityFeePerGas),
  };
}

export function WalletProvider({
  children,
  source = localKeySource,
}: {
  children: React.ReactNode;
  /** Where the key comes from; the device key unless a test passes another. */
  source?: SignerSource;
}) {
  const [signer, setSigner] = useState<Signer | null>(null);
  const [ready, setReady] = useState(false);
  const [signing, setSigning] = useState(false);
  /** The live signer, for callbacks that must not wait on a re-render. */
  const current = useRef<Signer | null>(null);
  /**
   * One connect at a time. A like and a follow tapped together on a fresh
   * install each found no key and each generated one; the second overwrote
   * the first in the keychain while the first's address was already on a
   * row on the server.
   */
  const connecting = useRef<Promise<Signer> | null>(null);

  const adopt = useCallback((next: Signer | null) => {
    current.current = next;
    setSigner(next);
  }, []);

  // Restore an existing key on boot so a returning user keeps their balance
  // and their position history.
  useEffect(() => {
    let cancelled = false;
    // A new source starts from nothing.
    adopt(null);
    setReady(false);
    connecting.current = null;
    source
      .restore()
      .then((existing) => {
        if (!cancelled) adopt(existing);
      })
      // A keychain that will not answer yet (a phone still locked after a
      // restart) leaves the wallet absent for now. `connect` reads again.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source, adopt]);

  const ensure = useCallback((): Promise<Signer> => {
    if (current.current) return Promise.resolve(current.current);
    if (!connecting.current) {
      connecting.current = (async () => {
        const next = (await source.restore()) ?? (await source.create());
        adopt(next);
        return next;
      })().finally(() => {
        connecting.current = null;
      });
    }
    return connecting.current;
  }, [source, adopt]);

  /** The signer that exists, never a new one: something built for an address needs *that* key. */
  const existing = useCallback(async (): Promise<Signer> => {
    const found = current.current ?? (await source.restore());
    if (!found) throw new Error("No wallet to sign with");
    if (!current.current) adopt(found);
    return found;
  }, [source, adopt]);

  const connect = useCallback(async () => (await ensure()).address, [ensure]);

  const disconnect = useCallback(async () => {
    await source.forget();
    adopt(null);
  }, [source, adopt]);

  const signStep = useCallback(
    async (step: UnsignedTransaction) => {
      const active = await existing();
      // The server builds for the address it was given. A mismatch means the
      // build belongs to a different wallet — a stale screen after a reset —
      // and signing it would only produce a transaction the chain rejects.
      if (!sameAddress(step.request.from, active.address)) {
        throw new Error("This transaction was built for a different wallet. Close it and try again.");
      }
      setSigning(true);
      try {
        return await active.signTransaction(toSerializable(step));
      } finally {
        setSigning(false);
      }
    },
    [existing],
  );

  const signMessage = useCallback(
    async (message: string) => {
      const active = await existing();
      setSigning(true);
      try {
        return await active.signMessage(message);
      } finally {
        setSigning(false);
      }
    },
    [existing],
  );

  const signTypedData = useCallback(
    async (data: TypedDataPayload) => {
      const active = await existing();
      setSigning(true);
      try {
        return await active.signTypedData(data);
      } finally {
        setSigning(false);
      }
    },
    [existing],
  );

  const exportKey = useCallback(async () => {
    const key = await readStoredKey();
    if (!key) throw new Error("This device has no key to export yet.");
    return key;
  }, []);

  const importKey = useCallback(
    async (privateKey: string) => {
      const key = privateKey.trim().replace(/^(?!0x)/, "0x");
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("A private key is 0x followed by 64 hex characters.");
      const next = localSigner(key as Hex);
      await store.set(LOCAL_KEY, key);
      adopt(next);
      return next.address;
    },
    [adopt],
  );

  const signAndSubmit = useCallback(
    async (
      steps: UnsignedTransaction[],
      onStep?: (progress: StepProgress) => void,
      onLanded?: (result: SubmitResult, step: { index: number; total: number; label: string }) => void,
    ) => {
      const total = steps.length;

      const signed: Hex[] = [];
      for (const [index, step] of steps.entries()) {
        onStep?.({ index, total, label: step.label, phase: "signing" });
        signed.push(await signStep(step));
      }

      const landed: SubmitResult[] = [];
      for (const [index, bytes] of signed.entries()) {
        onStep?.({ index, total, label: steps[index].label, phase: "submitting" });
        try {
          const result = await juno.submit({ signed: bytes });
          landed.push(result);
          onLanded?.(result, { index, total, label: steps[index].label });
        } catch (caught) {
          const reason = caught instanceof Error ? caught.message : "the network refused it";
          if (landed.length === 0) throw caught;
          throw new PartialSubmitError(
            `${steps[index - 1].label} went through, but ${steps[index].label.toLowerCase()} did not: ${reason}`,
            landed,
          );
        }
      }
      return landed;
    },
    [signStep],
  );

  const value = useMemo<WalletState>(
    () => ({
      address: signer?.address ?? null,
      mode: signer?.mode ?? source.mode,
      ready,
      signing,
      connect,
      disconnect,
      signStep,
      signMessage,
      signTypedData,
      exportKey,
      importKey,
      signAndSubmit,
    }),
    [signer, source.mode, ready, signing, connect, disconnect, signStep, signMessage, signTypedData, exportKey, importKey, signAndSubmit],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside a WalletProvider");
  return context;
}
