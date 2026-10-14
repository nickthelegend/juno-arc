#!/bin/sh
# Deploy Juno's contracts to Arc — one script for both networks.
#
#   sh scripts/deploy.sh testnet                       # Arc testnet (5042002)
#   JUNO_CONFIRM_MAINNET=yes sh scripts/deploy.sh mainnet   # Arc mainnet (5042), see MAINNET.md
#   DRY_RUN=1 sh scripts/deploy.sh testnet             # simulate against the live chain, broadcast nothing
#   VERIFY=1 sh scripts/deploy.sh testnet              # also verify on the Arc explorer (Blockscout)
#
# contracts/script/Deploy.s.sol deploys Uniswap's published v2 factory + Router02 (Arc has no Uniswap), the
# launchpad, its graduator, JunoCrossChain (CCIP CCTs), JunoSwapRouter and JunoTrackers (Chainlink Data Feeds,
# registered on mainnet), and writes deployments/arc-<network>.json.
#
# Needs Circle's Arc Foundry forge (https://github.com/circlefin/arc-foundry): set FORGE=/path/to/forge if it isn't
# the forge on PATH. The deployer key is never stored in this repo: it is read from DEPLOYER_ENV (default
# ../.deployer/deployer.env, which defines DEPLOYER_PRIVATE_KEY) inside this process only, and the broadcast holds the
# shared deployer lock so parallel deploys from the same wallet never collide on nonces.
#
# Optional env: JUNO_OWNER (a Safe on mainnet), JUNO_PROTOCOL_SHARE_BPS, JUNO_MAX_RAISE_USDC, UNISWAP_V2_FACTORY.
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
NETWORK=${1:-${NETWORK:-testnet}}
case "$NETWORK" in
  testnet) RPC=${ARC_TESTNET_RPC_URL:-https://rpc.testnet.arc.io}; CHAIN=5042002; API=https://explorer.testnet.arc.io/api/ ;;
  mainnet) RPC=${ARC_MAINNET_RPC_URL:-https://rpc.mainnet.arc.io}; CHAIN=5042; API=https://explorer.arc.io/api/ ;;
  *) echo "usage: sh scripts/deploy.sh testnet|mainnet"; exit 1 ;;
esac
FORGE=${FORGE:-forge}
CAST=${CAST:-cast}
OUT=${JUNO_DEPLOYMENT_OUT:-$ROOT/deployments/arc-$NETWORK.json}
[ "$("$CAST" chain-id --rpc-url "$RPC")" = "$CHAIN" ] || { echo "$RPC is not chain $CHAIN"; exit 1; }
[ -d contracts/node_modules/@chainlink/contracts-ccip ] || (cd contracts && npm ci --no-audit --no-fund)
[ -f contracts/lib/forge-std/src/Script.sol ] || git submodule update --init --recursive

if [ "$NETWORK" = mainnet ] && [ -z "$DRY_RUN" ] && [ "$JUNO_CONFIRM_MAINNET" != yes ]; then
  echo "Mainnet holds real money. Read MAINNET.md, then re-run with JUNO_CONFIRM_MAINNET=yes."; exit 1
fi

DEPLOYER_ENV=${DEPLOYER_ENV:-$ROOT/../.deployer/deployer.env}
[ -f "$DEPLOYER_ENV" ] || { echo "No deployer key file at $DEPLOYER_ENV (set DEPLOYER_ENV)."; exit 1; }
set -a; . "$DEPLOYER_ENV"; set +a
[ -n "$DEPLOYER_PRIVATE_KEY" ] || { echo "$DEPLOYER_ENV doesn't define DEPLOYER_PRIVATE_KEY"; exit 1; }
DEPLOYER=$("$CAST" wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
BAL=$("$CAST" balance "$DEPLOYER" --rpc-url "$RPC")
echo "deployer $DEPLOYER on $NETWORK: $("$CAST" from-wei "$BAL") USDC (native, 18 decimals)"

export DEPLOYER_PRIVATE_KEY JUNO_DEPLOYMENT_OUT="$OUT"
mkdir -p deployments
cd contracts
# 1. Simulate against the live chain (writes $OUT.dry-run).
"$FORGE" script script/Deploy.s.sol --network arc --rpc-url "$RPC"
[ -n "$DRY_RUN" ] && { echo "dry run only: nothing was sent"; exit 0; }
[ "$BAL" = 0 ] && { echo "The deployer holds no USDC on $NETWORK: fund $DEPLOYER (about 1 USDC covers the deploy)."; exit 1; }

# 2. Broadcast, holding the shared deployer lock only for the broadcast itself.
LOCK="${DEPLOY_LOCK:-$ROOT/../.deployer/lock}"
until mkdir "$LOCK" 2>/dev/null; do sleep 3; done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
"$FORGE" script script/Deploy.s.sol --network arc --rpc-url "$RPC" --broadcast --slow
rmdir "$LOCK"; trap - EXIT
echo "addresses: $OUT"

# 3. Verify Juno's own contracts on Blockscout (Uniswap's and Chainlink's are their published bytecode).
if [ -n "$VERIFY" ]; then
  get() { node -e "console.log(require('$OUT').$1)"; }
  for pair in "launchpad src/JunoLaunchpad.sol:JunoLaunchpad" "graduator src/graduators/UniswapV2Graduator.sol:UniswapV2Graduator" \
              "crossChain src/JunoCrossChain.sol:JunoCrossChain" "swapRouter src/JunoSwapRouter.sol:JunoSwapRouter" \
              "trackers src/JunoTrackers.sol:JunoTrackers"; do
    key=${pair%% *}; contract=${pair#* }
    "$FORGE" verify-contract "$(get "$key")" "$contract" --verifier blockscout --verifier-url "$API" \
      --rpc-url "$RPC" --guess-constructor-args --watch || echo "  (verification failed: $contract)"
  done
fi
