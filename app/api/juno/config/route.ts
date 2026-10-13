import { junoJson, junoOptions } from "@/lib/juno/api";
import { ccipLanes, cctpDestinations, gatewaySources } from "@/lib/juno/arc";
import { ARC_MAINNET_FEEDS } from "@/lib/juno/chainlink";
import { usdcQuote } from "@/lib/juno/launchpad";
import { localStorageMode } from "@/lib/juno/local-media";
import { memoAddress, memoLive } from "@/lib/juno/memo";
import {
  ARC_CCTP_DOMAIN,
  ARC_FINALITY,
  CCIP_EXPLORER,
  chainId,
  deployment,
  explorerBase,
  localFork,
  network,
  networkKey,
  publicRpcEndpoint,
} from "@/lib/juno/network";
import { relayerAddress } from "@/lib/juno/relayer";

export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * Which chain this server talks to, where its contracts are, and which Arc and
 * Circle and Chainlink pieces are switched on.
 *
 * The app reads this once at start rather than compiling any of it in, so one
 * build can follow a server from testnet to mainnet. Nothing here is a secret.
 * The only chain read is the cached Memo probe, which never throws.
 *
 * `rpcUrl` is the *public* endpoint (`NEXT_PUBLIC_ARC_RPC_URL`, else the
 * network's): `ARC_RPC_URL` is the server's own and may carry a key.
 * `localFork` is true when the server's RPC is a node on this machine (a local
 * Arc fork); confirmation times measured there are the fork's, not Arc's.
 * `explorer` is the base URL; links are `${explorer}/tx/${hash}`,
 * `/address/${a}` and `/token/${t}`.
 */
export async function GET() {
  const d = deployment();
  const net = network();
  const relayer = relayerAddress();
  const usdc = usdcQuote();
  return junoJson({
    network: net,
    networkKey: networkKey(),
    chainId: chainId(),
    rpcUrl: publicRpcEndpoint(),
    localFork: localFork(),
    explorer: explorerBase(),
    usdc: usdc.address,
    launchpad: d.launchpad,
    contracts: {
      launchpad: d.launchpad,
      swapRouter: d.swapRouter,
      crossChain: d.crossChain,
      trackers: d.trackers,
      graduator: d.graduator,
      uniswapV2Factory: d.uniswapV2Factory,
      uniswapV2Router02: d.uniswapV2Router02,
    },
    deployBlock: Number(d.deployBlock),
    quoteTokens: [usdc],
    faucet: net === "testnet",
    // "ipfs": photos and metadata are pinned to IPFS on Pinata. "local": no Pinata key is set, so this server
    // keeps them on its own disk under their IPFS content address (demo storage; not pinned to the network).
    storage: localStorageMode() ? "local" : "ipfs",
    v2Trading: d.swapRouter !== null,
    venues: [{ id: "uniswap-v2", name: "Uniswap v2", quotes: [usdc.address] }],
    arc: {
      finality: ARC_FINALITY,
      gasToken: "USDC",
      memo: { address: memoAddress(), live: await memoLive() },
      gateway: {
        available: Boolean(d.gatewayWallet && d.gatewayMinter),
        wallet: d.gatewayWallet,
        minter: d.gatewayMinter,
        domain: ARC_CCTP_DOMAIN,
        sources: gatewaySources(net).map(({ domain, name }) => ({ domain, name })),
      },
      cctp: {
        domain: d.cctpDomain,
        tokenMessenger: d.tokenMessengerV2,
        destinations: cctpDestinations(net).map(({ domain, name }) => ({ domain, name })),
      },
      ccip: {
        router: d.ccipRouter,
        chainSelector: d.ccipChainSelector,
        crossChain: d.crossChain,
        lanes: ccipLanes(net).map(({ selector, name }) => ({ selector, name })),
        explorer: CCIP_EXPLORER,
      },
      feeds: { network: "mainnet", count: Object.keys(ARC_MAINNET_FEEDS).length },
      relayer: { available: relayer !== null, address: relayer },
    },
  });
}
