#!/usr/bin/env node
// watcher — autonomous hunter for DeadManSwitch.
//
// Each pass:
//   1. discovers switches from SwitchCreated logs (chunked eth_getLogs from
//      FROM_BLOCK / the last scanned block, the last 64 blocks again against
//      reorganisations), plus any listed in the config;
//   2. for every switch that needs attention (decide() in watcherCore.ts):
//      pending transactions first, in nonce order; then one read of each
//      switch that is due, taking every step that sends nothing; then the
//      transactions, highest bounty first, re-reading chain time as blocks
//      go by so that a switch going dark meanwhile joins the same pass.
//        a tx still pending from an earlier pass → resolve it first (receipt,
//                       or replace it: same nonce, higher fees, capped; one
//                       that no longer pays is left at its own fees, or its
//                       nonce freed when a later markDark / revealKey waits
//                       behind it whose bounty pays for that too)
//        DARK         → markDark            (if the bounty can pay for markDark + reveal)
//        DARK_MARKED  → profit pre-check on revealGasEstimate (before any KMS call)
//                     → KMS public decrypt  (one handle, retry/backoff, per-pass time budget)
//                     → verify the key opens the ciphertext (warn loudly if not; still reveal)
//                     → profitability check on the exact revealKey gas estimate
//                     → revealKey (claims the bounty)
//        REVEALED     → decrypt from chain state → save plaintext to outDir (0600)
//                     → publishPlaintext when --publish
//                     → done once the finalized block shows it (not on Anvil);
//                       then what was booked is checked on the final chain
//      Losing a race (someone else's markDark / revealKey lands first, at
//      simulation time or on-chain in the same block) is not an error: the
//      switch is re-read and handled from its new state.
//   3. persists progress to a small JSON state file.
//
// Run:  npm run watcher -- [--once] [--config watcher.config.json] [--altruistic] [--publish]

import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseError, bytesToHex, formatGwei, TransactionNotFoundError, type Address, type Hex } from "viem";
import { createClients, Dms, findEvent, STATE_NAMES, type Fees, type StateName, type SwitchAction, type SwitchActionKind, type SwitchInfo, type TxResult } from "./chain.js";
import { ConfigError, parseConfig, type Config, type Env } from "./config.js";
import { dekFromBytes32, KEY_MISMATCH_WARNING, verifyKeyOpensCiphertext, wipe } from "./envelope.js";
import { describeError, revertErrorName, TxReplacedError, TxRevertedError, TxTimeoutError } from "./errors.js";
import { createFhevm, fheChainFor, FhevmError, NO_ROUTE_RECHECK_MS, type DecryptedDek, type Fhevm } from "./fhevm.js";
import { fmtEth } from "./format.js";
import { sanitizeForTerminal } from "./sanitize.js";
import {
  assessProfit,
  backoffMs,
  capFees,
  chunkEnd,
  classifyLogsError,
  decide,
  jitteredMs,
  newTracked,
  parseWatcherArgs,
  parseWatcherConfig,
  replacementFees,
  shouldPoll,
  trackKey,
  WATCHER_USAGE,
  type PendingTx,
  type TrackedSwitch,
  type TxKind,
  type WatcherConfig,
  type WatcherFlags,
  type WatcherState,
} from "./watcherCore.js";

export type Logger = (msg: string) => void;

const defaultLog: Logger = (msg) => console.log(`[watcher ${new Date().toISOString()}] ${sanitizeForTerminal(msg)}`);

/** setTimeout as a promise that also resolves as soon as `signal` aborts (stop()). */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal?.aborted) return done();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

/** Revert names that mean "someone else already moved this switch on" — re-read instead of backing off. */
const RACE_ERRORS = new Set(["AlreadyDarkMarked", "AlreadyRevealed", "NotActive", "AlreadyPublished", "NotDark", "NotDarkMarked", "NotRevealed"]);
const isRace = (err: unknown): boolean => RACE_ERRORS.has(revertErrorName(err) ?? "");

/** Public decryption cannot work until the operator fixes the configuration (missing / rejected API key). */
const isFatalDecrypt = (err: unknown): boolean => err instanceof ConfigError || (err instanceof FhevmError && err.fatal);

/** The KMS step was skipped this pass (time budget used up, or stopping); not a failure. */
class Deferred extends Error {}

/** Another watcher took the state file over: nothing more is sent. */
class LockLost extends Error {}

/** Gas of the 0-value self-transfer that frees a nonce. */
const SELF_TRANSFER_GAS = 21_000n;

/** Where a pending transaction the state file does not track comes from, for the warnings about one. */
const UNTRACKED_FROM =
  "another watcher state file, process or wallet using this key; a watcher moved to a new contract with a fresh state file " +
  "leaves the old one's pending transactions behind. This watcher cannot re-price or free it";

/** During a pass, the state file is rewritten at most this often (and at its end); broadcasts are written at once. */
const PERSIST_EVERY_MS = 5_000;

/** At the same bounty, which next step is sent first: a reveal (its markDark is paid for already), then a markDark, then a publish. */
const SEND_ORDER: readonly StateName[] = ["DARK_MARKED", "DARK", "REVEALED"];

/** During a pass's transactions, chain time is read again after a broadcast, or after this long (about one slot). */
const RECHECK_EVERY_MS = 12_000;

/** Passes whose search for a booked transaction's event failed, before the search is given up and the booking kept (settleBooked). */
const MAX_EVENT_SEARCHES = 3;

/** A reduced getLogs chunk doubles after this many accepted requests; after each refused growth, after twice as many (at most MAX_GROW_AFTER). */
const GROW_AFTER = 4;
const MAX_GROW_AFTER = 64;

/**
 * Blocks below the last scanned one that discovery scans again on each pass with new blocks (not on local
 * Anvil): two epochs, about when Ethereum finalizes a block, so a reorganisation up to that deep cannot hide a
 * SwitchCreated log. One topic-filtered eth_getLogs at the default chunk size.
 */
const REORG_OVERLAP_BLOCKS = 64n;

/** Fees of a pending transaction's latest broadcast. */
const feesOf = (q: PendingTx): Fees => ({ maxFeePerGas: BigInt(q.maxFeePerGas), maxPriorityFeePerGas: BigInt(q.maxPriorityFeePerGas) });

/** A pending markDark / revealKey that still carries the call (no self-transfer took its nonce). */
const isAction = (q: PendingTx): boolean => q.kind !== "publishPlaintext" && q.cancelFrom === undefined && q.cancelled === undefined;

/** A self-transfer that gave up a held-back action (not one that freed the nonce of a call that would now revert). */
const gaveUp = (q: PendingTx): boolean => q.cancelFrom !== undefined && q.cancelled === undefined;

/** A markDark / revealKey that earns its bounty once mined: what freeing the nonces in front of it must fit into. */
interface Payer {
  /** For the log. */
  what: string;
  /** Undefined: about to be sent, so behind every pending transaction. */
  nonce?: number;
  bounty: bigint;
  /** Gas its profit check counts (markDark: its own plus revealGasEstimate). */
  gas: bigint;
  /** The fees it is (or will be) mined at. */
  fees: Fees;
}

/** Short hash of the relayer settings, so a persisted decryption failure is dropped once they change. The key itself is never stored. */
const relayerId = (cfg: Config): string =>
  createHash("sha256").update(`${cfg.chainId}\n${cfg.relayerUrl ?? ""}\n${cfg.relayerApiKey ?? ""}`).digest("hex").slice(0, 16);

/** What the watcher needs from the chain. `Dms` implements it; unit tests pass a stub. */
export type WatcherDms = Pick<
  Dms,
  | "address"
  | "blockNumber"
  | "switchCreatedLogs"
  | "latestTimestamp"
  | "info"
  | "ciphertext"
  | "estimateMarkDark"
  | "estimateRevealKey"
  | "fees"
  | "latestBaseFee"
  | "send"
  | "waitFor"
  | "txOutcome"
  | "replace"
  | "freeNonce"
  | "knowsTx"
  | "nonce"
  | "actionLogs"
  | "finalizedBlock"
  | "signer"
>;

export interface PassSummary {
  polled: number;
  markedDark: string[];
  revealed: string[];
  saved: string[];
  published: string[];
  keyMismatches: string[];
  unprofitable: string[];
  /** Someone else's transaction landed first; ours reverted (or was cancelled). Not an error. */
  lostRaces: string[];
  pending: string[];
  errors: string[];
}

const emptySummary = (): PassSummary => ({
  polled: 0,
  markedDark: [],
  revealed: [],
  saved: [],
  published: [],
  keyMismatches: [],
  unprofitable: [],
  lostRaces: [],
  pending: [],
  errors: [],
});

/**
 * Message / HTTP status / JSON-RPC codes (the first, and every one) of an error and its causes, for
 * classifyLogsError. Of a viem error only its short message and details count (the node's own words): its full
 * message also names the request URL and body, which say nothing about the failure (an RPC URL with "pruned" in
 * its hostname would match the wrong rule).
 */
const errorInfo = (err: unknown): { message: string; status?: number; code?: number; codes: number[] } => {
  const parts: string[] = [];
  const codes: number[] = [];
  let status: number | undefined;
  let e = err as { message?: unknown; status?: unknown; code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; e && i < 10; i++, e = e.cause as typeof e) {
    const own = e instanceof BaseError ? [e.shortMessage, e.details] : [e.message];
    for (const x of own) if (typeof x === "string" && x !== "") parts.push(x);
    if (typeof e.status === "number") status ??= e.status;
    if (typeof e.code === "number") codes.push(e.code);
  }
  return { message: parts.join(" | "), status, code: codes[0], codes };
};

// ---------- State file ---------- //

export const loadState = (path: string, chainId: number, contract: Address): WatcherState => {
  if (!existsSync(path)) return { version: 1, chainId, contract, switches: {} };
  let s: WatcherState;
  try {
    s = JSON.parse(readFileSync(path, "utf8")) as WatcherState;
  } catch (err) {
    throw new ConfigError(`state file ${path} is not valid JSON (${(err as Error).message}); move it aside to start fresh`);
  }
  if (s.version !== 1 || typeof s.switches !== "object") throw new ConfigError(`state file ${path} has an unknown format`);
  if (s.chainId !== chainId || s.contract.toLowerCase() !== contract.toLowerCase()) {
    // Its transactions still pending hold this signer's nonces on this chain: every transaction a watcher with a
    // fresh state file sends waits behind them, and nothing would re-price or free them.
    const nonces = s.chainId === chainId ? Object.values(s.switches).flatMap((t) => (t.pendingTx ? [t.pendingTx.nonce] : [])) : [];
    nonces.sort((a, b) => a - b);
    throw new ConfigError(
      `state file ${path} belongs to chain ${s.chainId} / contract ${s.contract}, not ${chainId} / ${contract}; use --state-file` +
        (nonces.length
          ? `. It still has transactions pending at nonces ${nonces.join(", ")} (pendingTx): with the same PRIVATE_KEY, every transaction ` +
            `of a watcher with another state file is mined only after them. First run the watcher of contract ${s.contract} until its ` +
            `state file has no pendingTx left, or give this watcher another PRIVATE_KEY`
          : ""),
    );
  }
  return s;
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};

/** f(), computed once. */
const once = <T>(f: () => T): (() => T) => {
  let v: { x: T } | undefined;
  return () => (v ??= { x: f() }).x;
};

const readTrimmed = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * This boot of the host, when the OS says (Linux boot_id, macOS kern.bootsessionuuid). Containers share
 * their host's. Unlike now − uptime it does not move when the clock is set, e.g. by NTP on a host without an RTC.
 */
const readBootId = once((): string | undefined => {
  try {
    if (process.platform === "linux") return readTrimmed("/proc/sys/kernel/random/boot_id");
    if (process.platform === "darwin") {
      return execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    }
  } catch {
    /* unknown */
  }
  return undefined;
});

/** This PID namespace (Linux, e.g. "pid:[4026531836]"): pids name the same processes only within one. */
const readPidNs = once((): string | undefined => {
  if (process.platform !== "linux") return undefined;
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
});

/** This machine's hostname (a container has its own). */
const readHost = once((): string => hostname());

/**
 * This machine across reboots, when it has a machine id (Linux /etc/machine-id; hashed, since the id itself is
 * meant to stay private). Without one, a hostname alone does not tell two machines apart.
 */
const readMachineId = once((): string | undefined => {
  const id = process.platform === "linux" ? (readTrimmed("/etc/machine-id") ?? readTrimmed("/var/lib/dbus/machine-id")) : undefined;
  return id ? createHash("sha256").update(`dms-watcher-lock\n${id}`).digest("hex").slice(0, 16) : undefined;
});

/** When a process started (Linux: clock ticks after boot, field 22 of /proc/<pid>/stat), to tell a reused pid from its first owner. */
const procStartTime = (pid: number): string | undefined => {
  if (process.platform !== "linux") return undefined;
  const stat = readTrimmed(`/proc/${pid}/stat`);
  // field 2, the command name, is in parentheses and may itself contain spaces and parentheses
  return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
};

/** How often a watcher refreshes its lock's heartbeat: the lock file's modification time. */
const HEARTBEAT_MS = 5_000;
/** A contender that cannot check the holder's pid judges it by its heartbeat, over this many heartbeat periods. */
const HEARTBEATS = 3;
/** Generations of takeover claims for one stale lock: each takeover that crashed half-way leaves one behind. */
const MAX_CLAIMS = 16;

/** What `<stateFile>.lock` records about its holder. */
interface LockRecord {
  pid: number;
  token?: string;
  /** The hostname (readHost), machine (readMachineId), boot (readBootId) and PID namespace (readPidNs) the pid belongs to. */
  host?: string;
  machine?: string;
  bootId?: string;
  pidNs?: string;
  /** procStartTime of the holder. */
  startTime?: string;
  /** How often the holder refreshes the heartbeat. Absent in locks of watchers before the heartbeat. */
  heartbeatMs?: number;
}

/** Locks this process holds, by token (several Watchers in one process, as in the tests, share one). */
const ownLocks = new Map<string, { pid: number; timer: ReturnType<typeof setInterval>; listeners: Set<() => void> }>();

/** Who is asking for the lock, and how to judge its holder. Injectable so tests can stage races, containers, machines and reboots. */
export interface LockEnv {
  pid: number;
  /** Whether a pid is running, in this PID namespace. */
  alive: (pid: number) => boolean;
  /** procStartTime: undefined if unknown. */
  startTime: (pid: number) => string | undefined;
  /** Wall clock, for the timestamps written (never to judge a lock: machines' clocks differ, and jump). */
  nowMs: () => number;
  /** Monotonic clock, for how long a contender has watched a heartbeat (a wall clock can jump when NTP sets it). */
  monoMs: () => number;
  /** Synchronous sleep (the lock is taken in the Watcher's constructor). */
  sleepMs: (ms: number) => void;
  /** This boot's id, if the OS gives one. */
  bootId: () => string | undefined;
  /** This hostname (readHost). */
  host: () => string;
  /** This machine (readMachineId), if it has a machine id. */
  machineId: () => string | undefined;
  /** This PID namespace, if the OS gives one (Linux). */
  pidNs: () => string | undefined;
  /** How often the holder refreshes its heartbeat. */
  heartbeatMs: number;
  /** Runs after the lock was judged stale, before it is taken over (tests interleave a second contender here). */
  beforeTakeover?: () => void;
}

/** A state-file lock this process holds. */
export interface StateLock {
  /** Whether it is still ours (reads the lock file): false once another watcher took it over, or it was deleted. */
  held(): boolean;
  /** Stop the heartbeat; delete the lock file if it is still ours. */
  release(): void;
}

/**
 * One watcher per state file. Two processes on the same file (say, overlapping cron --once runs, in containers
 * or on machines sharing the file) would each send the same markDark / revealKey (the later one reverts: gas
 * lost) and overwrite each other's records.
 *
 * `<stateFile>.lock` names its holder: pid, machine, boot, PID namespace, process start time and a random
 * token. The holder refreshes its heartbeat (the file's mtime) every `heartbeatMs`, from a timer, so also
 * while a pass waits on a receipt or the KMS. A contender judges a lock:
 *  - by the pid, when the pid means the same process to it: same boot of the same kernel and the same PID
 *    namespace. Gone, or now another process (start time), is stale at once; running is held, whatever the
 *    clocks say. An equal pid number in another namespace (node is PID 1 in every container) proves nothing.
 *  - as stale at once when this machine wrote it before its last boot (same machine id and hostname, other
 *    boot id). Without a machine id this rule is off: two machines can share a hostname, and a state file.
 *  - an older watcher's lock (no heartbeat, no PID namespace) on this boot: with our pid it was an earlier
 *    process (PID 1 in a container that was killed), stale; with a pid that runs here, held.
 *  - otherwise (another PID namespace or machine, or a dead pid in an older lock) by watching its heartbeat
 *    for 3 of its periods on a monotonic clock, however fresh it looks: if it moves, it is held, and refused
 *    at once; if it does not, it is stale. No wall clock decides: machines' clocks differ, and a clock that
 *    jumped (a host without an RTC, set by NTP) cannot stop a heartbeat or fake one.
 * A stale lock is taken over through a claim file made with exclusive create (no link(), which SMB/CIFS and
 * some FUSE mounts lack), named after the stale lock's exact contents: only the claim's maker removes that
 * lock, and only if it is still those contents. A claim whose maker died half-way is skipped for the next
 * generation, so a crash never blocks later starts; the winner clears old claims. Returns the lock;
 * `onLost` runs when its heartbeat finds that another watcher has taken it over.
 */
export const lockStateFile = (stateFile: string, envIn: Partial<LockEnv> = {}, onLost?: () => void): StateLock => {
  const env: LockEnv = {
    pid: process.pid,
    alive: pidAlive,
    startTime: procStartTime,
    nowMs: Date.now,
    monoMs: () => performance.now(),
    sleepMs: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    bootId: readBootId,
    host: readHost,
    machineId: readMachineId,
    pidNs: readPidNs,
    heartbeatMs: HEARTBEAT_MS,
    ...envIn,
  };
  /** A recorded heartbeat interval, kept sane (a lock file is not trusted to stall every start for an hour). */
  const sane = (ms: number) => Math.min(Math.max(ms, 10), 60_000);
  const hb = sane(env.heartbeatMs);
  const path = `${stateFile}.lock`;
  const me = { bootId: env.bootId(), pidNs: env.pidNs(), host: env.host(), machine: env.machineId() };

  const read = (p: string): string | undefined => {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };
  /** Contents and mtime (the heartbeat) of a lock or claim file; undefined once it is gone. */
  const snapshot = (p: string): { raw: string; mtimeMs: number } | undefined => {
    try {
      return { raw: readFileSync(p, "utf8"), mtimeMs: statSync(p).mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  };
  const rm = (p: string) => {
    try {
      unlinkSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  };
  const parse = (raw: string): LockRecord | undefined => {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (typeof j.pid !== "number" || !Number.isSafeInteger(j.pid) || j.pid <= 0) return undefined;
      const str = (k: string) => (typeof j[k] === "string" && j[k] ? { [k]: j[k] as string } : {});
      return {
        pid: j.pid,
        ...str("token"),
        ...str("host"),
        ...str("machine"),
        ...str("bootId"),
        ...str("pidNs"),
        ...str("startTime"),
        ...(typeof j.heartbeatMs === "number" && Number.isFinite(j.heartbeatMs) ? { heartbeatMs: j.heartbeatMs } : {}),
      };
    } catch {
      return undefined;
    }
  };
  const ours = (token: string): boolean => {
    const raw = read(path);
    return raw !== undefined && parse(raw)?.token === token;
  };
  const heldBy = (token: string): boolean => {
    try {
      return ours(token);
    } catch {
      return true; // cannot tell (an I/O error): not a reason to stop
    }
  };
  const handle = (token: string): StateLock => {
    if (onLost) ownLocks.get(token)?.listeners.add(onLost);
    return {
      held: () => heldBy(token),
      release: () => {
        const own = ownLocks.get(token);
        if (own) clearInterval(own.timer);
        ownLocks.delete(token);
        try {
          if (ours(token)) unlinkSync(path);
        } catch {
          /* best effort: a lock left behind is taken over by the next start */
        }
      },
    };
  };

  /** Whether a pid in `r` names the same process for this one: same boot of the same kernel, same PID namespace. */
  const pidsComparable = (r: LockRecord): boolean =>
    me.bootId !== undefined && r.bootId === me.bootId && r.pidNs === me.pidNs && (me.pidNs !== undefined || process.platform !== "linux");
  /** A pid that is gone, or that another process has now (its start time differs). */
  const pidGone = (r: LockRecord): boolean => {
    if (r.pid === env.pid) return true; // our pid but not our token: the process that wrote it is gone
    if (!env.alive(r.pid)) return true;
    const now = r.startTime !== undefined ? env.startTime(r.pid) : undefined;
    return now !== undefined && now !== r.startTime;
  };
  /**
   * Watch `p` (as snapshotted) for `ms` on the monotonic clock, polling 12 times: "moved" when its heartbeat
   * (mtime) moved with the same contents, "changed" when the contents changed or it is gone, else "unchanged".
   */
  const watch = (p: string, snap: { raw: string; mtimeMs: number }, ms: number): "moved" | "changed" | "unchanged" => {
    const end = env.monoMs() + ms;
    for (let left = ms; left > 0; left = end - env.monoMs()) {
      env.sleepMs(Math.min(left, Math.max(10, Math.floor(ms / 12))));
      const now = snapshot(p);
      if (!now || now.raw !== snap.raw) return "changed";
      if (now.mtimeMs !== snap.mtimeMs) return "moved";
    }
    return "unchanged";
  };

  type Verdict = "mine" | "live" | "stale" | { watchMs: number };
  const judge = (held: LockRecord | undefined): Verdict => {
    if (held === undefined) return { watchMs: HEARTBEATS * hb }; // being written right now, or garbage
    if (held.token !== undefined && ownLocks.get(held.token)?.pid === env.pid) return "mine"; // this process holds it already
    // Written by this machine before it last booted: the process is gone, whatever its pid names now. Only with a
    // machine id: two machines can have the same hostname (and share the state file).
    if (me.machine !== undefined && held.machine === me.machine && held.host === me.host && held.bootId !== undefined && me.bootId !== undefined && held.bootId !== me.bootId) {
      return "stale";
    }
    if (pidsComparable(held)) return pidGone(held) ? "stale" : "live";
    if (held.heartbeatMs === undefined && held.bootId !== undefined && held.bootId === me.bootId) {
      // An older watcher's lock (no heartbeat, no PID namespace) on this boot. Our pid there was an earlier process
      // (PID 1 in a container that was killed: alive(1) is this one); another pid that runs here is held.
      if (held.pid === env.pid) return "stale";
      if (env.alive(held.pid)) return "live";
    }
    // Another PID namespace or machine: watched for 3 of its heartbeats, however fresh it looks (a container
    // killed just after a beat looks fresh). An older lock has no heartbeat: it does not move.
    return { watchMs: HEARTBEATS * sane(held.heartbeatMs ?? hb) };
  };
  const checkFirst =
    `If you are sure no watcher uses it (none of the processes, containers or machines that share this state file runs one, ` +
    `and the lock's modification time, which a running watcher refreshes every few seconds, has stopped changing), delete ${path}`;

  const token = randomUUID();
  const startTime = env.startTime(env.pid);
  const mine = JSON.stringify({
    pid: env.pid,
    token,
    host: me.host,
    ...(me.machine ? { machine: me.machine } : {}),
    ...(me.bootId ? { bootId: me.bootId } : {}),
    ...(me.pidNs ? { pidNs: me.pidNs } : {}),
    ...(startTime ? { startTime } : {}),
    heartbeatMs: hb,
    startedAt: new Date(env.nowMs()).toISOString(),
  } satisfies LockRecord & { startedAt: string });

  /** A claim that will not complete: its maker is gone, or (not checkable by pid) it has not moved for 2 heartbeats; claims live for a few file operations. */
  const abandoned = (claim: string, snap: { raw: string; mtimeMs: number }): boolean => {
    const c = parse(snap.raw);
    return c !== undefined && pidsComparable(c) ? pidGone(c) : watch(claim, snap, 2 * hb) === "unchanged";
  };
  /** Remove the stale lock `raw`, if this contender gets to: see lockStateFile. The caller then tries to create its own. */
  const takeOver = (raw: string): void => {
    const stem = `${path}.takeover-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
    for (let n = 0; n < MAX_CLAIMS; n++) {
      const claim = `${stem}.${n}`;
      try {
        writeFileSync(claim, mine, { flag: "wx", mode: 0o600 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new ConfigError(`state file ${stateFile}: cannot take over the stale ${path} (${(err as Error).message}). ${checkFirst}.`);
        }
        const c = snapshot(claim);
        if (c !== undefined && abandoned(claim, c)) continue; // its maker died half-way: the next generation
        env.sleepMs(10); // another contender is taking it over (or just did): judge the lock again
        return;
      }
      try {
        // Still the lock that was judged stale: nobody else can replace it while this claim exists.
        if (read(path) === raw) rm(path);
      } finally {
        rm(claim);
      }
      return;
    }
    throw new ConfigError(`state file ${stateFile}: ${MAX_CLAIMS} takeovers of the stale ${path} were abandoned half-way. ${checkFirst}, and ${stem}.*.`);
  };

  /** (contents, heartbeat) of locks already watched and found dead, so a contended takeover does not watch them again. */
  const dead = new Set<string>();
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      writeFileSync(path, mine, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const snap = snapshot(path);
      if (snap === undefined) continue; // released meanwhile
      const held = parse(snap.raw);
      let v = judge(held);
      if (v === "mine" && held?.token !== undefined) return handle(held.token);
      if (typeof v === "object") {
        const key = `${snap.mtimeMs}\n${snap.raw}`;
        if (dead.has(key)) v = "stale";
        else {
          const seen = watch(path, snap, v.watchMs);
          if (seen === "changed" || (seen === "moved" && held === undefined)) continue; // changed hands, or was being written: judge it again
          if (seen === "unchanged") dead.add(key);
          v = seen === "moved" ? "live" : "stale"; // the same holder's heartbeat moved: it runs
        }
      }
      if (v === "live") {
        throw new ConfigError(
          `state file ${stateFile} is in use by another watcher (pid ${held?.pid})${held?.host ? ` on ${held.host}` : ""}; ` +
            `run one watcher per state file, also across containers and machines (or pass --state-file). ${checkFirst}.`,
        );
      }
      env.beforeTakeover?.();
      takeOver(snap.raw);
      continue;
    }
    if (read(path) !== mine) continue; // removed again at once by a takeover that judged the file before it was written
    const timer = setInterval(() => {
      const own = ownLocks.get(token);
      if (!own) return clearInterval(timer);
      if (!heldBy(token)) {
        clearInterval(timer);
        for (const f of own.listeners) f();
        return;
      }
      try {
        const now = new Date(env.nowMs());
        utimesSync(path, now, now);
      } catch {
        /* the next beat tries again */
      }
    }, hb);
    timer.unref();
    ownLocks.set(token, { pid: env.pid, timer, listeners: new Set() });
    try {
      const now = new Date(env.nowMs()); // the heartbeat by this clock from the start (a network filesystem may stamp its own)
      utimesSync(path, now, now);
      // Claims left by takeovers that crashed half-way (and by older watchers' link-based takeovers) are void now.
      const base = basename(path);
      for (const f of readdirSync(dirname(path))) if (f.startsWith(`${base}.takeover-`) || f.startsWith(`${base}.stale-`)) rm(join(dirname(path), f));
    } catch {
      /* best effort */
    }
    return handle(token);
  }
  throw new ConfigError(`state file ${stateFile}: could not take ${path}. ${checkFirst}, and any ${path}.takeover-* file.`);
};

/** Write the state (or its JSON, already serialised) atomically: a temporary file, then a rename. */
export const saveState = (path: string, s: WatcherState | string): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, typeof s === "string" ? s : JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
};

// ---------- Watcher ---------- //

export class Watcher {
  readonly state: WatcherState;
  private stopping = false;
  /** Aborted by stop(): interrupts sleeps and in-flight KMS requests. */
  private readonly stopSignal = new AbortController();
  private fhevmP?: Promise<Fhevm>;
  /** --rescan-from, consumed by the first discovery that reaches the head. */
  private rescanFrom?: bigint;
  /** Time spent on KMS requests and retry waits in the current pass, against decryptPassBudgetSec. */
  private decryptSpentMs = 0;
  /** Latest block timestamp, read once per pass (switch states come from getSwitchInfo, which the contract judges by block.timestamp). */
  private chainTime = 0n;
  /** What the state file holds, as last written by this process. */
  private savedJson?: string;
  /** When persist() last ran (wall clock), for the in-pass write throttle. */
  private persistedAtMs = 0;
  /** `<stateFile>.lock`, held while this Watcher runs. */
  private readonly lock: StateLock;
  /** Another watcher took the state file over: this one stopped, and writes and sends nothing more. */
  private lockLost = false;
  /** warnUntrackedNonces ran (once per process, in the first pass). */
  private noncesChecked = false;
  /** Transactions broadcast by this process: blocks have gone by since the count was last seen (pass). */
  private broadcasts = 0;
  /** Pending transactions forgotten without a receipt (forgetPending): their nonces may need refilling (processSwitch). */
  private forgotten = 0;
  /** Dark switches whose markDark was paused (decryptBroken) when read this pass: queued once it is lifted (pass). */
  private readonly pausedMarks = new Set<TrackedSwitch>();

  constructor(
    readonly cfg: Config,
    readonly wcfg: WatcherConfig,
    readonly dms: WatcherDms,
    private readonly fhevmFactory: () => Promise<Fhevm>,
    readonly log: Logger = defaultLog,
    lockEnv?: Partial<LockEnv>,
  ) {
    this.lock = lockStateFile(wcfg.stateFile, lockEnv, () => this.onLockLost());
    try {
      this.state = loadState(wcfg.stateFile, cfg.chainId, dms.address);
    } catch (err) {
      this.lock.release();
      throw err;
    }
    for (const t of Object.values(this.state.switches)) {
      // Profitability verdicts belong to the previous process's policy and gas prices.
      t.profitRecheckAtMs = undefined;
      // So does "done" for a switch archived while publish was off: with publish on, it has work again.
      if (wcfg.publish && t.terminal && t.saved && t.commitmentMatches === true && !t.keyMismatch && !t.published) t.terminal = false;
    }
    for (const w of wcfg.switches) this.track(w.owner, w.id);
    this.rescanFrom = wcfg.rescanFrom;
    // Only worth a note when the configured block is below anything scanned so far (e.g. FROM_BLOCK lowered
    // after the first run); the same FROM_BLOCK on every start is the normal setup.
    const configured = wcfg.fromBlock ?? (cfg.fromBlock > 0n ? cfg.fromBlock : undefined);
    const { lastScannedBlock: last, firstScannedBlock: first } = this.state;
    if (wcfg.discover && last !== undefined && first !== undefined && configured !== undefined && this.rescanFrom === undefined && configured < BigInt(first)) {
      this.log(
        `note: ${wcfg.fromBlock !== undefined ? "--from-block / fromBlock" : "FROM_BLOCK"} ${configured} only applies to the first run; ` +
          `the state file has scanned blocks ${first} to ${last}, so discovery resumes at ${BigInt(last) + 1n}. ` +
          `Use --rescan-from ${configured} to look for switches created since block ${configured} again.`,
      );
    }
    const broken = this.state.decryptBroken;
    if (broken && broken.relayer !== relayerId(cfg)) {
      this.log(`relayer settings changed since public decryption last failed (${broken.reason}); markDark is no longer paused`);
      this.state.decryptBroken = undefined;
    }
  }

  stop(): void {
    this.stopping = true;
    this.stopSignal.abort();
  }

  /** Whether another watcher took the state file over (main exits 1). */
  get lostLock(): boolean {
    return this.lockLost;
  }

  /**
   * Another watcher took `<stateFile>.lock` over: it judged this one dead (say, the process was frozen past
   * its heartbeat bound). Its state file and transactions count now: stop, and write or send nothing more.
   */
  private onLockLost(): void {
    if (this.lockLost) return;
    this.lockLost = true;
    this.log(`lost ${this.wcfg.stateFile}.lock to another watcher: stopping without writing the state file or sending anything more`);
    this.stop();
  }

  /** Whether this Watcher still holds the state-file lock (reads the lock file). */
  private holdsLock(): boolean {
    if (!this.lockLost && !this.lock.held()) this.onLockLost();
    return !this.lockLost;
  }

  /** Before a broadcast: the lock must still be ours, or another watcher may be sending the same transaction. */
  private assertLock(): void {
    if (!this.holdsLock()) throw new LockLost(`lost ${this.wcfg.stateFile}.lock to another watcher; not sending`);
  }

  private fhevm(): Promise<Fhevm> {
    // A failed initialisation is not cached: the next attempt tries again.
    this.fhevmP ??= this.fhevmFactory().catch((err: unknown) => {
      this.fhevmP = undefined;
      throw err;
    });
    return this.fhevmP;
  }

  async close(): Promise<void> {
    if (this.fhevmP) (await this.fhevmP.catch(() => undefined))?.close();
    this.lock.release();
  }

  private track(owner: Address, id: bigint): boolean {
    const k = trackKey(owner, id);
    if (this.state.switches[k]) return false;
    this.state.switches[k] = newTracked(owner, id);
    return true;
  }

  private tag(t: TrackedSwitch): string {
    return `${t.owner.slice(0, 10)}…/${t.id}`;
  }

  /** Write the state file, unless it already holds exactly this state (a pass where nothing moved writes nothing). */
  private persist(): void {
    this.persistedAtMs = Date.now();
    if (!this.holdsLock()) return; // the state file is another watcher's now
    const json = JSON.stringify(this.state, null, 2);
    if (json === this.savedJson) return;
    saveState(this.wcfg.stateFile, json);
    this.savedJson = json;
  }

  /**
   * persist(), at most once per PERSIST_EVERY_MS. Each write serialises the whole state, so writing after
   * every switch that changed costs O(N²) a pass. A broadcast is written at once (submit, resolvePending),
   * which is what a crash must not lose; anything else is written at the end of the pass, or by this.
   */
  private persistSoon(): void {
    if (Date.now() - this.persistedAtMs >= PERSIST_EVERY_MS) this.persist();
  }

  /**
   * Scan SwitchCreated logs from the last scanned block (or FROM_BLOCK, or
   * --rescan-from) up to head − confirmations, scanning up to
   * REORG_OVERLAP_BLOCKS below it again whenever there are new blocks. Progress
   * is saved every 20 chunks and the scan stops early on stop(). Without
   * `waitOnTransient`, a transient provider error ends the scan at once
   * ("later": pass() retries it after its transactions, so they never wait on
   * it). A range the node does not serve (pruned history) is asked for again
   * at once, twice, then reported as a configuration error and not asked for
   * again before a backoff (logsUnavailable).
   */
  async discover(waitOnTransient = true): Promise<"done" | "later"> {
    const confirmations = BigInt(this.wcfg.confirmations ?? (this.cfg.chainId === 31337 ? 0 : 2));
    const head = (await this.dms.blockNumber()) - confirmations;
    const last = this.state.lastScannedBlock !== undefined ? BigInt(this.state.lastScannedBlock) : undefined;
    const rescan = this.rescanFrom;
    const resume = last !== undefined ? last + 1n : (this.wcfg.fromBlock ?? this.cfg.fromBlock);
    // --rescan-from only ever moves the start back: starting above `resume` would skip blocks for good.
    const start = rescan !== undefined && rescan < resume ? rescan : resume;
    if (start > head) {
      this.rescanFrom = undefined;
      return "done";
    }
    if (rescan !== undefined) {
      this.log(
        rescan < resume
          ? `rescanning SwitchCreated logs from block ${rescan} to ${head} (--rescan-from)`
          : `--rescan-from ${rescan}: blocks from ${resume} on have not been scanned yet, so discovery starts there`,
      );
    }
    // Remember the lowest block ever scanned from (first run or a real rescan), for the FROM_BLOCK note.
    const first = this.state.firstScannedBlock !== undefined ? BigInt(this.state.firstScannedBlock) : undefined;
    if ((last === undefined || start < resume) && (first === undefined || start < first)) this.state.firstScannedBlock = start.toString();
    const max = this.wcfg.logChunkBlocks;
    const remembered = this.state.logChunkBlocks !== undefined ? BigInt(this.state.logChunkBlocks) : max;
    let chunk = remembered >= 1n && remembered < max ? remembered : max;
    // `confirmations` only delays discovery: a reorganisation deeper than that (or a node serving getLogs behind
    // the one that answered the head) can put a SwitchCreated log in a block already scanned. Scan up to
    // REORG_OVERLAP_BLOCKS of them again (never below the first block scanned); track() ignores the switches it
    // knows. Only as many as fit in one request with the new blocks: a provider that caps the range (the working
    // chunk) is not asked for several more requests every pass.
    const fresh = head - start + 1n;
    const room = chunk > fresh ? chunk - fresh : 0n;
    const overlap = this.cfg.chainId === 31337 ? 0n : room < REORG_OVERLAP_BLOCKS ? room : REORG_OVERLAP_BLOCKS;
    const floor = BigInt(this.state.firstScannedBlock ?? this.wcfg.fromBlock ?? this.cfg.fromBlock);
    let scanFrom = start - overlap > floor ? start - overlap : floor;
    if (scanFrom > start) scanFrom = start;
    // A range the node did not serve is not asked for again before its backoff ends (unless the scan no longer reaches it).
    const blocked = this.state.logsUnavailable;
    if (blocked && scanFrom > BigInt(blocked.to)) this.state.logsUnavailable = undefined;
    else if (blocked && Date.now() < blocked.retryAtMs) throw this.historyUnavailable(blocked);

    // Carried over from earlier passes: a steady-state pass covers only a few blocks, too few to grow back on its own.
    let successes = chunk < max ? (this.state.logChunkSuccesses ?? 0) : 0;
    // A grown chunk not yet accepted at full width (`probing`); each time one is refused, the next growth waits for
    // twice as many successes (a provider with a fixed range cap is not asked for more every few passes).
    let growAfter = chunk < max ? (this.state.logChunkGrowAfter ?? GROW_AFTER) : GROW_AFTER;
    let probing = chunk < max && this.state.logChunkProbing === true;
    let transientFailures = 0;
    let unavailable = 0;
    let sincePersist = 0;
    let from = scanFrom;
    while (from <= head && !this.stopping) {
      const hi = chunkEnd(from, head, chunk);
      let logs;
      try {
        logs = await this.dms.switchCreatedLogs(from, hi);
      } catch (err) {
        const kind = classifyLogsError(errorInfo(err));
        if (kind === "unavailable") {
          if (unavailable++ < 2) {
            this.log(`getLogs ${from}-${hi}: the node does not have these blocks (${describeError(err)}); asking again`);
            continue; // at once: another backend of a load-balanced RPC may have them
          }
          const failures = blocked?.from === from.toString() ? blocked.failures + 1 : 1;
          const u = { from: from.toString(), to: hi.toString(), failures, retryAtMs: Date.now() + backoffMs(failures, this.wcfg.backoffBaseSec, this.wcfg.backoffMaxSec) };
          this.state.logsUnavailable = u;
          throw this.historyUnavailable(u);
        }
        if (kind === "transient" && !waitOnTransient) {
          this.log(`getLogs ${from}-${hi} failed (${describeError(err)}); retrying it after this pass's transactions`);
          return "later";
        }
        if (kind === "transient" && transientFailures < 5) {
          const wait = 1_000 * 2 ** transientFailures++;
          this.log(`getLogs ${from}-${hi} failed (${describeError(err)}); retrying the same range in ${wait / 1000}s`);
          await sleep(wait, this.stopSignal.signal);
          continue;
        }
        if (kind === "range" && chunk > 1n) {
          if (probing) growAfter = Math.min(growAfter * 2, MAX_GROW_AFTER);
          probing = false;
          chunk /= 2n;
          successes = 0;
          this.state.logChunkBlocks = chunk.toString();
          this.state.logChunkSuccesses = undefined;
          this.state.logChunkGrowAfter = growAfter !== GROW_AFTER ? growAfter : undefined;
          this.state.logChunkProbing = undefined;
          this.log(`getLogs ${from}-${hi} failed (${describeError(err)}); retrying with ${chunk}-block chunks`);
          continue;
        }
        throw err;
      }
      transientFailures = 0;
      unavailable = 0;
      if (this.state.logsUnavailable && hi >= BigInt(this.state.logsUnavailable.from)) this.state.logsUnavailable = undefined;
      for (const l of logs) {
        if (this.track(l.owner, l.id)) this.log(`discovered switch ${l.owner}/${l.id} (block ${l.blockNumber})`);
      }
      // A rescan never moves the high-water mark backwards.
      if (last === undefined || hi > BigInt(this.state.lastScannedBlock ?? -1)) this.state.lastScannedBlock = hi.toString();
      // The provider accepted this span (a doubled chunk only counts as accepted at its full width): grow back towards logChunkBlocks.
      if (probing && hi - from + 1n >= chunk) [probing, growAfter] = [false, GROW_AFTER];
      from = hi + 1n;
      if (chunk < max && ++successes >= growAfter) {
        chunk = chunk * 2n < max ? chunk * 2n : max;
        successes = 0;
        probing = chunk < max;
      }
      this.state.logChunkBlocks = chunk < max ? chunk.toString() : undefined;
      this.state.logChunkSuccesses = chunk < max && successes > 0 ? successes : undefined;
      this.state.logChunkGrowAfter = chunk < max && growAfter !== GROW_AFTER ? growAfter : undefined;
      this.state.logChunkProbing = probing || undefined;
      if (++sincePersist >= 20) {
        this.persist();
        sincePersist = 0;
      }
    }
    if (from > head) this.rescanFrom = undefined;
    return "done";
  }

  /** The configuration error for a range the node does not serve (logsUnavailable), naming the start block to fix. */
  private historyUnavailable(u: NonNullable<WatcherState["logsUnavailable"]>): ConfigError {
    return new ConfigError(
      `the RPC node does not serve blocks ${u.from}-${u.to} (pruned history), so discovery cannot pass them: set FROM_BLOCK ` +
        `(or fromBlock, --from-block, --rescan-from) to the contract's deploy block or later, on an RPC that still has the ` +
        `blocks from there on (an archive node keeps them all); discovery asks again in ${Math.max(0, Math.round((u.retryAtMs - Date.now()) / 1000))} s`,
    );
  }

  /**
   * Once per process, before anything is sent: warn when transactions this state file does not track hold the
   * signer's next nonces (the node's pending count is ahead of its mined one). Every transaction this watcher
   * sends is mined only after them, and it cannot re-price or free them.
   */
  private async warnUntrackedNonces(): Promise<void> {
    const [latest, pending] = await Promise.all([this.dms.nonce("latest"), this.dms.nonce("pending")]);
    const tracked = new Set(Object.values(this.state.switches).flatMap((t) => (t.pendingTx ? [t.pendingTx.nonce] : [])));
    const untracked: number[] = [];
    for (let n = latest; n < pending && untracked.length <= 10; n++) if (!tracked.has(n)) untracked.push(n);
    if (untracked.length === 0) return;
    const list = untracked.length > 10 ? `${untracked.slice(0, 10).join(", ")}, …` : untracked.join(", ");
    this.log(
      `WARNING: nonce${untracked.length > 1 ? "s" : ""} ${list} of this signer ${untracked.length > 1 ? "are" : "is"} pending but not tracked by ` +
        `${this.wcfg.stateFile} (${UNTRACKED_FROM}); every transaction this watcher sends is mined only after ${untracked.length > 1 ? "them" : "it"}`,
    );
  }

  /** One pass over everything. */
  async pass(): Promise<PassSummary> {
    const summary = emptySummary();
    this.decryptSpentMs = 0;
    if (!this.holdsLock()) {
      summary.errors.push(`lost ${this.wcfg.stateFile}.lock to another watcher`);
      return summary;
    }
    if (!this.noncesChecked) {
      this.noncesChecked = true;
      await this.warnUntrackedNonces().catch((err: unknown) => this.log(`could not compare the signer's pending and mined nonces: ${describeError(err)}`));
    }
    const discover = async (waitOnTransient: boolean): Promise<"done" | "later"> => {
      try {
        return await this.discover(waitOnTransient);
      } catch (err) {
        summary.errors.push(`discovery: ${describeError(err)}`);
        this.log(`discovery failed: ${describeError(err)}`);
        return "done";
      } finally {
        this.persist();
      }
    };
    // No waiting here: a transient provider error is retried after the transactions (4. below), which never wait on it.
    const discoverLater = this.wcfg.discover && (await discover(false)) === "later";
    if (this.stopping) return summary;
    this.chainTime = await this.dms.latestTimestamp();
    const all = Object.values(this.state.switches);
    const discovered = new Map(all.map((t, i) => [t, i]));
    /**
     * Switches whose next step sends a transaction, in the order they are handled: highest bounty first, so a
     * backlog of low-bounty switches (spam timed to go dark first, say) cannot hold up one worth more; at the same
     * bounty a reveal before a markDark, then discovery order. Each waits for its receipts, so the order matters.
     */
    const queue: { t: TrackedSwitch; info: SwitchInfo }[] = [];
    const ahead = (a: (typeof queue)[number], b: (typeof queue)[number]): boolean =>
      a.info.bounty !== b.info.bounty
        ? a.info.bounty > b.info.bounty
        : SEND_ORDER.indexOf(a.info.stateName) !== SEND_ORDER.indexOf(b.info.stateName)
          ? SEND_ORDER.indexOf(a.info.stateName) < SEND_ORDER.indexOf(b.info.stateName)
          : discovered.get(a.t)! < discovered.get(b.t)!;
    const polled = new Set<TrackedSwitch>();
    /** Read a switch and take every step that sends nothing; queue it if its next step sends a transaction. */
    const survey = async (t: TrackedSwitch) => {
      if (!polled.has(t)) summary.polled++;
      polled.add(t);
      const info = await this.processSwitch(t, summary, true);
      if (info) {
        const q = { t, info };
        const i = queue.findIndex((o) => ahead(q, o));
        queue.splice(i < 0 ? queue.length : i, 0, q);
      }
      this.persistSoon();
    };
    this.pausedMarks.clear();
    try {
      // 1. Transactions left pending by an earlier pass or process, in nonce order: once one's fees are raised, the
      //    next one is judged behind a transaction that is being mined, and is raised in the same pass, not the next.
      for (const t of all.filter((o) => o.pendingTx).sort((a, b) => a.pendingTx!.nonce - b.pendingTx!.nonce)) {
        if (this.stopping) break;
        await survey(t);
      }
      // 2. Every other switch that is due: one read, and whatever needs no transaction (waiting, archiving, done).
      //    Those still under an unprofitable or backoff verdict cannot send anything before it ends (unless their state
      //    moved): they are read after the transactions (3.), so a backlog of them does not delay any.
      const waiting: TrackedSwitch[] = [];
      const wallNow = Date.now();
      for (const t of all) {
        if (this.stopping) break;
        if (polled.has(t) || t.pendingTx || !shouldPoll(t, this.chainTime)) continue;
        if (wallNow < t.nextAttemptAtMs || wallNow < (t.profitRecheckAtMs ?? 0)) waiting.push(t);
        else await survey(t);
      }
      // 3. The transactions, in queue order; once it is empty, the waiting switches are read (and anything they send
      //    queued). Once blocks went by (something was sent, or a while passed), a switch that became due meanwhile
      //    (an ALIVE one past its deadline) is read and queued by the same order; so are the dark switches whose
      //    markDark was paused when they were read, once public decryption works again.
      let broadcasts = this.broadcasts;
      let readAtMs = Date.now();
      while (!this.stopping) {
        const next = queue.shift();
        if (!next) {
          const t = waiting.shift();
          if (!t) break;
          await survey(t);
          continue;
        }
        await this.processSwitch(next.t, summary);
        this.persistSoon();
        if (this.pausedMarks.size > 0 && !this.markDarkPaused()) {
          const paused = [...this.pausedMarks];
          this.pausedMarks.clear();
          for (const t of paused) if (!this.stopping && !queue.some((q) => q.t === t)) await survey(t);
        }
        if (this.broadcasts === broadcasts && Date.now() - readAtMs < RECHECK_EVERY_MS) continue;
        [broadcasts, readAtMs] = [this.broadcasts, Date.now()];
        const before = this.chainTime;
        try {
          const now = await this.dms.latestTimestamp();
          if (now <= before) continue; // no new block yet (or a node behind the last one read)
          this.chainTime = now;
        } catch {
          continue; // the next switch is handled anyway; the time is read again after it
        }
        for (const t of all) {
          if (this.stopping) break;
          if (!t.pendingTx && shouldPoll(t, this.chainTime) && !shouldPoll(t, before) && !queue.some((q) => q.t === t)) await survey(t);
        }
      }
      // 4. A discovery cut short by a transient provider error, retried (with its waits) now that nothing waits on it.
      //    Switches it finds are handled next pass.
      if (discoverLater && !this.stopping) await discover(true);
    } finally {
      // Everything that changed during the pass, in one write.
      this.persist();
    }
    return summary;
  }

  /** Whether markDark is paused because public decryption fails for a reason a retry cannot fix (decryptBroken). */
  private markDarkPaused(): boolean {
    const broken = this.state.decryptBroken;
    return broken !== undefined && Date.now() < broken.untilMs;
  }

  private fail(t: TrackedSwitch, what: string, err: unknown, summary: PassSummary, countAsError = true, minWaitMs = 0): void {
    t.attempts++;
    t.lastError = `${what}: ${describeError(err)}`;
    const wait = Math.max(backoffMs(t.attempts, this.wcfg.backoffBaseSec, this.wcfg.backoffMaxSec), minWaitMs);
    t.nextAttemptAtMs = Date.now() + wait;
    this.log(`${this.tag(t)}: ${t.lastError}; attempt ${t.attempts}, retrying in ${Math.round(wait / 1000)}s`);
    (countAsError ? summary.errors : summary.pending).push(`${trackKey(t.owner, t.id)}: ${t.lastError}`);
  }

  private succeeded(t: TrackedSwitch): void {
    t.attempts = 0;
    t.nextAttemptAtMs = 0;
    t.profitRecheckAtMs = undefined;
    t.lastError = undefined;
    t.note = undefined;
  }

  private unprofitable(t: TrackedSwitch, note: string, summary: PassSummary): void {
    t.note = note;
    t.profitRecheckAtMs = Date.now() + this.wcfg.unprofitableRecheckSec * 1000;
    this.log(`${this.tag(t)}: ${note}`);
    summary.unprofitable.push(`${trackKey(t.owner, t.id)}: ${note}`);
  }

  private profit(bountyWei: bigint, gasUnits: bigint, fees: Fees, extraCostWei?: bigint) {
    return assessProfit({
      bountyWei,
      gasUnits,
      gasPriceWei: fees.maxFeePerGas,
      extraCostWei,
      safetyFactor: this.wcfg.safetyFactor,
      minProfitWei: this.wcfg.minProfitWei,
      altruistic: this.wcfg.altruistic,
      maxGasPriceWei: this.wcfg.maxGasPriceWei,
    });
  }

  /** Run a KMS request or retry wait, charging its duration to this pass's decryptPassBudgetSec. */
  private async onKmsClock<T>(f: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await f();
    } finally {
      this.decryptSpentMs += Date.now() - t0;
    }
  }

  /** The relayer's Retry-After (HTTP 429), capped at backoffMaxSec so a hostile or buggy relayer cannot park a switch; undefined if none or not a number. */
  private retryAfterMs(err: unknown): number | undefined {
    const sec = err instanceof FhevmError ? err.retryAfterSec : undefined;
    return sec !== undefined && Number.isFinite(sec) && sec >= 0 ? Math.min(sec, this.wcfg.backoffMaxSec) * 1000 : undefined;
  }

  private async fetchKey(t: TrackedSwitch, handle: Hex): Promise<DecryptedDek> {
    const fhe = await this.fhevm();
    const budgetLeftMs = () => this.wcfg.decryptPassBudgetSec * 1000 - this.decryptSpentMs;
    let last: unknown;
    for (let i = 0; i < this.wcfg.decryptAttemptsPerPass; i++) {
      const budgetMs = budgetLeftMs();
      if (budgetMs < 1_000) {
        if (i === 0) throw new Deferred("KMS time budget for this pass (decryptPassBudgetSec) is used up; next pass");
        break;
      }
      const request = () =>
        this.onKmsClock(() => fhe.publicDecryptDek(handle, { timeoutMs: Math.min(this.wcfg.decryptTimeoutSec * 1000, budgetMs), signal: this.stopSignal.signal }));
      try {
        return await request().catch(async (err: unknown) => {
          // One "no route" answer can be an edge reloading its routes for a second or two: ask again
          // NO_ROUTE_RECHECK_MS later, and only a second one pauses markDark. With no budget left for that wait,
          // this answer alone is not taken as final.
          if (!(err instanceof FhevmError && err.noRoute) || this.stopping) throw err;
          if (budgetLeftMs() < NO_ROUTE_RECHECK_MS + 1_000) throw new FhevmError(err.message, { cause: err });
          this.log(`${this.tag(t)}: the relayer has no route for the request; asking again in ${NO_ROUTE_RECHECK_MS / 1000}s`);
          await this.onKmsClock(() => sleep(NO_ROUTE_RECHECK_MS, this.stopSignal.signal));
          if (this.stopping) throw err;
          return request();
        });
      } catch (err) {
        if (this.stopping) throw new Deferred("stopping");
        if (isFatalDecrypt(err)) throw err;
        last = err;
        if (i + 1 < this.wcfg.decryptAttemptsPerPass) {
          // Honour the relayer's Retry-After (HTTP 429), but never past this pass's budget.
          const wait = this.retryAfterMs(err) ?? 2_000 * (i + 1);
          if (wait >= budgetLeftMs()) break;
          await this.onKmsClock(() => sleep(wait, this.stopSignal.signal));
        }
      }
    }
    this.log(`${this.tag(t)}: KMS has not served the key yet`);
    throw last;
  }

  // ---------- Transactions ---------- //

  /** Bookkeeping for a mined, successful action. */
  private mined(t: TrackedSwitch, kind: TxKind, tx: TxResult, summary: PassSummary): void {
    const k = trackKey(t.owner, t.id);
    this.succeeded(t);
    const block = tx.receipt.blockNumber;
    if (t.bookedBlock === undefined || block < BigInt(t.bookedBlock)) t.bookedBlock = block.toString();
    switch (kind) {
      case "markDark":
        t.markDarkTx = tx.hash;
        summary.markedDark.push(k);
        this.log(`${this.tag(t)}: markDark ${tx.hash} mined (gas ${tx.receipt.gasUsed})`);
        break;
      case "revealKey": {
        const ev = findEvent(tx, "KeyRevealed");
        t.revealTx = tx.hash;
        t.revealedByUs = true;
        summary.revealed.push(k);
        if (t.keyMismatch && !summary.keyMismatches.includes(k)) summary.keyMismatches.push(k);
        this.log(`${this.tag(t)}: revealKey ${tx.hash}; bounty ${fmtEth(ev?.args.bountyPaid ?? 0n)} (gas ${tx.receipt.gasUsed})`);
        break;
      }
      case "publishPlaintext":
        t.publishTx = tx.hash;
        summary.published.push(k);
        this.log(`${this.tag(t)}: publishPlaintext ${tx.hash} (gas ${tx.receipt.gasUsed})`);
        break;
    }
  }

  /** Our transaction lost to someone else's: record it, it is not an error. */
  private lostRace(t: TrackedSwitch, kind: TxKind, hash: Hex, errorName: string, gasUsed: bigint | undefined, summary: PassSummary): void {
    (t.lostRaces ??= []).push({ action: kind, hash, errorName, ...(gasUsed !== undefined ? { gasUsed: gasUsed.toString() } : {}), at: new Date().toISOString() });
    const msg = `lost the ${kind} race: ${hash} ${gasUsed !== undefined ? `reverted on-chain with ${errorName} (gas ${gasUsed})` : `was cancelled (${errorName})`}`;
    this.log(`${this.tag(t)}: ${msg}; re-reading the switch`);
    summary.lostRaces.push(`${trackKey(t.owner, t.id)}: ${msg}`);
  }

  /**
   * Whether a switch's last state (revealed [and published], or cancelled) is final: the same at the "finalized"
   * block, which no reorganisation changes any more. Until then the switch is not terminal and is read again each
   * pass, so a reorganisation that drops a reveal (ours or anyone's), a publish or a cancel is noticed and the
   * switch handled from its new state. Once final, what was booked for it is checked (settleBooked). Local Anvil:
   * final at once.
   */
  private async isFinal(t: TrackedSwitch, info: SwitchInfo, what: string, summary: PassSummary): Promise<boolean> {
    if (this.cfg.chainId === 31337) return true;
    try {
      const fin = await this.dms.info(t.owner, BigInt(t.id), "finalized");
      if (fin.stateName !== info.stateName || fin.published !== info.published) {
        const note = `${what}; not final yet, read again until the finalized block shows it`;
        if (t.note !== note) this.log(`${this.tag(t)}: ${note}`);
        t.note = note;
        return false;
      }
      await this.settleBooked(t, info, summary);
    } catch (err) {
      this.fail(t, "finality check", err, summary);
      return false;
    }
    t.note = undefined;
    if (!info.published) t.published = undefined;
    return true;
  }

  /**
   * For a switch whose outcome is final: check each transaction booked for it (from its first receipt) on the
   * final chain. Its receipt there decides: mined and successful, it stands; reverted (a reorganisation put it
   * behind a competitor's), it is a lost race. No receipt alone proves nothing (the node answering may lack it):
   * the action's event on the final chain decides. If it names this watcher, the booking stands, moved to that
   * event's transaction (a reorganisation can include an earlier broadcast of the same nonce instead of its
   * replacement); if it names someone else, the action was theirs. Without an event to go by, the booking is
   * kept. Then the archive record is brought in line.
   */
  private async settleBooked(t: TrackedSwitch, info: SwitchInfo, summary: PassSummary): Promise<void> {
    const booked: [TxKind, Hex | undefined][] = [
      ["markDark", t.markDarkTx],
      ["revealKey", t.revealTx],
      ["publishPlaintext", t.publishTx],
    ];
    const book = (kind: TxKind, hash: Hex | undefined) => {
      if (kind === "markDark") t.markDarkTx = hash;
      else if (kind === "publishPlaintext") t.publishTx = hash;
      else [t.revealTx, t.revealedByUs] = [hash, hash !== undefined];
    };
    for (const [kind, hash] of booked) {
      if (!hash) continue;
      let reverted: TxRevertedError | undefined;
      try {
        if (await this.dms.txOutcome(kind, hash)) continue; // mined, and still succeeds
      } catch (err) {
        if (!(err instanceof TxRevertedError)) throw err;
        reverted = err;
      }
      if (reverted) {
        book(kind, undefined);
        this.log(`${this.tag(t)}: WARNING: ${kind} ${hash} was booked from its first receipt, but on the final chain it reverted (${reverted.errorName ?? "?"})${kind === "revealKey" ? "; its bounty was not earned" : ""}`);
        this.lostRace(t, kind, hash, reverted.errorName ?? "?", reverted.gasUsed, summary);
        continue;
      }
      let action: SwitchAction | undefined;
      try {
        action = await this.finalAction(t, kind);
        t.eventSearchFailures = undefined;
      } catch (err) {
        // Searched again next pass (an error this one); after MAX_EVENT_SEARCHES failures, there is no event to go by.
        const failures = (t.eventSearchFailures ?? 0) + 1;
        t.eventSearchFailures = failures < MAX_EVENT_SEARCHES ? failures : undefined;
        if (failures < MAX_EVENT_SEARCHES) throw err;
        this.log(`${this.tag(t)}: WARNING: ${kind} ${hash}: no receipt, and the search for its event failed ${failures} times (${describeError(err)}); kept as booked`);
        continue;
      }
      if (!action) {
        this.log(`${this.tag(t)}: ${kind} ${hash}: the node serves no receipt for it, and no ${kind} event was found; kept as booked`);
      } else if (action.actor === this.dms.signer) {
        if (action.hash !== hash) {
          book(kind, action.hash);
          this.log(`${this.tag(t)}: ${kind} ${hash} is not mined on the final chain; ${action.hash}, sent at its nonce, is: booked that instead`);
        }
      } else {
        book(kind, undefined);
        this.log(
          `${this.tag(t)}: WARNING: ${kind} ${hash} is not mined on the final chain: ${kind} ${action.hash} by ${action.actor} is` +
            `${kind === "revealKey" ? "; its bounty was not earned" : ""}`,
        );
      }
    }
    if (t.saved) this.amendArchive(t, info.revealedKey);
  }

  /**
   * The final chain's event for a switch's markDark / revealKey / publish (at most one): searched from
   * REORG_OVERLAP_BLOCKS below the first receipt booked for the switch (where a reorganisation can have moved it
   * from) to the head (searchAction). The switch's state is final by then, so no later event can contradict one
   * found above the finalized block. Undefined: none found, or nothing to search from.
   */
  private async finalAction(t: TrackedSwitch, kind: TxKind): Promise<SwitchAction | undefined> {
    if (t.bookedBlock === undefined) return undefined;
    const lowest = BigInt(t.bookedBlock) - REORG_OVERLAP_BLOCKS;
    return this.searchAction(t, kind, lowest > 0n ? lowest : 0n, await this.dms.blockNumber());
  }

  /**
   * The event of a switch's `kind` action in [from, to], if any, in discovery's working chunk size: halved on a
   * range error, a range the node does not serve (pruned history) asked for again once. Other failures throw.
   */
  private async searchAction(t: TrackedSwitch, kind: SwitchActionKind, from: bigint, to: bigint): Promise<SwitchAction | undefined> {
    let chunk = this.state.logChunkBlocks !== undefined ? BigInt(this.state.logChunkBlocks) : this.wcfg.logChunkBlocks;
    let unavailable = 0;
    while (from <= to) {
      const hi = chunkEnd(from, to, chunk);
      let found: SwitchAction[];
      try {
        found = await this.dms.actionLogs(kind, t.owner, BigInt(t.id), from, hi);
      } catch (err) {
        const why = classifyLogsError(errorInfo(err));
        if (why === "range" && chunk > 1n) {
          chunk /= 2n;
          continue;
        }
        if (why === "unavailable" && unavailable++ < 1) continue;
        throw err;
      }
      if (found[0]) return found[0];
      unavailable = 0;
      from = hi + 1n;
    }
    return undefined;
  }

  /**
   * Broadcast an action, record it in the state file *before* waiting, then
   * wait up to txReceiptTimeoutSec. "pending" = still unmined (the next pass
   * resolves it); "race" = it reverted because someone else got there first;
   * "void" = a transaction the watcher did not send took its nonce.
   * `pays`: the bounty of a markDark / revealKey and the gas its profit check
   * counted. `gasLimit`: the call's own gas estimate, sent as is (no second
   * estimate).
   */
  private async submit(
    t: TrackedSwitch,
    kind: TxKind,
    args: readonly unknown[],
    fees: Fees,
    summary: PassSummary,
    pays?: { bounty: bigint; gas: bigint },
    gasLimit?: bigint,
  ): Promise<"mined" | "pending" | "race" | "void"> {
    // Nonces are mined in order: a transaction held back at its own fees would hold this one up too.
    // It is freed first if this one's bounty pays for that as well (resolvePending); otherwise this one waits behind it.
    if (pays) {
      const next: Payer = { what: `the ${kind} about to be sent for ${this.tag(t)}`, bounty: pays.bounty, gas: pays.gas, fees };
      // In nonce order: freeing one lets the next be judged as next to be mined.
      const held = Object.values(this.state.switches).filter((o) => o !== t && o.pendingTx?.heldBack);
      held.sort((a, b) => a.pendingTx!.nonce - b.pendingTx!.nonce);
      for (const o of held) {
        if (!o.pendingTx?.heldBack) continue;
        try {
          await this.resolvePending(o, summary, next);
        } catch (err) {
          this.fail(o, `pending ${o.pendingTx?.kind ?? "transaction"}`, err, summary);
        }
      }
    }
    this.assertLock();
    const sent = await this.dms.send(kind, args, { fees, gas: gasLimit });
    this.broadcasts++;
    t.pendingTx = {
      kind,
      hashes: [sent.hash],
      nonce: sent.nonce,
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      sentAtMs: Date.now(),
      ...(pays ? { profitGas: pays.gas.toString() } : {}),
    };
    this.persist();
    this.log(`${this.tag(t)}: ${kind} sent ${sent.hash} (nonce ${sent.nonce}, max fee ${formatGwei(fees.maxFeePerGas)} gwei)`);
    let tx: TxResult;
    try {
      tx = await this.dms.waitFor(kind, sent.hash, this.wcfg.txReceiptTimeoutSec * 1000);
    } catch (err) {
      if (err instanceof TxTimeoutError) {
        const msg = `${kind} ${sent.hash} not mined after ${this.wcfg.txReceiptTimeoutSec}s; checking it again next pass (replaced with higher fees if still pending)`;
        this.log(`${this.tag(t)}: ${msg}`);
        summary.pending.push(`${trackKey(t.owner, t.id)}: ${msg}`);
        return "pending";
      }
      if (err instanceof TxReplacedError) {
        // The nonce went to someone else's transaction from this key (a wallet's "cancel"): ours never ran.
        this.log(`${this.tag(t)}: ${err.message}; re-reading the switch`);
        this.forgetPending(t);
        return "void";
      }
      if (err instanceof TxRevertedError) {
        t.pendingTx = undefined;
        if (isRace(err)) {
          this.lostRace(t, kind, err.hash, err.errorName ?? "?", err.gasUsed, summary);
          return "race";
        }
      }
      // Anything else (e.g. the RPC failed while polling): keep pendingTx so the next pass resolves it.
      throw err;
    }
    t.pendingTx = undefined;
    this.mined(t, kind, tx, summary);
    return "mined";
  }

  /** Whether one of the pending transaction's broadcasts has a receipt; handles it if so. */
  private async settlePending(t: TrackedSwitch, p: PendingTx, summary: PassSummary): Promise<boolean> {
    const latest = p.hashes.length - 1;
    // Every broadcast from the first self-transfer on is a cancel (older state files only mark the latest one).
    const cancelFrom = p.cancelFrom ?? (p.cancelled !== undefined ? latest : p.hashes.length);
    for (let i = latest; i >= 0; i--) {
      const isCancel = i >= cancelFrom;
      let tx: TxResult | undefined;
      try {
        tx = await this.dms.txOutcome(isCancel ? "cancel" : p.kind, p.hashes[i]);
      } catch (err) {
        if (!(err instanceof TxRevertedError)) throw err;
        t.pendingTx = undefined;
        if (!isRace(err)) throw err;
        this.lostRace(t, p.kind, err.hash, err.errorName ?? "?", err.gasUsed, summary);
        return true;
      }
      if (!tx) continue;
      t.pendingTx = undefined;
      if (!isCancel) this.mined(t, p.kind, tx, summary);
      else if (p.cancelled !== undefined) this.lostRace(t, p.kind, tx.hash, p.cancelled, undefined, summary);
      else {
        // Freed by resolvePending because it no longer paid and held up later transactions: given up, not lost.
        this.forgetPending(t);
        this.log(`${this.tag(t)}: self-transfer ${tx.hash} took nonce ${p.nonce}; ${p.kind} given up, re-reading the switch`);
      }
      return true;
    }
    return false;
  }

  /** The pending tx is gone without a receipt of its own (void, dropped, given up): so is anything noted about it. */
  private forgetPending(t: TrackedSwitch): void {
    this.forgotten++;
    t.pendingTx = undefined;
    t.note = undefined;
    t.profitRecheckAtMs = undefined;
  }

  /**
   * settlePending; failing that, a nonce already used on-chain means a
   * transaction the watcher did not send took it, and ours is void.
   */
  private async settledOrVoid(t: TrackedSwitch, p: PendingTx, summary: PassSummary): Promise<boolean> {
    if (await this.settlePending(t, p, summary)) return true;
    if ((await this.dms.nonce("latest")) <= p.nonce) return false;
    if (await this.settlePending(t, p, summary)) return true; // mined between the two reads
    this.log(`${this.tag(t)}: nonce ${p.nonce} was taken by a transaction the watcher did not send; ${p.kind} ${p.hashes[p.hashes.length - 1]} is void`);
    this.forgetPending(t);
    return true;
  }

  /**
   * Why a nonce in front of `p`'s is not being mined, if one is not: a nonce the watcher has no transaction for
   * (a gap: dropped; or held by a transaction this state file does not track, `untracked`), one whose
   * transaction the node no longer knows (dropped, though the state file still has it), or one priced below the
   * latest base fee (held back or not; without a base fee, a held-back one). Undefined when `p` is next, or
   * behind transactions that are being mined.
   */
  private async notMinedInFront(t: TrackedSwitch, p: PendingTx): Promise<{ reason: string; untracked?: true } | undefined> {
    const latest = await this.dms.nonce("latest");
    if (latest >= p.nonce) return undefined;
    const byNonce = new Map<number, TrackedSwitch>();
    for (const o of Object.values(this.state.switches)) if (o !== t && o.pendingTx) byNonce.set(o.pendingTx.nonce, o);
    const base = await this.dms.latestBaseFee();
    for (let n = latest; n < p.nonce; n++) {
      const o = byNonce.get(n);
      const q = o?.pendingTx;
      if (!o || !q) {
        // The node's pending count includes nonce n: some transaction holds it, one this state file has no record of.
        if ((await this.dms.nonce("pending")) > n) {
          return { reason: `nonce ${n} in front of it is held by a transaction that ${this.wcfg.stateFile} does not track (${UNTRACKED_FROM})`, untracked: true };
        }
        return { reason: `nonce ${n} in front of it is not one the watcher is waiting on (dropped, or another sender's)` };
      }
      if (!(await this.dms.knowsTx(q.hashes[q.hashes.length - 1]))) return { reason: `nonce ${n} in front of it is a transaction the node dropped (${this.tag(o)})` };
      if (base !== undefined ? BigInt(q.maxFeePerGas) >= base : !q.heldBack) continue;
      return { reason: q.heldBack ? `nonce ${n} in front of it is held back (${this.tag(o)})` : `nonce ${n} in front of it (${this.tag(o)}) is priced below the base fee` };
    }
    return undefined;
  }

  /**
   * The switch reads as being in an earlier `state` than its last one, `before`. States only move forward on one
   * chain: this is a reorganisation, or a read from a node behind the one read before (a load-balanced RPC), and
   * acting on the latter sends a transaction that can only revert. It is the latter when what moved the switch to
   * `before` is still on the chain: a transaction of ours booked for it (mined, or known to the node); `before`
   * (or later) at the finalized block, which no reorganisation reaches; or its event (KeyRevealed,
   * SwitchDarkMarked, SwitchCancelled) between the finalized block and the head, whoever sent it. Says which, if
   * one is. A failure to read the finalized state or the events counts as not found: the read is taken as it is
   * (at worst, a race lost).
   */
  private async staleRead(t: TrackedSwitch, before: StateName, state: StateName): Promise<string | undefined> {
    const at = STATE_NAMES.indexOf(state);
    const booked: [TxKind, Hex | undefined][] = [
      ["revealKey", at < STATE_NAMES.indexOf("REVEALED") && t.revealedByUs ? t.revealTx : undefined],
      ["markDark", at < STATE_NAMES.indexOf("DARK_MARKED") ? t.markDarkTx : undefined],
    ];
    for (const [kind, hash] of booked) {
      if (!hash) continue;
      try {
        if (await this.dms.txOutcome(kind, hash)) return `its ${kind} ${hash} is mined`;
      } catch (err) {
        if (!(err instanceof TxRevertedError)) throw err;
        return `its ${kind} ${hash} is mined`; // reverted, but in a block the node read had not reached
      }
      if (await this.dms.knowsTx(hash)) return `its ${kind} ${hash} is still known to the node`;
    }
    const kind: SwitchActionKind | undefined = before === "REVEALED" ? "revealKey" : before === "DARK_MARKED" ? "markDark" : before === "CANCELLED" ? "cancel" : undefined;
    try {
      const fin = (await this.dms.info(t.owner, BigInt(t.id), "finalized")).stateName;
      const atLeast = fin === before || (fin !== "CANCELLED" && before !== "CANCELLED" && STATE_NAMES.indexOf(fin) >= STATE_NAMES.indexOf(before));
      if (atLeast) return `the finalized block shows it ${fin}`;
      if (kind) {
        const [finalized, head] = await Promise.all([this.dms.finalizedBlock(), this.dms.blockNumber()]);
        const action = await this.searchAction(t, kind, finalized, head);
        if (action) return `${kind} ${action.hash} by ${action.actor} is in block ${action.blockNumber}`;
      }
    } catch (err) {
      this.log(`${this.tag(t)}: could not check whether the read of ${state} is behind (${describeError(err)}); taking it as it is`);
    }
    return undefined;
  }

  /** A pending publishPlaintext would now revert: the switch is published already (or no longer revealed). */
  private async publishWouldRevert(t: TrackedSwitch): Promise<boolean> {
    const info = await this.dms.info(t.owner, BigInt(t.id));
    return info.stateName !== "REVEALED" || info.published;
  }

  /** Gas units a pending markDark / revealKey's profit check counts. */
  private gasOf(q: PendingTx): bigint {
    return q.profitGas !== undefined ? BigInt(q.profitGas) : this.wcfg.revealGasEstimate;
  }

  /** What a pending transaction was allowed to cost when it was sent (its bounty covered that): gas × its max fee. */
  private allowedWei(q: PendingTx): bigint {
    return (isAction(q) ? this.gasOf(q) : SELF_TRANSFER_GAS) * BigInt(q.maxFeePerGas);
  }

  /**
   * Whether anything behind `p`'s nonce might pay for freeing it, judged from the state file and the node's
   * pending nonce alone: `next`; another switch's pending markDark / revealKey (held back or not: a held-back one
   * may still be mined at its own fees once `p`'s nonce is freed, which freeingPays judges); or a transaction the
   * watcher did not send (`untracked`: the node's pending nonce is past every tracked one).
   */
  private async mayWaitBehind(t: TrackedSwitch, p: PendingTx, next?: Payer): Promise<{ untracked: boolean } | undefined> {
    const others = Object.values(this.state.switches).flatMap((o) => (o !== t && o.pendingTx ? [o.pendingTx] : []));
    const untracked = (await this.dms.nonce("pending")) > Math.max(p.nonce, ...others.map((q) => q.nonce)) + 1;
    return untracked || next || others.some((q) => q.nonce > p.nonce && isAction(q)) ? { untracked } : undefined;
  }

  /**
   * Whether freeing `p`'s nonce (a self-transfer at `freeFees`) gets a later transaction mined that pays for it.
   * The other pending transactions are judged at the current `market` fees, each at the fees it would be mined at
   * (its own when they are at the market rate or still cover the latest base fee, so it is mined at them once the
   * nonces in front are freed; else its replacement fees): a markDark / revealKey whose bounty
   * covers its gas there is a payer; one whose bounty does not, or a self-transfer that gave one up, blocks the
   * nonces behind it unless already at the market rate; anything else (publishPlaintext, a cancel, a call that
   * would now revert) is mined at market fees and earns nothing. A payer behind `p`, or `next`, must cover its own
   * gas plus a self-transfer for every blocking nonce in front of it (`p` included), by the safetyFactor /
   * minProfitEth rule; fees stay capped by maxGasPriceGwei. A transaction the watcher did not send cannot be
   * valued: for one, each of those self-transfers may cost no more than its own nonce's transaction was allowed to
   * cost when sent. Returns what waits, for the log.
   */
  private async freeingPays(t: TrackedSwitch, p: PendingTx, freeFees: Fees, market: Fees, untracked: boolean, next?: Payer): Promise<string | undefined> {
    const payers: Payer[] = next ? [next] : [];
    const blocking: { nonce: number; costWei?: bigint; allowedWei: bigint }[] = [
      { nonce: p.nonce, costWei: SELF_TRANSFER_GAS * freeFees.maxFeePerGas, allowedWei: this.allowedWei(p) },
    ];
    const base = await this.dms.latestBaseFee();
    for (const o of Object.values(this.state.switches)) {
      const q = o.pendingTx;
      if (o === t || !q || !(isAction(q) || gaveUp(q))) continue;
      const own = feesOf(q);
      const atMarket = own.maxFeePerGas >= market.maxFeePerGas && own.maxPriorityFeePerGas >= market.maxPriorityFeePerGas;
      // Includable at its own fees: once the nonces in front are freed it is mined at them, not re-priced.
      const includable = atMarket || (base !== undefined && own.maxFeePerGas >= base);
      const fees = includable ? own : replacementFees(own, market, this.wcfg.maxGasPriceWei);
      if (isAction(q)) {
        const info = await this.dms.info(o.owner, BigInt(o.id));
        if (info.stateName !== (q.kind === "markDark" ? "DARK" : "DARK_MARKED")) continue; // would revert: freed at market fees
        if (fees && this.profit(info.bounty, this.gasOf(q), fees).ok) {
          payers.push({ what: `${q.kind} ${q.hashes[q.hashes.length - 1]} of ${this.tag(o)}`, nonce: q.nonce, bounty: info.bounty, gas: this.gasOf(q), fees });
          continue;
        }
      }
      if (!includable) blocking.push({ nonce: q.nonce, costWei: fees && SELF_TRANSFER_GAS * fees.maxFeePerGas, allowedWei: this.allowedWei(q) });
    }
    for (const w of payers) {
      if (w.nonce !== undefined && w.nonce < p.nonce) continue;
      const before = blocking.filter((b) => w.nonce === undefined || b.nonce < w.nonce);
      if (before.some((b) => b.costWei === undefined)) continue; // maxGasPriceGwei leaves no room to free one of them
      if (this.profit(w.bounty, w.gas, w.fees, before.reduce((sum, b) => sum + b.costWei!, 0n)).ok) return w.what;
    }
    if (untracked && blocking.every((b) => b.costWei !== undefined && b.costWei <= b.allowedWei)) return "a transaction the watcher did not send";
    return undefined;
  }

  /**
   * A transaction from an earlier pass (or process) has no known outcome:
   * use its receipt if it was mined; wait while it is younger than
   * txReceiptTimeoutSec; otherwise replace it (same nonce, fees +12.5% or the
   * market rate, capped by maxGasPriceGwei). A markDark / revealKey is only
   * re-sent while the bounty still pays for it at the new fees. Otherwise it is
   * held back: it stays pending at its own fees and can still be mined. Not
   * when the node has dropped it (then the switch is re-read, and sent afresh
   * at market fees if that pays), and not when something waits behind its
   * nonce that pays for freeing it (freeingPays; `next` is a transaction about
   * to be sent): nonces are mined in order, so its nonce is then freed with a
   * 0-value self-transfer at the replacement fees and the action is given up.
   * The fees of such a self-transfer are raised later only on the same terms.
   */
  private async resolvePending(t: TrackedSwitch, summary: PassSummary, next?: Payer): Promise<"wait" | "resolved"> {
    const p = t.pendingTx!;
    const k = trackKey(t.owner, t.id);
    const current = p.hashes[p.hashes.length - 1];
    const cancelling = p.cancelFrom !== undefined || p.cancelled !== undefined;
    const what = cancelling ? `self-transfer ${current} (cancelling ${p.kind})` : `${p.kind} ${current}`;
    if (await this.settledOrVoid(t, p, summary)) return "resolved";
    const ageSec = Math.round((Date.now() - p.sentAtMs) / 1000);
    if (ageSec < this.wcfg.txReceiptTimeoutSec) {
      summary.pending.push(`${k}: ${what} pending for ${ageSec}s`);
      return "wait";
    }
    // A replacement re-sends the call while the switch is still in the state it applies to (otherwise
    // replace() frees the nonce with a self-transfer, which needs no profit check): it must still pay.
    let bounty: bigint | undefined;
    /** The call would now revert (the state moved on): replace() then frees the nonce with a self-transfer. */
    let wouldRevert = false;
    if (isAction(p)) {
      const info = await this.dms.info(t.owner, BigInt(t.id));
      if (info.stateName === (p.kind === "markDark" ? "DARK" : "DARK_MARKED")) bounty = info.bounty;
      else wouldRevert = true;
    }
    // Held back below unless higher fees pay: for the action, its bounty; for a self-transfer that gave one up, what waits behind it.
    const holdable = bounty !== undefined || gaveUp(p);
    if (!holdable) {
      // Nothing (a publishPlaintext, a cancel) pays for raising the fees of a transaction that cannot be mined before a held-back nonce.
      const held = Object.values(this.state.switches).find((o) => o !== t && o.pendingTx?.heldBack && o.pendingTx.nonce < p.nonce);
      if (held) {
        const msg = `${what} pending for ${ageSec}s; not raising its fees while nonce ${held.pendingTx!.nonce} in front of it is held back (${this.tag(held)})`;
        this.log(`${this.tag(t)}: ${msg}`);
        summary.pending.push(`${k}: ${msg}`);
        return "wait";
      }
    }
    // The node may have dropped it (a restart without a journal, an eviction). Nothing below would notice
    // (only replace() does, and it is not reached while the fees stay put): re-read the switch and start over,
    // which also refills the nonce for whatever waits behind it.
    if (!(await this.dms.knowsTx(current))) {
      if (await this.settledOrVoid(t, p, summary)) return "resolved"; // mined since the first check
      this.log(`${this.tag(t)}: ${what} was dropped from the mempool; re-reading the switch`);
      this.forgetPending(t);
      return "resolved";
    }
    // Whether it holds up a later transaction that pays for freeing it.
    const behind = holdable ? await this.mayWaitBehind(t, p, next) : undefined;
    if (holdable && !behind && t.profitRecheckAtMs !== undefined && Date.now() < t.profitRecheckAtMs) {
      summary.unprofitable.push(`${k}: ${t.note ?? `not replacing ${what}: unprofitable at current fees`}`);
      return "wait";
    }
    const waiting = (why: string, warn = false): "wait" => {
      const msg = `${what} pending for ${ageSec}s; ${why}`;
      this.log(`${this.tag(t)}: ${warn ? "WARNING: " : ""}${msg}`);
      summary.pending.push(`${k}: ${msg}`);
      return "wait";
    };
    // Nonces are mined in order: while one in front of it is not being mined, no fee gets this one mined,
    // and every raise would apply once it is (also to freeing it, which would only waste a self-transfer).
    const blocked = await this.notMinedInFront(t, p);
    if (blocked) {
      // Left at its own fees like any held-back transaction: what comes behind it waits too, and a payer
      // sent later frees it (submit) once the nonces in front of it are freed. A transaction the watcher does
      // not track cannot be re-priced or freed by it (its fees are unknown): the operator has to act.
      p.heldBack = true;
      return waiting(`not raising its fees: ${blocked.reason}`, blocked.untracked);
    }
    const market = await this.dms.fees();
    const fees = replacementFees(feesOf(p), market, this.wcfg.maxGasPriceWei);
    if (!fees) return waiting("maxGasPriceGwei leaves no room to raise its fees, waiting");
    // Nothing pays for a publishPlaintext or for a self-transfer freeing the nonce of a call that would revert:
    // their fees follow the market up, and never go past it (+12.5% a pass would compound without bound). A raise
    // above the market's max fee is allowed when the market's tip has risen past this one's (the max fee has to
    // rise with the tip), or to turn a call that would now revert into a self-transfer.
    const tipBehind = market.maxPriorityFeePerGas > BigInt(p.maxPriorityFeePerGas);
    if (
      !holdable &&
      fees.maxFeePerGas > market.maxFeePerGas &&
      !tipBehind &&
      !(wouldRevert || (p.kind === "publishPlaintext" && !cancelling && (await this.publishWouldRevert(t))))
    ) {
      return waiting(`not raising its fees above the market rate (${formatGwei(market.maxFeePerGas)} gwei): it earns nothing, so it is re-priced only when the market moves up`);
    }
    /** The action is given up (its nonce freed instead of the call re-sent): why, and what waits behind it. */
    let giveUp: { reason: string; waiting: string } | undefined;
    if (holdable) {
      const pr = bounty !== undefined ? this.profit(bounty, this.gasOf(p), fees) : undefined;
      if (!pr?.ok) {
        // Its own max fee covers the latest base fee again: nothing holds it up, so freeing its nonce would only
        // waste a self-transfer. It stays held back and is mined at its own fees.
        const base = behind ? await this.dms.latestBaseFee() : undefined;
        const minable = base !== undefined && BigInt(p.maxFeePerGas) >= base;
        const waiting = behind && !minable && (await this.freeingPays(t, p, fees, market, behind.untracked, next));
        if (!waiting) {
          if (next) return "wait"; // asked on behalf of `next` (submit): this switch's own resolvePending reports it
          p.heldBack = true;
          const atFee = `${formatGwei(fees.maxFeePerGas)} gwei`;
          const freeing = `nothing waiting behind nonce ${p.nonce} pays for freeing it`;
          const note = pr
            ? `not replacing pending ${what} at max fee ${atFee}: ${pr.reason}; it can still be mined at its own fees${behind ? `; ${freeing}` : ""}`
            : `not raising the fees of ${what} to ${atFee}: nothing waiting behind nonce ${p.nonce} pays for that; it can still be mined at its own fees`;
          this.unprofitable(t, note, summary);
          return "wait";
        }
        if (pr) giveUp = { reason: pr.reason, waiting };
      }
      t.note = undefined;
      t.profitRecheckAtMs = undefined;
    }
    let r: Awaited<ReturnType<WatcherDms["replace"]>>;
    this.assertLock();
    try {
      r = giveUp !== undefined ? { hash: await this.dms.freeNonce(p.nonce, fees), cancelled: true } : await this.dms.replace(current, p.nonce, fees);
    } catch (err) {
      // An earlier broadcast may have been mined since the check above: the node then forgets `current`
      // (not found) or rejects the replacement ("nonce too low"). Its receipt decides, not this error.
      if (await this.settledOrVoid(t, p, summary)) return "resolved";
      if (!(err instanceof TransactionNotFoundError)) throw err;
      // Dropped from the mempool and the nonce is still free: start over from the switch's state.
      this.log(`${this.tag(t)}: ${what} was dropped from the mempool; re-reading the switch`);
      this.forgetPending(t);
      return "resolved";
    }
    this.broadcasts++;
    p.hashes.push(r.hash);
    p.maxFeePerGas = fees.maxFeePerGas.toString();
    p.maxPriorityFeePerGas = fees.maxPriorityFeePerGas.toString();
    p.sentAtMs = Date.now();
    p.heldBack = undefined;
    if (r.cancelled) {
      if (giveUp === undefined) p.cancelled = r.errorName ?? "state moved on";
      p.cancelFrom ??= p.hashes.length - 1;
    }
    this.persist();
    const msg =
      giveUp !== undefined
        ? `not replacing ${what} at max fee ${formatGwei(fees.maxFeePerGas)} gwei (${giveUp.reason}); ${giveUp.waiting} waits behind nonce ${p.nonce} ` +
          `and pays for freeing it: freed it with self-transfer ${r.hash}`
        : r.cancelled
          ? `${p.kind} ${current} would now revert (${r.errorName}); freed nonce ${p.nonce} with self-transfer ${r.hash}`
          : `${what} pending for ${ageSec}s; replaced by ${r.hash} (nonce ${p.nonce}, max fee ${formatGwei(fees.maxFeePerGas)} gwei)`;
    this.log(`${this.tag(t)}: ${msg}`);
    summary.pending.push(`${k}: ${msg}`);
    return "wait";
  }

  // ---------- Output files ---------- //

  /** <outDir>/<chainId>-<contract>/ — one directory per deployment. */
  private outDirFor(): string {
    return join(this.wcfg.outDir, `${this.cfg.chainId}-${this.dms.address.toLowerCase()}`);
  }

  /**
   * Write <owner>-<id>.bin (plaintext) and .json (metadata, written last) with
   * O_EXCL, mode 0600. Never overwrites: files already there for the same
   * switch and key are the same archive (an earlier run); anything else gets a
   * numbered name and a warning.
   */
  private writeOutputs(t: TrackedSwitch, meta: Record<string, unknown>, plaintext?: Uint8Array): string {
    const dir = this.outDirFor();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stem = `${t.owner.toLowerCase()}-${t.id}`;
    const sameSwitch = (m: Record<string, unknown>) => this.isArchiveOf(m, t, meta.revealedKey);
    const sameBytes = (path: string) => !!plaintext && Buffer.compare(readFileSync(path), Buffer.from(plaintext)) === 0;
    for (let n = 0; n < 1000; n++) {
      const base = join(dir, n === 0 ? stem : `${stem}.${n}`);
      const [bin, json] = [`${base}.bin`, `${base}.json`];
      const result = plaintext ? bin : json;
      if (existsSync(json)) {
        let existing: Record<string, unknown> | undefined;
        try {
          existing = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
        } catch {
          existing = undefined;
        }
        if (existing && sameSwitch(existing)) {
          if (plaintext && !existsSync(bin)) writeFileSync(bin, plaintext, { mode: 0o600, flag: "wx" });
          this.log(`${this.tag(t)}: already archived in ${json}`);
          return result;
        }
        continue;
      }
      if (existsSync(bin) && !sameBytes(bin)) continue;
      if (plaintext && !existsSync(bin)) writeFileSync(bin, plaintext, { mode: 0o600, flag: "wx" });
      writeFileSync(json, JSON.stringify(meta, null, 2), { mode: 0o600, flag: "wx" });
      if (n > 0) this.log(`${this.tag(t)}: WARNING: ${join(dir, stem)}.* already exists for a different switch or key; wrote ${base}.* instead`);
      return result;
    }
    throw new Error(`too many conflicting files for ${join(dir, stem)}`);
  }

  /** Whether an archive record (.json) is this switch's, for this revealed key. */
  private isArchiveOf(m: Record<string, unknown>, t: TrackedSwitch, revealedKey: unknown): boolean {
    return (
      String(m.contract).toLowerCase() === this.dms.address.toLowerCase() &&
      String(m.owner).toLowerCase() === t.owner.toLowerCase() &&
      String(m.id) === t.id &&
      String(m.revealedKey).toLowerCase() === String(revealedKey).toLowerCase()
    );
  }

  /**
   * Once a switch's outcome is final: bring its archive record (.json, written when it was archived) in line with
   * the state file, which a reorganisation since can have changed (revealTx, revealedByUs, lostRaces). Only this
   * switch's record for this key is rewritten, atomically (a temporary file, then a rename); the plaintext is not.
   */
  private amendArchive(t: TrackedSwitch, revealedKey: Hex): void {
    const dir = this.outDirFor();
    const stem = `${t.owner.toLowerCase()}-${t.id}`;
    const now = { revealTx: t.revealTx ?? null, revealedByUs: t.revealedByUs ?? false, lostRaces: t.lostRaces ?? [] };
    for (let n = 0; n < 1000; n++) {
      const base = join(dir, n === 0 ? stem : `${stem}.${n}`);
      const json = `${base}.json`;
      // writeOutputs takes the first slot with neither file: the record is in front of it
      if (!existsSync(json)) {
        if (existsSync(`${base}.bin`)) continue;
        return;
      }
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!this.isArchiveOf(m, t, revealedKey)) continue;
      if (JSON.stringify([m.revealTx, m.revealedByUs, m.lostRaces]) === JSON.stringify([now.revealTx, now.revealedByUs, now.lostRaces])) return;
      writeFileSync(`${json}.tmp`, JSON.stringify({ ...m, ...now, amendedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      renameSync(`${json}.tmp`, json);
      this.log(`${this.tag(t)}: amended ${json}: revealTx ${now.revealTx ?? "none"}, revealedByUs ${now.revealedByUs}, ${now.lostRaces.length} lost races`);
      return;
    }
  }

  // ---------- Per-switch state machine ---------- //

  /**
   * Drive one switch through as many steps as it can take right now. With `survey`, stop before a step that
   * sends a transaction (markDark, revealKey, publishPlaintext) and return the switch's info then: pass() sends
   * those in its own order. Otherwise (and when a survey settles without one) undefined.
   */
  async processSwitch(t: TrackedSwitch, summary: PassSummary, survey = false): Promise<SwitchInfo | undefined> {
    const owner = t.owner;
    const id = BigInt(t.id);
    const k = trackKey(owner, id);
    if (t.pendingTx) {
      const forgotten = this.forgotten;
      try {
        if ((await this.resolvePending(t, summary)) === "wait") return;
      } catch (err) {
        this.fail(t, `pending ${t.pendingTx?.kind ?? "transaction"}`, err, summary);
        return;
      }
      // Forgotten without a receipt (dropped, void, given up): its nonce may be a gap that holds up every later one.
      // Its next step is taken now, in pass()'s nonce order, not queued: what waits behind that nonce is then judged
      // behind a transaction that is being mined.
      if (this.forgotten !== forgotten) survey = false;
    }
    let lastAction = "none";
    for (let step = 0; step < 8; step++) {
      let info: SwitchInfo;
      try {
        info = await this.dms.info(owner, id);
      } catch (err) {
        this.fail(t, "read", err, summary);
        return;
      }
      if (t.lastState !== info.stateName) {
        if (t.lastState) {
          // States only move forward, except in a chain reorganisation (or on a node behind the one read before):
          // the switch is handled from where it is now, and what was booked is checked once it is final (isFinal).
          const back = STATE_NAMES.indexOf(info.stateName) < STATE_NAMES.indexOf(t.lastState);
          if (back) {
            // Read from a node behind the one read before (staleRead), not a reorganisation: acting on it would send a
            // transaction that can only revert.
            let stale: string | undefined;
            try {
              stale = await this.staleRead(t, t.lastState, info.stateName);
            } catch (err) {
              this.fail(t, "read", err, summary);
              return;
            }
            if (stale) {
              const note = `read ${info.stateName}, but ${stale}: the node read is behind; reading it again next pass`;
              if (t.note !== note) this.log(`${this.tag(t)}: ${note}`);
              t.note = note;
              return;
            }
          }
          this.log(
            back
              ? `${this.tag(t)}: WARNING: state went back from ${t.lastState} to ${info.stateName} (a chain reorganisation, or a node behind the one read before); handling it from there`
              : `${this.tag(t)}: ${t.lastState} -> ${info.stateName}`,
          );
          // A backoff, profit verdict or note about the previous state's action does not apply to the next one.
          t.attempts = 0;
          t.nextAttemptAtMs = 0;
          t.profitRecheckAtMs = undefined;
          t.note = undefined;
        }
        t.lastState = info.stateName;
      }
      const d = decide(
        { state: info.stateName, expiresAt: info.expiresAt, bounty: info.bounty, published: info.published },
        t,
        { publish: this.wcfg.publish },
        { chainTime: this.chainTime, wallMs: Date.now() },
      );
      lastAction = d.action;

      switch (d.action) {
        case "ignore":
          t.terminal = d.terminal && (await this.isFinal(t, info, d.reason, summary));
          t.recheckAtChainTime = d.recheckAtChainTime?.toString();
          return;
        case "wait":
          if (t.note && d.untilMs === t.profitRecheckAtMs) summary.unprofitable.push(`${k}: ${t.note}`);
          return;
        case "done":
          if (info.published) t.published = true;
          if (!(await this.isFinal(t, info, d.reason, summary))) return;
          t.terminal = true;
          this.log(`${this.tag(t)}: done (${d.reason})`);
          return;

        case "mark-dark": {
          const broken = this.state.decryptBroken;
          if (broken && this.markDarkPaused()) {
            const note = `not marking dark while public decryption fails (${broken.reason})`;
            if (t.note !== note) this.log(`${this.tag(t)}: ${note}`);
            t.note = note;
            summary.pending.push(`${k}: ${note}`);
            this.pausedMarks.add(t);
            return;
          }
          if (survey) return info;
          try {
            const [gas, fees] = await Promise.all([this.dms.estimateMarkDark(owner, id), this.dms.fees()]);
            const profitGas = gas + this.wcfg.revealGasEstimate;
            const p = this.profit(info.bounty, profitGas, fees);
            if (!p.ok) {
              this.unprofitable(t, `not marking dark: ${p.reason}`, summary);
              return;
            }
            t.note = undefined;
            const pays = { bounty: info.bounty, gas: profitGas };
            if ((await this.submit(t, "markDark", [owner, id], capFees(fees, this.wcfg.maxGasPriceWei), summary, pays, gas)) === "pending") return;
          } catch (err) {
            if (isRace(err)) continue;
            this.fail(t, "markDark", err, summary);
            return;
          }
          continue;
        }

        case "reveal": {
          if (survey) return info;
          // Cheap pre-check on revealGasEstimate before spending a KMS request (the exact estimate needs the proof).
          let pre;
          try {
            pre = this.profit(info.bounty, this.wcfg.revealGasEstimate, await this.dms.fees());
          } catch (err) {
            this.fail(t, "fee estimate", err, summary);
            return;
          }
          if (!pre.ok) {
            this.unprofitable(t, `not revealing: ${pre.reason}`, summary);
            return;
          }
          let key: DecryptedDek;
          try {
            key = await this.fetchKey(t, info.encKeyHandle);
            this.state.decryptBroken = undefined;
          } catch (err) {
            if (err instanceof Deferred) {
              summary.pending.push(`${k}: public decrypt deferred (${err.message})`);
              return;
            }
            if (isFatalDecrypt(err)) {
              this.state.decryptBroken = {
                reason: `${describeError(err)}${err instanceof FhevmError && err.hint ? `; ${err.hint}` : ""}`,
                untilMs: Date.now() + this.wcfg.backoffMaxSec * 1000,
                relayer: relayerId(this.cfg),
              };
              this.fail(t, "public decrypt", err, summary, true);
              return;
            }
            this.fail(t, "public decrypt", err, summary, false, this.retryAfterMs(err) ?? 0);
            return;
          }
          try {
            const ct = await this.dms.ciphertext(owner, id);
            const check = await verifyKeyOpensCiphertext(ct, key.dek, info.plaintextCommitment);
            if (!check.ok) {
              t.keyMismatch = true;
              this.log(`${this.tag(t)}: WARNING: ${KEY_MISMATCH_WARNING} (${check.reason}). Revealing anyway.`);
            }
            const [gas, fees] = await Promise.all([
              this.dms.estimateRevealKey(owner, id, key.dataKey, key.decryptionProof),
              this.dms.fees(),
            ]);
            const p = this.profit(info.bounty, gas, fees);
            if (!p.ok) {
              this.unprofitable(t, `not revealing: ${p.reason}`, summary);
              return;
            }
            t.note = undefined;
            const args = [owner, id, key.dataKey, key.decryptionProof] as const;
            const pays = { bounty: info.bounty, gas };
            if ((await this.submit(t, "revealKey", args, capFees(fees, this.wcfg.maxGasPriceWei), summary, pays, gas)) === "pending") return;
          } catch (err) {
            if (isRace(err)) continue;
            this.fail(t, "revealKey", err, summary);
            return;
          } finally {
            wipe(key.dek);
          }
          continue;
        }

        case "archive": {
          try {
            const ct = await this.dms.ciphertext(owner, id);
            const check = await verifyKeyOpensCiphertext(ct, dekFromBytes32(info.revealedKey), info.plaintextCommitment);
            const meta: Record<string, unknown> = {
              chainId: this.cfg.chainId,
              contract: this.dms.address,
              owner,
              id: t.id,
              revealedKey: info.revealedKey,
              plaintextCommitment: info.plaintextCommitment,
              revealTx: t.revealTx ?? null,
              revealedByUs: t.revealedByUs ?? false,
              lostRaces: t.lostRaces ?? [],
              savedAt: new Date().toISOString(),
            };
            if (!check.ok) {
              t.keyMismatch = true;
              const file = this.writeOutputs(t, { ...meta, keyMismatch: true, warning: KEY_MISMATCH_WARNING, detail: check.reason });
              t.saved = true;
              this.log(`${this.tag(t)}: WARNING: ${KEY_MISMATCH_WARNING}; recorded ${file}`);
              if (!summary.keyMismatches.includes(k)) summary.keyMismatches.push(k);
            } else {
              const commitmentMatches = check.commitmentMatches === true;
              const file = this.writeOutputs(
                t,
                {
                  ...meta,
                  keyMismatch: false,
                  commitmentMatches,
                  salt: bytesToHex(check.opened.salt),
                  plaintextBytes: check.opened.plaintext.length,
                },
                check.opened.plaintext,
              );
              t.saved = true;
              t.commitmentMatches = commitmentMatches;
              if (!commitmentMatches) this.log(`${this.tag(t)}: WARNING: plaintext does not match the owner's commitment (cannot be published)`);
              this.log(`${this.tag(t)}: saved ${check.opened.plaintext.length} plaintext bytes to ${file}`);
            }
            this.succeeded(t);
            summary.saved.push(k);
          } catch (err) {
            this.fail(t, "archive", err, summary);
            return;
          }
          continue;
        }

        case "publish": {
          if (survey) return info;
          try {
            const ct = await this.dms.ciphertext(owner, id);
            const check = await verifyKeyOpensCiphertext(ct, dekFromBytes32(info.revealedKey), info.plaintextCommitment);
            if (!check.ok || !check.commitmentMatches) {
              t.commitmentMatches = false;
              continue;
            }
            const fees = capFees(await this.dms.fees(), this.wcfg.maxGasPriceWei);
            const args = [owner, id, bytesToHex(check.opened.salt), bytesToHex(check.opened.plaintext)] as const;
            if ((await this.submit(t, "publishPlaintext", args, fees, summary)) === "pending") return;
          } catch (err) {
            if (isRace(err)) continue;
            this.fail(t, "publishPlaintext", err, summary);
            return;
          }
          continue;
        }
      }
    }
    // Eight steps without settling: the state keeps changing under us, or a race keeps repeating.
    const msg = `no progress after 8 steps (state ${t.lastState}, last action ${lastAction}); trying again next pass`;
    this.log(`${this.tag(t)}: ${msg}`);
    summary.pending.push(`${k}: ${msg}`);
  }

  /** Daemon loop (or a single pass with --once). */
  async run(): Promise<PassSummary> {
    let last = emptySummary();
    for (;;) {
      try {
        last = await this.pass();
      } catch (err) {
        // e.g. the RPC is down: log, count, and keep the daemon alive.
        last = emptySummary();
        last.errors.push(`pass: ${describeError(err)}`);
        this.log(`pass failed: ${describeError(err)}`);
      }
      if (this.lockLost && !last.errors.some((e) => e.includes(".lock to another watcher"))) last.errors.push(`lost ${this.wcfg.stateFile}.lock to another watcher`);
      const s = last;
      if (s.markedDark.length || s.revealed.length || s.published.length || s.lostRaces.length || s.errors.length || this.wcfg.once) {
        this.log(
          `pass: polled ${s.polled}, marked ${s.markedDark.length}, revealed ${s.revealed.length}, saved ${s.saved.length}, ` +
            `published ${s.published.length}, lost races ${s.lostRaces.length}, unprofitable ${s.unprofitable.length}, ` +
            `pending ${s.pending.length}, errors ${s.errors.length}`,
        );
      }
      if (this.wcfg.once || this.stopping) return last;
      await sleep(jitteredMs(this.wcfg.pollIntervalSec, this.wcfg.jitterPct), this.stopSignal.signal);
      if (this.stopping) return last;
    }
  }
}

/** Build a Watcher (and the Dms it drives) from env + argv-style flags. */
export const createWatcher = (env: Env, flags: WatcherFlags, log: Logger = defaultLog): { watcher: Watcher; dms: Dms } => {
  const cfg = parseConfig(env);
  if (!cfg.privateKey) throw new ConfigError("PRIVATE_KEY is required for the watcher (it sends markDark / revealKey transactions)");
  // Fail fast on a relayer setup that can never decrypt (no ZAMA_RELAYER_API_KEY on mainnet),
  // before the watcher pays for any markDark it could not follow up.
  fheChainFor(cfg);
  let raw: unknown;
  const configPath = flags.config ?? (existsSync("./watcher.config.json") ? "./watcher.config.json" : undefined);
  if (configPath) {
    if (!existsSync(configPath)) throw new ConfigError(`watcher config ${configPath} not found`);
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new ConfigError(`watcher config ${configPath} is not valid JSON: ${(err as Error).message}`);
    }
  }
  const wcfg = parseWatcherConfig(raw, flags);
  wcfg.outDir = resolve(wcfg.outDir);
  wcfg.stateFile = resolve(wcfg.stateFile);
  if (!wcfg.discover && wcfg.switches.length === 0) throw new ConfigError("discovery is off and the config lists no switches: nothing to watch");
  if (!wcfg.discover && wcfg.rescanFrom !== undefined) throw new ConfigError("--rescan-from needs discovery (drop --no-discover)");
  const clients = createClients(cfg);
  const dms = new Dms(clients, cfg.dmsAddress);
  return { watcher: new Watcher(cfg, wcfg, dms, () => createFhevm(cfg, clients), log), dms };
};

const main = async (): Promise<number> => {
  dotenv.config({ quiet: true });
  let flags: WatcherFlags;
  try {
    flags = parseWatcherArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${describeError(err)}\n\n${WATCHER_USAGE}`);
    return 2;
  }
  if (flags.help) {
    console.log(WATCHER_USAGE);
    return 0;
  }
  let w: Watcher | undefined;
  try {
    const built = createWatcher(process.env, flags);
    w = built.watcher;
    const { dms } = built;
    await dms.assertDeployment(w.cfg.chainId);
    const signer = dms.signer;
    const balance = await dms.publicClient.getBalance({ address: signer });
    w.log(
      `contract ${dms.address} on chain ${w.cfg.chainId}; signer ${signer} (${fmtEth(balance)}); ` +
        `${w.wcfg.altruistic ? "altruistic" : `safety factor ${w.wcfg.safetyFactor}`}; publish ${w.wcfg.publish}; ` +
        `out ${w.wcfg.outDir}; state ${w.wcfg.stateFile}${w.wcfg.once ? "; single pass" : ""}`,
    );
    if (w.wcfg.discover && w.state.lastScannedBlock === undefined && (w.wcfg.fromBlock ?? w.cfg.fromBlock) === 0n && w.cfg.chainId !== 31337) {
      w.log("note: scanning from block 0; set FROM_BLOCK to the contract's deploy block to speed this up");
    }
    const watcher = w;
    const onSignal = () => {
      watcher.log("stopping: finishing the current step (progress is saved) ...");
      watcher.stop();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const summary = await w.run();
    return w.lostLock || (w.wcfg.once && summary.errors.length > 0) ? 1 : 0;
  } catch (err) {
    console.error(`error: ${describeError(err)}`);
    if (process.env.DMS_DEBUG) console.error(err);
    return 1;
  } finally {
    await w?.close();
  }
};

const isMain = (() => {
  try {
    // Real paths: started through a symlink (npm's dms-watcher bin link, a symlinked deploy directory,
    // macOS /tmp), argv[1] is the link while import.meta.url is the file it points to.
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) main().then((code) => process.exit(code));
