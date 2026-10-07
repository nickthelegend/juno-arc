#!/usr/bin/env bash
# Juno on a local fork of Arc testnet, in one command.
#
#   npm run demo:local          # start: fork (reused if up), databases, API (production build), seeded content, web app
#   npm run demo:local -- stop  # stop only what this script started (by recorded PIDs)
#
# Needs on PATH: Circle's Arc Foundry anvil/cast/forge (or ARC_ANVIL/FORGE/CAST), Node 22+, PostgreSQL 16
# (a running server your user can create databases on), and MongoDB 7 (`mongod`). `npm install` first.
#
# What it does (ports 8910–8913):
#  1. Builds the API (production) unless SKIP_BUILD=1.
#  2. Reuses an Arc fork already answering on :8910, or starts one with scripts/arc-fork.sh (which deploys
#     Juno with the real deploy script into .fork/arc-fork.json). Circle's USDC, CCTP, Gateway and Memo and
#     Chainlink's CCIP contracts are the real ones, forked.
#  3. Creates the Postgres database (juno_arc unless DEMO_DB) if missing and migrates; starts its own
#     mongod on :8913 (data under JUNO_MONGO_DIR, PID recorded).
#  4. Serves the API on :8911 (next start), with the relayer funded by anvil_setBalance.
#  5. Seeds demo content through the API: launches, buys, sells — real signed transactions on the fork.
#  6. Serves the web app (juno-expo's web export, if it has been built) on :8912.
# Nothing touches Arc testnet itself: every transaction lands on the local fork.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
RUN="$ROOT/.juno/demo-local"
FORK_PORT=${ARC_FORK_PORT:-8910}
API_PORT=${API_PORT:-8911}
APP_PORT=${APP_PORT:-8912}
MONGO_PORT=${MONGO_PORT:-8913}
DB=${DEMO_DB:-juno_arc}
MONGO_DIR=${JUNO_MONGO_DIR:-$RUN/mongo}
RPC="http://127.0.0.1:$FORK_PORT"
API="http://127.0.0.1:$API_PORT"
APP="http://127.0.0.1:$APP_PORT"
CAST=${CAST:-cast}
mkdir -p "$RUN/logs"

# Stops only what this script started: the PIDs it recorded. The fork is stopped only if this script
# started it (fork.pid); a fork that was already running is left alone.
stop() {
  for name in web api mongod fork; do
    [[ -f "$RUN/$name.pid" ]] || continue
    pid="$(cat "$RUN/$name.pid")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      # next start / serve run under an npx or node parent: stop its children first, then it.
      for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill "$child" 2>/dev/null || true; done
      kill "$pid" 2>/dev/null || true
      echo "stopped $name ($pid)"
    fi
    rm -f "$RUN/$name.pid"
  done
}

if [[ "${1:-}" == "stop" ]]; then
  stop
  exit 0
fi

need() { command -v "$1" >/dev/null || { echo "Needs $1 on PATH ($2)." >&2; exit 1; }; }
need node "Node 22+"
need psql "PostgreSQL 16"
need createdb "PostgreSQL 16"
need mongod "MongoDB 7"
need "$CAST" "Arc Foundry cast (set CAST=…)"
for port in $API_PORT $APP_PORT $MONGO_PORT; do
  if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is in use. Stop what holds it (npm run demo:local -- stop), or set API_PORT / APP_PORT / MONGO_PORT." >&2
    exit 1
  fi
done

trap 'echo "A step failed: logs are in $RUN/logs. Stopping what this run started." >&2; stop' ERR

# The relayer key: the one in .env.local, else a fresh one for this demo (kept in .juno/, git-ignored).
val() { [[ -f .env.local ]] && grep "^$1=" .env.local | tail -1 | cut -d= -f2- || true; }
RELAYER_KEY=$(val JUNO_RELAYER_PRIVATE_KEY)
if [[ -z "$RELAYER_KEY" ]]; then
  [[ -f "$RUN/relayer.key" ]] || (umask 077; "$CAST" wallet new --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].private_key))' > "$RUN/relayer.key")
  RELAYER_KEY=$(cat "$RUN/relayer.key")
fi
RELAYER=$("$CAST" wallet address --private-key "$RELAYER_KEY")

(umask 077; cat > "$RUN/env" <<EOF
NEXT_PUBLIC_ARC_NETWORK=testnet
ARC_RPC_URL=$RPC
NEXT_PUBLIC_ARC_RPC_URL=$RPC
JUNO_DEPLOYMENT_FILE=.fork/arc-fork.json
JUNO_LOG_RANGE=10000
JUNO_RELAYER_PRIVATE_KEY=$RELAYER_KEY
DATABASE_URL=postgresql://localhost:5432/$DB
DATABASE_URL_UNPOOLED=postgresql://localhost:5432/$DB
DATABASE_SSL=disable
MONGODB_URI=mongodb://127.0.0.1:$MONGO_PORT
MONGODB_DB=$DB
JUNO_APP_URL=
NEXT_PUBLIC_SITE_URL=$APP
JUNO_API_URL=$API
ENVIO_GRAPHQL_URL=
EOF
)
# These win over .env.local (Next.js never overrides a variable that is already set).
set -a; . "$RUN/env"; set +a

if [[ "${SKIP_BUILD:-}" == "1" && -d .next ]]; then
  echo "1/6 Build: reusing the last one (SKIP_BUILD=1)"
else
  echo "1/6 Building the API (production)"
  ./node_modules/.bin/next build --webpack > "$RUN/logs/build.log" 2>&1
fi

echo "2/6 Arc fork on :$FORK_PORT"
if "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1 && [[ -f .fork/arc-fork.json ]]; then
  echo "    reusing the fork already running (chain $("$CAST" chain-id --rpc-url "$RPC"))"
else
  sh scripts/arc-fork.sh > "$RUN/logs/fork.log" 2>&1
  [[ -f .fork/arc-fork.pid ]] && cp .fork/arc-fork.pid "$RUN/fork.pid"
fi
"$CAST" rpc anvil_setBalance "$RELAYER" 0x3635c9adc5dea00000 --rpc-url "$RPC" > /dev/null   # 1,000 USDC of gas
echo "    relayer $RELAYER funded with 1,000 USDC"

echo "3/6 Databases"
psql -lqt | cut -d'|' -f1 | grep -qw "$DB" || createdb "$DB"
./node_modules/.bin/drizzle-kit migrate > "$RUN/logs/migrate.log" 2>&1
mkdir -p "$MONGO_DIR"
mongod --dbpath "$MONGO_DIR" --port "$MONGO_PORT" --bind_ip 127.0.0.1 > "$RUN/logs/mongod.log" 2>&1 &
echo $! > "$RUN/mongod.pid"
for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$MONGO_PORT") 2>/dev/null && break; sleep 1; done

echo "4/6 Starting the API on :$API_PORT"
./node_modules/.bin/next start -p "$API_PORT" > "$RUN/logs/api.log" 2>&1 &
echo $! > "$RUN/api.pid"
for _ in $(seq 1 120); do curl -sf "$API/api/juno/config" >/dev/null && break; sleep 1; done
curl -sf "$API/api/juno/config" >/dev/null || { echo "The API did not start: see $RUN/logs/api.log" >&2; false; }

echo "5/6 Seeding demo content (real signed transactions on the fork)"
if [[ "${SKIP_SEED:-}" == "1" ]]; then
  echo "    skipped (SKIP_SEED=1)"
else
  JUNO_API_URL=$API ARC_RPC_URL=$RPC node scripts/seed-fork.mjs > "$RUN/logs/seed.log" 2>&1 \
    || { echo "Seeding failed: see $RUN/logs/seed.log. Stopping what this run started." >&2; stop; exit 1; }
  tail -3 "$RUN/logs/seed.log" | sed 's/^/    /'
fi

echo "6/6 Web app on :$APP_PORT"
WEB_DIR=""
for d in juno-expo/dist-fork juno-expo/dist-local juno-expo/dist; do [[ -f "$d/index.html" ]] && { WEB_DIR=$d; break; }; done
if [[ -z "$WEB_DIR" ]]; then
  echo "    juno-expo has no web export yet (expected juno-expo/dist-fork with EXPO_PUBLIC_API_URL=$API) — skipping."
else
  npx --yes serve "$WEB_DIR" -s -l "$APP_PORT" > "$RUN/logs/web.log" 2>&1 &
  echo $! > "$RUN/web.pid"
  echo "    serving $WEB_DIR"
fi

trap - ERR
if [[ -n "$WEB_DIR" ]]; then APP_LINE="$APP   ($WEB_DIR)"; else APP_LINE="not served (no juno-expo web export yet)"; fi
cat <<EOF

Juno is running on a local fork of Arc testnet.
  API   $API   (GET /api/juno/config)
  App   $APP_LINE
  Fork  $RPC   (chain 5042002; USDC is the gas token: fund a wallet with cast rpc anvil_setBalance)

Every transaction is real and signed, on the fork. Logs: .juno/demo-local/logs.
Stop it with: npm run demo:local -- stop
EOF
