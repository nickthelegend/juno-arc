#!/bin/sh
# Rehearse Juno on a local fork of Arc testnet — Circle's real USDC, CCTP, Gateway and Memo contracts and
# Chainlink's real CCIP contracts — without spending testnet USDC.
#
#   ARC_ANVIL=/path/to/arc-foundry/anvil FORGE=/path/to/arc-foundry/forge sh scripts/arc-fork.sh
#   sh scripts/arc-fork.sh stop
#
# Needs Circle's Arc Foundry (https://github.com/circlefin/arc-foundry): plain anvil can fork Arc but can't move
# Arc's native USDC; `--network arc` can. Ports 8910–8919 (ARC_FORK_PORT, default 8910).
#  1. starts arc-anvil forking Arc testnet with 1-second blocks;
#  2. deploys with the real deploy script (contracts/script/Deploy.s.sol) using anvil's public dev account 0 into
#     .fork/arc-fork.json (git-ignored);
#  3. gives the relayer and any FUND="0x… 0x…" wallets USDC by setting their native balance (on Arc it is the same
#     USDC as the ERC-20 at 0x3600…0000).
# Then point the app at it: JUNO_DEPLOYMENT_FILE=.fork/arc-fork.json ARC_RPC_URL=http://127.0.0.1:8910 npm run dev
#
# The fork's RPC does not execute Arc's CallFrom precompile, so Memo-wrapped calls are probed and skipped there
# (the app falls back to a plain call); `forge test --network arc` does execute it (test/fork/ArcTestnetFork.t.sol).
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${ARC_FORK_PORT:-8910}
RPC=http://127.0.0.1:$PORT
ANVIL=${ARC_ANVIL:-anvil}
FORGE=${FORGE:-forge}
CAST=${CAST:-cast}
mkdir -p .fork
if [ "$1" = stop ]; then
  [ -f .fork/arc-fork.pid ] && kill "$(cat .fork/arc-fork.pid)" 2>/dev/null && rm -f .fork/arc-fork.pid && echo "stopped"
  exit 0
fi
if ! $CAST chain-id --rpc-url $RPC >/dev/null 2>&1; then
  nohup "$ANVIL" --network arc --fork-url "${ARC_TESTNET_RPC_URL:-https://rpc.testnet.arc.io}" --port "$PORT" \
    --block-time 1 --silent > .fork/arc-fork.log 2>&1 &
  echo $! > .fork/arc-fork.pid
  i=0; until $CAST chain-id --rpc-url $RPC >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 90 ] && { echo "the fork didn't start: .fork/arc-fork.log"; exit 1; }; sleep 1; done
fi
# anvil's public dev account 0 (the well-known "test … junk" mnemonic): only ever used on this local fork.
printf 'DEPLOYER_PRIVATE_KEY=%s\n' "$($CAST wallet private-key --mnemonic "test test test test test test test test test test test junk")" > .fork/deployer.env
chmod 600 .fork/deployer.env
set -a; . ./.fork/deployer.env; set +a
DEPLOYER=$($CAST wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
$CAST rpc anvil_setBalance "$DEPLOYER" 0x3635c9adc5dea00000 --rpc-url $RPC >/dev/null   # 1,000 USDC

val() { [ -f .env.local ] && grep "^$1=" .env.local | tail -1 | cut -d= -f2- || true; }
for a in $(val JUNO_RELAYER_ADDRESS) $FUND; do
  $CAST rpc anvil_setBalance "$a" 0x3635c9adc5dea00000 --rpc-url $RPC >/dev/null && echo "funded $a with 1,000 USDC"
done

# The fork shares testnet's chain id, so keep forge's records of it apart from a real testnet deploy.
B=contracts/broadcast/Deploy.s.sol/5042002
rm -rf .fork/broadcast-keep; [ -d $B ] && mkdir -p .fork/broadcast-keep && cp -R $B .fork/broadcast-keep/
(cd contracts && JUNO_DEPLOYMENT_OUT="$ROOT/.fork/arc-fork.json" "$FORGE" script script/Deploy.s.sol --network arc \
  --rpc-url $RPC --broadcast --slow 2>&1 | grep -E "Juno|Uniswap|Owner|Wrote|Error|error" || true)
rm -rf $B; [ -d .fork/broadcast-keep/5042002 ] && cp -R .fork/broadcast-keep/5042002 $B; rm -rf .fork/broadcast-keep
[ -f .fork/arc-fork.json ] && echo "fork ready on $RPC — addresses in .fork/arc-fork.json"
