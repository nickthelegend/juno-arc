import { readFileSync } from "node:fs";
import path from "node:path";

import { getAddress, isAddress, zeroAddress, type Address, type Chain } from "viem";
import { arc, arcTestnet } from "viem/chains";

/**
 * Which Arc network Juno talks to, where its contracts live, and how to link
 * to them.
 *
 * Testnet is the default on purpose: a launch is permanent, and rehearsing the
 * whole lifecycle — launch, trade, fill, graduate, claim — costs nothing there.
 * Switching to mainnet is `NEXT_PUBLIC_ARC_NETWORK=mainnet` plus a mainnet
 * deployment record (`deployments/arc-mainnet.json`); nothing in the code is
 * testnet-specific.
 *
 * Addresses come from the deployment record `scripts/deploy.sh` writes
 * (`deployments/arc-<network>.json`, or `JUNO_DEPLOYMENT_FILE` — the local
 * fork's is `.fork/arc-fork.json`), never from hand-copied env vars, so the
 * server and the deploy can't disagree about where the launchpad is.
 */

export type Network = "testnet" | "mainnet";

export function network(): Network {
  return process.env.NEXT_PUBLIC_ARC_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

export function isMainnet(): boolean {
  return network() === "mainnet";
}

/**
 * The value stored in every row's `network` column. Distinct per chain so a
 * database shared between environments cannot mix them.
 */
export function networkKey(): string {
  return isMainnet() ? "arc" : "arc-testnet";
}

/**
 * Arc has sub-second, deterministic finality: a block is final the moment it
 * is produced, so a receipt in hand is a final transaction — there is no
 * "confirmations" count to wait out and no reorg to hedge against.
 */
export const ARC_FINALITY = "deterministic, ~0.5 s blocks";

/** Explorers (Blockscout): `/tx/`, `/address/`, `/token/`. */
const EXPLORER: Record<Network, string> = {
  testnet: "https://explorer.testnet.arc.io",
  mainnet: "https://explorer.arc.io",
};

const PUBLIC_RPC: Record<Network, string> = {
  testnet: "https://rpc.testnet.arc.io",
  mainnet: "https://rpc.mainnet.arc.io",
};

const ARC_TESTNET: Chain = {
  ...arcTestnet,
  rpcUrls: { default: { http: [PUBLIC_RPC.testnet] } },
  blockExplorers: { default: { name: "Arc Explorer", url: EXPLORER.testnet } },
};
const ARC_MAINNET: Chain = {
  ...arc,
  rpcUrls: { default: { http: [PUBLIC_RPC.mainnet] } },
  blockExplorers: { default: { name: "Arc Explorer", url: EXPLORER.mainnet } },
};

export function chain(): Chain {
  return isMainnet() ? ARC_MAINNET : ARC_TESTNET;
}

export function chainId(): number {
  return chain().id;
}

/** Arc mainnet, for reading Chainlink Data Feeds (they are registered on mainnet only). */
export const arcMainnetChain: Chain = ARC_MAINNET;

/**
 * The public endpoints are rate-limited, and a live demo hits them in bursts.
 * A dedicated RPC belongs in `ARC_RPC_URL`. Falling back is deliberate — it
 * keeps local development working without credentials.
 */
export function rpcEndpoint(): string {
  return (
    process.env.ARC_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_ARC_RPC_URL?.trim() ||
    PUBLIC_RPC[network()]
  );
}

/** The RPC the app is told about — never one that carries a key. */
export function publicRpcEndpoint(): string {
  return process.env.NEXT_PUBLIC_ARC_RPC_URL?.trim() || PUBLIC_RPC[network()];
}

/** Arc mainnet's RPC, for Chainlink Data Feeds. */
export function mainnetRpcEndpoint(): string {
  return process.env.ARC_MAINNET_RPC_URL?.trim() || PUBLIC_RPC.mainnet;
}

/**
 * Whether the server's RPC is a node on this machine: an Arc fork in
 * development. Timings measured there are the fork's, not Arc's, so the app
 * must not present them as Arc's.
 */
export function localFork(): boolean {
  try {
    const host = new URL(rpcEndpoint()).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]";
  } catch {
    return false;
  }
}

export function usingPublicRpc(): boolean {
  return !process.env.ARC_RPC_URL?.trim() && !process.env.NEXT_PUBLIC_ARC_RPC_URL?.trim();
}

/* ------------------------------------------------------------------ */
/* The deployment record                                               */
/* ------------------------------------------------------------------ */

/**
 * `deployments/arc-<network>.json`, as `scripts/deploy.sh` writes it. Every
 * address is optional here: a record from an older deploy, or none at all,
 * leaves the matching feature off rather than pointing it at the zero address.
 */
export type Deployment = {
  chainId: number;
  network: string;
  launchpad: Address | null;
  graduator: Address | null;
  swapRouter: Address | null;
  crossChain: Address | null;
  trackers: Address | null;
  uniswapV2Factory: Address | null;
  uniswapV2Router02: Address | null;
  uniswapV2PairInitCodeHash: string | null;
  ccipPoolInitCodeHash: string | null;
  usdc: Address;
  tokenMessengerV2: Address | null;
  cctpDomain: number;
  gatewayWallet: Address | null;
  gatewayMinter: Address | null;
  memo: Address | null;
  ccipRouter: Address | null;
  /** A uint64 — kept as a decimal string, it does not fit a JS number. */
  ccipChainSelector: string | null;
  ccipTokenPoolFactory: Address | null;
  ccipRegistryModuleOwnerCustom: Address | null;
  ccipTokenAdminRegistry: Address | null;
  deployBlock: bigint;
  owner: Address | null;
  maxRaiseUnits: string | null;
  protocolShareBps: number | null;
  /** Where it was read from, for error messages. */
  source: string | null;
};

/** USDC on Arc: one address on both networks (6-dec ERC-20 view of the native balance). */
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
/** Arc's Memo contract, same address on both networks. */
export const ARC_MEMO: Address = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
/** Circle CCTP V2 domain of Arc. */
export const ARC_CCTP_DOMAIN = 26;

/** Circle's and Chainlink's addresses per network, used when the record omits them. */
const DEFAULTS: Record<Network, Partial<Deployment>> = {
  testnet: {
    chainId: 5042002,
    tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    ccipRouter: "0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8",
    ccipChainSelector: "3034092155422581607",
    ccipTokenPoolFactory: "0xdC6b0980d1B3661adf889b85554555C4AFFf2dB5",
    ccipRegistryModuleOwnerCustom: "0x524B83ae8208490151339c626fd0E35b964483e3",
    ccipTokenAdminRegistry: "0xd3e461C55676B10634a5F81b747c324B85686Dd1",
  },
  mainnet: {
    chainId: 5042,
    tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayMinter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
    ccipRouter: "0xB79791184973589c38e114D43Eb8E4588C283A18",
    ccipChainSelector: "6370580034781731079",
    ccipTokenPoolFactory: "0x7CcFb2Fa43637b4858Cb1269CF0d64a99e8C668a",
    ccipRegistryModuleOwnerCustom: "0x3201a20D2a33820C0DaC8Bc93C4819755C2a8c7F",
    ccipTokenAdminRegistry: "0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29",
  },
};

/**
 * JSON with integers too large for a double (CCIP chain selectors) read as
 * strings, so `3034092155422581607` does not come back as …600.
 */
export function parseDeploymentJson(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"')) as Record<string, unknown>;
}

function addressOr(value: unknown, fallback: Address | null | undefined): Address | null {
  if (typeof value === "string" && isAddress(value) && value !== zeroAddress) return getAddress(value);
  return fallback ?? null;
}

export function deploymentFrom(raw: Record<string, unknown>, net: Network = network(), source: string | null = null): Deployment {
  const d = DEFAULTS[net];
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? String(v) : null);
  const num = (v: unknown) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    chainId: num(raw.chainId) ?? d.chainId!,
    network: str(raw.network) ?? net,
    launchpad: addressOr(raw.launchpad, null),
    graduator: addressOr(raw.graduator, null),
    swapRouter: addressOr(raw.swapRouter, null),
    crossChain: addressOr(raw.crossChain, null),
    trackers: addressOr(raw.trackers, null),
    uniswapV2Factory: addressOr(raw.uniswapV2Factory, null),
    uniswapV2Router02: addressOr(raw.uniswapV2Router02, null),
    uniswapV2PairInitCodeHash: str(raw.uniswapV2PairInitCodeHash),
    ccipPoolInitCodeHash: str(raw.ccipPoolInitCodeHash),
    usdc: addressOr(raw.usdc, ARC_USDC)!,
    tokenMessengerV2: addressOr(raw.tokenMessengerV2, d.tokenMessengerV2),
    cctpDomain: num(raw.cctpDomain) ?? ARC_CCTP_DOMAIN,
    gatewayWallet: addressOr(raw.gatewayWallet, d.gatewayWallet),
    gatewayMinter: addressOr(raw.gatewayMinter, d.gatewayMinter),
    memo: addressOr(raw.memo, ARC_MEMO),
    ccipRouter: addressOr(raw.ccipRouter, d.ccipRouter),
    ccipChainSelector: str(raw.ccipChainSelector) ?? d.ccipChainSelector ?? null,
    ccipTokenPoolFactory: addressOr(raw.ccipTokenPoolFactory, d.ccipTokenPoolFactory),
    ccipRegistryModuleOwnerCustom: addressOr(raw.ccipRegistryModuleOwnerCustom, d.ccipRegistryModuleOwnerCustom),
    ccipTokenAdminRegistry: addressOr(raw.ccipTokenAdminRegistry, d.ccipTokenAdminRegistry),
    deployBlock: /^\d+$/.test(str(raw.deployBlock) ?? "") ? BigInt(str(raw.deployBlock)!) : 0n,
    owner: addressOr(raw.owner, null),
    maxRaiseUnits: str(raw.maxRaiseUnits),
    protocolShareBps: num(raw.protocolShareBps),
    source,
  };
}

export function deploymentFile(): string {
  const configured = process.env.JUNO_DEPLOYMENT_FILE?.trim();
  return configured || path.join("deployments", `arc-${network()}.json`);
}

let cachedDeployment: Deployment | null = null;

/**
 * The deployment this server runs against. Read once per process; with no
 * record on disk every Juno address is null and the routes say "not deployed".
 */
export function deployment(): Deployment {
  if (cachedDeployment) return cachedDeployment;
  const file = deploymentFile();
  const full = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  let raw: Record<string, unknown> = {};
  let source: string | null = null;
  try {
    raw = parseDeploymentJson(readFileSync(full, "utf8"));
    source = file;
  } catch {
    raw = {};
  }
  cachedDeployment = deploymentFrom(raw, network(), source);
  return cachedDeployment;
}

/** For tests. */
export function resetDeploymentCache(): void {
  cachedDeployment = null;
}

/**
 * The Juno launchpad. Null until one is deployed and recorded — every read
 * and every route checks, and says so, rather than calling the zero address.
 */
export function launchpadAddress(): Address | null {
  return deployment().launchpad;
}

export function requireLaunchpad(): Address {
  const address = launchpadAddress();
  if (!address) {
    throw new Error(
      `No Juno launchpad is recorded for Arc ${network()} (${deploymentFile()}). Deploy with scripts/deploy.sh, or point JUNO_DEPLOYMENT_FILE at a record.`,
    );
  }
  return address;
}

/** The block the launchpad was deployed in — where the log scan starts. */
export function launchpadDeployBlock(): bigint {
  return deployment().deployBlock;
}

/** `JunoSwapRouter`: trades a coin after it graduates into its Uniswap v2 pair. */
export function swapRouterAddress(): Address | null {
  return deployment().swapRouter;
}

/** `JunoCrossChain`: makes a graduated coin a Chainlink CCIP Cross-Chain Token. */
export function crossChainAddress(): Address | null {
  return deployment().crossChain;
}

/** `JunoTrackers`: Chainlink Data Feed marks for tracker coins. */
export function trackersAddress(): Address | null {
  return deployment().trackers;
}

/** Circle USDC — the only quote token, and the gas token. */
export function usdcAddress(): Address {
  return deployment().usdc;
}

/** Retained for readers of the launchpad's `Pool.creator`: an unknown token reads as the zero address. */
export const ZERO_ADDRESS: Address = zeroAddress;

/* ------------------------------------------------------------------ */
/* Explorer links — the proof a judge clicks                           */
/* ------------------------------------------------------------------ */

export function explorerBase(): string {
  return EXPLORER[network()];
}

export const explorer = {
  tx: (hash: string) => `${explorerBase()}/tx/${hash}`,
  address: (address: string) => `${explorerBase()}/address/${address}`,
  token: (address: string) => `${explorerBase()}/token/${address}`,
};

/** Chainlink's CCIP explorer, for a message id. */
export const CCIP_EXPLORER = "https://ccip.chain.link";
export function ccipMessageUrl(messageId: string): string {
  return `${CCIP_EXPLORER}/msg/${messageId}`;
}
