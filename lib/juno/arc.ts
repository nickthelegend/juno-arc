/**
 * Arc's cross-chain neighbours, as Circle and Chainlink number them.
 *
 * Pure data, no I/O: the routes, the scripts and the tests all read the same
 * tables.
 */

import type { Network } from "./network";

/** A Circle CCTP V2 domain (developers.circle.com/cctp/supported-domains). */
export type CctpDomain = { domain: number; name: string; evm: boolean };

const CCTP_TESTNET: CctpDomain[] = [
  { domain: 6, name: "Base Sepolia", evm: true },
  { domain: 0, name: "Ethereum Sepolia", evm: true },
  { domain: 3, name: "Arbitrum Sepolia", evm: true },
  { domain: 2, name: "OP Sepolia", evm: true },
  { domain: 1, name: "Avalanche Fuji", evm: true },
  { domain: 7, name: "Polygon Amoy", evm: true },
  { domain: 10, name: "Unichain Sepolia", evm: true },
  { domain: 11, name: "Linea Sepolia", evm: true },
  { domain: 13, name: "Sonic Testnet", evm: true },
  { domain: 14, name: "World Chain Sepolia", evm: true },
  { domain: 5, name: "Solana Devnet", evm: false },
];

const CCTP_MAINNET: CctpDomain[] = [
  { domain: 6, name: "Base", evm: true },
  { domain: 0, name: "Ethereum", evm: true },
  { domain: 3, name: "Arbitrum", evm: true },
  { domain: 2, name: "OP Mainnet", evm: true },
  { domain: 1, name: "Avalanche", evm: true },
  { domain: 7, name: "Polygon PoS", evm: true },
  { domain: 10, name: "Unichain", evm: true },
  { domain: 11, name: "Linea", evm: true },
  { domain: 13, name: "Sonic", evm: true },
  { domain: 14, name: "World Chain", evm: true },
  { domain: 5, name: "Solana", evm: false },
];

/** Where creator fees can be sent from Arc through CCTP (Arc itself, domain 26, is refused by the launchpad). */
export function cctpDestinations(net: Network): CctpDomain[] {
  return net === "mainnet" ? CCTP_MAINNET : CCTP_TESTNET;
}

export function cctpDomainName(net: Network, domain: number): string | null {
  if (domain === 26) return net === "mainnet" ? "Arc" : "Arc Testnet";
  return cctpDestinations(net).find((d) => d.domain === domain)?.name ?? null;
}

/** Circle Iris: CCTP attestations and fees. */
export function irisApiUrl(net: Network): string {
  return process.env.CIRCLE_IRIS_API_URL?.trim() || (net === "mainnet" ? "https://iris-api.circle.com" : "https://iris-api-sandbox.circle.com");
}

/** Circle Gateway's API. */
export function gatewayApiUrl(net: Network): string {
  return process.env.CIRCLE_GATEWAY_API_URL?.trim() || (net === "mainnet" ? "https://gateway-api.circle.com" : "https://gateway-api-testnet.circle.com");
}

/** A chain Gateway can take a unified USDC balance from, with its USDC address. */
export type GatewaySource = { domain: number; name: string; usdc: `0x${string}` };

const GATEWAY_TESTNET: GatewaySource[] = [
  { domain: 6, name: "Base Sepolia", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { domain: 0, name: "Ethereum Sepolia", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { domain: 3, name: "Arbitrum Sepolia", usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  { domain: 1, name: "Avalanche Fuji", usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  { domain: 2, name: "OP Sepolia", usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  { domain: 7, name: "Polygon Amoy", usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
  { domain: 26, name: "Arc Testnet", usdc: "0x3600000000000000000000000000000000000000" },
];

const GATEWAY_MAINNET: GatewaySource[] = [
  { domain: 6, name: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  { domain: 0, name: "Ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { domain: 3, name: "Arbitrum", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  { domain: 1, name: "Avalanche", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
  { domain: 2, name: "OP Mainnet", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  { domain: 7, name: "Polygon PoS", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  { domain: 26, name: "Arc", usdc: "0x3600000000000000000000000000000000000000" },
];

export function gatewaySources(net: Network): GatewaySource[] {
  return net === "mainnet" ? GATEWAY_MAINNET : GATEWAY_TESTNET;
}

/** A CCIP lane out of Arc (docs.chain.link/ccip/directory). Selectors are uint64, kept as strings. */
export type CcipLane = { selector: string; name: string; evm: boolean };

const CCIP_TESTNET: CcipLane[] = [
  { selector: "10344971235874465080", name: "Base Sepolia", evm: true },
  { selector: "16015286601757825753", name: "Ethereum Sepolia", evm: true },
  { selector: "16281711391670634445", name: "Polygon Amoy", evm: true },
  { selector: "16423721717087811551", name: "Solana Devnet", evm: false },
];

const CCIP_MAINNET: CcipLane[] = [
  { selector: "15971525489660198786", name: "Base", evm: true },
  { selector: "5009297550715157269", name: "Ethereum", evm: true },
  { selector: "4051577828743386545", name: "Polygon", evm: true },
  { selector: "124615329519749607", name: "Solana", evm: false },
];

export function ccipLanes(net: Network): CcipLane[] {
  return net === "mainnet" ? CCIP_MAINNET : CCIP_TESTNET;
}

export function ccipLaneName(net: Network, selector: string | bigint): string | null {
  const key = String(selector);
  return ccipLanes(net).find((lane) => lane.selector === key)?.name ?? null;
}
