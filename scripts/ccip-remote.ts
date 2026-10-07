/**
 * Deploy a Juno coin's other side on a remote chain, so it can cross from Arc over Chainlink CCIP.
 *
 *   npm run ccip:remote -- --token 0x<arc coin> --dry-run                       # the plan, nothing sent
 *   npm run ccip:remote -- --token 0x<arc coin>                                  # Base Sepolia (default)
 *   npm run ccip:remote -- --token 0x<arc coin> --chain ethereum-sepolia
 *   npm run ccip:remote -- --token 0x<arc coin> --send-arc                       # …and wire it on Arc too
 *
 * A graduated Juno coin becomes a CCIP Cross-Chain Token on Arc in one transaction by its
 * creator (`JunoCrossChain.enable`, from the app). This script builds the matching half on
 * the remote chain from Chainlink's own published code — nothing Juno wrote — and wires both:
 *
 *   on the remote chain (key: CCIP_REMOTE_PRIVATE_KEY, RPC: BASE_SEPOLIA_RPC_URL or ETHEREUM_SEPOLIA_RPC_URL)
 *   1. deploy CrossChainToken 2.0.0 (`bytecode/v2_0_0/cross_chain_token.bin`): same name and
 *      symbol as on Arc, 18 decimals, max supply 1e27 (the coin's whole supply), no pre-mint;
 *      the deployer is its owner, burn/mint role admin and CCIP admin;
 *   2. deploy BurnMintTokenPool 2.0.0 (`burn_mint_token_pool.bin`) for it:
 *      `(token, 18, advancedPoolHooks = address(0), rmnProxy, router)`;
 *   3. `token.grantMintAndBurnRoles(pool)`;
 *   4. register it with CCIP: `RegistryModuleOwnerCustom.registerAdminViaGetCCIPAdmin(token)`,
 *      `TokenAdminRegistry.acceptAdminRole(token)`, `TokenAdminRegistry.setPool(token, pool)`;
 *   5. `pool.applyChainUpdates([], [Arc: remotePool = JunoCrossChain.poolOf(coin), remoteToken = coin,
 *      rate limits on])`;
 *
 *   on Arc (the coin's creator)
 *   6. `JunoCrossChain.applyChainUpdates(coin, [], [remote chain: its pool and token, rate limits on])`
 *      — printed as calldata and as the app's `POST /api/juno/tx/ccip-chains` body; sent by this
 *      script with `--send-arc` (key: JUNO_SCRIPT_PRIVATE_KEY, which must be the coin's creator).
 *
 * After step 6, `npm run ccip:send` moves the coin across.
 *
 * Options:
 *   --token <address>        the coin on Arc (required)
 *   --chain <name>           base-sepolia (default) | ethereum-sepolia | custom
 *   --rpc <url>              override the remote RPC env var
 *   --router/--rmn/--registry-module/--token-admin-registry/--selector   required with --chain custom
 *   --capacity N --rate N    rate limits in tokens (default 50,000,000 capacity, 13,000/s; capacity ≤ 1e8, rate < capacity)
 *   --remote-token <addr>    reuse a token already deployed by an earlier run (skips step 1)
 *   --remote-pool <addr>     reuse a pool already deployed by an earlier run (skips step 2)
 *   --arc-pool <addr>        the coin's Arc pool, when it can't be read (testing only)
 *   --skip-registry          skip step 4 (only for a chain without Chainlink's registry, e.g. a bare local node:
 *                            the token is then NOT routable by CCIP)
 *   --dry-run                print the plan and the encoded constructor arguments; send nothing
 *                            (the admin in the encoding is the remote key's address, else --admin <addr>)
 *   --send-arc               also send step 6 on Arc
 *   --allow-mainnet          required for a mainnet remote chain or Arc mainnet
 *
 * The remote key is read from the environment and never printed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { junoCrossChainAbi, junoLaunchpadAbi, junoTokenAbi } from "../lib/juno/abi";
import { ccipLanes } from "../lib/juno/arc";
import { crossChainAddress, deployment, isMainnet, network } from "../lib/juno/network";
import { readScriptKey } from "./lib/key";
import { ARC_CCIP_SELECTOR, DEFAULT_LANE_LIMIT, chainUpdate, ccipPoolReadAbi, type RateLimit } from "./lib/ccip";
import { apiBase, arg, describeError, flag, header, line, links, run, scriptReader, send } from "./lib/cli";

/* ------------------------------------------------------------------ */
/* Remote chains                                                       */
/* ------------------------------------------------------------------ */

type RemoteChain = {
  key: string;
  name: string;
  chainId: number;
  /** The remote chain's CCIP selector — the lane from Arc. */
  selector: bigint;
  router: Address;
  rmnProxy: Address;
  registryModule: Address;
  tokenAdminRegistry: Address;
  rpcEnv: string;
  mainnet: boolean;
};

/** From Chainlink's CCIP Directory (docs.chain.link/ccip/directory/testnet). */
const REMOTES: Record<string, RemoteChain> = {
  "base-sepolia": {
    key: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84532,
    selector: 10344971235874465080n,
    router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
    rmnProxy: "0x99360767a4705f68CcCb9533195B761648d6d807",
    registryModule: "0x176ae8C6C11DD2c031B924CE1A0A43188035f3f6",
    tokenAdminRegistry: "0x736D0bBb318c1B27Ff686cd19804094E66250e17",
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
    mainnet: false,
  },
  "ethereum-sepolia": {
    key: "ethereum-sepolia",
    name: "Ethereum Sepolia",
    chainId: 11155111,
    selector: 16015286601757825753n,
    router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
    rmnProxy: "0xba3f6251de62dED61Ff98590cB2fDf6871FbB991",
    registryModule: "0xa3c796d480638d7476792230da1E2ADa86e031b0",
    tokenAdminRegistry: "0x95F29FEE11c5C55d26cCcf1DB6772DE953B37B82",
    rpcEnv: "ETHEREUM_SEPOLIA_RPC_URL",
    mainnet: false,
  },
};

/** Chain ids of public mainnets this script must not touch without --allow-mainnet. */
const MAINNET_CHAIN_IDS = new Set([1, 10, 56, 137, 8453, 42161, 43114, 59144, 5042, 324, 130, 146, 480, 81457, 534352]);
/** Chain ids known to be testnets or local nodes. */
const TESTNET_CHAIN_IDS = new Set([84532, 11155111, 80002, 421614, 11155420, 43113, 5042002, 31337, 1337]);

function addressArg(name: string, required: boolean): Address | undefined {
  const raw = arg(name);
  if (!raw) {
    if (required) throw new Error(`--${name} <address> is required`);
    return undefined;
  }
  if (!isAddress(raw)) throw new Error(`--${name} ${raw} is not an address`);
  return getAddress(raw);
}

function remoteChain(): RemoteChain {
  const key = (arg("chain", "base-sepolia") ?? "base-sepolia").toLowerCase();
  if (key !== "custom") {
    const preset = REMOTES[key];
    if (!preset) throw new Error(`--chain ${key}: one of ${Object.keys(REMOTES).join(", ")}, custom`);
    return preset;
  }
  const selector = arg("selector");
  if (!selector || !/^\d+$/.test(selector)) throw new Error("--chain custom needs --selector <uint64>");
  return {
    key: "custom",
    name: arg("name-of-chain", "custom chain")!,
    chainId: 0,
    selector: BigInt(selector),
    router: addressArg("router", true)!,
    rmnProxy: addressArg("rmn", true)!,
    registryModule: addressArg("registry-module", true)!,
    tokenAdminRegistry: addressArg("token-admin-registry", true)!,
    rpcEnv: "CCIP_REMOTE_RPC_URL",
    mainnet: false,
  };
}

/* ------------------------------------------------------------------ */
/* Chainlink's published artifacts                                     */
/* ------------------------------------------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url));
const CCIP_PACKAGE = path.join(here, "..", "contracts", "node_modules", "@chainlink", "contracts-ccip");

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const bin = path.join(CCIP_PACKAGE, "bytecode", "v2_0_0", `${name}.bin`);
  const json = path.join(CCIP_PACKAGE, "abi", "v2_0_0", `${name}.json`);
  let bytecode: string;
  let abiRaw: unknown;
  try {
    bytecode = readFileSync(bin, "utf8").trim();
    abiRaw = JSON.parse(readFileSync(json, "utf8"));
  } catch {
    throw new Error(
      `Chainlink's ${name} artifacts are missing at ${CCIP_PACKAGE}. Install the contracts' dependencies (cd contracts && npm install).`,
    );
  }
  if (!bytecode.startsWith("0x")) bytecode = `0x${bytecode}`;
  const abi = (Array.isArray(abiRaw) ? abiRaw : (abiRaw as { abi: unknown }).abi) as Abi;
  return { abi, bytecode: bytecode as Hex };
}

const registryModuleAbi = parseAbi(["function registerAdminViaGetCCIPAdmin(address token)"]);
const tokenAdminRegistryAbi = parseAbi([
  "function acceptAdminRole(address localToken)",
  "function setPool(address localToken, address pool)",
  "function getPool(address token) view returns (address)",
  "function getTokenConfig(address token) view returns ((address administrator, address pendingAdministrator, address tokenPool))",
]);
const roleAbi = parseAbi([
  "function MINTER_ROLE() view returns (bytes32)",
  "function BURNER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantMintAndBurnRoles(address burnAndMinter)",
  "function getCCIPAdmin() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function maxSupply() view returns (uint256)",
]);

const ZERO = /^0x0{40}$/i;

/** The Juno coin's whole supply: the remote side can never mint more than exists. */
const MAX_SUPPLY = 10n ** 27n;
const TOKEN_DECIMALS = 18;
/** JunoCrossChain.MAX_CAPACITY: a bucket can hold at most 10% of the supply. */
const MAX_CAPACITY = 100_000_000n * 10n ** 18n;

function rateLimit(): RateLimit {
  const capacityArg = arg("capacity");
  const rateArg = arg("rate");
  if (capacityArg === undefined && rateArg === undefined) return DEFAULT_LANE_LIMIT;
  const capacity = capacityArg !== undefined ? parseUnits(capacityArg, 18) : DEFAULT_LANE_LIMIT.capacity;
  const rate = rateArg !== undefined ? parseUnits(rateArg, 18) : DEFAULT_LANE_LIMIT.rate;
  if (capacity <= 0n || capacity > MAX_CAPACITY) throw new Error("--capacity must be above 0 and at most 100,000,000 tokens");
  if (rate <= 0n || rate >= capacity) throw new Error("--rate must be above 0 and below --capacity");
  return { isEnabled: true, capacity, rate };
}

/* ------------------------------------------------------------------ */
/* Remote sending                                                      */
/* ------------------------------------------------------------------ */

function remoteKey(): PrivateKeyAccount | null {
  const raw = process.env.CCIP_REMOTE_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error("CCIP_REMOTE_PRIVATE_KEY is not a 32-byte hex private key");
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

type Remote = { client: PublicClient; chain: Chain; rpc: string };

async function connect(remote: RemoteChain, required: boolean): Promise<Remote | null> {
  const rpc = arg("rpc") ?? process.env[remote.rpcEnv]?.trim();
  if (!rpc) {
    if (required) throw new Error(`Set ${remote.rpcEnv} (or pass --rpc) to reach ${remote.name}.`);
    return null;
  }
  const probe = createPublicClient({ transport: http(rpc, { retryCount: 3, timeout: 30_000 }) });
  const chainId = await probe.getChainId();
  if (MAINNET_CHAIN_IDS.has(chainId) || remote.mainnet) {
    if (!flag("allow-mainnet")) throw new Error(`${rpc} is a mainnet (chain ${chainId}). Pass --allow-mainnet if you mean it.`);
  } else if (!TESTNET_CHAIN_IDS.has(chainId) && !flag("allow-mainnet")) {
    throw new Error(`Chain ${chainId} is not a known testnet. Pass --allow-mainnet if it is safe to deploy there.`);
  }
  if (remote.chainId && chainId !== remote.chainId) {
    throw new Error(`${remote.rpcEnv} answers chain ${chainId}, not ${remote.name} (${remote.chainId}).`);
  }
  const chain: Chain = {
    id: chainId,
    name: remote.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  };
  const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 3, timeout: 30_000 }) }) as PublicClient;
  return { client, chain, rpc };
}

async function remoteSend(
  remote: Remote,
  account: PrivateKeyAccount,
  label: string,
  tx: { to?: Address; data: Hex },
): Promise<{ hash: Hex; contractAddress: Address | null }> {
  const wallet = createWalletClient({ account, chain: remote.chain, transport: http(remote.rpc, { retryCount: 2 }) });
  console.log(`\n${label}…`);
  let gas: bigint;
  try {
    gas = await remote.client.estimateGas({ account: account.address, to: tx.to, data: tx.data });
  } catch (error) {
    throw new Error(`${label}: ${describeError(error)}`);
  }
  const hash = await wallet
    .sendTransaction({ account, chain: remote.chain, to: tx.to ?? null, data: tx.data, gas: gas + gas / 5n })
    .catch((error: unknown) => {
      throw new Error(`${label}: ${describeError(error)}`);
    });
  line("sent", hash);
  const receipt = await remote.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  line("confirmed", `block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  return { hash, contractAddress: receipt.contractAddress ? getAddress(receipt.contractAddress) : null };
}

async function hasCode(client: PublicClient, address: Address): Promise<boolean> {
  const code = await client.getCode({ address }).catch(() => undefined);
  return !!code && code !== "0x";
}

/* ------------------------------------------------------------------ */

async function main() {
  const remote = remoteChain();
  const dryRun = flag("dry-run");
  if (remote.mainnet && !flag("allow-mainnet")) throw new Error(`${remote.name} is a mainnet. Pass --allow-mainnet if you mean it.`);

  // The Arc side must be the lane's other end: Arc testnet ↔ Sepolia chains, Arc mainnet ↔ mainnets.
  const arcSelector = isMainnet() ? ARC_CCIP_SELECTOR.mainnet : ARC_CCIP_SELECTOR.testnet;
  const lane = ccipLanes(network()).find((l) => BigInt(l.selector) === remote.selector);
  if (!lane) {
    throw new Error(`${remote.name} (selector ${remote.selector}) is not a CCIP lane from Arc ${network()}.`);
  }
  if (isMainnet() && !flag("allow-mainnet")) throw new Error("Arc mainnet: pass --allow-mainnet if you mean it.");

  header();
  const coinRaw = arg("token");
  if (!coinRaw || !isAddress(coinRaw)) throw new Error("--token <the coin's address on Arc> is required");
  const coin = getAddress(coinRaw);
  const reader = scriptReader();
  const cc = crossChainAddress();

  // The Arc coin: its name and symbol carry over; its pool is the remote's counterpart.
  const launchpad = deployment().launchpad;
  const [name, symbol, creator] = await Promise.all([
    reader.readContract({ address: coin, abi: junoTokenAbi, functionName: "name" }),
    reader.readContract({ address: coin, abi: junoTokenAbi, functionName: "symbol" }),
    launchpad
      ? reader
          .readContract({ address: launchpad, abi: junoLaunchpadAbi, functionName: "getPool", args: [coin] })
          .then((pool) => (ZERO.test(pool.creator) ? null : getAddress(pool.creator)))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  let arcPool = addressArg("arc-pool", false);
  if (!arcPool) {
    if (!cc) throw new Error(`No JunoCrossChain is recorded for Arc ${network()}; pass --arc-pool to test without one.`);
    const pool = await reader.readContract({ address: cc, abi: junoCrossChainAbi, functionName: "poolOf", args: [coin] });
    if (ZERO.test(pool)) {
      throw new Error(
        `$${symbol} is not a CCIP Cross-Chain Token on Arc yet: its creator enables it first (the app's "Go cross-chain", JunoCrossChain.enable). Then re-run.`,
      );
    }
    arcPool = getAddress(pool);
  } else {
    console.log("NOTE: --arc-pool overrides JunoCrossChain.poolOf — for testing only.");
  }
  const limit = rateLimit();

  line("Arc coin", `${coin} ($${symbol}, "${name}")`);
  line("Arc pool", arcPool);
  if (creator) line("creator", creator);
  line("remote", `${remote.name} (CCIP selector ${remote.selector})`);
  line("router", remote.router);
  line("RMN proxy", remote.rmnProxy);
  line("registry mod", remote.registryModule);
  line("admin reg.", remote.tokenAdminRegistry);
  line("rate limit", `capacity ${formatEther(limit.capacity)} tokens, refill ${formatEther(limit.rate)}/s, both directions`);

  const account = remoteKey();
  const deployer = account?.address ?? addressArg("admin", false) ?? null;
  if (account) line("remote key", `${account.address} (from CCIP_REMOTE_PRIVATE_KEY)`);
  else if (!dryRun) throw new Error("Set CCIP_REMOTE_PRIVATE_KEY (the remote deployer's key; it is never printed), or use --dry-run.");

  // Constructor arguments, encoded exactly as deployed.
  const tokenArtifact = artifact("cross_chain_token");
  const poolArtifact = artifact("burn_mint_token_pool");
  const admin = deployer ?? zeroAddress;
  const tokenArgs = [
    {
      name,
      symbol,
      maxSupply: MAX_SUPPLY,
      preMint: 0n,
      preMintRecipient: zeroAddress,
      decimals: TOKEN_DECIMALS,
      ccipAdmin: admin,
    },
    admin, // burnMintRoleAdmin: grants the pool its roles in step 3
    admin, // owner (DEFAULT_ADMIN_ROLE)
  ] as const;
  const tokenDeploy = encodeDeployData({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode, args: tokenArgs as never });

  const remoteTokenArg = addressArg("remote-token", false);
  const remotePoolArg = addressArg("remote-pool", false);

  if (dryRun) {
    console.log("\nPlan (dry run — nothing is sent):");
    console.log(`  1. deploy CrossChainToken 2.0.0  ${remoteTokenArg ? `(skipped: --remote-token ${remoteTokenArg})` : ""}`);
    console.log(`       code keccak ${keccak256(tokenArtifact.bytecode)}, ${(tokenArtifact.bytecode.length - 2) / 2} bytes`);
    console.log(`       args ((${JSON.stringify(name)}, ${JSON.stringify(symbol)}, maxSupply 1e27, preMint 0, preMintRecipient 0x0, decimals 18, ccipAdmin ${admin}), burnMintRoleAdmin ${admin}, owner ${admin})`);
    console.log(`       encoded args ${tokenDeploy.slice(tokenArtifact.bytecode.length)}`);
    const poolArgsPreview = encodeAbiParameters(
      [{ type: "address" }, { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "address" }],
      [remoteTokenArg ?? zeroAddress, TOKEN_DECIMALS, zeroAddress, remote.rmnProxy, remote.router],
    );
    console.log(`  2. deploy BurnMintTokenPool 2.0.0 ${remotePoolArg ? `(skipped: --remote-pool ${remotePoolArg})` : ""}`);
    console.log(`       code keccak ${keccak256(poolArtifact.bytecode)}, ${(poolArtifact.bytecode.length - 2) / 2} bytes`);
    console.log(`       args (token ${remoteTokenArg ?? "<step 1>"}, 18, advancedPoolHooks 0x0, rmnProxy ${remote.rmnProxy}, router ${remote.router})`);
    console.log(`       encoded args ${poolArgsPreview}${remoteTokenArg ? "" : "  (token word filled in after step 1)"}`);
    console.log("  3. token.grantMintAndBurnRoles(pool)");
    console.log(`  4. ${flag("skip-registry") ? "(skipped: --skip-registry) " : ""}registerAdminViaGetCCIPAdmin(token); acceptAdminRole(token); setPool(token, pool)`);
    console.log(`  5. pool.applyChainUpdates([], [{ Arc ${network()} ${arcSelector}, remotePools [abi.encode(${arcPool})], remoteToken abi.encode(${coin}) }])`);
    console.log("  6. on Arc: JunoCrossChain.applyChainUpdates(coin, [], [{ " + remote.name + ", remote pool, remote token }])");
    const connected = await connect(remote, false).catch((error: Error) => {
      console.log(`\n${remote.name} RPC: ${error.message}`);
      return null;
    });
    if (connected) {
      const checks = await Promise.all(
        [remote.router, remote.rmnProxy, remote.registryModule, remote.tokenAdminRegistry].map((a) => hasCode(connected.client, a)),
      );
      console.log(`\n${remote.name} at ${connected.rpc}: router ${checks[0] ? "ok" : "NO CODE"}, RMN ${checks[1] ? "ok" : "NO CODE"}, registry module ${checks[2] ? "ok" : "NO CODE"}, admin registry ${checks[3] ? "ok" : "NO CODE"}`);
      if (deployer) line("balance", `${formatEther(await connected.client.getBalance({ address: deployer }))} ETH`);
    }
    printArcStep(coin, creator, remote, remoteTokenArg ?? null, remotePoolArg ?? null, limit);
    return;
  }

  const connected = (await connect(remote, true))!;
  const signer = account!;
  const balance = await connected.client.getBalance({ address: signer.address });
  line("balance", `${formatEther(balance)} ETH on ${remote.name}`);
  if (balance === 0n) throw new Error(`${signer.address} has no gas on ${remote.name}. Fund it from a ${remote.name} faucet first.`);
  const [routerOk, rmnOk, moduleOk, registryOk] = await Promise.all(
    [remote.router, remote.rmnProxy, remote.registryModule, remote.tokenAdminRegistry].map((a) => hasCode(connected.client, a)),
  );
  if (!routerOk || !rmnOk) {
    console.log(`WARNING: no contract at the ${!routerOk ? "router" : "RMN proxy"} on chain ${connected.chain.id}. The pool deploys, but CCIP can't route through it.`);
  }

  // 1. The token.
  let remoteToken = remoteTokenArg;
  if (remoteToken) {
    line("token", `${remoteToken} (reused)`);
  } else {
    const deployed = await remoteSend(connected, signer, "Deploying CrossChainToken 2.0.0", { data: tokenDeploy });
    remoteToken = deployed.contractAddress!;
    line("token", remoteToken);
  }
  const typeAndVersion = await connected.client
    .readContract({ address: remoteToken, abi: parseAbi(["function typeAndVersion() view returns (string)"]), functionName: "typeAndVersion" })
    .catch(() => "?");
  line("token is", typeAndVersion);

  // 2. The pool.
  let remotePool = remotePoolArg;
  if (remotePool) {
    line("pool", `${remotePool} (reused)`);
  } else {
    const poolDeploy = encodeDeployData({
      abi: poolArtifact.abi,
      bytecode: poolArtifact.bytecode,
      args: [remoteToken, TOKEN_DECIMALS, zeroAddress, remote.rmnProxy, remote.router] as never,
    });
    const deployed = await remoteSend(connected, signer, "Deploying BurnMintTokenPool 2.0.0", { data: poolDeploy });
    remotePool = deployed.contractAddress!;
    line("pool", remotePool);
  }
  const poolToken = await connected.client.readContract({ address: remotePool, abi: ccipPoolReadAbi, functionName: "getToken" });
  if (getAddress(poolToken) !== remoteToken) throw new Error(`The pool at ${remotePool} is for ${poolToken}, not ${remoteToken}.`);

  // 3. Mint and burn roles for the pool.
  const [minter, burner] = await Promise.all([
    connected.client.readContract({ address: remoteToken, abi: roleAbi, functionName: "MINTER_ROLE" }),
    connected.client.readContract({ address: remoteToken, abi: roleAbi, functionName: "BURNER_ROLE" }),
  ]);
  const [canMint, canBurn] = await Promise.all([
    connected.client.readContract({ address: remoteToken, abi: roleAbi, functionName: "hasRole", args: [minter, remotePool] }),
    connected.client.readContract({ address: remoteToken, abi: roleAbi, functionName: "hasRole", args: [burner, remotePool] }),
  ]);
  if (canMint && canBurn) {
    line("roles", "the pool already mints and burns");
  } else {
    await remoteSend(connected, signer, "Granting the pool mint and burn roles", {
      to: remoteToken,
      data: encodeFunctionData({ abi: roleAbi, functionName: "grantMintAndBurnRoles", args: [remotePool] }),
    });
  }

  // 4. CCIP's registry.
  if (flag("skip-registry")) {
    console.log("\nSKIPPED registry (--skip-registry): the token is NOT registered with CCIP on this chain and can't be routed.");
  } else if (!moduleOk || !registryOk) {
    throw new Error(
      `No contract at the ${!moduleOk ? "RegistryModuleOwnerCustom" : "TokenAdminRegistry"} on chain ${connected.chain.id}. On a bare local node re-run with --skip-registry --remote-token ${remoteToken} --remote-pool ${remotePool}.`,
    );
  } else {
    const current = await connected.client.readContract({
      address: remote.tokenAdminRegistry,
      abi: tokenAdminRegistryAbi,
      functionName: "getTokenConfig",
      args: [remoteToken],
    });
    if (ZERO.test(current.administrator)) {
      // Re-runs resume: a proposal already pending for us only needs accepting.
      if (getAddress(current.pendingAdministrator) !== signer.address) {
        await remoteSend(connected, signer, "Proposing ourselves as the token's CCIP admin (registerAdminViaGetCCIPAdmin)", {
          to: remote.registryModule,
          data: encodeFunctionData({ abi: registryModuleAbi, functionName: "registerAdminViaGetCCIPAdmin", args: [remoteToken] }),
        });
      }
      await remoteSend(connected, signer, "Accepting the admin role in the TokenAdminRegistry", {
        to: remote.tokenAdminRegistry,
        data: encodeFunctionData({ abi: tokenAdminRegistryAbi, functionName: "acceptAdminRole", args: [remoteToken] }),
      });
    } else if (getAddress(current.administrator) !== signer.address) {
      throw new Error(`The token's CCIP admin in the TokenAdminRegistry is ${current.administrator}, not this key; it must set the pool.`);
    } else {
      line("registry", "already the token's CCIP admin");
    }
    if (getAddress(current.tokenPool) !== remotePool) {
      await remoteSend(connected, signer, "Setting the token's pool in the TokenAdminRegistry", {
        to: remote.tokenAdminRegistry,
        data: encodeFunctionData({ abi: tokenAdminRegistryAbi, functionName: "setPool", args: [remoteToken, remotePool] }),
      });
    }
  }

  // 5. Arc, on the remote pool.
  const arcWired = await connected.client.readContract({
    address: remotePool,
    abi: ccipPoolReadAbi,
    functionName: "isSupportedChain",
    args: [arcSelector],
  });
  if (arcWired) {
    line("Arc lane", "already wired on the remote pool");
  } else {
    const poolAbi = poolArtifact.abi;
    await remoteSend(connected, signer, `Wiring Arc ${network()} on the remote pool`, {
      to: remotePool,
      data: encodeFunctionData({
        abi: poolAbi,
        functionName: "applyChainUpdates",
        args: [[], [chainUpdate({ selector: arcSelector, remotePool: arcPool, remoteToken: coin, limit })]] as never,
      }),
    });
  }
  const supported = await connected.client.readContract({ address: remotePool, abi: ccipPoolReadAbi, functionName: "getSupportedChains" });
  line("pool lanes", supported.map(String).join(", "));

  console.log(`\n${remote.name} side done.`);
  line("token", remoteToken);
  line("pool", remotePool);

  // 6. Arc.
  const arcCall = printArcStep(coin, creator, remote, remoteToken, remotePool, limit);
  if (flag("send-arc")) {
    if (!arcCall) throw new Error("No JunoCrossChain recorded on Arc; can't send the Arc step.");
    if (isMainnet() && !flag("allow-mainnet")) throw new Error("Arc mainnet: pass --allow-mainnet if you mean it.");
    const key = readScriptKey();
    if (!key) throw new Error("Set JUNO_SCRIPT_PRIVATE_KEY to the coin creator's Arc key to send the Arc step.");
    const arcAccount = privateKeyToAccount(key);
    if (creator && getAddress(creator) !== arcAccount.address) {
      throw new Error(`Only the coin's creator (${creator}) can wire its lanes; JUNO_SCRIPT_PRIVATE_KEY is ${arcAccount.address}.`);
    }
    const receipt = await send(arcAccount, { ...arcCall, value: 0n, label: `Wiring ${remote.name} on the Arc pool (JunoCrossChain)` });
    line("Arc tx", links.tx(receipt.transactionHash));
    console.log(`\nBoth sides wired. Send it: npm run ccip:send -- --token ${coin} --to ${remote.key} --amount <tokens> --yes`);
  }
}

/** Step 6, printed for the creator (calldata and the app's API body); returns the call. */
function printArcStep(
  coin: Address,
  creator: string | null,
  remote: RemoteChain,
  remoteToken: Address | null,
  remotePool: Address | null,
  limit: RateLimit,
): { to: Address; data: Hex } | null {
  const cc = crossChainAddress();
  console.log(`\nOn Arc ${network()}, the coin's creator wires ${remote.name}:`);
  const token = remoteToken ?? ("0x" + "00".repeat(20)) as Address;
  const pool = remotePool ?? ("0x" + "00".repeat(20)) as Address;
  if (!remoteToken || !remotePool) console.log("  (remote addresses are placeholders until the remote side is deployed)");
  const data = encodeFunctionData({
    abi: junoCrossChainAbi,
    functionName: "applyChainUpdates",
    args: [coin, [], [chainUpdate({ selector: remote.selector, remotePool: pool, remoteToken: token, limit })]],
  });
  line("to", cc ?? "<JunoCrossChain: not recorded>");
  line("from", creator ?? "<the coin's creator>");
  line("calldata", data);
  const body = {
    token: coin,
    creator: creator ?? "<creator>",
    add: [
      {
        selector: remote.selector.toString(),
        remotePool: pool,
        remoteToken: token,
        ...(limit === DEFAULT_LANE_LIMIT ? {} : { capacity: Number(formatEther(limit.capacity)), rate: Number(formatEther(limit.rate)) }),
      },
    ],
  };
  console.log(`  or POST ${apiBase()}/api/juno/tx/ccip-chains`);
  console.log(`  ${JSON.stringify(body)}`);
  return cc ? { to: cc, data } : null;
}

run(main);
