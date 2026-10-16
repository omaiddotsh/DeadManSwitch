// In-flight writes outlive the component that sent them (lib/pendingWrites.ts,
// runWrite's tracking, the shared follower in hooks.ts): a reload or a
// navigation must not offer a second top-up, markDark or revealKey while the
// first is unconfirmed, and a top-up whose wallet answer was lost must not be
// offered again as if it had failed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InternalRpcError, TransactionNotFoundError, TransactionReceiptNotFoundError, UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError, getContractError, type BaseError, type Hex, type PublicClient, type TransactionReceipt,
} from "viem";
import { dmsAbi } from "./abi";
import type { KeyValueStorage } from "./createAttempt";
import {
  UNCONFIRMED_NONCE_CHECKS, WRITE_WAIT_MS, createWriteFollower, runWrite, waitForUnconfirmedTopUp, type WriteTracking,
} from "./hooks";
import {
  PENDING_WRITES_STORAGE_KEY, WriteDetachedError, WriteInFlightError, WriteUnconfirmedError,
  createPendingWriteStore, createWriteWatchers, parsePendingWrites, serializePendingWrites, writeKey,
  type PendingWrite, type WriteTarget,
} from "./pendingWrites";
import { fakeChain, type FakeTx } from "./fakeChain.testutil";

class Mem implements KeyValueStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const FUNDER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const ONE_ETH = 10n ** 18n;

const target = (fn: WriteTarget["fn"], id = 11n): WriteTarget => ({ chainId: 11155111, contract: CONTRACT, fn, owner: OWNER, id });
const receipt = (status: "success" | "reverted", hash: Hex = H1) =>
  ({ status, blockNumber: 100n, transactionHash: hash }) as unknown as TransactionReceipt;

/** A node on which `hash` is pending until `mine()` is called. */
const chain = () => {
  const st = { mined: new Set<string>(), waits: 0 };
  const client = {
    chain: { id: 11155111 },
    waitForTransactionReceipt: ({ hash, timeout }: { hash: Hex; timeout: number }) => new Promise((resolve, reject) => {
      st.waits++;
      const iv = setInterval(() => { if (st.mined.has(hash)) { clearInterval(iv); clearTimeout(to); st.waits--; resolve(receipt("success", hash)); } }, 1_000);
      const to = setTimeout(() => { clearInterval(iv); st.waits--; reject(new WaitForTransactionReceiptTimeoutError({ hash })); }, timeout);
    }),
    getTransaction: async ({ hash }: { hash: Hex }) => ({ from: FUNDER, nonce: 7, hash }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (st.mined.has(hash)) return receipt("success", hash);
      throw new TransactionReceiptNotFoundError({ hash });
    },
    getTransactionCount: async () => 7,
    readContract: async () => 0n,
  } as unknown as PublicClient;
  return { client, st, mine: (h: Hex) => st.mined.add(h) };
};

/** What useTxRunner passes to runWrite, over `storage` (a reload = a new store over the same storage). */
const tracking = (storage: Mem, client: PublicClient, fn: WriteTarget["fn"] = "fundBounty", value = ONE_ETH, id = 11n) => {
  const store = createPendingWriteStore(() => storage);
  const follower = createWriteFollower(store, createWriteWatchers<TransactionReceipt | null>());
  const track: WriteTracking = {
    store, target: target(fn, id), value, from: FUNDER,
    before: async () => ({ nonce: 7, stakeBefore: 0n, call: null }),
    watch: (w) => follower.follow(client, w),
  };
  return { store, follower, track };
};

beforeEach(() => { vi.useFakeTimers({ now: 1_700_000_000_000 }); });
afterEach(() => { vi.useRealTimers(); });

describe("pending-write records", () => {
  it("round-trip through sessionStorage; a tampered or unknown entry reads as none", () => {
    const w: PendingWrite = { ...target("fundBounty"), hash: H1, from: FUNDER, nonce: 7, value: ONE_ETH, sentAt: 1, stakeBefore: null, call: null };
    const admin: PendingWrite = { ...target("setMinBountyUsd"), owner: null, id: null, hash: null, from: null, nonce: null, value: 0n, sentAt: 2, stakeBefore: 3n, call: null };
    expect(parsePendingWrites(serializePendingWrites([w, admin]))).toEqual([w, admin]);
    // The call (to, value, calldata hash) once a node returned the tx; a record written before it existed reads as unknown.
    const withCall: PendingWrite = { ...w, call: { to: CONTRACT, value: ONE_ETH, inputHash: H2 } };
    expect(parsePendingWrites(serializePendingWrites([withCall]))).toEqual([withCall]);
    const legacy = JSON.parse(serializePendingWrites([w])) as { writes: Record<string, unknown>[] };
    delete legacy.writes[0]!.call;
    expect(parsePendingWrites(JSON.stringify(legacy))).toEqual([w]);
    const badCall = JSON.parse(serializePendingWrites([withCall])) as { writes: { call: Record<string, unknown> }[] };
    badCall.writes[0]!.call.inputHash = "0x12";
    expect(parsePendingWrites(JSON.stringify(badCall))).toEqual([]);
    const raw = JSON.parse(serializePendingWrites([w])) as { writes: Record<string, unknown>[] };
    for (const bad of [{ fn: "steal" }, { hash: "0x12" }, { value: "-1" }, { owner: "0xnope" }, { id: "0" }, { nonce: -1 }]) {
      expect(parsePendingWrites(JSON.stringify({ v: 1, writes: [{ ...raw.writes[0], ...bad }] }))).toEqual([]);
    }
    expect(parsePendingWrites(JSON.stringify({ v: 2, writes: raw.writes }))).toEqual([]);
    expect(parsePendingWrites("{not json")).toEqual([]);
  });
});

describe("#0: a sent write survives a reload, and blocks a second one until it settles", () => {
  it("a top-up still pending after a reload: the record (hash, sender, value) is still there and a second top-up never reaches the wallet", async () => {
    const storage = new Mem();
    const { client, mine } = chain();
    const tab1 = tracking(storage, client);
    const sent = vi.fn(async () => H1);
    void runWrite(sent, client, async () => {}, {}, tab1.track).catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveBeenCalledTimes(1);

    // Reload: a new store over the same sessionStorage.
    const tab2 = tracking(storage, client);
    const w = tab2.store.get(writeKey(target("fundBounty"), FUNDER));
    expect(w).toMatchObject({ hash: H1, from: FUNDER, value: ONE_ETH, fn: "fundBounty", owner: OWNER, id: 11n });
    const again = vi.fn(async () => H2);
    const out = await runWrite(again, client, async () => {}, {}, tab2.track).catch((e: unknown) => e);
    expect(out).toBeInstanceOf(WriteInFlightError);
    expect((out as Error).message).toContain(H1.slice(0, 10));
    expect(again).not.toHaveBeenCalled();

    // Another switch, or another function on this one, is not blocked.
    const otherSend = vi.fn(async () => H2);
    void runWrite(otherSend, client, async () => {}, {}, { ...tab2.track, target: target("fundBounty", 12n) }).catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(otherSend).toHaveBeenCalledTimes(1);

    // The reloaded page resumes the wait; once mined, the record ends and a new top-up may go.
    const resumed = tab2.follower.follow(client, w!);
    mine(H1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(resumed).resolves.toMatchObject({ status: "success", transactionHash: H1 });
    expect(tab2.store.get(writeKey(target("fundBounty"), FUNDER))).toBeNull();
    expect(storage.getItem(PENDING_WRITES_STORAGE_KEY)).toContain(H2.slice(2)); // only switch 12's top-up is left
  });

  it.each(["markDark", "revealKey"] as const)("%s: a second one for the same switch is refused while the first is pending", async (fn) => {
    const storage = new Mem();
    const { client } = chain();
    const first = tracking(storage, client, fn, 0n);
    void runWrite(async () => H1, client, async () => {}, {}, first.track).catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const second = vi.fn(async () => H2);
    await expect(runWrite(second, client, async () => {}, {}, tracking(storage, client, fn, 0n).track)).rejects.toBeInstanceOf(WriteInFlightError);
    expect(second).not.toHaveBeenCalled();
  });

  it("a revert ends the record too (the action may be retried), and a rejection in the wallet records nothing", async () => {
    const storage = new Mem();
    const { client } = chain();
    const failing = { ...client, waitForTransactionReceipt: async () => receipt("reverted") } as unknown as PublicClient;
    const t = tracking(storage, failing, "markDark", 0n);
    await expect(runWrite(async () => H1, failing, async () => {}, {}, t.track)).rejects.toThrow(/reverted/);
    expect(t.store.all()).toEqual([]);
    await expect(runWrite(async () => { throw new UserRejectedRequestError(new Error("no")); }, failing, async () => {}, {}, t.track)).rejects.toBeDefined();
    expect(t.store.all()).toEqual([]);
  });

  it("the deadline counts from the original send, across a reload", async () => {
    const storage = new Mem();
    const { client } = chain();
    const t = tracking(storage, client);
    const w: PendingWrite = { ...target("fundBounty"), hash: H1, from: FUNDER, nonce: 7, value: ONE_ETH, sentAt: Date.now() - (WRITE_WAIT_MS - 60_000), stakeBefore: null, call: null };
    t.store.put(w);
    const out: { error?: Error } = {};
    t.follower.follow(client, w).catch((e: Error) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(out.error?.message).toMatch(/still not confirmed/);
    expect(t.store.all()).toEqual([]);
  });
});

describe("K5: a resumed wait stops when nothing shows the write any more, and the record is kept for the next page", () => {
  it("releasing the last holder aborts the wait: no more RPC calls, WriteDetachedError, record kept", async () => {
    const storage = new Mem();
    const { client, st } = chain();
    const watchers = createWriteWatchers<TransactionReceipt | null>(1_000);
    const store = createPendingWriteStore(() => storage);
    const follower = createWriteFollower(store, watchers);
    const w: PendingWrite = { ...target("fundBounty"), hash: H1, from: FUNDER, nonce: 7, value: ONE_ETH, sentAt: Date.now(), stakeBefore: null, call: null };
    store.put(w);
    const release = watchers.retain(writeKey(w, w.from));
    const out: { error?: unknown } = {};
    follower.follow(client, w, { resumed: true }).catch((e: unknown) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(10_000);
    release(); // the component unmounted
    await vi.advanceTimersByTimeAsync(2_000);
    expect(out.error).toBeInstanceOf(WriteDetachedError);
    expect(store.get(writeKey(w, w.from))).toMatchObject({ hash: H1 });
    // Within one receipt-wait slice nothing is polling any more.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(st.waits).toBe(0);
  });

  it("a remount within the grace period keeps the same wait", async () => {
    const watchers = createWriteWatchers<number>(1_000);
    let starts = 0;
    const r1 = watchers.retain("k");
    const p = watchers.join("k", H1, (signal) => { starts++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new WriteDetachedError()))); });
    p.catch(() => {});
    r1();
    const r2 = watchers.retain("k");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchers.running("k")).toBe(true);
    void watchers.join("k", H1, () => { starts++; return new Promise(() => {}); });
    expect(starts).toBe(1);
    r2();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchers.running("k")).toBe(false);
  });
});

describe("F2: a top-up whose wallet answer was lost (it may have been broadcast)", () => {
  /** viem's wrapping of a wallet's internal error (-32603) without revert data: what WalletConnect / a failing wallet RPC gives. */
  const lostAnswer = () => getContractError(
    new InternalRpcError(Object.assign(new Error("the transaction was broadcast, then the response was lost"), { code: -32603 })) as BaseError,
    { abi: dmsAbi, functionName: "fundBounty", args: [OWNER, 11n], address: CONTRACT },
  );

  it("is not reported as a revert; it is recorded without a hash and blocks another top-up of the switch", async () => {
    const storage = new Mem();
    const { client } = chain();
    const t = tracking(storage, client);
    const refresh = vi.fn(async () => {});
    const e = await runWrite(async () => { throw lostAnswer(); }, client, refresh, {}, t.track).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WriteUnconfirmedError);
    expect((e as Error).message).not.toMatch(/revert/i);
    expect((e as Error).message).toMatch(/check your wallet/i);
    expect(refresh).toHaveBeenCalled();
    const w = t.store.get(writeKey(target("fundBounty"), FUNDER));
    expect(w).toMatchObject({ hash: null, from: FUNDER, nonce: 7, value: ONE_ETH, stakeBefore: 0n, call: null });
    // A reload, then "Add ETH" again: refused before the wallet.
    const again = vi.fn(async () => H2);
    await expect(runWrite(again, client, async () => {}, {}, tracking(storage, client).track)).rejects.toBeInstanceOf(WriteInFlightError);
    expect(again).not.toHaveBeenCalled();
  });

  it("an ambiguous answer to a write that carries no value is not recorded (a duplicate can only revert)", async () => {
    const storage = new Mem();
    const { client } = chain();
    const t = tracking(storage, client, "markDark", 0n);
    await expect(runWrite(async () => { throw lostAnswer(); }, client, async () => {}, {}, t.track)).rejects.toBeDefined();
    expect(t.store.all()).toEqual([]);
  });

  /** The funder's stake and mined nonce as the page reads them. */
  const topUpChain = (o: { stakeAt: (t: number) => bigint; nonceAt: (t: number) => number }) => {
    const t0 = Date.now();
    return {
      chain: { id: 11155111 },
      readContract: async () => o.stakeAt(Date.now() - t0),
      getTransactionCount: async () => o.nonceAt(Date.now() - t0),
    } as unknown as PublicClient;
  };
  const unconfirmed: PendingWrite = { ...target("fundBounty"), hash: null, from: FUNDER, nonce: 7, value: ONE_ETH, sentAt: 1_700_000_000_000, stakeBefore: 2n, call: null };

  it("it landed: the stake grew by the top-up, so the wait ends as a success", async () => {
    const client = topUpChain({ stakeAt: (t) => (t > 25_000 ? 2n + ONE_ETH : 2n), nonceAt: (t) => (t > 25_000 ? 8 : 7) });
    const out: { value?: unknown; error?: unknown } = {};
    waitForUnconfirmedTopUp(client, unconfirmed).then((v) => { out.value = v; }, (e: unknown) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(out.error).toBeUndefined();
    expect(out.value).toBeNull();
  });

  it("the account's nonce moved and the stake did not grow: not this top-up (a verdict that tells the user to check the wallet)", async () => {
    const client = topUpChain({ stakeAt: () => 2n, nonceAt: (t) => (t > 25_000 ? 8 : 7) });
    const out: { error?: Error } = {};
    waitForUnconfirmedTopUp(client, unconfirmed).catch((e: Error) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(25_000 + (UNCONFIRMED_NONCE_CHECKS + 1) * 10_000);
    expect(out.error?.message).toMatch(/check your wallet/i);
    expect(out.error?.message).not.toMatch(/send it again/i);
  });

  it("aborted (nothing shows it any more): WriteDetachedError", async () => {
    const client = topUpChain({ stakeAt: () => 2n, nonceAt: () => 7 });
    const ac = new AbortController();
    const p = waitForUnconfirmedTopUp(client, unconfirmed, ac.signal);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(WriteDetachedError);
  });
});

describe("K2: a top-up the app's RPC never saw is not called safe to send again", () => {
  it("dropped verdict for a value-carrying write: says the app cannot see it and to check the wallet first", async () => {
    const storage = new Mem();
    const node = {
      chain: { id: 11155111 },
      waitForTransactionReceipt: ({ timeout }: { timeout: number }) => new Promise((_, reject) => setTimeout(() => reject(new WaitForTransactionReceiptTimeoutError({ hash: H1 })), timeout)),
      getTransaction: async () => { throw new TransactionNotFoundError({ hash: H1 }); },
      getTransactionReceipt: async () => { throw new TransactionReceiptNotFoundError({ hash: H1 }); },
      getTransactionCount: async () => 7,
    } as unknown as PublicClient;
    const t = tracking(storage, node);
    const out: { error?: Error } = {};
    runWrite(async () => H1, node, async () => {}, {}, t.track).catch((e: Error) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(out.error?.message).toContain(H1);
    expect(out.error?.message).not.toMatch(/send it again/i);
    expect(out.error?.message).toMatch(/can(no|')t see/i);
    expect(out.error?.message).toMatch(/check your wallet/i);
    // Re-enabled (the record ended), with the warning kept by the caller.
    expect(t.store.all()).toEqual([]);
  });
});

describe("a stuck ping or cancel: the owner is pointed at the wallet's speed-up, not told to wait", () => {
  it.each(["ping", "cancel"] as const)("%s: the refusal says to speed it up in the wallet, since a second one would queue behind it", async (fn) => {
    const storage = new Mem();
    const { client } = chain();
    void runWrite(async () => H1, client, async () => {}, {}, tracking(storage, client, fn, 0n).track).catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await runWrite(async () => H2, client, async () => {}, {}, tracking(storage, client, fn, 0n).track).catch((e: unknown) => e);
    expect(out).toBeInstanceOf(WriteInFlightError);
    expect((out as Error).message).toMatch(/speed it up/i);
    expect((out as Error).message).not.toMatch(/Wait for it/);
  });

  it("a top-up still says to wait: speeding it up is not urgent and resending would pay twice", () => {
    const w: PendingWrite = { ...target("fundBounty"), hash: H1, from: FUNDER, nonce: 7, value: ONE_ETH, sentAt: 1, stakeBefore: null, call: null };
    expect(new WriteInFlightError(w).message).toMatch(/Wait for it/);
  });
});

// ---------- real viem receipt waits against a fake chain ----------

/** Settle `p` while advancing fake time in 1 s steps (real viem polls on the fake chain meanwhile). */
const settle = async <T,>(p: Promise<T>, maxMs: number) => {
  const out: { value?: T; error?: Error; atMs?: number } = {};
  const t0 = Date.now();
  p.then((v) => { out.value = v; out.atMs = Date.now() - t0; }, (e: Error) => { out.error = e; out.atMs = Date.now() - t0; });
  for (let t = 0; t < maxMs && !("value" in out) && !out.error; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
  return out;
};

describe("a run's own wait outlives the component that showed the write", () => {
  it("a front-run revealKey: the panel unmounts mid-wait, and the revert is still reported and the record ends", async () => {
    const c = fakeChain();
    const store = createPendingWriteStore(() => new Mem());
    const watchers = createWriteWatchers<TransactionReceipt | null>();
    const follower = createWriteFollower(store, watchers);
    const t = target("revealKey", 7n);
    const OURS: FakeTx = { hash: H1, from: FUNDER, to: CONTRACT, nonce: 3, input: "0xdeadbeef", value: 0n, fee: 1n, reverted: true };
    const shown = watchers.retain(writeKey(t)); // RevealPanel follows the write
    const p = runWrite(async () => { c.broadcast(OURS); c.mineAt(OURS, 20_000); return OURS.hash; }, c.client, async () => {}, {}, {
      store, target: t, value: 0n, from: FUNDER, watch: (w) => follower.follow(c.client, w),
    });
    const out: { value?: unknown; error?: Error } = {};
    p.then((v) => { out.value = v; }, (e: Error) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(15_000);
    shown(); // a competitor's reveal landed: the card swaps RevealPanel for RevealedView
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    c.stop();
    expect(out.error?.message).toMatch(/reverted/);
    expect(store.all()).toEqual([]);
  });

  it("a resumed wait (no run behind it) still stops when nothing shows it", async () => {
    const c = fakeChain();
    const store = createPendingWriteStore(() => new Mem());
    const watchers = createWriteWatchers<TransactionReceipt | null>();
    const follower = createWriteFollower(store, watchers);
    const w: PendingWrite = { ...target("markDark", 7n), hash: H1, from: FUNDER, nonce: 3, value: 0n, sentAt: Date.now(), stakeBefore: null, call: null };
    store.put(w);
    const shown = watchers.retain(writeKey(w));
    const out = settle(follower.follow(c.client, w, { resumed: true }), 0);
    await vi.advanceTimersByTimeAsync(10_000);
    shown();
    await vi.advanceTimersByTimeAsync(5_000);
    c.stop();
    expect((await out).error).toBeInstanceOf(WriteDetachedError);
    expect(store.get(writeKey(w))).not.toBeNull();
  });
});

describe("time in the wallet prompt is not charged to the receipt wait", () => {
  const T1: FakeTx = { hash: H1, from: OWNER, to: CONTRACT, nonce: 5, input: "0x5c36b186", value: 10n ** 16n, fee: 1_000_000_000n };
  const t = { ...target("fundBounty", 1n) };
  const scenario = async (o: { promptMs: number; visibleToRpc: boolean; minedAfterSendMs: number }) => {
    const c = fakeChain();
    const store = createPendingWriteStore(() => new Mem());
    const watchers = createWriteWatchers<TransactionReceipt | null>();
    const follower = createWriteFollower(store, watchers);
    const send = () => new Promise<Hex>((resolve) => setTimeout(() => {
      if (o.visibleToRpc) c.broadcast(T1);
      c.mineAt(T1, c.nowMs() + o.minedAfterSendMs);
      resolve(T1.hash);
    }, o.promptMs));
    const out = await settle(runWrite(send, c.client, async () => {}, {}, {
      store, target: t, value: T1.value, from: OWNER, watch: (w) => follower.follow(c.client, w),
      before: async () => ({ nonce: 5, stakeBefore: 0n, call: null }),
    }), 70 * 60_000);
    c.stop();
    return out;
  };

  it("a prompt left open 31 minutes, then approved and mined 24 s later: success, not 'still not confirmed'", async () => {
    const r = await scenario({ promptMs: 31 * 60_000, visibleToRpc: true, minedAfterSendMs: 24_000 });
    expect(r.error).toBeUndefined();
    expect(r.value).toMatchObject({ hash: H1 });
  });

  it("a 3-minute prompt, then a private send mined 4 minutes later: success, not 'dropped'", async () => {
    const r = await scenario({ promptMs: 3 * 60_000, visibleToRpc: false, minedAfterSendMs: 4 * 60_000 });
    expect(r.error).toBeUndefined();
    expect(r.value).toMatchObject({ hash: H1 });
  });

  it("a top-up whose wallet answer was lost after a long prompt is stamped when the wallet answered", async () => {
    const storage = new Mem();
    const { client } = chain();
    const tr = tracking(storage, client);
    const asked = Date.now();
    const lost = () => new Promise<Hex>((_, reject) => setTimeout(() => reject(
      getContractError(new InternalRpcError(Object.assign(new Error("lost"), { code: -32603 })) as BaseError,
        { abi: dmsAbi, functionName: "fundBounty", args: [OWNER, 11n], address: CONTRACT })), 20 * 60_000));
    void runWrite(lost, client, async () => {}, {}, tr.track).catch(() => {});
    await vi.advanceTimersByTimeAsync(20 * 60_000 + 1_000);
    const w = tr.store.all()[0];
    expect(w?.hash).toBeNull();
    expect(w!.sentAt).toBeGreaterThanOrEqual(asked + 20 * 60_000);
  });

  it("a persisted send time in the future counts as now: the drop check and the deadline still run", async () => {
    const node = {
      chain: { id: 11155111 },
      waitForTransactionReceipt: ({ timeout }: { timeout: number }) => new Promise((_, reject) => setTimeout(() => reject(new WaitForTransactionReceiptTimeoutError({ hash: H1 })), timeout)),
      getTransaction: async () => { throw new TransactionNotFoundError({ hash: H1 }); },
      getTransactionReceipt: async () => { throw new TransactionReceiptNotFoundError({ hash: H1 }); },
      getTransactionCount: async () => 7,
    } as unknown as PublicClient;
    const store = createPendingWriteStore(() => new Mem());
    const follower = createWriteFollower(store, createWriteWatchers<TransactionReceipt | null>());
    const w: PendingWrite = { ...target("markDark", 7n), hash: H1, from: FUNDER, nonce: null, value: 0n, sentAt: Date.now() + 24 * 3_600_000, stakeBefore: null, call: null };
    store.put(w);
    const r = await settle(follower.follow(node, w), 10 * 60_000);
    expect(r.error?.name).toBe("TxDroppedError");
  });
});

describe("a lost-answer top-up without a stake baseline gets no verdict from the nonce alone", () => {
  it("the stake read failed before the send; the nonce moved (maybe by this very top-up): no 'not on the switch'", async () => {
    const client = {
      chain: { id: 11155111 },
      readContract: async () => ONE_ETH, // the stake now includes the top-up
      getTransactionCount: async () => 8, // nonce 7 was used (by the top-up)
      getBlockNumber: async () => 100n,
    } as unknown as PublicClient;
    const w: PendingWrite = { ...target("fundBounty"), hash: null, from: FUNDER, nonce: 7, value: ONE_ETH, sentAt: Date.now(), stakeBefore: null, call: null };
    const out: { value?: unknown; error?: Error } = {};
    waitForUnconfirmedTopUp(client, w).then((v) => { out.value = v; }, (e: Error) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(out.error).toBeUndefined();
    // Still nothing to conclude at the deadline: it says so instead of claiming it is not on the switch.
    await vi.advanceTimersByTimeAsync(WRITE_WAIT_MS);
    expect(out.error?.message).toMatch(/check your wallet/i);
    expect(out.error?.message).not.toMatch(/not on the switch|has not shown up/i);
  });
});

describe("a top-up in flight blocks only its sender", () => {
  it("account A's pending top-up does not block account B's; it still blocks A's second one; markDark stays one per switch", async () => {
    const storage = new Mem();
    const { client } = chain();
    const a = tracking(storage, client);
    void runWrite(async () => H1, client, async () => {}, {}, a.track).catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const bSend = vi.fn(async () => H2);
    void runWrite(bSend, client, async () => {}, {}, { ...a.track, from: OWNER }).catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bSend).toHaveBeenCalledTimes(1);
    const aAgain = vi.fn(async () => H2);
    await expect(runWrite(aAgain, client, async () => {}, {}, a.track)).rejects.toBeInstanceOf(WriteInFlightError);
    expect(aAgain).not.toHaveBeenCalled();

    const mark = tracking(storage, client, "markDark", 0n);
    void runWrite(async () => `0x${"33".repeat(32)}` as Hex, client, async () => {}, {}, mark.track).catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const otherHunter = vi.fn(async () => H2);
    await expect(runWrite(otherHunter, client, async () => {}, {}, { ...mark.track, from: OWNER })).rejects.toBeInstanceOf(WriteInFlightError);
    expect(otherHunter).not.toHaveBeenCalled();
  });
});
