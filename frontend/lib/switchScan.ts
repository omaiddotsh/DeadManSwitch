// Switch discovery: chunked eth_getLogs scans for SwitchCreated, shared by
// every list (hunt, archive, dashboard).
//
// - Provider errors are classified like the watcher's (client/src/watcherCore.ts
//   classifyLogsError): a rate limit, timeout or network failure is retried on
//   the same range after a pause; so is a load-balanced node's "pruned
//   history" (another node serves the range). A "range too large / too many
//   results" answer halves the chunk, which grows back after a few accepted
//   ranges; a larger size refused again is tried again only after twice as
//   many (a provider with a fixed span cap, like drpc's free plan at 101
//   blocks, is not probed every few ranges).
// - A scan keeps a few requests in flight (SCAN_CONCURRENCY): one at a time
//   once the provider rate-limits, or while trying a chunk size not yet
//   accepted.
// - The scan is incremental and resumable: progress is kept after every
//   accepted range (so a failure, react-query's retry or a reload resumes
//   there), and mirrored to localStorage per (chain, contract, FROM_BLOCK), so
//   a later visit scans only the blocks since the last one: from the block
//   after the last finalized one that scan saw, or REORG_OVERLAP blocks back
//   where the node has no "finalized" tag. Not on Anvil, whose chain is reset
//   between runs.
//
// Pure: no React, no wagmi. Unit-tested in switchScan.test.ts.

import { encodePacked, keccak256, type Hex, type PublicClient } from "viem";
import { dmsAbi } from "./abi";
import type { Address } from "./contracts";
import type { KeyValueStorage } from "./createAttempt";
import type { SwitchHandle } from "./switch";

/** A switch as announced by its SwitchCreated event (creation-time values). */
export interface SwitchListing extends SwitchHandle {
  key: Hex;
  pingInterval: bigint;
  createdAt: bigint;
  initialBounty: bigint;
  plaintextCommitment: Hex;
  encKeyHandle: Hex;
  blockNumber: bigint;
  txHash: Hex;
}

/** Every switch created in [fromBlock, scannedTo], newest first. */
export interface ScanState {
  contract: Address;
  fromBlock: bigint;
  scannedTo: bigint;
  items: SwitchListing[];
  /**
   * The chain's last finalized block when this scan started (absent when the
   * node has no "finalized" tag): the next scan re-scans from the block after
   * it, so a reorg below REORG_OVERLAP cannot leave a phantom or a gap.
   */
  finalized?: bigint;
  /** While a scan is running (kept in memory only): the blocks it covers. */
  scanning?: { from: bigint; to: bigint };
}

/** Blocks re-scanned below the last scan's head, in case they were reorganised (the least, without a "finalized" tag). */
export const REORG_OVERLAP = 12n;
/** eth_getLogs requests in flight at once during a long scan. */
export const SCAN_CONCURRENCY = 4;
/** Pauses (1, 2, 4 … 32 s) before a rate-limited or failed range gives the scan up. */
const MAX_TRANSIENT_RETRIES = 6;
/** Accepted ranges in a row before a halved chunk doubles again; doubled each time the larger size is refused again. */
const GROW_AFTER = 4;
/** A chunk size that keeps being refused is tried again after at most this many accepted ranges. */
const MAX_GROW_AFTER = 1_024;

// ---------- provider errors ----------

/** The provider's own words, HTTP status and JSON-RPC code, from a viem error and its causes. */
const errorFacts = (e: unknown): { text: string; status?: number; code?: number; codes: number[] } => {
  const parts: string[] = [];
  const codes: number[] = [];
  let status: number | undefined;
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const x = cur as { details?: unknown; shortMessage?: unknown; message?: unknown; status?: unknown; code?: unknown; cause?: unknown };
    // viem's `message` repeats `details` plus the URL and request body; plain errors only have `message`.
    const own = [x.details, x.shortMessage].filter((m): m is string => typeof m === "string");
    if (own.length) parts.push(...own);
    else if (typeof x.message === "string") parts.push(x.message);
    if (status === undefined && typeof x.status === "number") status = x.status;
    if (typeof x.code === "number") codes.push(x.code);
    cur = x.cause;
  }
  return { text: parts.join(" | "), status, code: codes[0], codes };
};

/**
 * Why a getLogs request failed:
 *   "transient"   — rate limit, timeout, network or 5xx: pause and retry the same range;
 *   "unavailable" — this node lacks the blocks' history ("pruned history",
 *                   code 4444, from a load-balanced RPC): retry the same range
 *                   (another node usually serves it), without slowing the scan;
 *   "range"       — the provider rejects the span or the result size: halve the chunk.
 * Unrecognised errors count as "range" (halving is the safe default).
 */
export const classifyLogsError = (e: unknown): "range" | "transient" | "unavailable" => {
  const { text: m, status, code, codes } = errorFacts(e);
  if (status === 429 || code === 429 || /rate.?limit|too many requests|throttl|capacity exceeded|compute units/i.test(m)) return "transient";
  if (codes.includes(4444) || /pruned|history (is )?(not |un)available/i.test(m)) return "unavailable";
  if (
    /block range|range (is )?(too|exceeds)|range limit|blocks? range|too many (blocks|results|logs)|more than \d+ (results|logs|blocks)|query returned more|response (size|is too)|result window|exceed(s|ed)? (the )?(max|maximum)|max(imum)? (block|range)|log response size/i.test(m)
  ) {
    return "range";
  }
  if (
    status === 408 || (status !== undefined && status >= 500)
    || /took too long|timed? ?out|timeout|failed to fetch|load failed|network|fetch failed|ECONNRESET|socket hang up/i.test(m)
  ) {
    return "transient";
  }
  return "range";
};

// ---------- one scan ----------

export interface ScanOptions<T = SwitchListing> {
  /** Requests in flight at once (default SCAN_CONCURRENCY). */
  concurrency?: number;
  /** After each accepted range, in block order: everything up to `scannedTo` is done. */
  onProgress?: (scannedTo: bigint, found: T[]) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Stop after the first range (in block order) whose results this accepts. */
  until?: (found: T[]) => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `fn`, retried after a pause (1, 2, 4 … 32 s) while it fails transiently (classifyLogsError). */
const retryTransient = async <T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= MAX_TRANSIENT_RETRIES || classifyLogsError(e) === "range") throw e;
      await sleep(1_000 * 2 ** attempt);
    }
  }
};

const switchCreatedIn = async (
  client: PublicClient, contract: Address, fromBlock: bigint, toBlock: bigint, owner?: Address,
): Promise<SwitchListing[]> => {
  const events = await client.getContractEvents({
    address: contract, abi: dmsAbi, eventName: "SwitchCreated",
    fromBlock, toBlock, strict: true,
    ...(owner ? { args: { owner } } : {}),
  });
  return events.map((ev) => {
    const a = ev.args;
    return {
      contractAddr: contract,
      owner: a.owner,
      id: a.switchId,
      key: a.switchKey,
      pingInterval: a.pingInterval,
      createdAt: a.timestamp,
      initialBounty: a.bounty,
      plaintextCommitment: a.plaintextCommitment,
      encKeyHandle: a.encKeyHandle,
      blockNumber: ev.blockNumber,
      txHash: ev.transactionHash,
    };
  });
};

/**
 * Chunked eth_getLogs (`fetch`) over [fromBlock, toBlock], at most `rangeCap`
 * blocks per call, every block exactly once. See the header for errors and
 * concurrency.
 */
const scanRanges = async <T>(
  fromBlock: bigint,
  toBlock: bigint,
  rangeCap: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  opts: ScanOptions<T> = {},
): Promise<T[]> => {
  const max = rangeCap > 0n ? rangeCap : 5_000n;
  const wide = Math.max(1, Math.floor(opts.concurrency ?? SCAN_CONCURRENCY));
  const sleep = opts.sleep ?? defaultSleep;
  const out: T[] = [];
  /** Ranges fetched past a failed one, by first block: used when the scan reaches them, never fetched twice. */
  const ahead = new Map<bigint, { end: bigint; found: T[] }>();
  let chunk = max;
  /** The chunk size was accepted (or is the cap): ranges go out `wide` at a time. */
  let proven = true;
  /** The chunk was just grown: a range error refuses the larger size again. */
  let probing = false;
  let growAfter = GROW_AFTER;
  let successes = 0;
  let transient = 0;
  let throttled = false;
  let stopped = false;
  let cursor = fromBlock;
  const commit = (end: bigint, found: T[]) => {
    out.push(...found);
    cursor = end + 1n;
    opts.onProgress?.(end, found);
    if (opts.until?.(found)) stopped = true;
  };

  while (cursor <= toBlock && !stopped) {
    const done = ahead.get(cursor);
    if (done) { ahead.delete(cursor); commit(done.end, done.found); continue; }
    // One range at a time once rate-limited, and while trying a chunk size not yet accepted.
    const width = throttled || !proven ? 1 : wide;
    const ranges: [bigint, bigint][] = [];
    for (let s = cursor; s <= toBlock && ranges.length < width && !ahead.has(s);) {
      let e = s + chunk - 1n > toBlock ? toBlock : s + chunk - 1n;
      for (const k of ahead.keys()) if (k > s && k <= e) e = k - 1n;
      ranges.push([s, e]);
      s = e + 1n;
    }
    const results = await Promise.allSettled(ranges.map(([s, e]) => fetch(s, e)));

    let failed: { span: bigint; reason: unknown } | null = null;
    for (let i = 0; i < ranges.length && !stopped; i++) {
      const [s, e] = ranges[i]!;
      const r = results[i]!;
      if (r.status === "rejected") { failed ??= { span: e - s + 1n, reason: r.reason }; continue; }
      if (failed) { ahead.set(s, { end: e, found: r.value }); continue; }
      transient = 0;
      commit(e, r.value);
      // A full-size range accepts the chunk size (a shorter one, cut at the end or at a range fetched ahead, does not).
      if (e - s + 1n >= chunk) {
        proven = true;
        if (probing) { probing = false; growAfter = GROW_AFTER; }
      }
      if (chunk < max && ++successes >= growAfter) {
        chunk = chunk * 2n < max ? chunk * 2n : max;
        successes = 0;
        proven = false;
        probing = true;
      }
    }
    if (stopped || !failed) continue;

    // The first failed range starts at `cursor`: retry it (whole after a pause, or halved).
    const kind = classifyLogsError(failed.reason);
    if (kind !== "range" && transient < MAX_TRANSIENT_RETRIES) {
      // A rate limit slows the rest of the scan; a node without the history does not.
      if (kind === "transient") throttled = true;
      await sleep(1_000 * 2 ** transient++);
    } else if (kind === "range" && failed.span > 1n) {
      // A grown chunk refused again: back to the size just accepted, and try the larger one after twice as many.
      if (probing) growAfter = growAfter * 2 < MAX_GROW_AFTER ? growAfter * 2 : MAX_GROW_AFTER;
      proven = probing;
      probing = false;
      chunk = failed.span >> 1n; // not `/ 2n`: Next 14's build-time tracer crashes on it ("Cannot mix BigInt")
      successes = 0;
    } else {
      throw failed.reason;
    }
  }
  return out;
};

/** SwitchCreated logs over [fromBlock, toBlock] (scanRanges), optionally for one owner. */
export const scanSwitchCreated = (
  client: PublicClient,
  contract: Address,
  fromBlock: bigint,
  toBlock: bigint,
  rangeCap: bigint,
  owner?: Address,
  opts: ScanOptions = {},
): Promise<SwitchListing[]> =>
  scanRanges(fromBlock, toBlock, rangeCap, (from, to) => switchCreatedIn(client, contract, from, to, owner), opts);

// ---------- the scan a list resumes (in memory + localStorage) ----------

export const SCAN_STORAGE_PREFIX = "dms:switch-scan:v1:";
/** During a long scan, progress reaches storage every this many accepted ranges (and at the end). */
const PERSIST_EVERY = 25;

export const scanStorageKey = (chainId: number, contract: string): string =>
  `${SCAN_STORAGE_PREFIX}${chainId}:${contract.toLowerCase()}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;

export const serializeScan = (s: ScanState): string =>
  JSON.stringify({
    v: 1, fromBlock: s.fromBlock.toString(), scannedTo: s.scannedTo.toString(),
    ...(s.finalized !== undefined ? { finalized: s.finalized.toString() } : {}),
    items: s.items.map((i) => ({
      owner: i.owner, id: i.id.toString(), key: i.key, pingInterval: i.pingInterval.toString(),
      createdAt: i.createdAt.toString(), initialBounty: i.initialBounty.toString(),
      plaintextCommitment: i.plaintextCommitment, encKeyHandle: i.encKeyHandle,
      blockNumber: i.blockNumber.toString(), txHash: i.txHash,
    })),
  });

/** Strict inverse of serializeScan; anything else (other versions, tampering, a truncated write) reads as no scan. */
export const parseScan = (raw: string | null | undefined, contract: Address): ScanState | null => {
  if (!raw) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  const r = o as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null || Array.isArray(r) || r.v !== 1) return null;
  if (typeof r.fromBlock !== "string" || !UINT_RE.test(r.fromBlock)) return null;
  if (typeof r.scannedTo !== "string" || !UINT_RE.test(r.scannedTo)) return null;
  const fromBlock = BigInt(r.fromBlock);
  const scannedTo = BigInt(r.scannedTo);
  if (scannedTo < fromBlock || !Array.isArray(r.items)) return null;
  // Absent in a scan from a node without the "finalized" tag (or from before it was recorded).
  if (r.finalized !== undefined && (typeof r.finalized !== "string" || !UINT_RE.test(r.finalized))) return null;
  const finalized = r.finalized === undefined ? undefined : BigInt(r.finalized);
  const items: SwitchListing[] = [];
  for (const x of r.items as unknown[]) {
    const i = x as Record<string, unknown> | null;
    if (typeof i !== "object" || i === null) return null;
    const uints = [i.id, i.pingInterval, i.createdAt, i.initialBounty, i.blockNumber];
    const words = [i.key, i.plaintextCommitment, i.encKeyHandle, i.txHash];
    if (typeof i.owner !== "string" || !ADDRESS_RE.test(i.owner)) return null;
    if (!uints.every((u) => typeof u === "string" && UINT_RE.test(u))) return null;
    if (!words.every((w) => typeof w === "string" && BYTES32_RE.test(w))) return null;
    const blockNumber = BigInt(i.blockNumber as string);
    if (blockNumber < fromBlock || blockNumber > scannedTo) return null;
    items.push({
      contractAddr: contract, owner: i.owner as Address, id: BigInt(i.id as string), key: i.key as Hex,
      pingInterval: BigInt(i.pingInterval as string), createdAt: BigInt(i.createdAt as string),
      initialBounty: BigInt(i.initialBounty as string), plaintextCommitment: i.plaintextCommitment as Hex,
      encKeyHandle: i.encKeyHandle as Hex, blockNumber, txHash: i.txHash as Hex,
    });
  }
  return { contract, fromBlock, scannedTo, items, ...(finalized !== undefined ? { finalized } : {}) };
};

export interface ScanStore {
  /** The last scan of (chain, contract) from `fromBlock`, or null (none, or one from another FROM_BLOCK). */
  get(chainId: number, contract: Address, fromBlock: bigint): ScanState | null;
  /** Keep `s` in memory; also write it to storage when `save` (default true) and the chain is persisted. */
  set(chainId: number, s: ScanState, save?: boolean): void;
  /**
   * `listener` runs when a list would show something new: a set that changed
   * how many switches are known, or a saved one (a scan's end, and its
   * progress every PERSIST_EVERY ranges). Returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
  /** Grows with every notification (a useSyncExternalStore snapshot). */
  version(): number;
}

/**
 * The last scan per (chain, contract), in memory and mirrored to `storage`
 * for chains where `persist(chainId)`. Storage failures (private mode, quota,
 * blocked site data) are ignored: the in-memory copy still serves this page.
 */
export const createScanStore = (storage: () => KeyValueStorage | null, persist: (chainId: number) => boolean): ScanStore => {
  const memo = new Map<string, ScanState>();
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    version: () => version,
    get: (chainId, contract, fromBlock) => {
      const k = scanStorageKey(chainId, contract);
      let s = memo.get(k);
      if (!s && persist(chainId)) {
        try { s = parseScan(storage()?.getItem(k), contract) ?? undefined; } catch { s = undefined; }
        if (s) memo.set(k, s);
      }
      return s && s.fromBlock === fromBlock ? s : null;
    },
    set: (chainId, s, save = true) => {
      const k = scanStorageKey(chainId, s.contract);
      const before = memo.get(k);
      memo.set(k, s);
      if (save || before?.items.length !== s.items.length) {
        version++;
        for (const l of [...listeners]) l();
      }
      if (!save || !persist(chainId)) return;
      try { storage()?.setItem(k, serializeScan(s)); } catch { /* storage unavailable or full */ }
    },
  };
};

export interface ScanTarget {
  chainId: number;
  contract: Address;
  fromBlock: bigint;
  rangeCap: bigint;
}

/** Newest first (by block), across deployments of a chain too. */
export const newestFirst = (items: Iterable<SwitchListing>): SwitchListing[] =>
  [...items].sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));

/** The chain's last finalized block, or undefined (a node without the tag, or any failure: the scan then keeps to REORG_OVERLAP). */
const finalizedBlock = async (client: PublicClient): Promise<bigint | undefined> => {
  try {
    return (await client.getBlock({ blockTag: "finalized" })).number ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Where a scan after `prev` starts: REORG_OVERLAP blocks below its head, or,
 * when it recorded the finalized block, the block after that one. Blocks below
 * it are final, so its items there stand. A long stall of finality costs at
 * most one range more.
 */
const resumeFrom = (prev: ScanState, rangeCap: bigint): bigint => {
  const overlap = prev.scannedTo + 1n - REORG_OVERLAP;
  if (prev.finalized === undefined) return overlap;
  const floor = prev.scannedTo + 1n - (rangeCap > 0n ? rangeCap : 5_000n);
  const deep = prev.finalized + 1n > floor ? prev.finalized + 1n : floor;
  return deep < overlap ? deep : overlap;
};

/**
 * All switches on the contract, newest first: resumes the last scan of this
 * (chain, contract), in this page or an earlier visit, and scans only blocks
 * since then, from the block after the last finalized one it saw (or
 * REORG_OVERLAP). Progress is kept after every accepted range.
 */
export const syncSwitchScan = async (
  client: PublicClient,
  t: ScanTarget,
  store: ScanStore,
  opts: ScanOptions = {},
): Promise<ScanState> => {
  const prev = store.get(t.chainId, t.contract, t.fromBlock);
  // The head uncached: viem keeps it 4 s, and the scan a create's invalidation
  // starts (its receipt found at the first look, with no block-number poll in
  // between) would read the previous scan's head and miss the new switch.
  const [latest, finalized] = await Promise.all([
    retryTransient(() => client.getBlockNumber({ cacheTime: 0 }), opts.sleep ?? defaultSleep),
    finalizedBlock(client),
  ]);
  // A node behind the last scan has nothing new; re-scanning would only hide recent switches until it catches up.
  if (prev && latest <= prev.scannedTo) return prev;
  let start = prev ? resumeFrom(prev, t.rangeCap) : t.fromBlock;
  if (start < t.fromBlock) start = t.fromBlock;
  // Blocks from `start` on are scanned again, and what they hold now replaces
  // what the last scan saw there: a reorg may have dropped or moved a switch.
  const byKey = new Map<string, SwitchListing>();
  for (const s of prev?.items ?? []) if (s.blockNumber < start) byKey.set(s.key, s);
  const final = finalized !== undefined && finalized <= latest ? { finalized } : {};
  const snapshot = (scannedTo: bigint, scanning?: ScanState["scanning"]): ScanState => ({
    contract: t.contract, fromBlock: t.fromBlock, scannedTo, items: newestFirst(byKey.values()), ...final,
    ...(scanning ? { scanning } : {}),
  });

  let unsaved = 0;
  await scanSwitchCreated(client, t.contract, start, latest, t.rangeCap, undefined, {
    ...opts,
    onProgress: (scannedTo, found) => {
      for (const f of found) byKey.set(f.key, f);
      const save = ++unsaved >= PERSIST_EVERY;
      if (save) unsaved = 0;
      store.set(t.chainId, snapshot(scannedTo, { from: start, to: latest }), save);
      opts.onProgress?.(scannedTo, found);
    },
  });
  const next = snapshot(latest);
  store.set(t.chainId, next);
  return next;
};

// ---------- the PlaintextPublished event of one switch ----------

export interface PublishedPlaintext {
  payload: Hex;
  publisher: Address;
  txHash: Hex;
  blockNumber: bigint;
}

export interface PublishedTarget {
  chainId: number;
  contract: Address;
  owner: Address;
  id: bigint;
  /** getSwitchInfo().revealedAt: publication can only follow the reveal. */
  revealedAt: bigint;
  fromBlock: bigint;
  rangeCap: bigint;
}

/** Seconds per slot where blocks come in fixed-time slots (post-merge Ethereum): at most one block per slot. */
const SLOT_SECONDS: Record<number, bigint> = { 1: 12n, 11155111: 12n };

/** DeadManSwitch._key: keccak256(abi.encodePacked(owner, id)), the indexed `switchKey` of its events. */
export const switchKeyOf = (owner: Address, id: bigint): Hex => keccak256(encodePacked(["address", "uint256"], [owner, id]));

const publishedIn = async (
  client: PublicClient, contract: Address, switchKey: Hex, fromBlock: bigint, toBlock: bigint,
): Promise<PublishedPlaintext[]> => {
  const evs = await client.getContractEvents({
    address: contract, abi: dmsAbi, eventName: "PlaintextPublished",
    args: { switchKey }, fromBlock, toBlock, strict: true,
  });
  return evs.map((ev) => ({ payload: ev.args.payload, publisher: ev.args.publisher, txHash: ev.transactionHash, blockNumber: ev.blockNumber }));
};

/**
 * The switch's PlaintextPublished event, or null when [reveal, head] holds
 * none (logs pruned by the provider, or a node behind the reveal or the
 * publication: the hook looks again later). Throws
 * when the RPC keeps failing, so an outage never reads as "not published".
 *
 * - Filtered by the indexed switchKey (derived locally: no switchKey call).
 * - Never before the reveal: publishPlaintext requires REVEALED. On chains with
 *   12 s slots at most (head.timestamp − revealedAt) / 12 blocks follow the
 *   reveal block, which bounds it from below without a lookup. Anvil mines
 *   many blocks per second, so there only FROM_BLOCK bounds it.
 * - A switch has at most one PlaintextPublished, usually right after the
 *   reveal (the reveal panel and the watcher publish next) or recent: both ends
 *   are searched first, in parallel; then the middle, forward.
 * - Errors are handled like discovery's (scanRanges): pauses on rate limits,
 *   halved chunks on range limits.
 */
export const findPublishedPlaintext = async (
  client: PublicClient,
  t: PublishedTarget,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<PublishedPlaintext | null> => {
  const sleep = opts.sleep ?? defaultSleep;
  const switchKey = switchKeyOf(t.owner, t.id);
  const head = await retryTransient(() => client.getBlock(), sleep);
  // This node has not seen the reveal yet, so not the publication either.
  if (head.timestamp < t.revealedAt) return null;
  const to = head.number;
  let from = t.fromBlock;
  const slot = SLOT_SECONDS[t.chainId];
  if (slot) {
    const sinceReveal = (head.timestamp - t.revealedAt) / slot;
    if (to - sinceReveal > from) from = to - sinceReveal;
  }
  if (from > to) return null;

  const cap = t.rangeCap > 0n ? t.rangeCap : 5_000n;
  const fetch = (a: bigint, b: bigint) => publishedIn(client, t.contract, switchKey, a, b);
  const scan = (a: bigint, b: bigint, concurrency?: number) =>
    scanRanges(a, b, cap, fetch, { sleep, concurrency, until: (found) => found.length > 0 });

  const firstEnd = from + cap - 1n < to ? from + cap - 1n : to;
  const lastStart = to - cap + 1n > firstEnd ? to - cap + 1n : firstEnd + 1n;
  const ends = await Promise.allSettled([scan(from, firstEnd, 1), lastStart <= to ? scan(lastStart, to, 1) : Promise.resolve([])]);
  for (const r of ends) if (r.status === "fulfilled" && r.value[0]) return r.value[0];
  for (const r of ends) if (r.status === "rejected") throw r.reason;
  if (firstEnd + 1n < lastStart) return (await scan(firstEnd + 1n, lastStart - 1n))[0] ?? null;
  return null;
};
