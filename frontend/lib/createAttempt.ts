// Idempotent switch creation: the state machine behind useCreateSwitch.
//
// A create is: check → seal → FHE-encrypt the key → createSwitch tx → receipt.
// Once the wallet has been asked to sign, the outcome can be unknown: the
// receipt wait times out in a gas spike, the RPC fails, or a WalletConnect
// session drops after the wallet broadcast. A retry under a NEW id could then
// leave two live switches holding the same secret, and the one the owner does
// not know about would go dark and publish it. So:
//
//   - One switch id per form session (a CreateAttempt), reused on every
//     retry. The contract allows one switch per (owner, id), so at most one of
//     the transactions can create it; any other reverts AlreadyExists.
//   - Before resealing, read the switch at (owner, id). If it exists and this
//     attempt already reached the wallet, an earlier transaction landed: that
//     is the success, and nothing new is sent.
//   - Once a tx hash exists, the outcome is "unconfirmed" (polled), never
//     "failed", until its receipt reverts or the network has forgotten the
//     transaction. No create is offered meanwhile.
//   - "Reverted" is never final for the switch: an earlier send of the id may
//     have created it (the retry then reverts AlreadyExists), and a
//     load-balanced RPC can serve a state read from a node behind the
//     receipt. So the switch is re-checked for a few minutes (and whenever
//     the owner asks), "reverted" stays shown until it appears, and an
//     attempt is dropped (letting a new id or another account start afresh)
//     only after re-reading the switch (dropAttempt).
//   - The attempt ({chainId, contract, owner, id, submitted, hash}, never the
//     secret, ciphertext or key) is mirrored to sessionStorage, so a reload
//     resumes it.
//
// Pure: no React, no wagmi, no FHE SDK. Unit-tested in createAttempt.test.ts.

import type { Hex } from "viem";
import type { Address } from "./contracts";
import { DMS_ERROR_MESSAGES, mayHaveBroadcast } from "./errors";
import { MAX_PING_INTERVAL, MIN_PING_INTERVAL, isValidInterval, type SwitchState } from "./switch";

// ---------- attempt ----------

/** Where a create runs: the switch is keyed by (contract, owner, id) on one chain. */
export interface CreateContext {
  chainId: number;
  contract: Address;
  owner: Address;
}

export interface CreateAttempt extends CreateContext {
  /** Chosen once per form session; every retry reuses it. */
  id: bigint;
  /** createSwitch was handed to the wallet with this id, so a tx may exist even without a hash. */
  submitted: boolean;
  /** Latest tx hash the wallet returned for this attempt. */
  hash: Hex | null;
}

const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const sameContext = (a: CreateContext, b: CreateContext): boolean =>
  a.chainId === b.chainId && eqAddr(a.contract, b.contract) && eqAddr(a.owner, b.owner);

/**
 * The finished create, if it belongs to `ctx` (the connected account on the viewed chain and contract):
 * another account sees its own form, and the card stays stored for when that account comes back (F4).
 */
export const createdFor = <C extends CreateContext>(c: C | null, ctx: CreateContext | null): C | null =>
  c && ctx && sameContext(c, ctx) ? c : null;

/** Identity of an attempt's current transaction, for matching poll results to it. */
export const attemptKey = (a: CreateAttempt): string =>
  `${a.chainId}:${a.contract.toLowerCase()}:${a.owner.toLowerCase()}:${a.id}:${a.hash ?? "-"}`;

/**
 * Whether a failed wallet request may still have broadcast the transaction
 * (lib/errors.ts): a rejection, a revert at the wallet's gas estimate, or a
 * pre-flight refusal happens before broadcast; anything else is ambiguous.
 */
export { mayHaveBroadcast };

// ---------- outcome of a submitted attempt ----------

/**
 * landed   — a switch exists at (owner, id): success, whichever tx made it
 * pending  — the tx is known to the network but not mined (or the state read
 *            lags behind its receipt): keep waiting, offer nothing
 * reverted — the tx was mined and reverted, and no switch was found at a
 *            block no older than the receipt's. Still re-checked for a few
 *            minutes: an earlier send of the id may yet show up
 * vanished — the app's RPC has not known the tx for several minutes, and no
 *            switch exists: dropped, replaced by a cancel, or sent through a
 *            private relay (MetaMask Smart Transactions, Flashbots Protect, MEV
 *            Blocker) that public nodes cannot see until it is mined. So not
 *            final: polling continues, and a retry reuses the id.
 * absent   — no hash came back from the wallet, and no switch exists (yet)
 * unknown  — the reads failed: keep polling
 */
export type AttemptOutcome = "landed" | "pending" | "reverted" | "vanished" | "absent" | "unknown";

export interface AttemptObservation {
  /** getSwitchInfo(owner, id).state (same as getState); null when the read failed. */
  state: number | null;
  /** Receipt of attempt.hash: "none" = not mined (yet), "error" = the read failed, null = no hash. */
  receipt: "success" | "reverted" | "none" | "error" | null;
  /** With no receipt: does the node know the tx? null = not checked, or the read failed. */
  txKnown: boolean | null;
  /** Consecutive polls, this one included, in which the node did not know the tx. */
  unknownPolls: number;
}

/** How often an attempt whose outcome is unknown is re-checked. */
export const ATTEMPT_POLL_MS = 10_000;

/**
 * Unknown to the node for this many polls in a row before a tx counts as
 * vanished. The first poll is immediate, so 31 polls span 5 minutes: long
 * enough for a private relay to include it or give up.
 */
export const VANISHED_AFTER_POLLS = 1 + (5 * 60_000) / ATTEMPT_POLL_MS;

export const classifyAttempt = (a: CreateAttempt, obs: AttemptObservation): AttemptOutcome => {
  if (obs.state === null) return "unknown";
  if (obs.state !== 0) return "landed";
  if (!a.hash) return "absent";
  switch (obs.receipt) {
    case "reverted": return "reverted";
    // A successful createSwitch receipt means the switch exists; the state
    // read hit a node that is behind. Wait for it rather than guess.
    case "success": return "pending";
    case "none":
      return obs.txKnown === false && obs.unknownPolls >= VANISHED_AFTER_POLLS ? "vanished" : "pending";
    default: return "unknown";
  }
};

/** Outcomes after which another createSwitch with the same id may be sent. */
export const canResend = (o: AttemptOutcome | null): boolean => o === "reverted" || o === "vanished";

/**
 * Once a hash is known to have reverted, the delays before each re-check of
 * its switch. Then the poll stops until the owner asks to check again. The
 * re-checks only look for an earlier send of the id, or a state read that
 * lagged: neither takes long, and polling a reverted attempt forever costs
 * four RPC calls every 10 s for nothing.
 */
export const REVERTED_RECHECK_MS: readonly number[] = [10_000, 20_000, 40_000, 80_000, 160_000];

export interface PollStep {
  show: AttemptOutcome;
  /** Delay before the next poll, or null to stop polling. */
  next: number | null;
  /** Polls of this hash since it was known to have reverted, for the next call; null while it is not. */
  reverted: number | null;
}

/**
 * What one poll of the current hash shows, and when to poll again.
 * `reverted`: null, or the polls of this hash since it was known to have
 * reverted, because the create run reported it (mined and reverted, or
 * cancelled / replaced in the wallet) or an earlier poll read its reverted
 * receipt. That stands until the switch appears: a cancelled hash has no
 * receipt and later polls read it as pending, then vanished, and one failed
 * read (a 429, a node behind) reads as unknown. Either would put the page
 * back to "waiting" for a tx that cannot land, and unmount the retry form.
 * A reverted receipt is final for its hash, not for the switch (an earlier
 * send of the same id may have created it, and a lagging state read may not
 * show it yet), so the switch is re-checked REVERTED_RECHECK_MS apart, then
 * no more. Only a switch at (owner, id) changes what is shown.
 */
export const pollStep = (o: AttemptOutcome, reverted: number | null): PollStep => {
  if (o === "landed") return { show: o, next: null, reverted };
  if (o !== "reverted" && reverted === null) return { show: o, next: ATTEMPT_POLL_MS, reverted: null };
  const n = reverted ?? 0;
  return { show: "reverted", next: REVERTED_RECHECK_MS[n] ?? null, reverted: n + 1 };
};

// ---------- submit planning ----------

/**
 * Why a new submit from `ctx` must not go ahead:
 * landed        — the switch exists; show it
 * pending       — a tx with this id is in flight; wait for it (or speed it up)
 * other-account — the attempt reached the wallet from another account or
 *                 chain and its outcome is unknown; finish it there first
 */
export type SubmitBlock = "landed" | "pending" | "other-account";

export const submitBlock = (
  attempt: CreateAttempt | null,
  ctx: CreateContext,
  outcome: AttemptOutcome | null,
): SubmitBlock | null => {
  if (!attempt?.submitted) return null;
  if (outcome === "landed") return "landed";
  if (attempt.hash && !canResend(outcome)) return "pending";
  if (!sameContext(attempt, ctx)) return "other-account";
  return null;
};

export type SubmitPlan =
  | { ok: true; attempt: CreateAttempt }
  | { ok: false; block: SubmitBlock };

/**
 * The attempt a submit from `ctx` runs under. A new form session draws its
 * id once; every later submit reuses it. An attempt that never reached the
 * wallet follows the account (nothing of it can be on-chain).
 */
export const planSubmit = (
  attempt: CreateAttempt | null,
  ctx: CreateContext,
  outcome: AttemptOutcome | null,
  freshId: () => bigint,
): SubmitPlan => {
  const block = submitBlock(attempt, ctx, outcome);
  if (block) return { ok: false, block };
  if (!attempt) return { ok: true, attempt: { ...ctx, id: freshId(), submitted: false, hash: null } };
  if (!attempt.submitted && !sameContext(attempt, ctx)) {
    return { ok: true, attempt: { ...ctx, id: attempt.id, submitted: false, hash: null } };
  }
  return { ok: true, attempt };
};

export class CreateBlockedError extends Error {
  constructor(readonly block: SubmitBlock, readonly attempt: CreateAttempt | null) {
    super(
      block === "pending"
        ? `A transaction for switch #${attempt?.id} is not confirmed yet. Wait for it; do not create the switch again.`
        : block === "other-account"
          ? `Switch #${attempt?.id} was sent from another account or network and may still land. Switch back to finish it.`
          : `Switch #${attempt?.id} already exists.`,
    );
    this.name = "CreateBlockedError";
  }
}

// ---------- persistence (sessionStorage) ----------

export const ATTEMPT_STORAGE_KEY = "dms:create-attempt:v1";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;

/** The persisted form. Deliberately no secret, plaintext, ciphertext or key material. */
export const serializeAttempt = (a: CreateAttempt): string =>
  JSON.stringify({
    v: 1, chainId: a.chainId, contract: a.contract, owner: a.owner,
    id: a.id.toString(), submitted: a.submitted, hash: a.hash,
  });

/** Strict inverse of serializeAttempt; anything else (other versions, tampering) reads as no attempt. */
export const parseAttempt = (raw: string | null | undefined): CreateAttempt | null => {
  if (!raw) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.chainId !== "number" || !Number.isSafeInteger(r.chainId) || r.chainId <= 0) return null;
  if (typeof r.contract !== "string" || !ADDRESS_RE.test(r.contract)) return null;
  if (typeof r.owner !== "string" || !ADDRESS_RE.test(r.owner)) return null;
  if (typeof r.id !== "string" || !/^[1-9][0-9]{0,77}$/.test(r.id) || BigInt(r.id) > UINT256_MAX) return null;
  if (typeof r.submitted !== "boolean") return null;
  if (r.hash !== null && (typeof r.hash !== "string" || !HASH_RE.test(r.hash))) return null;
  return {
    chainId: r.chainId, contract: r.contract as Address, owner: r.owner as Address,
    id: BigInt(r.id), submitted: r.submitted, hash: (r.hash as Hex | null),
  };
};

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A finished create: what the "Switch created" card shows. Never the secret, ciphertext or key. */
export interface CreatedSwitch {
  chainId: number;
  contract: Address;
  owner: Address;
  id: bigint;
  pingInterval: bigint;
  state: SwitchState;
  /** The createSwitch tx, when this page saw it (null for a send whose hash never came back). */
  hash: Hex | null;
  /** Found on-chain (an earlier send landed) rather than confirmed by this send's receipt. */
  adopted: boolean;
}

export const CREATED_STORAGE_KEY = "dms:create-done:v1";

const SWITCH_STATES: readonly SwitchState[] = ["none", "alive", "dark", "darkMarked", "revealed", "cancelled"];

export const serializeCreated = (c: CreatedSwitch): string =>
  JSON.stringify({
    v: 1, chainId: c.chainId, contract: c.contract, owner: c.owner, id: c.id.toString(),
    pingInterval: c.pingInterval.toString(), state: c.state, hash: c.hash, adopted: c.adopted,
  });

/** Strict inverse of serializeCreated; anything else reads as none. */
export const parseCreated = (raw: string | null | undefined): CreatedSwitch | null => {
  if (!raw) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.chainId !== "number" || !Number.isSafeInteger(r.chainId) || r.chainId <= 0) return null;
  if (typeof r.contract !== "string" || !ADDRESS_RE.test(r.contract)) return null;
  if (typeof r.owner !== "string" || !ADDRESS_RE.test(r.owner)) return null;
  if (typeof r.id !== "string" || !/^[1-9][0-9]{0,77}$/.test(r.id) || BigInt(r.id) > UINT256_MAX) return null;
  if (typeof r.pingInterval !== "string" || !/^[0-9]{1,20}$/.test(r.pingInterval)) return null;
  if (typeof r.state !== "string" || !SWITCH_STATES.includes(r.state as SwitchState)) return null;
  if (r.hash !== null && (typeof r.hash !== "string" || !HASH_RE.test(r.hash))) return null;
  if (typeof r.adopted !== "boolean") return null;
  return {
    chainId: r.chainId, contract: r.contract as Address, owner: r.owner as Address, id: BigInt(r.id),
    pingInterval: BigInt(r.pingInterval), state: r.state as SwitchState, hash: r.hash as Hex | null, adopted: r.adopted,
  };
};

/**
 * The current attempt, and the last finished create, as an external store
 * (useSyncExternalStore). The finished create is kept here, not in the form's
 * state: a create that is mining when the form unmounts (the owner opened
 * another page) still finishes, and the form that mounts next must show
 * "Switch created", not an empty form.
 */
export interface AttemptStore {
  get(): CreateAttempt | null;
  set(a: CreateAttempt | null): void;
  /** The last create that finished in this tab, until "start over" or the next create. */
  created(): CreatedSwitch | null;
  setCreated(c: CreatedSwitch | null): void;
  subscribe(listener: () => void): () => void;
  /**
   * A create run of this page has asked the wallet to sign this attempt and
   * the wallet has not answered yet (in memory only: the prompt belongs to
   * this page). Such an attempt must not be dropped: approving the open
   * prompt later would send a create that nothing tracks.
   */
  awaitingWallet(a: CreateAttempt): boolean;
  setAwaitingWallet(a: CreateAttempt, waiting: boolean): void;
}

/**
 * In memory, mirrored to `storage`: the attempt once it has reached the wallet
 * (before that it is only an unused random id), and the finished create.
 * Storage failures (private mode, blocked site data, quota) are ignored: the
 * in-memory copy still keeps retries in this page on the same id.
 */
export const createAttemptStore = (storage: () => KeyValueStorage | null): AttemptStore => {
  let loaded = false;
  let current: CreateAttempt | null = null;
  let done: CreatedSwitch | null = null;
  const prompts = new Map<string, number>();
  const switchKey = (a: CreateAttempt) => `${a.chainId}:${a.contract.toLowerCase()}:${a.owner.toLowerCase()}:${a.id}`;
  const listeners = new Set<() => void>();
  const load = () => {
    if (loaded) return;
    loaded = true;
    try { current = parseAttempt(storage()?.getItem(ATTEMPT_STORAGE_KEY)); } catch { current = null; }
    try { done = parseCreated(storage()?.getItem(CREATED_STORAGE_KEY)); } catch { done = null; }
  };
  const notify = () => { for (const l of listeners) l(); };
  return {
    get: () => { load(); return current; },
    set: (a) => {
      load();
      current = a;
      try {
        const s = storage();
        if (a?.submitted) s?.setItem(ATTEMPT_STORAGE_KEY, serializeAttempt(a));
        else s?.removeItem(ATTEMPT_STORAGE_KEY);
      } catch { /* storage unavailable */ }
      notify();
    },
    created: () => { load(); return done; },
    setCreated: (c) => {
      load();
      done = c;
      try {
        const s = storage();
        if (c) s?.setItem(CREATED_STORAGE_KEY, serializeCreated(c));
        else s?.removeItem(CREATED_STORAGE_KEY);
      } catch { /* storage unavailable */ }
      notify();
    },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    awaitingWallet: (a) => (prompts.get(switchKey(a)) ?? 0) > 0,
    setAwaitingWallet: (a, waiting) => {
      const k = switchKey(a);
      const n = (prompts.get(k) ?? 0) + (waiting ? 1 : -1);
      if (n > 0) prompts.set(k, n); else prompts.delete(k);
    },
  };
};

/** `cur` is an attempt for the same switch as `a` (chain, contract, owner, id). */
const sameSwitch = (cur: CreateAttempt | null, a: CreateAttempt): cur is CreateAttempt =>
  !!cur && sameContext(cur, a) && cur.id === a.id;

/*
 * Store writes of a create after it awaited something (the FHE step, the
 * wallet, the receipt). Meanwhile the store may have come to hold another
 * switch's attempt: another form instance dropped this one and sent a new id,
 * or another account started one. A late run must neither erase nor
 * overwrite that record: the page would stop tracking a sent tx, and a later
 * submit could put the same secret in a second switch.
 */

/** End `a`'s attempt, if the store still holds it. */
const endAttempt = (store: AttemptStore, a: CreateAttempt): void => {
  if (sameSwitch(store.get(), a)) store.set(null);
};

/** Record `a`, unless the store now holds another switch's attempt. */
const keepAttempt = (store: AttemptStore, a: CreateAttempt): void => {
  const cur = store.get();
  if (!cur || sameSwitch(cur, a)) store.set(a);
};

/**
 * Record that `a`'s switch exists (the run's receipt, a poll, or a re-read
 * found it): end the attempt and keep the result for whichever form shows it.
 * A run that finishes late does not end another switch's attempt.
 */
export const recordCreated = (
  store: AttemptStore,
  a: CreateAttempt,
  s: { pingInterval: bigint; state: SwitchState },
  hash: Hex | null,
  adopted: boolean,
): CreatedSwitch => {
  endAttempt(store, a);
  const c: CreatedSwitch = {
    chainId: a.chainId, contract: a.contract, owner: a.owner, id: a.id,
    pingInterval: s.pingInterval, state: s.state, hash, adopted,
  };
  store.setCreated(c);
  return c;
};

// ---------- leaving "Switch created" ----------

export type NewSessionResult =
  /** The switch is there: the finished create is cleared, and the next create is a new form session (a new id). */
  | { kind: "cleared" }
  /**
   * The switch does not read at head (the block that held it was reorganised away, and its transaction is
   * waiting to be mined again): the attempt is back, same id and hash, and is followed as unconfirmed, so no
   * second switch with the same secret can be started meanwhile.
   */
  | { kind: "reopened"; attempt: CreateAttempt }
  /** The store changed during the read (another create started, or the card was cleared): nothing was done. */
  | { kind: "changed" };

/**
 * "Create another": a create is reported after one confirmation, and a reorg can hide it for a while. So
 * the switch is read again (at the head, not at the receipt's block, which may be orphaned) before the
 * finished create is cleared. A failed read throws, and nothing changes.
 */
export const startNewSession = async (
  store: AttemptStore,
  read: (c: CreatedSwitch) => Promise<SwitchSnapshot>,
): Promise<NewSessionResult> => {
  const c = store.created();
  if (!c) return { kind: "cleared" };
  const s = await read(c);
  if (store.created() !== c) return { kind: "changed" };
  if (s.exists) {
    store.setCreated(null);
    return { kind: "cleared" };
  }
  const a: CreateAttempt = { chainId: c.chainId, contract: c.contract, owner: c.owner, id: c.id, submitted: true, hash: c.hash };
  const cur = store.get();
  if (cur && !sameSwitch(cur, a)) return { kind: "changed" };
  store.set(a);
  store.setCreated(null);
  return { kind: "reopened", attempt: a };
};

// ---------- dropping a sent attempt ----------

/** Reads of the switch before a sent attempt is dropped, and the pause between them. */
export const DROP_RECHECK_READS = 3;
export const DROP_RECHECK_GAP_MS = 1_500;

export type DropResult =
  /** No read found the switch: the attempt is gone, and the next submit draws a new id. */
  | { kind: "dropped" }
  /** The switch exists (an earlier send landed): show it as created. Nothing was dropped. */
  | { kind: "landed"; attempt: CreateAttempt; snapshot: SwitchSnapshot }
  /** The stored attempt changed during the reads (the poll adopted it, a new send). Nothing was dropped. */
  | { kind: "changed" }
  /** A wallet prompt of this page for it is still open: approving it later would send a create nothing tracks. Nothing was dropped. */
  | { kind: "awaiting-wallet"; attempt: CreateAttempt };

/**
 * Drop the stored attempt so that this page can start a new switch: under a
 * new id, or from another account. If a send of it did create the switch, a
 * new one would hold the same secret, and the one nobody pings would release
 * it. A "reverted" or "absent" poll does not rule that out (an earlier send
 * of the id may have landed first, and one read can lag), so the switch is
 * re-read DROP_RECHECK_READS times, DROP_RECHECK_GAP_MS apart, and the
 * attempt is dropped only when no read finds it. `readFresh` should read at a
 * block no older than the attempt's receipt. A failed read throws, and
 * nothing is dropped. Nor is an attempt whose wallet prompt is still open in
 * this page (store.awaitingWallet): the user must answer it first.
 */
export const dropAttempt = async (
  store: AttemptStore,
  readFresh: (a: CreateAttempt) => Promise<SwitchSnapshot>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<DropResult> => {
  const a = store.get();
  if (!a) return { kind: "dropped" };
  if (store.awaitingWallet(a)) return { kind: "awaiting-wallet", attempt: a };
  // Never sent: nothing of it can be on-chain.
  if (a.submitted) {
    for (let i = 0; i < DROP_RECHECK_READS; i++) {
      if (i > 0) await sleep(DROP_RECHECK_GAP_MS);
      const s = await readFresh(a);
      if (store.get() !== a) return { kind: "changed" };
      if (s.exists) return { kind: "landed", attempt: a, snapshot: s };
    }
  }
  store.set(null);
  return { kind: "dropped" };
};

// ---------- the create run ----------

export type CreateStage =
  | "idle" | "sealing" | "encrypting-key" | "confirm-in-wallet" | "mining"
  /** A tx hash exists and its outcome is not known yet: polled, never shown as failed. */
  | "unconfirmed"
  | "done" | "error";

const IN_FLIGHT: ReadonlySet<CreateStage> = new Set(["sealing", "encrypting-key", "confirm-in-wallet", "mining"]);
export const isInFlight = (s: CreateStage): boolean => IN_FLIGHT.has(s);

/** createSwitch arguments other than id / interval / value. */
export interface PreparedCreate {
  commitment: Hex;
  ciphertext: Hex;
  encKey: Hex;
  inputProof: Hex;
}

export interface SwitchSnapshot {
  exists: boolean;
  state: SwitchState;
  pingInterval: bigint;
}

export interface CreateDeps {
  ctx: CreateContext;
  /**
   * The form's cancel (its Cancel button, or the form unmounting). Checked once more right before the wallet
   * prompt: the FHE step can finish after an abort it did not see (the SDK ignores the signal after the
   * relayer's answer). Not after the wallet answered: from then on a transaction may exist.
   */
  signal?: AbortSignal;
  store: AttemptStore;
  /** Latest polled outcome of the stored attempt's current tx, if any. */
  outcome: AttemptOutcome | null;
  freshId: () => bigint;
  readSwitch: (owner: Address, id: bigint) => Promise<SwitchSnapshot>;
  readMinBounty: () => Promise<bigint>;
  /** Seal + FHE-encrypt under a fresh key. Holds the secret; this module never sees it. */
  prepare: () => Promise<PreparedCreate>;
  send: (a: CreateAttempt, p: PreparedCreate, pingInterval: bigint, valueWei: bigint) => Promise<Hex>;
  /** Throws when the wait times out or the RPC fails. */
  waitForReceipt: (hash: Hex) => Promise<"success" | "reverted">;
  onStage: (s: CreateStage) => void;
}

/** The form cancelled the create before its wallet prompt (CreateDeps.signal). */
export class CreateCancelledError extends Error {
  constructor() {
    super("cancelled before the wallet prompt; nothing was sent");
    this.name = "CreateCancelledError";
  }
}

export type CreateRunResult =
  | { kind: "created"; attempt: CreateAttempt; pingInterval: bigint; state: SwitchState; hash: Hex | null; adopted: boolean }
  /** Broadcast, outcome unknown (receipt wait failed): poll it. */
  | { kind: "unconfirmed"; attempt: CreateAttempt }
  /** Mined and reverted, and no switch at (owner, id): the same id may be retried. */
  | { kind: "reverted"; attempt: CreateAttempt };

/**
 * One submit of the create form. Throws for failures before anything can be
 * on-chain (and for a blocked submit); everything after the wallet returned a
 * hash ends in a result, never a throw.
 */
export const runCreate = async (
  d: CreateDeps,
  input: { pingInterval: bigint; bountyWei: bigint },
): Promise<CreateRunResult> => {
  const current = d.store.get();
  const plan = planSubmit(current, d.ctx, d.outcome, d.freshId);
  if (!plan.ok) throw new CreateBlockedError(plan.block, current);
  let a = plan.attempt;
  if (a !== current) d.store.set(a);

  if (!isValidInterval(input.pingInterval)) {
    throw new Error(`Ping interval must be between ${MIN_PING_INTERVAL} s and ${MAX_PING_INTERVAL} s.`);
  }

  // Cheap checks before the (first time, minutes-long) FHE step, and the
  // idempotency check: a switch here means an earlier send of this id landed.
  d.onStage("sealing");
  const [minBounty, existing] = await Promise.all([d.readMinBounty(), d.readSwitch(a.owner, a.id)]);
  if (existing.exists) {
    if (a.submitted) {
      endAttempt(d.store, a);
      return { kind: "created", attempt: a, pingInterval: existing.pingInterval, state: existing.state, hash: a.hash, adopted: true };
    }
    // Never sent from here, so not ours to claim: draw a fresh id next time.
    endAttempt(d.store, a);
    throw new Error(DMS_ERROR_MESSAGES.AlreadyExists!);
  }
  if (input.bountyWei < minBounty) throw new Error(DMS_ERROR_MESSAGES.BountyTooLow!);

  const prepared = await d.prepare();
  if (d.signal?.aborted) throw new CreateCancelledError();

  // Persist before the wallet prompt: from here a tx may exist without a hash.
  // The previous hash (reverted or vanished) no longer describes this send:
  // keeping it would let a poll of that old hash report this send as failed.
  d.onStage("confirm-in-wallet");
  // The FHE step can take minutes. If this attempt was dropped or replaced
  // meanwhile (another form, tab or account), sending now would create a
  // switch nothing tracks, or a second one with the same secret.
  if (!sameSwitch(d.store.get(), a)) {
    throw new Error("This create was replaced by a newer one (another form, tab or account) before the wallet prompt; nothing was sent.");
  }
  const before = a;
  a = { ...a, submitted: true, hash: null };
  d.store.set(a);
  let hash: Hex;
  const prompt = a;
  d.store.setAwaitingWallet(prompt, true);
  try {
    hash = await d.send(a, prepared, input.pingInterval, input.bountyWei);
  } catch (e) {
    // Rejected, or a revert in the wallet's estimate: nothing new was sent,
    // so the attempt is what it was before.
    if (!mayHaveBroadcast(e)) {
      a = before;
      keepAttempt(d.store, a);
    }
    throw e;
  } finally {
    d.store.setAwaitingWallet(prompt, false);
  }
  a = { ...a, hash };
  keepAttempt(d.store, a);

  d.onStage("mining");
  let status: "success" | "reverted";
  try {
    status = await d.waitForReceipt(hash);
  } catch {
    return { kind: "unconfirmed", attempt: a };
  }
  if (status === "success") {
    endAttempt(d.store, a);
    return { kind: "created", attempt: a, pingInterval: input.pingInterval, state: "alive", hash, adopted: false };
  }
  // Reverted. An earlier send of this id may have landed first (AlreadyExists).
  let after: SwitchSnapshot;
  try {
    after = await d.readSwitch(a.owner, a.id);
  } catch {
    return { kind: "unconfirmed", attempt: a };
  }
  if (after.exists) {
    endAttempt(d.store, a);
    return { kind: "created", attempt: a, pingInterval: after.pingInterval, state: after.state, hash, adopted: true };
  }
  return { kind: "reverted", attempt: a };
};

// ---------- what the form shows ----------

/** Heading of the form's error box. */
export const errorTitle = (a: CreateAttempt | null, outcome: AttemptOutcome | null): string =>
  !a?.submitted ? "Could not create the switch"
    // No hash, or one the network has not seen: the send may still land.
    : !a.hash || outcome === "vanished" ? "Not confirmed"
    : "The switch was not created";

const shortHash = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/**
 * The stage and error the form renders, from the running create (`local`),
 * the stored attempt and its polled outcome. An attempt with a hash is
 * "unconfirmed" until its outcome says otherwise, whatever the last create()
 * call ended with.
 */
export const deriveCreateView = (i: {
  local: CreateStage;
  localError: string | null;
  attempt: CreateAttempt | null;
  outcome: AttemptOutcome | null;
  created: boolean;
}): { stage: CreateStage; error: string | null } => {
  if (isInFlight(i.local)) return { stage: i.local, error: null };
  if (i.created) return { stage: "done", error: null };
  const a = i.attempt;
  // A retry that failed before reaching the wallet reports its own error.
  const own = i.local === "error" ? i.localError : null;
  if (a?.submitted && a.hash) {
    if (i.outcome === "reverted") {
      return {
        stage: "error",
        error: own
          ?? `Transaction ${shortHash(a.hash)} reverted on-chain: switch #${a.id} was not created. Trying again reuses the same id.`,
      };
    }
    if (i.outcome === "vanished") {
      return {
        stage: "error",
        error: own
          ?? `Transaction ${shortHash(a.hash)} has not been seen on the network for several minutes, and switch #${a.id} does not exist yet. It may have been dropped or replaced, or sent privately (e.g. MetaMask Smart Transactions, Flashbots Protect), which public nodes only see once it is mined. Check your wallet's activity first: if it is still pending there, wait. This page keeps checking. Trying again reuses the same id, so at most one transaction can create the switch; if the first one lands, the retry reverts and costs only gas.`,
      };
    }
    return { stage: "unconfirmed", error: null };
  }
  if (i.local === "error") return { stage: "error", error: i.localError };
  return { stage: "idle", error: null };
};
