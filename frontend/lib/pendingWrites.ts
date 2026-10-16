// Writes the wallet has sent and whose outcome is not known yet, per tab.
//
// A write's lifecycle used to live in the component that sent it. A reload or
// a navigation dropped it: the page showed no pending transaction, the bounty
// had not moved (the top-up was not mined yet), and "Add ETH" was offered
// again, so a second top-up was one click away (and a second markDark or
// revealKey could only revert and burn gas). So, like the create flow's
// attempt (createAttempt.ts):
//
//   - every sent write is recorded, keyed by (chain, contract, switch,
//     function), with its hash, sender, nonce and value, and mirrored to
//     sessionStorage, so a reload in the same tab still knows it;
//   - a second write with the same key is refused until the first settles
//     (WriteInFlightError), whichever component or page sends it;
//   - whichever component shows that switch follows the record: its receipt
//     wait resumes after a reload, and stops when no component is left to
//     show it (the record stays, and the next one resumes it);
//   - a value-carrying write (fundBounty) whose wallet answered with an
//     ambiguous error after it may have broadcast is recorded without a hash,
//     and blocks a resend until the switch shows it, the account's nonce
//     moved without it, or the owner says nothing was sent.
//
// No React, no wagmi. Unit-tested in pendingWrites.test.ts.

import type { Hex } from "viem";
import type { Address } from "./deployments";
import type { KeyValueStorage } from "./createAttempt";

export type WriteFn =
  | "ping" | "fundBounty" | "cancel" | "reclaimContribution" | "reclaimOwnerStake"
  | "markDark" | "revealKey" | "publishPlaintext"
  | "setMinBountyUsd" | "transferAdmin" | "acceptAdmin" | "renounceAdmin";

const WRITE_FNS: readonly WriteFn[] = [
  "ping", "fundBounty", "cancel", "reclaimContribution", "reclaimOwnerStake", "markDark", "revealKey", "publishPlaintext",
  "setMinBountyUsd", "transferAdmin", "acceptAdmin", "renounceAdmin",
];

/** What a write is about: a function on one switch, or (owner and id null) on the contract itself. */
export interface WriteTarget {
  chainId: number;
  contract: Address;
  fn: WriteFn;
  owner: Address | null;
  id: bigint | null;
}

/**
 * What a write's call was (to, value, keccak256 of the calldata), from the
 * first node that returned the tx: enough to tell a wallet speed-up of it
 * from another call, as viem does, also after a reload. Not the calldata.
 */
export interface WriteCall { to: Address | null; value: bigint; inputHash: Hex }

export interface PendingWrite extends WriteTarget {
  /** null: the wallet answered with an error after it may have broadcast (no hash came back). */
  hash: Hex | null;
  /** The account that sent it (part of the key of PER_SENDER writes; never changed afterwards). */
  from: Address | null;
  /** The tx's nonce once a node returned it; for a write without a hash, the account's pending nonce just before it. */
  nonce: number | null;
  /** Wei sent with the call. */
  value: bigint;
  /**
   * When the wallet answered (ms since the epoch): with the hash, or with the
   * ambiguous error of a record without one. Time spent in the wallet's prompt
   * is not counted; the receipt wait's deadline counts from here, across reloads.
   */
  sentAt: number;
  /** fundBounty without a hash: the sender's stake on the switch before it (it landed once the stake grew by `value`). */
  stakeBefore: bigint | null;
  /** The call, once a node returned the tx (null until then, and for a record without a hash). */
  call: WriteCall | null;
}

/**
 * Writes that are per sender, not per switch: two funders may top up or
 * reclaim the same switch at once (and one account's pending top-up must not
 * block another account in the same tab). The others are one per switch (one
 * markDark or reveal releases it; ping, cancel and rescue are the owner's).
 */
const PER_SENDER: ReadonlySet<WriteFn> = new Set(["fundBounty", "reclaimContribution"]);

/** The record's key: chain, contract, switch, function, and for PER_SENDER functions the sending account. */
export const writeKey = (t: WriteTarget, from?: Address | null): string =>
  `${t.chainId}:${t.contract.toLowerCase()}:${t.owner?.toLowerCase() ?? "-"}:${t.id ?? "-"}:${t.fn}` +
  (PER_SENDER.has(t.fn) ? `:${from?.toLowerCase() ?? "-"}` : "");

/** Writes that move ETH from the sender: a second one by mistake costs money, not just gas. */
export const isValueCarrying = (w: { fn: WriteFn; value: bigint }): boolean => w.fn === "fundBounty" && w.value > 0n;

// ---------- persistence ----------

export const PENDING_WRITES_STORAGE_KEY = "dms:pending-writes:v1";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;

const encode = (w: PendingWrite) => ({
  chainId: w.chainId, contract: w.contract, fn: w.fn, owner: w.owner, id: w.id === null ? null : w.id.toString(),
  hash: w.hash, from: w.from, nonce: w.nonce, value: w.value.toString(), sentAt: w.sentAt,
  stakeBefore: w.stakeBefore === null ? null : w.stakeBefore.toString(),
  call: w.call === null ? null : { to: w.call.to, value: w.call.value.toString(), inputHash: w.call.inputHash },
});

/** The persisted form: only public chain data (no secret, key or plaintext). */
export const serializePendingWrites = (ws: readonly PendingWrite[]): string => JSON.stringify({ v: 1, writes: ws.map(encode) });

const uint = (v: unknown): bigint | undefined =>
  typeof v === "string" && UINT_RE.test(v) && BigInt(v) <= UINT256_MAX ? BigInt(v) : undefined;

const parseOne = (o: unknown): PendingWrite | null => {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.chainId !== "number" || !Number.isSafeInteger(r.chainId) || r.chainId <= 0) return null;
  if (typeof r.contract !== "string" || !ADDRESS_RE.test(r.contract)) return null;
  if (typeof r.fn !== "string" || !WRITE_FNS.includes(r.fn as WriteFn)) return null;
  const onSwitch = r.owner !== null || r.id !== null;
  if (onSwitch && (typeof r.owner !== "string" || !ADDRESS_RE.test(r.owner) || uint(r.id) === undefined || uint(r.id) === 0n)) return null;
  if (r.hash !== null && (typeof r.hash !== "string" || !HASH_RE.test(r.hash))) return null;
  if (r.from !== null && (typeof r.from !== "string" || !ADDRESS_RE.test(r.from))) return null;
  if (r.nonce !== null && (typeof r.nonce !== "number" || !Number.isSafeInteger(r.nonce) || r.nonce < 0)) return null;
  const value = uint(r.value);
  if (value === undefined) return null;
  if (typeof r.sentAt !== "number" || !Number.isFinite(r.sentAt) || r.sentAt <= 0) return null;
  const stakeBefore = r.stakeBefore === null ? null : uint(r.stakeBefore);
  if (stakeBefore === undefined) return null;
  // `call` came later: a record without it (absent) reads as not known yet.
  let call: WriteCall | null = null;
  if (r.call !== undefined && r.call !== null) {
    const c = r.call as Record<string, unknown>;
    const value = typeof c === "object" ? uint(c.value) : undefined;
    if (typeof c !== "object" || (c.to !== null && (typeof c.to !== "string" || !ADDRESS_RE.test(c.to)))
      || value === undefined || typeof c.inputHash !== "string" || !HASH_RE.test(c.inputHash)) return null;
    call = { to: c.to as Address | null, value, inputHash: c.inputHash as Hex };
  }
  return {
    chainId: r.chainId, contract: r.contract as Address, fn: r.fn as WriteFn,
    owner: onSwitch ? (r.owner as Address) : null, id: onSwitch ? uint(r.id)! : null,
    hash: r.hash as Hex | null, from: r.from as Address | null, nonce: r.nonce as number | null,
    value, sentAt: r.sentAt, stakeBefore, call,
  };
};

/** Strict inverse of serializePendingWrites; a malformed entry is dropped, anything else unknown reads as none. */
export const parsePendingWrites = (raw: string | null | undefined): PendingWrite[] => {
  if (!raw) return [];
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return []; }
  if (typeof o !== "object" || o === null || (o as { v?: unknown }).v !== 1) return [];
  const list = (o as { writes?: unknown }).writes;
  if (!Array.isArray(list)) return [];
  return list.map(parseOne).filter((w): w is PendingWrite => w !== null);
};

// ---------- store ----------

/** The tab's in-flight writes, as an external store (useSyncExternalStore). */
export interface PendingWriteStore {
  /** The write in flight for this key (the same object until it changes), or null. */
  get(key: string): PendingWrite | null;
  all(): readonly PendingWrite[];
  /** Record a write (replacing the key's previous record). */
  put(w: PendingWrite): void;
  /** Merge what a node said about the tx (its nonce and call) into the record of that same send. */
  update(key: string, hash: Hex | null, patch: Partial<Pick<PendingWrite, "nonce" | "call">>): void;
  /** End the record, if it is still that send (a late watcher must not clear a newer one). */
  remove(key: string, hash: Hex | null): void;
  subscribe(listener: () => void): () => void;
}

/**
 * In memory, mirrored to `storage`. Storage failures (private mode, blocked
 * site data) are ignored: the in-memory copy still guards this page.
 */
const sameCall = (a: WriteCall | null, b: WriteCall | null): boolean =>
  a === b || (!!a && !!b && (a.to ?? "").toLowerCase() === (b.to ?? "").toLowerCase() && a.value === b.value && a.inputHash === b.inputHash);

export const createPendingWriteStore = (storage: () => KeyValueStorage | null): PendingWriteStore => {
  let loaded = false;
  let entries = new Map<string, PendingWrite>();
  const listeners = new Set<() => void>();
  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      for (const w of parsePendingWrites(storage()?.getItem(PENDING_WRITES_STORAGE_KEY))) entries.set(writeKey(w, w.from), w);
    } catch { /* storage unavailable */ }
  };
  const commit = (next: Map<string, PendingWrite>) => {
    entries = next;
    try {
      const s = storage();
      if (next.size) s?.setItem(PENDING_WRITES_STORAGE_KEY, serializePendingWrites([...next.values()]));
      else s?.removeItem(PENDING_WRITES_STORAGE_KEY);
    } catch { /* storage unavailable */ }
    for (const l of listeners) l();
  };
  const sameSend = (w: PendingWrite | undefined, hash: Hex | null): w is PendingWrite =>
    !!w && (w.hash === null ? hash === null : !!hash && w.hash.toLowerCase() === hash.toLowerCase());
  return {
    get: (key) => { load(); return entries.get(key) ?? null; },
    all: () => { load(); return [...entries.values()]; },
    put: (w) => { load(); commit(new Map(entries).set(writeKey(w, w.from), w)); },
    update: (key, hash, patch) => {
      load();
      const w = entries.get(key);
      const unchanged = (patch.nonce === undefined || patch.nonce === w?.nonce)
        && (patch.call === undefined || sameCall(patch.call, w?.call ?? null));
      if (!sameSend(w, hash) || unchanged) return;
      commit(new Map(entries).set(key, { ...w, ...patch }));
    },
    remove: (key, hash) => {
      load();
      if (!sameSend(entries.get(key), hash)) return;
      const next = new Map(entries);
      next.delete(key);
      commit(next);
    },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
};

// ---------- errors ----------

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const WHAT: Record<WriteFn, string> = {
  ping: "A ping", fundBounty: "A top-up", cancel: "A cancel", reclaimContribution: "A reclaim", reclaimOwnerStake: "A rescue",
  markDark: "A markDark", revealKey: "A reveal", publishPlaintext: "A publish", setMinBountyUsd: "A minimum-bounty change",
  transferAdmin: "An admin transfer", acceptAdmin: "An admin acceptance", renounceAdmin: "An admin renounce",
};

/** Owner writes that only work if mined before the deadline. */
const DEADLINE_BOUND: ReadonlySet<WriteFn> = new Set(["ping", "cancel"]);

/** A second write with the same key while the first is in flight: refused before the wallet. */
export class WriteInFlightError extends Error {
  constructor(readonly write: PendingWrite) {
    super(
      write.hash
        ? `${WHAT[write.fn]} of this ${write.owner ? "switch" : "contract"} is still waiting to be mined (${short(write.hash)}). ` +
          (DEADLINE_BOUND.has(write.fn)
            // A second one from this page would get the next nonce and queue behind the stuck one, so it could not help.
            ? "If it is stuck, speed it up in your wallet (same transaction, higher fee) before the deadline; nothing new was sent."
            : "Wait for it; nothing new was sent.")
        : `${WHAT[write.fn]} of this switch may already have been sent: your wallet answered with an error instead of a transaction hash. Check your wallet's activity; this page keeps watching the switch. Nothing new was sent.`,
    );
    this.name = "WriteInFlightError";
  }
}

/**
 * The wallet answered a value-carrying write with an ambiguous error (it may
 * have broadcast). The write stays recorded without a hash, blocking a resend.
 */
export class WriteUnconfirmedError extends Error {
  constructor(readonly write: PendingWrite, cause: unknown) {
    super(
      `Your wallet answered with an error instead of a transaction hash, so this page cannot tell whether the ${write.fn === "fundBounty" ? "top-up" : "transaction"} was sent. Check your wallet's activity before trying again. This page keeps watching the switch and does not offer it again until it shows up, or you confirm nothing was sent.`,
      { cause },
    );
    this.name = "WriteUnconfirmedError";
  }
}

/** The wait for a write stopped because nothing on the page follows it any more; the record is kept. */
export class WriteDetachedError extends Error {
  constructor() {
    super("stopped waiting: nothing on this page shows the transaction any more");
    this.name = "WriteDetachedError";
  }
}

// ---------- shared waits ----------

/**
 * One wait per in-flight write, shared by the run that sent it and every
 * component that shows it. A wait a run of this tab started (`pinned`) runs
 * until its outcome: the run reports it (its toast, a lost race's revert)
 * whatever component showed it unmounts. A wait only resumed for display (a
 * record from before a reload) is kept alive by `retain`; when the last holder
 * lets go (its component unmounted), it is aborted after `graceMs` (a remount
 * in between keeps it, as React's development double-mount does), and the
 * record stays for the next component to resume.
 */
export const createWriteWatchers = <T>(graceMs = 1_000) => {
  const waits = new Map<string, { hash: Hex | null; promise: Promise<T>; ac: AbortController; pinned: boolean }>();
  const refs = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const sameHash = (a: Hex | null, b: Hex | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  return {
    /** The wait for `key`'s current send: the running one (pinned too if `pinned`), or a new one from `start`. */
    join(key: string, hash: Hex | null, start: (signal: AbortSignal) => Promise<T>, pinned = false): Promise<T> {
      const cur = waits.get(key);
      if (cur && sameHash(cur.hash, hash)) {
        if (pinned) cur.pinned = true;
        return cur.promise;
      }
      cur?.ac.abort();
      const ac = new AbortController();
      const promise = start(ac.signal);
      const w = { hash, promise, ac, pinned };
      waits.set(key, w);
      const done = () => { if (waits.get(key) === w) waits.delete(key); };
      promise.then(done, done);
      return promise;
    },
    /** Keep `key`'s wait running while held; returns the release. */
    retain(key: string): () => void {
      refs.set(key, (refs.get(key) ?? 0) + 1);
      const t = timers.get(key);
      if (t) { clearTimeout(t); timers.delete(key); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (refs.get(key) ?? 1) - 1;
        if (n > 0) { refs.set(key, n); return; }
        refs.delete(key);
        timers.set(key, setTimeout(() => {
          timers.delete(key);
          const w = waits.get(key);
          if (refs.has(key) || !w || w.pinned) return;
          w.ac.abort();
          waits.delete(key);
        }, graceMs));
      };
    },
    running: (key: string): boolean => waits.has(key),
    /** Abort `key`'s wait now (its record was ended by hand). */
    stop(key: string): void {
      waits.get(key)?.ac.abort();
      waits.delete(key);
    },
  };
};
