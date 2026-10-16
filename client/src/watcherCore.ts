// Pure parts of the watcher: config/flag parsing, the per-switch decision
// function, the profitability check, backoff. No I/O; unit-tested in
// test/watcherCore.test.ts. The I/O loop lives in watcher.ts.

import { getAddress, isAddress, parseEther, parseGwei, type Address, type Hex } from "viem";
import type { StateName } from "./chain.js";
import { ConfigError } from "./config.js";

// ---------- Config ---------- //

export interface WatchEntry {
  owner: Address;
  id: bigint;
}

export interface WatcherConfig {
  /** Seconds between passes (daemon mode). */
  pollIntervalSec: number;
  /** ± jitter on the poll interval, percent. */
  jitterPct: number;
  /** Where revealed plaintexts are written (mode 0600). */
  outDir: string;
  /** Small JSON file with discovery progress and per-switch state. */
  stateFile: string;
  /** Discover switches from SwitchCreated logs. */
  discover: boolean;
  /** Override FROM_BLOCK for discovery (first run only: afterwards the state file's lastScannedBlock wins). */
  fromBlock?: bigint;
  /** --rescan-from: scan again from this block on the first pass, even though the state file is further ahead. */
  rescanFrom?: bigint;
  /**
   * Max block span per eth_getLogs request. Halved when the provider rejects
   * the range, grown back after successes; the working size is remembered in
   * the state file.
   */
  logChunkBlocks: bigint;
  /**
   * Discovery stops this many blocks behind the head, which only delays it: a
   * reorg deeper than this can still move a SwitchCreated log into a range
   * already scanned. What finds such a log is that each pass with new blocks
   * scans the last 64 blocks again (not on local Anvil). Undefined = auto
   * (0 on local Anvil, 2 elsewhere).
   */
  confirmations?: number;
  /** Switches to watch in addition to (or instead of) discovered ones. */
  switches: WatchEntry[];
  /** Reveal regardless of profit (still honours maxGasPriceGwei). */
  altruistic: boolean;
  /** Also call publishPlaintext after revealing (costs gas, no reward). */
  publish: boolean;
  /** Bounty must cover estimated gas cost × safetyFactor (+ minProfit). */
  safetyFactor: number;
  minProfitWei: bigint;
  /** Hard cap on gas price; 0 = none. */
  maxGasPriceWei: bigint;
  /** Gas assumed for revealKey when deciding whether to markDark (real estimate used at reveal time). */
  revealGasEstimate: bigint;
  /** Per-request timeout for the KMS public decryption. */
  decryptTimeoutSec: number;
  /** Public-decrypt attempts within one pass before backing off. */
  decryptAttemptsPerPass: number;
  /**
   * Total time one pass may spend waiting on the KMS across all switches:
   * requests plus the waits between retries, nothing else (the rest waits for the next pass).
   */
  decryptPassBudgetSec: number;
  /**
   * How long to wait for a transaction's receipt before moving on. The tx is
   * recorded in the state file; the next pass checks it again and, if it is
   * still pending, replaces it (same nonce, fees +12.5% or the market rate,
   * capped by maxGasPriceGwei). A markDark / revealKey is replaced only while
   * the bounty pays for it at those fees; otherwise it is left at its own fees,
   * or its nonce is freed with a self-transfer when a later markDark / revealKey
   * waits behind it whose bounty pays for that too.
   */
  txReceiptTimeoutSec: number;
  backoffBaseSec: number;
  backoffMaxSec: number;
  /** How long to leave an unprofitable switch before re-checking gas prices. */
  unprofitableRecheckSec: number;
  /** Single pass, then exit. */
  once: boolean;
}

export const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  pollIntervalSec: 30,
  jitterPct: 10,
  outDir: "./released-secrets",
  stateFile: "./watcher-state.json",
  discover: true,
  logChunkBlocks: 5_000n,
  switches: [],
  altruistic: false,
  publish: false,
  safetyFactor: 1.5,
  minProfitWei: 0n,
  maxGasPriceWei: 0n,
  revealGasEstimate: 400_000n,
  decryptTimeoutSec: 120,
  decryptAttemptsPerPass: 2,
  decryptPassBudgetSec: 300,
  txReceiptTimeoutSec: 120,
  backoffBaseSec: 15,
  backoffMaxSec: 900,
  unprofitableRecheckSec: 600,
  once: false,
};

export interface WatcherFlags {
  config?: string;
  once: boolean;
  altruistic?: boolean;
  publish?: boolean;
  discover?: boolean;
  fromBlock?: bigint;
  rescanFrom?: bigint;
  outDir?: string;
  stateFile?: string;
  help?: boolean;
}

export const WATCHER_USAGE = `DeadManSwitch watcher — discovers switches, marks dark ones, reveals keys, claims bounties.

Usage: watcher [--config <file>] [--once] [--altruistic] [--publish] [--no-discover]
               [--from-block <n>] [--rescan-from <n>] [--out-dir <dir>] [--state-file <file>]

  --config <file>     JSON config (default ./watcher.config.json if present; see watcher.config.example.json)
  --once              one pass over every switch, then exit (non-zero if an action failed)
  --altruistic        reveal even when the bounty does not cover gas
  --publish           also post the plaintext on-chain after revealing
  --no-discover       only watch the switches listed in the config
  --from-block <n>    first run only: start discovery here (overrides FROM_BLOCK); once the
                      state file exists, discovery continues from its last scanned block
  --rescan-from <n>   scan SwitchCreated logs again from block <n> on the first pass (finds
                      switches missed because FROM_BLOCK was set too high); never skips
                      blocks that have not been scanned yet
  --out-dir <dir>     where revealed plaintexts are written
  --state-file <file> watcher state (default ./watcher-state.json)

Environment: PRIVATE_KEY, RPC_URL, CHAIN_ID, DMS_ADDRESS, ZAMA_RELAYER_API_KEY, ZAMA_RELAYER_URL, FROM_BLOCK`;

export const parseWatcherArgs = (argv: string[]): WatcherFlags => {
  const f: WatcherFlags = { once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new ConfigError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--config":
        f.config = val();
        break;
      case "--once":
        f.once = true;
        break;
      case "--altruistic":
        f.altruistic = true;
        break;
      case "--publish":
        f.publish = true;
        break;
      case "--no-discover":
        f.discover = false;
        break;
      case "--discover":
        f.discover = true;
        break;
      case "--from-block":
      case "--rescan-from": {
        const v = val();
        if (!/^\d+$/.test(v)) throw new ConfigError(`${a} must be a block number, got "${v}"`);
        if (a === "--from-block") f.fromBlock = BigInt(v);
        else f.rescanFrom = BigInt(v);
        break;
      }
      case "--out-dir":
        f.outDir = val();
        break;
      case "--state-file":
        f.stateFile = val();
        break;
      case "-h":
      case "--help":
        f.help = true;
        break;
      default:
        throw new ConfigError(`unknown watcher flag "${a}"`);
    }
  }
  return f;
};

const num = (raw: Record<string, unknown>, k: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  const v = raw[k];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new ConfigError(`watcher config: ${k} must be a number in [${min}, ${max}]`);
  return v;
};
const bool = (raw: Record<string, unknown>, k: string, def: boolean): boolean => {
  const v = raw[k];
  if (v === undefined) return def;
  if (typeof v !== "boolean") throw new ConfigError(`watcher config: ${k} must be true or false`);
  return v;
};
const str = (raw: Record<string, unknown>, k: string, def: string): string => {
  const v = raw[k];
  if (v === undefined) return def;
  if (typeof v !== "string" || !v) throw new ConfigError(`watcher config: ${k} must be a non-empty string`);
  return v;
};
const amount = (raw: Record<string, unknown>, k: string, def: bigint, parse: (s: string) => bigint): bigint => {
  const v = raw[k];
  if (v === undefined) return def;
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s)) throw new ConfigError(`watcher config: ${k} must be a non-negative decimal`);
  return parse(s);
};

const UINT256_MAX = (1n << 256n) - 1n;

/** Keys a config file may contain (keys starting with "_" are comments). */
export const WATCHER_CONFIG_KEYS = new Set([
  "pollIntervalSec",
  "jitterPct",
  "outDir",
  "stateFile",
  "discover",
  "fromBlock",
  "logChunkBlocks",
  "confirmations",
  "switches",
  "altruistic",
  "publish",
  "safetyFactor",
  "minProfitEth",
  "maxGasPriceGwei",
  "revealGasEstimate",
  "decryptTimeoutSec",
  "decryptAttemptsPerPass",
  "decryptPassBudgetSec",
  "txReceiptTimeoutSec",
  "backoffBaseSec",
  "backoffMaxSec",
  "unprofitableRecheckSec",
]);

/** Merge defaults ← config file JSON ← CLI flags, validating every field. */
export const parseWatcherConfig = (rawIn: unknown, flags: WatcherFlags): WatcherConfig => {
  if (rawIn !== undefined && (typeof rawIn !== "object" || rawIn === null || Array.isArray(rawIn))) {
    throw new ConfigError("watcher config must be a JSON object");
  }
  const raw = (rawIn ?? {}) as Record<string, unknown>;
  const d = DEFAULT_WATCHER_CONFIG;
  for (const k of Object.keys(raw)) {
    if (!k.startsWith("_") && !WATCHER_CONFIG_KEYS.has(k)) throw new ConfigError(`watcher config: unknown key "${k}"`);
  }

  const switchesRaw = raw.switches ?? [];
  if (!Array.isArray(switchesRaw)) throw new ConfigError("watcher config: switches must be an array of { owner, id }");
  const switches: WatchEntry[] = switchesRaw.map((s, i) => {
    const e = s as { owner?: unknown; id?: unknown };
    if (typeof e.owner !== "string" || !isAddress(e.owner, { strict: false })) throw new ConfigError(`watcher config: switches[${i}].owner is not an address`);
    // JSON.parse has already rounded an integer above 2^53 (the frontend's ids are random 64-bit): it would name another switch.
    if (Number.isInteger(e.id) && !Number.isSafeInteger(e.id)) {
      throw new ConfigError(`watcher config: switches[${i}].id is too large for a JSON number (read as ${e.id}); quote it: "id": "…"`);
    }
    const idRaw = typeof e.id === "number" ? String(e.id) : e.id;
    if (typeof idRaw !== "string" || !/^\d+$/.test(idRaw) || BigInt(idRaw) === 0n) throw new ConfigError(`watcher config: switches[${i}].id must be a positive integer`);
    if (BigInt(idRaw) > UINT256_MAX) throw new ConfigError(`watcher config: switches[${i}].id does not fit in a uint256`);
    return { owner: getAddress(e.owner), id: BigInt(idRaw) };
  });

  const fromBlockRaw = raw.fromBlock;
  let fromBlock: bigint | undefined;
  if (fromBlockRaw !== undefined) {
    const s = String(fromBlockRaw);
    if (!/^\d+$/.test(s)) throw new ConfigError("watcher config: fromBlock must be a block number");
    fromBlock = BigInt(s);
  }
  const chunk = num(raw, "logChunkBlocks", Number(d.logChunkBlocks), 1, 1_000_000);

  return {
    pollIntervalSec: num(raw, "pollIntervalSec", d.pollIntervalSec, 1),
    jitterPct: num(raw, "jitterPct", d.jitterPct, 0, 100),
    outDir: flags.outDir ?? str(raw, "outDir", d.outDir),
    stateFile: flags.stateFile ?? str(raw, "stateFile", d.stateFile),
    discover: flags.discover ?? bool(raw, "discover", d.discover),
    fromBlock: flags.fromBlock ?? fromBlock,
    rescanFrom: flags.rescanFrom,
    logChunkBlocks: BigInt(Math.floor(chunk)),
    confirmations: raw.confirmations === undefined ? undefined : Math.floor(num(raw, "confirmations", 0, 0, 1000)),
    switches,
    altruistic: flags.altruistic ?? bool(raw, "altruistic", d.altruistic),
    publish: flags.publish ?? bool(raw, "publish", d.publish),
    safetyFactor: num(raw, "safetyFactor", d.safetyFactor, 1, 100),
    minProfitWei: amount(raw, "minProfitEth", d.minProfitWei, (s) => parseEther(s)),
    maxGasPriceWei: amount(raw, "maxGasPriceGwei", d.maxGasPriceWei, (s) => parseGwei(s)),
    revealGasEstimate: BigInt(Math.floor(num(raw, "revealGasEstimate", Number(d.revealGasEstimate), 21_000, 30_000_000))),
    decryptTimeoutSec: num(raw, "decryptTimeoutSec", d.decryptTimeoutSec, 1, 3600),
    decryptAttemptsPerPass: Math.floor(num(raw, "decryptAttemptsPerPass", d.decryptAttemptsPerPass, 1, 20)),
    decryptPassBudgetSec: num(raw, "decryptPassBudgetSec", d.decryptPassBudgetSec, 1, 86_400),
    txReceiptTimeoutSec: num(raw, "txReceiptTimeoutSec", d.txReceiptTimeoutSec, 1, 3600),
    backoffBaseSec: num(raw, "backoffBaseSec", d.backoffBaseSec, 1),
    backoffMaxSec: num(raw, "backoffMaxSec", d.backoffMaxSec, 1),
    unprofitableRecheckSec: num(raw, "unprofitableRecheckSec", d.unprofitableRecheckSec, 1),
    once: flags.once,
  };
};

// ---------- Persistent state ---------- //

export type TxKind = "markDark" | "revealKey" | "publishPlaintext";

/** A transaction broadcast for a switch and not yet resolved (persisted before waiting for its receipt). */
export interface PendingTx {
  kind: TxKind;
  /** Every hash broadcast for this nonce: the original, then each replacement. */
  hashes: Hex[];
  nonce: number;
  /** Fees of the latest broadcast, decimal wei. */
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** When the latest hash was broadcast (wall clock, ms). */
  sentAtMs: number;
  /**
   * Set once a broadcast is a 0-value self-transfer that frees the nonce
   * because the call itself would now revert: that revert's error name.
   */
  cancelled?: string;
  /**
   * Index in `hashes` of the first self-transfer: every hash from there on is a
   * cancel, not the action. Without `cancelled`, the nonce was freed because a
   * replacement would not pay and a later transaction that pays for freeing it
   * waited behind it: the action was given up, no race was lost.
   */
  cancelFrom?: number;
  /**
   * Left at its own fees: a markDark / revealKey whose replacement would not
   * pay, a self-transfer that gave one up whose higher fees nothing behind
   * it pays for, or any transaction behind a nonce that is not being mined
   * (no fee helps it then). Nonces are mined in order, so before the watcher
   * sends a markDark / revealKey it frees this nonce (or raises its fees) if
   * the new transaction's bounty pays for that too.
   */
  heldBack?: boolean;
  /**
   * Gas units the profit check counted when the action was sent (markDark: its
   * estimate + revealGasEstimate), decimal. A replacement must still pay for
   * them at its own, higher fees.
   */
  profitGas?: string;
}

/** Our transaction was mined but lost to someone else's (it reverted, or was cancelled because the state moved on). */
export interface LostRace {
  action: TxKind;
  hash: Hex;
  /** The custom error the replay decoded (AlreadyDarkMarked, AlreadyRevealed, ...). */
  errorName: string;
  gasUsed?: string;
  at: string;
}

export interface TrackedSwitch {
  owner: Address;
  /** Decimal string (JSON has no bigint). */
  id: string;
  lastState?: StateName;
  /** ALIVE switches are not polled again before this chain time (their deadline). */
  recheckAtChainTime?: string;
  /** Consecutive failures of the pending action. */
  attempts: number;
  /** Wall-clock gate for the next action after a failure (exponential backoff). */
  nextAttemptAtMs: number;
  /**
   * Wall-clock gate after an unprofitable verdict. Kept apart from the backoff
   * because it depends on policy: a new watcher process (perhaps --altruistic,
   * perhaps a new safety factor) clears it on startup.
   */
  profitRecheckAtMs?: number;
  /** Plaintext (or a key-mismatch record) written to outDir. */
  saved: boolean;
  commitmentMatches?: boolean;
  keyMismatch?: boolean;
  markDarkTx?: Hex;
  revealTx?: Hex;
  publishTx?: Hex;
  /** Lowest block of a receipt booked for this switch (decimal): where its events are looked for once it is final. */
  bookedBlock?: string;
  /** Passes in a row whose search for a booked transaction's event failed (given up at 3, the booking kept). */
  eventSearchFailures?: number;
  revealedByUs?: boolean;
  /** Seen published on-chain (by anyone): done whatever the publish policy. */
  published?: boolean;
  /** Broadcast and not yet resolved; checked first on the next pass. */
  pendingTx?: PendingTx;
  lostRaces?: LostRace[];
  lastError?: string;
  note?: string;
  /**
   * Nothing left to do (cancelled, or revealed + saved [+ published]), set once the finalized block shows that state
   * (at once on local Anvil); a revealed, unpublished one is reopened by a run with publish on.
   */
  terminal: boolean;
}

export interface WatcherState {
  version: 1;
  chainId: number;
  contract: Address;
  /** Last block fully scanned for SwitchCreated, as a decimal string. */
  lastScannedBlock?: string;
  /** Lowest block discovery has started from (first run or --rescan-from), as a decimal string. */
  firstScannedBlock?: string;
  /** getLogs chunk size the provider last accepted (decimal string). */
  logChunkBlocks?: string;
  /** Successful getLogs requests at that reduced chunk size since it last changed (it doubles after logChunkGrowAfter). */
  logChunkSuccesses?: number;
  /** Successes needed before the reduced chunk doubles: 4, twice as many after each refused growth (at most 64). */
  logChunkGrowAfter?: number;
  /** The chunk was just doubled and not yet accepted at full width: refused, it doubles logChunkGrowAfter. */
  logChunkProbing?: boolean;
  /**
   * A getLogs range the node did not serve (pruned history), after asking three times in a row: discovery does
   * not ask for it again before `retryAtMs` (backoff across passes, `failures` so far), and reports it as a
   * configuration error meanwhile. Cleared once that range is served, or no longer asked for.
   */
  logsUnavailable?: { from: string; to: string; failures: number; retryAtMs: number };
  /**
   * Public decryption failed in a way a retry cannot fix (relayer API key
   * missing, wrong or revoked): markDark pauses until `untilMs`, since it would
   * be gas for nothing. Kept here so that separate --once runs honour it too.
   * Lifted early by a successful public decryption, or when the relayer
   * settings change (`relayer` is a short hash of them, not the key).
   */
  decryptBroken?: { reason: string; untilMs: number; relayer: string };
  switches: Record<string, TrackedSwitch>;
}

export const newTracked = (owner: Address, id: bigint): TrackedSwitch => ({
  owner,
  id: id.toString(),
  attempts: 0,
  nextAttemptAtMs: 0,
  saved: false,
  terminal: false,
});

/** Key used in the state file: "<owner lowercase>/<id>". */
export const trackKey = (owner: Address, id: bigint | string): string => `${owner.toLowerCase()}/${id.toString()}`;

// ---------- Decision ---------- //

export interface ChainView {
  state: StateName;
  expiresAt: bigint;
  bounty: bigint;
  published: boolean;
}

export interface Now {
  /** Latest block timestamp (seconds). Deadlines are judged by chain time, never the local clock. */
  chainTime: bigint;
  /** Local wall clock (ms) for backoff timers. */
  wallMs: number;
}

export type Decision =
  | { action: "ignore"; reason: string; terminal: boolean; recheckAtChainTime?: bigint }
  | { action: "wait"; reason: string; untilMs: number }
  | { action: "mark-dark" }
  | { action: "reveal" }
  | { action: "archive" }
  | { action: "publish" }
  | { action: "done"; reason: string };

/**
 * What to do next for one switch, from its on-chain view and our local record.
 *
 *   NONE         → ignore (re-check next pass)
 *   CANCELLED    → ignore, terminal (the key is never released)
 *   ALIVE        → ignore until the deadline (chain time)
 *   DARK         → mark-dark          (profitability pre-check in the caller)
 *   DARK_MARKED  → reveal             (fetch key + proof, verify tag, profit check, revealKey)
 *   REVEALED     → archive (decrypt from chain, save) → publish (if enabled, unpublished,
 *                  commitment verified) → done
 *
 * Every action is deferred while a failure backoff is pending. markDark and
 * revealKey are also deferred while an unprofitable verdict is pending; archive
 * and publish are not, since the profit check has nothing to do with them.
 */
export const decide = (
  view: ChainView,
  local: Pick<TrackedSwitch, "saved" | "commitmentMatches" | "keyMismatch" | "nextAttemptAtMs" | "profitRecheckAtMs">,
  policy: { publish: boolean },
  now: Now,
): Decision => {
  const backoff = (d: Decision): Decision =>
    now.wallMs < local.nextAttemptAtMs ? { action: "wait", reason: "backing off after a failure", untilMs: local.nextAttemptAtMs } : d;
  const gate = (d: Decision): Decision => {
    const b = backoff(d);
    if (b !== d) return b;
    const p = local.profitRecheckAtMs ?? 0;
    if (now.wallMs < p) return { action: "wait", reason: "unprofitable; re-checking later", untilMs: p };
    return d;
  };

  switch (view.state) {
    case "NONE":
      return { action: "ignore", reason: "switch does not exist", terminal: false };
    case "CANCELLED":
      return { action: "ignore", reason: "cancelled by the owner; the key is never released", terminal: true };
    case "ALIVE":
      return { action: "ignore", reason: "owner alive", terminal: false, recheckAtChainTime: view.expiresAt };
    case "DARK":
      return gate({ action: "mark-dark" });
    case "DARK_MARKED":
      return gate({ action: "reveal" });
    case "REVEALED":
      if (!local.saved) return backoff({ action: "archive" });
      if (policy.publish && !view.published && local.commitmentMatches === true && !local.keyMismatch) return backoff({ action: "publish" });
      return { action: "done", reason: view.published ? "revealed and published" : "revealed" };
  }
};

/** Whether a tracked switch needs an on-chain read this pass. */
export const shouldPoll = (t: Pick<TrackedSwitch, "terminal" | "recheckAtChainTime">, chainTime: bigint): boolean => {
  if (t.terminal) return false;
  if (t.recheckAtChainTime !== undefined && chainTime < BigInt(t.recheckAtChainTime)) return false;
  return true;
};

// ---------- Profitability ---------- //

export interface ProfitInput {
  bountyWei: bigint;
  gasUnits: bigint;
  gasPriceWei: bigint;
  /** Wei the action must also pay for besides its own gas (e.g. self-transfers that free the nonces in front of it). */
  extraCostWei?: bigint;
  safetyFactor: number;
  minProfitWei: bigint;
  altruistic: boolean;
  /** 0 = no cap. */
  maxGasPriceWei: bigint;
}

export interface ProfitResult {
  ok: boolean;
  reason: string;
  costWei: bigint;
  requiredWei: bigint;
}

const BPS = 10_000n;

export const assessProfit = (i: ProfitInput): ProfitResult => {
  const extra = i.extraCostWei ?? 0n;
  const costWei = i.gasUnits * i.gasPriceWei + extra;
  const factorBps = BigInt(Math.ceil(i.safetyFactor * Number(BPS)));
  const requiredWei = (costWei * factorBps + BPS - 1n) / BPS + i.minProfitWei;
  if (i.maxGasPriceWei > 0n && i.gasPriceWei > i.maxGasPriceWei) {
    return { ok: false, reason: `gas price ${i.gasPriceWei} wei is above the cap ${i.maxGasPriceWei} wei`, costWei, requiredWei };
  }
  if (i.altruistic) return { ok: true, reason: "altruistic mode", costWei, requiredWei };
  if (i.bountyWei >= requiredWei) return { ok: true, reason: "bounty covers gas × safety factor", costWei, requiredWei };
  return {
    ok: false,
    reason: `bounty ${i.bountyWei} wei < required ${requiredWei} wei (${extra > 0n ? "(" : ""}gas ${i.gasUnits} × ${i.gasPriceWei} wei${extra > 0n ? ` + ${extra} wei)` : ""} × ${i.safetyFactor}${i.minProfitWei > 0n ? ` + min profit ${i.minProfitWei}` : ""})`,
    costWei,
    requiredWei,
  };
};

// ---------- Timing ---------- //

/** Exponential backoff after `attempts` consecutive failures (attempts ≥ 1). */
export const backoffMs = (attempts: number, baseSec: number, maxSec: number): number =>
  Math.min(baseSec * 2 ** Math.max(0, attempts - 1), maxSec) * 1000;

/** Poll interval with ± pct jitter, in ms. `rand` in [0, 1). */
export const jitteredMs = (baseSec: number, pct: number, rand: number = Math.random()): number =>
  Math.max(0, Math.round((baseSec + (rand * 2 - 1) * baseSec * (pct / 100)) * 1000));

// ---------- Discovery ---------- //

/** Inclusive end of the getLogs chunk starting at `from` (never past `head`). */
export const chunkEnd = (from: bigint, head: bigint, size: bigint): bigint => {
  if (size < 1n) throw new Error("chunk size must be ≥ 1");
  const hi = from + size - 1n;
  return hi > head ? head : hi;
};

/**
 * Why a getLogs request failed, from the node's own error text (never a URL or request body), HTTP status and
 * JSON-RPC codes (`codes`: every code in the error's cause chain, `code` the first):
 *   "transient"   — rate limit, timeout, network or 5xx: sleep and retry the same range;
 *   "unavailable" — the node lacks the blocks' history ("pruned history", code 4444). Another backend of a
 *                   load-balanced RPC may serve it, so it is asked again at once; one that never does is a
 *                   configuration problem (a start block below what the RPC keeps), not a reason to sleep;
 *   "range"       — the provider rejects the span or the result size: halve the chunk.
 * Unrecognised errors count as "range" (halving is the safe default).
 */
export const classifyLogsError = (e: { message: string; status?: number; code?: number; codes?: number[] }): "range" | "transient" | "unavailable" => {
  const m = e.message;
  if (e.status === 429 || e.code === 429 || /rate.?limit|too many requests|throttl|capacity exceeded|compute units/i.test(m)) return "transient";
  if (e.code === 4444 || e.codes?.includes(4444) || /pruned|history (is )?(not |un)available/i.test(m)) return "unavailable";
  if (
    /block range|range (is )?(too|exceeds)|range limit|blocks? range|too many (blocks|results|logs)|more than \d+ (results|logs|blocks)|query returned more|response (size|is too)|result window|exceed(s|ed)? (the )?(max|maximum)|max(imum)? (block|range)|log response size/i.test(
      m,
    )
  ) {
    return "range";
  }
  if (
    e.status === 408 ||
    (e.status !== undefined && e.status >= 500) ||
    /took too long|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i.test(m)
  ) {
    return "transient";
  }
  return "range";
};

// ---------- Fees ---------- //

/** EIP-1559 fee caps, wei. */
export interface FeePair {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Clamp fees to the gas-price cap (0 = none), keeping the tip ≤ the max fee. */
export const capFees = (f: FeePair, capWei: bigint): FeePair => {
  const maxFeePerGas = capWei > 0n && f.maxFeePerGas > capWei ? capWei : f.maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : f.maxPriorityFeePerGas };
};

/** +12.5% (+1 wei): clears the 10% minimum bump nodes require for a same-nonce replacement. */
const bump = (x: bigint): bigint => x + (x * 125n) / 1000n + 1n;

/**
 * Fees for a same-nonce replacement: at least +12.5% on both caps and at least
 * the current market estimate, capped by `capWei` (0 = no cap). Undefined when
 * the cap leaves no room for a valid replacement.
 */
export const replacementFees = (old: FeePair, market: FeePair, capWei: bigint): FeePair | undefined => {
  const minFee = bump(old.maxFeePerGas);
  const minTip = bump(old.maxPriorityFeePerGas);
  let maxFeePerGas = market.maxFeePerGas > minFee ? market.maxFeePerGas : minFee;
  if (capWei > 0n && maxFeePerGas > capWei) maxFeePerGas = capWei;
  if (maxFeePerGas < minFee) return undefined;
  let maxPriorityFeePerGas = market.maxPriorityFeePerGas > minTip ? market.maxPriorityFeePerGas : minTip;
  if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  if (maxPriorityFeePerGas < minTip) return undefined;
  return { maxFeePerGas, maxPriorityFeePerGas };
};

/** Split [from, to] into chunks of at most `size` blocks. */
export const blockRanges = (from: bigint, to: bigint, size: bigint): [bigint, bigint][] => {
  const out: [bigint, bigint][] = [];
  if (size < 1n) throw new Error("chunk size must be ≥ 1");
  for (let s = from; s <= to; s += size) out.push([s, s + size - 1n > to ? to : s + size - 1n]);
  return out;
};
