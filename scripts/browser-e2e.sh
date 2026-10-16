#!/usr/bin/env bash
# =============================================================================
# browser-e2e.sh — one command, fully local browser end-to-end test of the
# DeadManSwitch frontend: Playwright drives the real UI (RainbowKit's connect
# modal, an injected EIP-1193 test wallet) against Anvil with Zama's
# forge-fhevm mock host. No testnet, no relayer, no API key, no downloads.
#
#   1. anvil on E2E_ANVIL_PORT (default 18600), chain 31337, started fresh
#   2. scripts/local-e2e.sh with SKIP_E2E=1: Zama's fhEVM host contracts and a
#      fresh DeadManSwitch on that node
#   3. the client (CLI + watcher, client/dist) for the cross-component specs
#      (frontend/e2e/specs/13-crosswire): `npm run build` in client/ when
#      client/dist is missing or older than client/src
#   4. next build + next start on E2E_PORT (default 3100), built for the local
#      chain (NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1, NEXT_PUBLIC_CONTRACT_31337, …)
#   5. playwright test (frontend/e2e); extra arguments go to Playwright, e.g.
#        scripts/browser-e2e.sh -g "cancel"      or   npm run test:e2e -- --headed
#
# Anvil and Next are always stopped on exit (success, failure, Ctrl-C), by pid.
# Idempotent: every run starts its own anvil and server; processes a killed
# earlier run left behind on these ports (found through its pid files) are
# stopped first. Anything else listening on the ports is an error.
#
# Requires Foundry (anvil, forge, cast; tested with 1.5.1), jq, curl, Node >= 22,
# frontend/node_modules and client/node_modules (npm ci in each). Playwright's
# Chromium must match @playwright/test's browsers.json (npx playwright install chromium).
#
# Environment:
#   E2E_ANVIL_PORT=18600     anvil port
#   E2E_PORT=3100            Next.js port
#   E2E_LOG_DIR=dir          base directory for per-run logs and pid files
#                            (default ${TMPDIR:-/tmp}/dms-browser-e2e)
#   E2E_OUTPUT_DIR=dir       Playwright artifacts: traces, screenshots, the
#                            diagnostics of each test (default frontend/test-results)
#   E2E_REPORT_DIR=dir       Playwright HTML report (default frontend/playwright-report)
#   E2E_REUSE_BUILD=1        skip `next build` when .next was built by this script
#                            with the same NEXT_PUBLIC_* values (a fresh anvil
#                            deploys to the same address every time). Only after
#                            no app code changed since that build.
#   E2E_STACK_ONLY=1         start everything, print the E2E_* exports, and wait
#                            (Ctrl-C stops it) instead of running Playwright, for
#                            `npx playwright test` from another shell
#   E2E_HEADED=1             run the browser headed
#   E2E_ALLOW_EXTERNAL=1     let the page reach non-local hosts (by default nothing but
#                            127.0.0.1 resolves in the test browser: WalletConnect,
#                            RainbowKit and wallet SDK telemetry stay offline)
#   E2E_TRACE=mode           Playwright trace: retain-on-failure (default), on, off
#   E2E_VIDEO=1              record a video of failed tests
#   E2E_LOG_RPC=1            keep each test's JSON-RPC log (rpc-log.txt), not only for failures
#   E2E_RETRIES=n            Playwright retries (default 0)
#   E2E_SCREENS=1            also run frontend/e2e/screens.spec.ts, the UI screenshot set
#                            (skipped otherwise); run it alone on a fresh stack:
#                              E2E_SCREENS=1 scripts/browser-e2e.sh e2e/screens.spec.ts
#   E2E_SCREENS_DIR=dir      where it writes <viewport>/<NN>-<page>-<state>.png and
#                            index.json (default frontend/test-results/screens)
# =============================================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="$ROOT/frontend"
CLIENT="$ROOT/client"
ANVIL_PORT="${E2E_ANVIL_PORT:-18600}"
APP_PORT="${E2E_PORT:-3100}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
APP_URL="http://127.0.0.1:${APP_PORT}"
CHAIN_ID=31337
LOG_BASE="${E2E_LOG_DIR:-${TMPDIR:-/tmp}/dms-browser-e2e}"
LOG_BASE="${LOG_BASE%/}"

STEP="init"
step() {
  STEP="$*"
  printf '\n==> %s\n' "$*"
}
die() {
  printf '\nbrowser-e2e: FAILED during "%s": %s\n' "$STEP" "$*" >&2
  exit 1
}
trap 'printf "\nbrowser-e2e: FAILED during \"%s\" (line %s: %s)\n" "$STEP" "$LINENO" "$BASH_COMMAND" >&2' ERR

# ---------------------------------------------------------------------------
# process handling: everything is stopped by pid, never by name
# ---------------------------------------------------------------------------

# The pid and its descendants (deepest first), from one `ps` snapshot.
# Plain strings, not arrays: macOS ships bash 3.2, where an empty array trips `set -u`.
descendants() {
  local root="$1" table queue="$1" out="" p child
  table="$(ps -A -o pid=,ppid= 2>/dev/null)" || { echo "$root"; return 0; }
  while [[ -n "${queue// /}" ]]; do
    set -- $queue
    p="$1"
    shift
    queue="$*"
    out="$p $out"
    for child in $(awk -v pp="$p" '$2 == pp { print $1 }' <<<"$table"); do
      queue="$queue $child"
    done
  done
  echo $out
}

# Stop a process tree: SIGTERM, up to 5 s, then SIGKILL.
stop_tree() {
  local root="$1" pids p
  [[ -n "$root" ]] || return 0
  kill -0 "$root" 2>/dev/null || return 0
  pids="$(descendants "$root")"
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  for _ in $(seq 1 50); do
    local alive=0
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    ((alive)) || break
    sleep 0.1
  done
  for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
  wait "$root" 2>/dev/null || true
}

ANVIL_PID=""
NEXT_PID=""
cleanup() {
  local status=$?
  trap - ERR
  if [[ -n "$NEXT_PID" ]]; then
    stop_tree "$NEXT_PID"
    echo "stopped next (pid $NEXT_PID)"
  fi
  if [[ -n "$ANVIL_PID" ]]; then
    stop_tree "$ANVIL_PID"
    echo "stopped anvil (pid $ANVIL_PID)"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The pid in an earlier run's pid file, if that process still runs a command
# matching `regex` and (when lsof is available) still listens on `port`; else
# nothing. Never fails: it runs in $(…), where a failing command would set off
# the ERR trap.
stale_pid() {
  local file="$1" regex="$2" port="$3" pid cmd
  pid="$(cat "$file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  grep -Eq -- "$regex" <<<"$cmd" || return 0
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
  fi
  printf '%s\n' "$pid"
}

anvil_up() { cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; }
app_up() { curl -s -o /dev/null --max-time 2 "$APP_URL/" 2>/dev/null; }

# ---------------------------------------------------------------------------
step "0/5 prerequisites"
for tool in anvil forge cast jq curl node; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found on PATH (Foundry: https://getfoundry.sh, Node >= 22)"
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
  die "Node >= 22 is required (found $(node --version))"
[[ -x "$FRONTEND/node_modules/.bin/next" && -x "$FRONTEND/node_modules/.bin/playwright" ]] ||
  die "frontend dependencies missing: run (cd frontend && npm ci)"
[[ -x "$CLIENT/node_modules/.bin/tsc" ]] ||
  die "client dependencies missing (the cross-component specs run the CLI and the watcher): run (cd client && npm ci)"
echo "foundry: $(anvil --version 2>/dev/null | head -n 1)"
# local-e2e.sh puts ~/.foundry/bin first on its PATH, so the deploy uses that
# forge even when another one comes first on yours. Say so when they differ.
home_forge="$HOME/.foundry/bin/forge"
if [[ -x "$home_forge" && "$(command -v forge)" != "$home_forge" ]]; then
  v_path="$(forge --version 2>/dev/null | head -n 1 || true)"
  v_home="$("$home_forge" --version 2>/dev/null | head -n 1 || true)"
  if [[ "$v_path" != "$v_home" ]]; then
    echo "note: local-e2e.sh deploys with $home_forge ($v_home), not $(command -v forge) ($v_path)"
  fi
fi

mkdir -p "$LOG_BASE"
LOG_DIR="$(mktemp -d "$LOG_BASE/run.$(date +%Y%m%d-%H%M%S).XXXX")"
echo "logs: $LOG_DIR"

# Leftovers of an earlier run of this script that was killed before its cleanup ran.
for f in "$LOG_BASE"/run.*/next.pid; do
  [[ -e "$f" ]] || continue
  # `next start` renames its process to "next-server (vX.Y.Z)".
  pid="$(stale_pid "$f" 'next-server|next start' "$APP_PORT")"
  if [[ -n "$pid" ]]; then
    echo "stopping next left over by an earlier run (pid $pid, $f)"
    stop_tree "$pid"
  fi
done
for f in "$LOG_BASE"/run.*/anvil.pid; do
  [[ -e "$f" ]] || continue
  pid="$(stale_pid "$f" "anvil .*--port $ANVIL_PORT" "$ANVIL_PORT")"
  if [[ -n "$pid" ]]; then
    echo "stopping anvil left over by an earlier run (pid $pid, $f)"
    stop_tree "$pid"
  fi
done
anvil_up && die "something already answers JSON-RPC on $RPC; stop it or set E2E_ANVIL_PORT"
app_up && die "something already listens on $APP_URL; stop it or set E2E_PORT"

# ---------------------------------------------------------------------------
step "1/5 anvil on $RPC"
anvil --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" --silent >"$LOG_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
echo "$ANVIL_PID" >"$LOG_DIR/anvil.pid"
for _ in $(seq 1 100); do
  anvil_up && break
  kill -0 "$ANVIL_PID" 2>/dev/null || die "anvil exited during startup (log: $LOG_DIR/anvil.log)"
  sleep 0.1
done
anvil_up || die "anvil did not answer on $RPC (log: $LOG_DIR/anvil.log)"
echo "anvil pid $ANVIL_PID"

# ---------------------------------------------------------------------------
step "2/5 fhEVM host + DeadManSwitch (scripts/local-e2e.sh SKIP_E2E=1)"
if ! ANVIL_PORT="$ANVIL_PORT" SKIP_E2E=1 bash "$ROOT/scripts/local-e2e.sh" >"$LOG_DIR/deploy.log" 2>&1; then
  tail -n 40 "$LOG_DIR/deploy.log" >&2 || true
  die "local-e2e.sh failed (log: $LOG_DIR/deploy.log)"
fi
DMS_ADDRESS="$(sed -n 's/^DMS_ADDRESS=\(0x[0-9a-fA-F]\{40\}\)$/\1/p' "$LOG_DIR/deploy.log" | tail -n 1)"
[[ -n "$DMS_ADDRESS" ]] || die "no DMS_ADDRESS in $LOG_DIR/deploy.log"
FROM_BLOCK="$(cast block-number --rpc-url "$RPC")"
echo "DMS_ADDRESS=$DMS_ADDRESS (switch scans from block $FROM_BLOCK)"

# ---------------------------------------------------------------------------
step "3/5 client (CLI + watcher) for the cross-component specs"
# The specs run client/dist/index.js and client/dist/watcher.js as subprocesses.
client_stale="$(find "$CLIENT/src" "$CLIENT/package.json" "$CLIENT/tsconfig.json" -newer "$CLIENT/dist/index.js" -print 2>/dev/null | head -n 1 || true)"
if [[ ! -f "$CLIENT/dist/index.js" || ! -f "$CLIENT/dist/watcher.js" || -n "$client_stale" ]]; then
  echo "npm run build in client/ (log: $LOG_DIR/client-build.log)"
  if ! (cd "$CLIENT" && npm run --silent build) >"$LOG_DIR/client-build.log" 2>&1; then
    tail -n 40 "$LOG_DIR/client-build.log" >&2 || true
    die "client build failed (log: $LOG_DIR/client-build.log)"
  fi
else
  echo "client/dist is up to date"
fi
export E2E_CLIENT_DIR="$CLIENT"

# ---------------------------------------------------------------------------
step "4/5 frontend on $APP_URL"
# Every NEXT_PUBLIC_* the app reads, set explicitly so a developer's .env.local
# (which never overrides variables already in the environment) cannot leak in.
export NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1
export NEXT_PUBLIC_CONTRACT_31337="$DMS_ADDRESS"
export NEXT_PUBLIC_RPC_URL_31337="$RPC"
export NEXT_PUBLIC_FROM_BLOCK_31337="$FROM_BLOCK"
export NEXT_PUBLIC_CONTRACT_1="" NEXT_PUBLIC_CONTRACT_11155111=""
export NEXT_PUBLIC_RPC_URL_1="" NEXT_PUBLIC_RPC_URL_11155111=""
export NEXT_PUBLIC_FROM_BLOCK_1="" NEXT_PUBLIC_FROM_BLOCK_11155111=""
export NEXT_PUBLIC_PREVIOUS_CONTRACTS_1="" NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111="" NEXT_PUBLIC_PREVIOUS_CONTRACTS_31337=""
export NEXT_PUBLIC_LOGS_RANGE_CAP="" NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=""
export NEXT_TELEMETRY_DISABLED=1

STAMP_FILE="$FRONTEND/.next/dms-browser-e2e.env"
STAMP="$(env | grep '^NEXT_PUBLIC_' | LC_ALL=C sort)"
if [[ "${E2E_REUSE_BUILD:-0}" == "1" && -f "$FRONTEND/.next/BUILD_ID" && -f "$STAMP_FILE" && "$(cat "$STAMP_FILE")" == "$STAMP" ]]; then
  echo "E2E_REUSE_BUILD=1: reusing the existing build (same NEXT_PUBLIC_* values)"
else
  # Through the package script, which picks the bundler (`next build --webpack`: Next 16
  # defaults to Turbopack, and next.config.js customises webpack).
  echo "npm run build (log: $LOG_DIR/build.log)"
  if ! (cd "$FRONTEND" && npm run --silent build) >"$LOG_DIR/build.log" 2>&1; then
    tail -n 40 "$LOG_DIR/build.log" >&2 || true
    die "next build failed (log: $LOG_DIR/build.log)"
  fi
  printf '%s\n' "$STAMP" >"$STAMP_FILE"
fi

# The server binary directly (not through npm), so NEXT_PID is the server itself.
(cd "$FRONTEND" && exec node node_modules/next/dist/bin/next start -p "$APP_PORT" -H 127.0.0.1) >"$LOG_DIR/next.log" 2>&1 &
NEXT_PID=$!
echo "$NEXT_PID" >"$LOG_DIR/next.pid"
for _ in $(seq 1 300); do
  app_up && break
  kill -0 "$NEXT_PID" 2>/dev/null || die "next start exited (log: $LOG_DIR/next.log)"
  sleep 0.1
done
app_up || die "the app did not answer on $APP_URL (log: $LOG_DIR/next.log)"
echo "next pid $NEXT_PID"

export E2E_BASE_URL="$APP_URL"
export E2E_RPC_URL="$RPC"
export E2E_DMS_ADDRESS="$DMS_ADDRESS"
export E2E_LOG_DIR_RUN="$LOG_DIR"

if [[ "${E2E_STACK_ONLY:-0}" == "1" ]]; then
  printf '\nE2E_STACK_ONLY=1: the stack is up. In another shell, from frontend/:\n'
  printf '  export E2E_BASE_URL=%s E2E_RPC_URL=%s E2E_DMS_ADDRESS=%s\n  npx playwright test\n' "$APP_URL" "$RPC" "$DMS_ADDRESS"
  printf 'Ctrl-C stops anvil and next.\n'
  wait "$NEXT_PID" || true
  die "next exited (log: $LOG_DIR/next.log)"
fi

# ---------------------------------------------------------------------------
step "5/5 playwright"
status=0
(cd "$FRONTEND" && node_modules/.bin/playwright test "$@") || status=$?
if ((status != 0)); then
  printf '\nbrowser-e2e: FAILED (playwright exit %s). Logs: %s\n' "$status" "$LOG_DIR" >&2
  exit "$status"
fi
printf '\nbrowser-e2e: PASSED (DeadManSwitch %s on %s, app %s)\n' "$DMS_ADDRESS" "$RPC" "$APP_URL"
