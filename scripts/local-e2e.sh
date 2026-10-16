#!/usr/bin/env bash
# =============================================================================
# local-e2e.sh — one command, fully local end-to-end test of DeadManSwitch on
# Zama fhEVM: no testnet, no relayer, no API key.
#
#   1. anvil on ANVIL_PORT (default 8545), chain 31337 — reused if already up
#   2. Zama's fhEVM host contracts (forge-fhevm, cleartext executor + mock KMS)
#      at their canonical local addresses — skipped if already deployed;
#      forge-fhevm's Soldeer dependencies are installed first if missing
#   3. a fresh DeadManSwitch, deployed with `forge script`
#   4. the client e2e (client/src/e2e.ts): full lifecycle, cancel path, watcher
#
# Idempotent: rerun it as often as you like; each run deploys a new
# DeadManSwitch and uses fresh switch ids. The e2e advances the node's clock
# (evm_increaseTime), so do not point it at a node whose time others rely on.
#
# Environment:
#   ANVIL_PORT=8545            port to use / start anvil on
#   KEEP_ANVIL=1               leave an anvil this script started running on exit
#   FORCE_HOST_DEPLOY=1        redeploy the fhEVM host even if it looks deployed
#   DEPLOYER_PRIVATE_KEY=0x..  key for the DeadManSwitch deploy (default: anvil #0)
#   SKIP_E2E=1                 stop after deploying (prints DMS_ADDRESS)
# =============================================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
CHAIN_ID=31337
# anvil dev account #0 — local only, never use on a public network
DEPLOYER_PK="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
FHEVM_DIR="$ROOT/contracts/dependencies/forge-fhevm-3ee696f"
# Use the Foundry the caller put on PATH (the docs pin one). Fall back to
# Foundry's default install directory only when a tool is missing.
for tool in anvil forge cast; do
  command -v "$tool" >/dev/null 2>&1 || { export PATH="$PATH:$HOME/.foundry/bin"; break; }
done

# Canonical forge-fhevm local host addresses (FHEVMHostAddresses.sol; same as the
# @zama-fhe/sdk `anvil` preset and @fhevm/solidity's ZamaConfig for 31337).
HOST_ADDRESSES=(
  0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D # ACL
  0xe3a9105a3a932253A70F126eb1E3b589C643dD24 # FHEVMExecutor
  0x901F8942346f7AB3a01F6D7613119Bca447Bb030 # KMSVerifier
  0x36772142b74871f255CbD7A3e89B401d3e45825f # InputVerifier
  0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154 # HCULimit
)

STEP="init"
step() {
  STEP="$*"
  printf '\n==> %s\n' "$*"
}
die() {
  printf '\nlocal-e2e: FAILED during "%s": %s\n' "$STEP" "$*" >&2
  exit 1
}
trap 'printf "\nlocal-e2e: FAILED during \"%s\" (line %s: %s)\n" "$STEP" "$LINENO" "$BASH_COMMAND" >&2' ERR

ANVIL_PID=""
cleanup() {
  if [[ -n "$ANVIL_PID" && "${KEEP_ANVIL:-0}" != "1" ]]; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for tool in anvil forge cast jq node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found on PATH (Foundry: https://getfoundry.sh, Node >= 22)"
done
# Say which Foundry runs, and warn when it is not the pinned version.
PINNED_FOUNDRY="1.5.1"
for tool in forge cast anvil; do
  v="$("$tool" --version 2>/dev/null || true)"
  v="${v%%$'\n'*}"
  echo "$tool: ${v:-unknown version} ($(command -v "$tool"))"
  if [[ -n "$PINNED_FOUNDRY" && "$v" != *"Version: $PINNED_FOUNDRY" && "$v" != *"Version: $PINNED_FOUNDRY-"* ]]; then
    echo "local-e2e: note: $tool is not the pinned Foundry version ($PINNED_FOUNDRY); results may differ" >&2
  fi
done
# @zama-fhe/sdk 3.6.0 (and the client's package.json engines) require Node >= 22.
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
  die "Node >= 22 is required (found $(node --version)); @zama-fhe/sdk 3.6.0 does not support older versions"

# ---------------------------------------------------------------------------
step "1/4 anvil on $RPC"
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  got="$(cast chain-id --rpc-url "$RPC")"
  [[ "$got" == "$CHAIN_ID" ]] || die "$RPC is chain $got, expected $CHAIN_ID"
  echo "reusing the node already listening on $RPC (block $(cast block-number --rpc-url "$RPC"))"
else
  log="${TMPDIR:-/tmp}/dms-anvil-${PORT}.log"
  anvil --port "$PORT" --chain-id "$CHAIN_ID" --silent >"$log" 2>&1 &
  ANVIL_PID=$!
  for _ in $(seq 1 100); do
    cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
    kill -0 "$ANVIL_PID" 2>/dev/null || die "anvil exited during startup (log: $log)"
    sleep 0.1
  done
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || die "anvil did not answer on $RPC (log: $log)"
  echo "started anvil (pid $ANVIL_PID, log $log)$([[ "${KEEP_ANVIL:-0}" == "1" ]] && echo "; it will be left running")"
fi

# ---------------------------------------------------------------------------
step "2/4 Zama fhEVM host (forge-fhevm)"
host_deployed() {
  local a code
  for a in "${HOST_ADDRESSES[@]}"; do
    code="$(cast code "$a" --rpc-url "$RPC")" || return 1
    [[ -n "$code" && "$code" != "0x" ]] || return 1
  done
}
if host_deployed && [[ "${FORCE_HOST_DEPLOY:-0}" != "1" ]]; then
  echo "host contracts already present at the canonical addresses; skipping (FORCE_HOST_DEPLOY=1 to redeploy)"
else
  if [[ ! -d "$FHEVM_DIR" ]]; then
    echo "forge-fhevm missing; installing the contracts' Soldeer dependencies"
    (cd "$ROOT/contracts" && forge soldeer install) || die "forge soldeer install (contracts) failed"
  fi
  [[ -x "$FHEVM_DIR/deploy-local.sh" ]] || die "$FHEVM_DIR/deploy-local.sh not found"
  if [[ ! -d "$FHEVM_DIR/dependencies" ]]; then
    echo "installing forge-fhevm's Soldeer dependencies"
    (cd "$FHEVM_DIR" && forge soldeer install) || die "forge soldeer install (forge-fhevm) failed"
  fi
  echo "deploying the host stack (builds forge-fhevm on first use)"
  (cd "$FHEVM_DIR" && ./deploy-local.sh --anvil-port "$PORT") || die "forge-fhevm deploy-local.sh failed"
  host_deployed || die "host contracts still missing after deploy-local.sh"
  echo "host deployed"
fi

# ---------------------------------------------------------------------------
step "3/4 deploy DeadManSwitch"
deploy_out="$(cd "$ROOT/contracts" && PRIVATE_KEY="$DEPLOYER_PK" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast 2>&1)" || {
  printf '%s\n' "$deploy_out" >&2
  die "forge script Deploy.s.sol failed"
}
DMS_ADDRESS="$(printf '%s\n' "$deploy_out" | sed -n 's/.*DeadManSwitch deployed at: *\(0x[0-9a-fA-F]\{40\}\).*/\1/p' | tail -n 1)"
[[ -n "$DMS_ADDRESS" ]] || {
  printf '%s\n' "$deploy_out" >&2
  die "could not find the deployed address in the forge script output"
}
code="$(cast code "$DMS_ADDRESS" --rpc-url "$RPC")"
[[ -n "$code" && "$code" != "0x" ]] || die "no code at $DMS_ADDRESS after deploy"
echo "DMS_ADDRESS=$DMS_ADDRESS"

if [[ "${SKIP_E2E:-0}" == "1" ]]; then
  echo "SKIP_E2E=1: stopping here"
  exit 0
fi

# ---------------------------------------------------------------------------
step "4/4 client e2e"
cd "$ROOT/client"
if [[ ! -d node_modules ]]; then
  npm ci || die "npm ci failed"
fi
DMS_ADDRESS="$DMS_ADDRESS" RPC_URL="$RPC" CHAIN_ID="$CHAIN_ID" npm run --silent e2e:local || die "client e2e failed"

printf '\nlocal-e2e: PASSED (DeadManSwitch %s on %s)\n' "$DMS_ADDRESS" "$RPC"
