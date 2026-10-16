// The create flow's chain reads (observeAttempt, readAttemptFresh) against a
// fake RPC whose "latest" state lags its receipts, as a load-balanced RPC can.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionRevertedError, TransactionNotFoundError, TransactionReceiptNotFoundError, UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError, encodeErrorResult, type Hex, type PublicClient, type TransactionReceipt,
} from "viem";
import { dmsAbi } from "./abi";
import {
  REVERTED_RECHECK_MS, classifyAttempt, deriveCreateView, submitBlock,
  type AttemptOutcome, type CreateAttempt, type CreateContext,
} from "./createAttempt";
import {
  DROP_GRACE_MS, READ_FLOOR_MS, chainClockMs, chainNowSec, nextChainClock, TxDroppedError, WAIT_SLICE_MS, WRITE_WAIT_MS, newAttemptPollMemory, noteWriteMined, readFunderStake, readSwitchInfo,
  runWrite, switchInfoPollMs, observeAttempt, pollAttempt, readAttemptFresh, restartRechecks, waitForWrite,
} from "./hooks";
import { ContractState, ZERO_ADDRESS, ZERO_BYTES32, toSwitchInfo, type RawSwitchInfo } from "./switch";
import { fakeChain, type FakeTx } from "./fakeChain.testutil";
import { keccak256 } from "viem";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const H1 = `0x${"11".repeat(32)}` as Hex;
const A: CreateAttempt = { chainId: 11155111, contract: CONTRACT, owner: OWNER, id: 42n, submitted: true, hash: H1 };

const raw = (exists: boolean): RawSwitchInfo => ({
  owner: exists ? OWNER : ZERO_ADDRESS, state: exists ? 1 : 0,
  lastPing: 0n, pingInterval: exists ? 86400n : 0n, createdAt: 0n, expiresAt: 0n, darkMarkedAt: 0n, revealedAt: 0n,
  bounty: 0n, ownerStake: 0n, plaintextCommitment: ZERO_BYTES32, encKeyHandle: ZERO_BYTES32, revealedKey: ZERO_BYTES32,
  ciphertextLength: 0n, published: false, rescuable: false,
});

/**
 * An earlier send of switch 42 landed in block `createdIn`; H1 reverted
 * (AlreadyExists) in block `revertedIn`. "latest" reads come from a node at
 * `staleHead`, and getBlockNumber reports `head`.
 */
const fakeRpc = (o: { createdIn: bigint; revertedIn: bigint; staleHead: bigint; head: bigint }) => {
  const reads: (bigint | "latest")[] = [];
  const client = {
    readContract: async ({ blockNumber }: { blockNumber?: bigint }) => {
      reads.push(blockNumber ?? "latest");
      return raw((blockNumber ?? o.staleHead) >= o.createdIn);
    },
    getTransactionReceipt: async () => ({ status: "reverted", blockNumber: o.revertedIn }),
    getBlockNumber: async () => o.head,
    getTransaction: async () => ({}),
  } as unknown as PublicClient;
  return { client, reads };
};

describe("R3: a reverted receipt is confirmed at a block no older than the receipt", () => {
  it("a lagging 'latest' read next to H1's reverted receipt reads as landed, not reverted", async () => {
    // getBlockNumber also answers from the lagging node: only the receipt's block is a safe floor.
    const { client, reads } = fakeRpc({ createdIn: 100n, revertedIn: 100n, staleHead: 99n, head: 99n });
    const { obs, info } = await observeAttempt(client, A, 0);
    expect(classifyAttempt(A, obs)).toBe("landed");
    expect(info).toMatchObject({ exists: true, pingInterval: 86400n });
    expect(reads).toEqual(["latest", 100n]);
  });

  it("with no switch at the receipt's block either, it stays reverted", async () => {
    const { client } = fakeRpc({ createdIn: 1_000n, revertedIn: 100n, staleHead: 99n, head: 120n });
    const { obs } = await observeAttempt(client, A, 0);
    expect(classifyAttempt(A, obs)).toBe("reverted");
  });

  it("a confirming read that fails is unknown, not reverted", async () => {
    const { client } = fakeRpc({ createdIn: 100n, revertedIn: 100n, staleHead: 99n, head: 99n });
    let n = 0;
    const failing = { ...client, readContract: async (x: never) => (n++ === 0 ? client.readContract(x) : Promise.reject(new Error("header not found"))) };
    const { obs } = await observeAttempt(failing as unknown as PublicClient, A, 0);
    expect(classifyAttempt(A, obs)).toBe("unknown");
  });

  it("readAttemptFresh (the re-check before an attempt is dropped) reads at max(head, receipt block)", async () => {
    const lagging = fakeRpc({ createdIn: 100n, revertedIn: 100n, staleHead: 99n, head: 99n });
    expect(await readAttemptFresh(lagging.client, A)).toMatchObject({ exists: true });
    expect(lagging.reads).toEqual([100n]);
    const ahead = fakeRpc({ createdIn: 100n, revertedIn: 100n, staleHead: 99n, head: 130n });
    await readAttemptFresh(ahead.client, A);
    expect(ahead.reads).toEqual([130n]);
    // No hash: the head the RPC reports.
    const noHash = fakeRpc({ createdIn: 100n, revertedIn: 100n, staleHead: 99n, head: 101n });
    expect(await readAttemptFresh(noHash.client, { ...A, hash: null })).toMatchObject({ exists: true });
    expect(noHash.reads).toEqual([101n]);
  });
});

describe("Q2: once 'reverted' is shown, only a landed switch changes it, and the re-checks stop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** H1 reverted in block 100. `fail`: every call gets a 429; `exists`: an earlier send of the id created the switch. */
  const scriptedRpc = () => {
    const st = { fail: false, exists: false, calls: 0 };
    const answer = <T,>(v: T): Promise<T> => {
      st.calls++;
      return st.fail
        ? Promise.reject(Object.assign(new Error("429 Too Many Requests"), { name: "HttpRequestError" }))
        : Promise.resolve(v);
    };
    const client = {
      readContract: () => answer(raw(st.exists)),
      getTransactionReceipt: () => answer({ status: "reverted", blockNumber: 100n }),
      getBlockNumber: () => answer(105n),
      getTransaction: () => answer({}),
    } as unknown as PublicClient;
    return { st, client };
  };

  const CTX: CreateContext = { chainId: A.chainId, contract: A.contract, owner: A.owner };
  const OTHER: CreateContext = { ...CTX, owner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" };
  /** CreateSwitchForm's router for `outcome`, seen from the sending account and from another one. */
  const card = (outcome: AttemptOutcome) => {
    // After a receipt timeout (R3) the last create() run left the local stage "unconfirmed".
    const view = deriveCreateView({ local: "unconfirmed", localError: null, attempt: A, outcome, created: false });
    const route = (ctx: CreateContext) => {
      const block = submitBlock(A, ctx, outcome);
      return view.stage === "unconfirmed" || block === "pending" ? "UnconfirmedCard"
        : block === "other-account" ? "OtherAccountCard" : `CreateForm:${view.stage}`;
    };
    return `${route(CTX)} / ${route(OTHER)}`;
  };
  const RETRY = "CreateForm:error / OtherAccountCard";

  it("a later failed poll read keeps the retry form, and polling backs off, then stops", async () => {
    const { st, client } = scriptedRpc();
    const shown: string[] = [];
    let landed = false;
    const stop = pollAttempt(client, A, newAttemptPollMemory(), {
      landed: () => { landed = true; },
      show: (o) => shown.push(card(o)),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shown).toEqual([RETRY]);
    // Poll 2: every read is rate limited.
    st.fail = true;
    await vi.advanceTimersByTimeAsync(REVERTED_RECHECK_MS[0]!);
    st.fail = false;
    expect(shown).toEqual([RETRY, RETRY]);
    // The rest of the re-checks, and long after: no more polls, no more RPC calls.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(shown).toEqual(Array(1 + REVERTED_RECHECK_MS.length).fill(RETRY));
    const calls = st.calls;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(st.calls).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
    expect(landed).toBe(false);
    stop();
  });

  it("'Check again' runs the re-checks again; a switch an earlier send created is still adopted", async () => {
    const { st, client } = scriptedRpc();
    const mem = newAttemptPollMemory();
    const shown: string[] = [];
    let landed = false;
    const on = { landed: () => { landed = true; }, show: (o: AttemptOutcome) => shown.push(card(o)) };
    const stop1 = pollAttempt(client, A, mem, on);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    stop1();
    expect(shown).toHaveLength(1 + REVERTED_RECHECK_MS.length);
    // The owner clicks "Check again" (checkNow): the poll restarts with its re-checks.
    restartRechecks(mem);
    st.fail = true;
    const stop2 = pollAttempt(client, A, mem, on);
    await vi.advanceTimersByTimeAsync(0);
    st.fail = false;
    expect(shown.at(-1)).toBe(RETRY);
    expect(vi.getTimerCount()).toBe(1);
    st.exists = true;
    await vi.advanceTimersByTimeAsync(REVERTED_RECHECK_MS[0]!);
    expect(landed).toBe(true);
    expect(shown.every((x) => x === RETRY)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    stop2();
  });

  it("before any revert, a failed read still shows 'unknown' (waiting), polled every 10 s", async () => {
    const { st, client } = scriptedRpc();
    st.fail = true;
    const shown: AttemptOutcome[] = [];
    const stop = pollAttempt(client, A, newAttemptPollMemory(), { landed: () => {}, show: (o) => shown.push(o) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    stop();
  });
});

describe("waitForWrite: the receipt wait behind every write hook (ping, fund, cancel, mark, reveal, publish, admin)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const HASH = `0x${"ab".repeat(32)}` as Hex;
  const SENDER = OWNER;
  const receipt = (status: "success" | "reverted") => ({ status, blockNumber: 100n, transactionHash: HASH }) as unknown as TransactionReceipt;
  type Step = (p: { onReplaced?: (r: { reason: string }) => void; timeout?: number }) => Promise<TransactionReceipt>;
  /** Successive receipt waits play `steps`. The tx stays known to the node (pending), so nothing reads as dropped. */
  const scripted = (steps: Step[]) => {
    let calls = 0;
    const client = {
      waitForTransactionReceipt: (p: never) => steps[Math.min(calls++, steps.length - 1)]!(p),
      getTransaction: async () => ({ from: SENDER, nonce: 5 }),
      getTransactionReceipt: async () => { throw new TransactionReceiptNotFoundError({ hash: HASH }); },
      getTransactionCount: async () => 5,
    } as unknown as PublicClient;
    return { client, calls: () => calls };
  };
  /** viem's own behaviour: no receipt within `timeout` → WaitForTransactionReceiptTimeoutError. */
  const timesOut: Step = (p) => new Promise((_, reject) =>
    setTimeout(() => reject(new WaitForTransactionReceiptTimeoutError({ hash: HASH })), p.timeout ?? 180_000));
  /** Settle `p` while advancing fake time by `ms`; returns the outcome and when it settled. */
  const settle = async <T,>(p: Promise<T>, ms: number) => {
    const t0 = Date.now();
    const out: { value?: T; error?: Error; atMs?: number } = {};
    p.then((v) => { out.value = v; out.atMs = Date.now() - t0; }, (e: Error) => { out.error = e; out.atMs = Date.now() - t0; });
    await vi.advanceTimersByTimeAsync(ms);
    return out;
  };

  it("a wallet 'cancel' (0-value self-send at the same nonce) is not reported as success", async () => {
    const s = scripted([async (p) => { p.onReplaced?.({ reason: "cancelled" }); return receipt("success"); }]);
    expect((await settle(waitForWrite(s.client, HASH), 1_000)).error?.message).toMatch(/cancelled or replaced/);
  });

  it("a replacement by a different transaction is not reported as success either", async () => {
    const s = scripted([async (p) => { p.onReplaced?.({ reason: "replaced" }); return receipt("success"); }]);
    expect((await settle(waitForWrite(s.client, HASH), 1_000)).error?.message).toMatch(/cancelled or replaced/);
  });

  it("a speed-up (same call, higher fee) is the same write: its receipt counts", async () => {
    const s = scripted([async (p) => { p.onReplaced?.({ reason: "repriced" }); return receipt("success"); }]);
    expect((await settle(waitForWrite(s.client, HASH), 1_000)).value).toMatchObject({ status: "success" });
  });

  it("viem's receipt timeouts are not a failure while the tx is pending: it keeps waiting, so the UI does not offer a second send", async () => {
    const s = scripted([timesOut, timesOut, async () => receipt("success")]);
    const out = await settle(waitForWrite(s.client, HASH), 15 * 60_000);
    expect(out.value).toMatchObject({ status: "success" });
    expect(s.calls()).toBe(3);
  });

  it("an RPC hiccup during the wait (429, node down) keeps waiting too", async () => {
    const s = scripted([async () => { throw new Error("HTTP request failed. Status: 429"); }, async () => receipt("success")]);
    expect((await settle(waitForWrite(s.client, HASH), 60_000)).value).toMatchObject({ status: "success" });
  });

  it("a tx still pending after WRITE_WAIT_MS: gives up with 'not confirmed', names the tx, warns against resending", async () => {
    const s = scripted([timesOut]);
    const out = await settle(waitForWrite(s.client, HASH), WRITE_WAIT_MS + 60_000);
    expect(out.error?.message).toMatch(/not confirmed/);
    expect(out.error?.message).toContain(HASH);
    expect(out.error?.message).toMatch(/before sending it again/);
    expect(out.atMs).toBeGreaterThanOrEqual(WRITE_WAIT_MS);
  });

  it("a mined revert is still a failure", async () => {
    const s = scripted([async () => receipt("reverted")]);
    expect((await settle(waitForWrite(s.client, HASH), 1_000)).error?.message).toMatch(/reverted/);
  });

  // ---------- dropped transactions ----------

  /**
   * A node's view of one tx over time (ms since the send): known in the mempool while `known(t)`, mined
   * at `minedAt`, and the sender's mined nonce past the tx's from `nonceUsedAt` (another tx took it).
   * Receipt waits behave like viem's: they resolve when mined, else time out.
   */
  const node = (o: { known: (t: number) => boolean | "error"; minedAt?: number; nonceUsedAt?: number }) => {
    const t0 = Date.now();
    const at = () => Date.now() - t0;
    const mined = () => o.minedAt !== undefined && at() >= o.minedAt;
    let checks = 0;
    const client = {
      waitForTransactionReceipt: ({ timeout }: { timeout: number }) => new Promise((resolve, reject) => {
        const iv = setInterval(() => { if (mined()) { clearInterval(iv); clearTimeout(to); resolve(receipt("success")); } }, 4_000);
        const to = setTimeout(() => { clearInterval(iv); reject(new WaitForTransactionReceiptTimeoutError({ hash: HASH })); }, timeout);
      }),
      getTransaction: async () => {
        checks++;
        const k = o.known(at());
        if (k === "error") throw new Error("HTTP request failed. Status: 429");
        if (k || mined()) return { from: SENDER, nonce: 5 };
        throw new TransactionNotFoundError({ hash: HASH });
      },
      getTransactionReceipt: async () => {
        if (mined()) return receipt("success");
        throw new TransactionReceiptNotFoundError({ hash: HASH });
      },
      getTransactionCount: async () => (o.nonceUsedAt !== undefined && at() >= o.nonceUsedAt ? 6 : 5),
    } as unknown as PublicClient;
    return { client, checks: () => checks };
  };

  it("a tx the network forgot (dropped, never mined): a distinct 'dropped' error after about 5 minutes, so the action is offered again", async () => {
    const n = node({ known: (t) => t < 60_000 });
    const out = await settle(waitForWrite(n.client, HASH), 10 * 60_000);
    expect(out.error).toBeInstanceOf(TxDroppedError);
    expect(out.error?.message).toContain(HASH);
    expect(out.error?.message).toMatch(/not mined/);
    expect(out.error?.message).toMatch(/send it again/);
    expect(out.error?.message).toMatch(/wallet still lists it as pending/);
    expect(out.atMs).toBeGreaterThanOrEqual(DROP_GRACE_MS);
    expect(out.atMs).toBeLessThanOrEqual(6 * 60_000);
  });

  it("never seen by this node at all (sent privately) and never mined: also 'dropped' after about 5 minutes", async () => {
    const n = node({ known: () => false });
    const out = await settle(waitForWrite(n.client, HASH), 10 * 60_000);
    expect(out.error).toBeInstanceOf(TxDroppedError);
  });

  it("a tx pending in the mempool for 29 minutes, then mined: never called dropped", async () => {
    const n = node({ known: () => true, minedAt: 29 * 60_000 });
    const out = await settle(waitForWrite(n.client, HASH), 30 * 60_000);
    expect(out.value).toMatchObject({ status: "success" });
  });

  it("the node forgetting it briefly (a few checks), or failing the checks (429), does not count as dropped", async () => {
    const blip = node({ known: (t) => t < 3 * 60_000 || t > 4 * 60_000, minedAt: 9 * 60_000 });
    expect((await settle(waitForWrite(blip.client, HASH), 10 * 60_000)).value).toMatchObject({ status: "success" });
    const failing = node({ known: (t) => (t < 60_000 ? true : "error"), minedAt: 12 * 60_000 });
    expect((await settle(waitForWrite(failing.client, HASH), 13 * 60_000)).value).toMatchObject({ status: "success" });
  });

  it("gone because another tx used its nonce (a replacement the receipt wait missed): not 'dropped, send again'", async () => {
    const n = node({ known: (t) => t < 60_000, nonceUsedAt: 90_000 });
    const out = await settle(waitForWrite(n.client, HASH), 10 * 60_000);
    expect(out.error).toBeDefined();
    expect(out.error).not.toBeInstanceOf(TxDroppedError);
    expect(out.error?.message).toMatch(/replaced/);
    expect(out.error?.message).not.toMatch(/send it again/);
  });

  it("during the grace period, one early look only (to learn the tx's sender and nonce); then every 15 s at most", async () => {
    const n = node({ known: () => true });
    void waitForWrite(n.client, HASH).catch(() => {});
    await vi.advanceTimersByTimeAsync(DROP_GRACE_MS - 1_000);
    expect(n.checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000 + 1_000);
    expect(n.checks()).toBeLessThanOrEqual(6);
  });
});

describe("K1: a receipt that arrived while the last check ran wins over a 'dropped' / 'replaced' verdict", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const HASH = `0x${"ab".repeat(32)}` as Hex;
  const ok = { status: "success", blockNumber: 100n, transactionHash: HASH } as unknown as TransactionReceipt;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * The receipt wait polls an up-to-date node every second; the drop checks' reads take `readMs` and go to a
   * node `lagMs` behind that never had the tx in its pool. The tx is mined 0.5 s into the `mineOnCheck`th check
   * after the grace period (the one that would give the verdict).
   */
  const node = (o: { seenEarly: boolean; readMs: number; lagMs: number; mineOnCheck?: number }) => {
    const t0 = Date.now();
    const at = () => Date.now() - t0;
    let minedAt = Number.MAX_SAFE_INTEGER;
    const live = { waits: 0, checks: [] as number[], waitsStarted: 0 };
    const client = {
      waitForTransactionReceipt: ({ timeout }: { timeout: number }) => new Promise((resolve, reject) => {
        live.waits++; live.waitsStarted++;
        const iv = setInterval(() => { if (at() >= minedAt) { clearInterval(iv); clearTimeout(to); live.waits--; resolve(ok); } }, 1_000);
        const to = setTimeout(() => { clearInterval(iv); live.waits--; reject(new WaitForTransactionReceiptTimeoutError({ hash: HASH })); }, timeout);
      }),
      getTransaction: async () => {
        const t = at(); live.checks.push(t);
        if (live.checks.filter((c) => c >= DROP_GRACE_MS).length === o.mineOnCheck) minedAt = t + 500;
        await sleep(o.readMs);
        if (o.seenEarly && t < 30_000) return { from: OWNER, nonce: 5 };
        if (t >= minedAt + o.lagMs) return { from: OWNER, nonce: 5 };
        throw new TransactionNotFoundError({ hash: HASH });
      },
      getTransactionReceipt: async () => {
        const t = at(); await sleep(o.readMs);
        if (t >= minedAt + o.lagMs) return ok;
        throw new TransactionReceiptNotFoundError({ hash: HASH });
      },
      getTransactionCount: async () => (at() >= minedAt ? 6 : 5),
    } as unknown as PublicClient;
    return { client, live };
  };

  const settle = async <T,>(p: Promise<T>, ms: number) => {
    const out: { value?: T; error?: Error } = {};
    p.then((v) => { out.value = v; }, (e: Error) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(ms);
    return out;
  };

  it("never seen by the app's RPC, mined during the 12th check: the receipt, not 'dropped, send it again'", async () => {
    const n = node({ seenEarly: false, readMs: 3_500, lagMs: 12_000, mineOnCheck: 12 });
    const out = await settle(waitForWrite(n.client, HASH), 10 * 60_000);
    expect(out.error).toBeUndefined();
    expect(out.value).toMatchObject({ status: "success" });
  });

  it("seen at the first look, then evicted, mined during the 12th check: the receipt, not 'replaced'", async () => {
    const n = node({ seenEarly: true, readMs: 3_500, lagMs: 12_000, mineOnCheck: 12 });
    const out = await settle(waitForWrite(n.client, HASH), 10 * 60_000);
    expect(out.error).toBeUndefined();
    expect(out.value).toMatchObject({ status: "success" });
  });

  it("K5: after a verdict nothing new starts, and the last receipt wait ends within one slice", async () => {
    const n = node({ seenEarly: false, readMs: 100, lagMs: 0 });
    const out: { error?: Error; at?: number } = {};
    const t0 = Date.now();
    waitForWrite(n.client, HASH).catch((e: Error) => { out.error = e; out.at = Date.now() - t0; });
    while (!out.error) await vi.advanceTimersByTimeAsync(1_000);
    expect(out.error).toBeInstanceOf(TxDroppedError);
    const checks = n.live.checks.length;
    const started = n.live.waitsStarted;
    await vi.advanceTimersByTimeAsync(WAIT_SLICE_MS + 1_000);
    expect(n.live.waits).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(n.live.checks.length).toBe(checks);
    expect(n.live.waitsStarted).toBe(started);
    expect(WAIT_SLICE_MS).toBeLessThanOrEqual(60_000);
  });

  it("K5: an abort (the page stopped showing the write) ends the wait at once and starts nothing more", async () => {
    const n = node({ seenEarly: true, readMs: 100, lagMs: 0 });
    const ac = new AbortController();
    const out: { error?: Error } = {};
    waitForWrite(n.client, HASH, { signal: ac.signal }).catch((e: Error) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(out.error?.name).toBe("WriteDetachedError");
    const checks = n.live.checks.length;
    const started = n.live.waitsStarted;
    await vi.advanceTimersByTimeAsync(WAIT_SLICE_MS + 1_000);
    expect(n.live.waits).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(n.live.checks.length).toBe(checks);
    expect(n.live.waitsStarted).toBe(started);
  });
});

describe("#7: after a write is mined, its switch is re-read at a block no older than the receipt", () => {
  const H = { contractAddr: CONTRACT, owner: OWNER, id: 42n };
  /** An RPC whose head (and "latest" state) lags at 99, behind the receipt's block 100. */
  const lagging = () => {
    const reads: [string, bigint | "latest"][] = [];
    const client = {
      chain: { id: 11155111 },
      getBlockNumber: async () => 99n,
      readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
        reads.push([functionName, blockNumber ?? "latest"]);
        return functionName === "getSwitchInfo" ? raw(true) : 0n;
      },
    } as unknown as PublicClient;
    return { client, reads };
  };

  it("switch info and the funder's stake are read at the receipt's block; another switch, and later reads, at latest", async () => {
    vi.useFakeTimers();
    try {
      const { client, reads } = lagging();
      noteWriteMined(11155111, H, 100n);
      await readSwitchInfo(client, H);
      await readFunderStake(client, H, OWNER);
      await readSwitchInfo(client, { ...H, id: 43n });
      expect(reads).toEqual([["getSwitchInfo", 100n], ["getFunderStake", 100n], ["getSwitchInfo", "latest"]]);
      vi.advanceTimersByTime(READ_FLOOR_MS + 1);
      await readSwitchInfo(client, H);
      expect(reads.at(-1)).toEqual(["getSwitchInfo", "latest"]);
      // Another chain's client is not affected.
      const other = lagging();
      noteWriteMined(1, H, 100n);
      await readSwitchInfo(other.client, H);
      expect(other.reads).toEqual([["getSwitchInfo", "latest"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runWrite hands the receipt to the refresh, so the hook can record its block", async () => {
    const HASH = `0x${"cd".repeat(32)}` as Hex;
    const r = { status: "success", blockNumber: 100n, transactionHash: HASH } as unknown as TransactionReceipt;
    const refresh = vi.fn(async (_receipt?: TransactionReceipt) => {});
    await runWrite(async () => HASH, { waitForTransactionReceipt: async () => r } as unknown as PublicClient, refresh);
    expect(refresh).toHaveBeenCalledWith(r);
  });
});

describe("switchInfoPollMs: per-switch polling on the hunt / archive lists", () => {
  const info = (state: number) => toSwitchInfo({ ...raw(true), state });
  it("live switches every 15 s; cancelled and revealed ones (only a reclaim or a publish can change them) every 5 min", () => {
    for (const s of [ContractState.ALIVE, ContractState.DARK, ContractState.DARK_MARKED]) expect(switchInfoPollMs(info(s))).toBe(15_000);
    expect(switchInfoPollMs(undefined)).toBe(15_000);
    expect(switchInfoPollMs(info(ContractState.REVEALED))).toBe(5 * 60_000);
    expect(switchInfoPollMs(info(ContractState.CANCELLED))).toBe(5 * 60_000);
  });

  it("100 listed switches, 80 of them finished: getSwitchInfo reads per 10 minutes drop from 4,000 to 960", () => {
    const list = [...Array(20).fill(ContractState.ALIVE), ...Array(40).fill(ContractState.REVEALED), ...Array(40).fill(ContractState.CANCELLED)];
    const reads = list.reduce((n, s) => n + 600_000 / switchInfoPollMs(info(s)), 0);
    expect(reads).toBe(20 * 40 + 80 * 2);
  });
});

describe("runWrite: every write hook refreshes the switch after a lost race too, not only after a success", () => {
  const HASH = `0x${"cd".repeat(32)}` as Hex;
  const receipt = (status: "success" | "reverted") => ({ status, blockNumber: 100n, transactionHash: HASH }) as unknown as TransactionReceipt;
  const clientWith = (r: TransactionReceipt) => ({ waitForTransactionReceipt: async () => r }) as unknown as PublicClient;
  const lostRace = (errorName: string) =>
    new ContractFunctionRevertedError({ abi: dmsAbi, functionName: "markDark", data: encodeErrorResult({ abi: dmsAbi, errorName } as never) });

  it("success: refreshed once, after the receipt", async () => {
    const order: string[] = [];
    const client = { waitForTransactionReceipt: async () => { order.push("receipt"); return receipt("success"); } } as unknown as PublicClient;
    await runWrite(async () => HASH, client, async () => { order.push("refresh"); });
    expect(order).toEqual(["receipt", "refresh"]);
  });

  it("revealKey mined but reverted (someone revealed first): the switch is refreshed at once, and the revert still surfaces", async () => {
    const refresh = vi.fn(async () => {});
    await expect(runWrite(async () => HASH, clientWith(receipt("reverted")), refresh)).rejects.toThrow(/reverted/);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["AlreadyDarkMarked", "AlreadyRevealed", "NotActive", "Expired"])(
    "refused at simulation with %s (the state moved on): refreshed at once", async (name) => {
      const refresh = vi.fn(async () => {});
      await expect(runWrite(async () => { throw lostRace(name); }, clientWith(receipt("success")), refresh)).rejects.toBeInstanceOf(ContractFunctionRevertedError);
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("a rejection in the wallet changed nothing on chain: no refresh", async () => {
    const refresh = vi.fn(async () => {});
    await expect(runWrite(async () => { throw new UserRejectedRequestError(new Error("no")); }, clientWith(receipt("success")), refresh)).rejects.toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a refresh that fails does not replace the write's own error", async () => {
    await expect(runWrite(async () => HASH, clientWith(receipt("reverted")), async () => { throw new Error("429"); })).rejects.toThrow(/reverted/);
  });
});

describe("#38: the chain clock never runs backwards between polls", () => {
  // Slots at 1200, 1212, …; the RPC serves each block ~3 s after its slot; the page polls every 12 s.
  const at = (wallSec: number) => wallSec * 1000;

  it("a poll that still sees the previous block (served late, or a missed slot) does not reset the countdown", () => {
    let clock = nextChainClock(undefined, 1200n, at(1203.2));
    const before = chainNowSec(clock, 1215);
    expect(before).toBe(1212n);
    // At wall 1215.0 block 1212 has not reached the RPC yet: it answers 1200 again.
    clock = nextChainClock(clock, 1200n, at(1215.0));
    for (const w of [1215, 1216, 1220]) expect(chainNowSec(clock, w)).toBeGreaterThanOrEqual(before);
    expect(chainNowSec(clock, 1220)).toBe(1217n);
  });

  it("a newer block moves it forward, and it is never ahead of the latest block plus the time since it was read", () => {
    let clock = nextChainClock(undefined, 1200n, at(1203.2));
    clock = nextChainClock(clock, 1236n, at(1239.1)); // two slots arrive at once after a stall
    expect(chainNowSec(clock, 1239)).toBe(1236n);
    expect(chainNowSec(clock, 1245)).toBe(1242n);
  });

  it("a switch from a deadline at 1205: 'dark' from about wall 1208 stays dark (no Ping button coming back)", () => {
    const deadline = 1205n;
    let clock = nextChainClock(undefined, 1200n, at(1203.2));
    const states: boolean[] = [];
    for (let w = 1208; w <= 1222; w++) {
      if (w === 1215) clock = nextChainClock(clock, 1200n, at(1215.0));
      states.push(chainNowSec(clock, w) >= deadline);
    }
    expect(states.every(Boolean)).toBe(true);
  });
});

// ---------- real viem receipt waits against a fake chain ----------

describe("a wallet speed-up mined between two receipt-wait slices is this write", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const S = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;
  const T1: FakeTx = { hash: `0x${"11".repeat(32)}`, from: S, to: CONTRACT, nonce: 5, input: "0x5c36b186", value: 0n, fee: 1_000_000_000n };
  /** Settle waitForWrite for T1 while `mined` lands at `atMs`. */
  const run = async (mined: FakeTx, atMs: number) => {
    const c = fakeChain();
    c.broadcast(T1);
    c.mineAt(mined, atMs);
    const out: { value?: TransactionReceipt; error?: Error } = {};
    waitForWrite(c.client, T1.hash).then((v) => { out.value = v; }, (e: Error) => { out.error = e; });
    for (let i = 0; i < 12 * 60 && !out.value && !out.error; i++) await vi.advanceTimersByTimeAsync(1_000);
    c.stop();
    await vi.advanceTimersByTimeAsync(WAIT_SLICE_MS + 5_000);
    return out;
  };

  it("a repriced copy (same call, higher fee) mined in any block of the first six minutes: its receipt, never 'replaced'", async () => {
    const T2: FakeTx = { ...T1, hash: `0x${"22".repeat(32)}`, fee: 3_000_000_000n };
    const failed: string[] = [];
    for (let at = 12_000; at <= 6 * 60_000; at += 12_000) {
      const o = await run(T2, at - 1);
      if (!o.value || o.error) failed.push(`${at / 1000}s: ${o.error?.message.slice(0, 60)}`);
      else expect(o.value.transactionHash).toBe(T2.hash);
    }
    expect(failed).toEqual([]);
  }, 120_000);

  it("a cancel (a 0-value self-send at the nonce) or another call: still not success", async () => {
    for (const at of [60_000, 180_000]) {
      const cancel = await run({ ...T1, hash: `0x${"33".repeat(32)}`, to: S, input: "0x", value: 0n, fee: 3_000_000_000n }, at);
      expect(cancel.error?.message).toMatch(/cancelled or replaced|replaced/);
      const other = await run({ ...T1, hash: `0x${"44".repeat(32)}`, input: "0xdeadbeef", fee: 3_000_000_000n }, at);
      expect(other.error?.message).toMatch(/replaced/);
    }
  }, 120_000);
});

describe("a write resumed after its 30 minutes, mined meanwhile, is a success", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([300, 1_200])("RPC latency %i ms: the receipt, not 'still not confirmed'", async (latencyMs) => {
    const S = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;
    const T1: FakeTx = { hash: `0x${"11".repeat(32)}`, from: S, to: CONTRACT, nonce: 5, input: "0x5c36b186", value: 0n, fee: 1n };
    const c = fakeChain({ latencyMs });
    c.broadcast(T1);
    c.mineAt(T1, 0);
    await vi.advanceTimersByTimeAsync(13_000);
    const out: { value?: TransactionReceipt; error?: Error } = {};
    waitForWrite(c.client, T1.hash, { startedAt: Date.now() - 31 * 60_000 }).then((v) => { out.value = v; }, (e: Error) => { out.error = e; });
    for (let i = 0; i < 120 && !out.value && !out.error; i++) await vi.advanceTimersByTimeAsync(500);
    c.stop();
    expect(out.error).toBeUndefined();
    expect(out.value?.status).toBe("success");
  });
});

describe("the chain clock follows the chain after the device clock steps", () => {
  it("a 5-minute forward step of the device clock is corrected at the next poll", () => {
    const realStart = 1_800_000_000_000;
    const genesis = 1_800_000_000;
    let skewMs = 0;
    let clock: ReturnType<typeof nextChainClock> | undefined;
    const errors: bigint[] = [];
    for (let t = 0; t <= 20 * 60_000; t += 12_000) {
      if (t === 5 * 60_000) skewMs = 300_000;
      const wall = realStart + t + skewMs;
      const block = BigInt(genesis + Math.floor((t - 3_000) / 12_000) * 12); // the latest block, ~3 s late
      clock = nextChainClock(clock, block, wall);
      if (t > 5 * 60_000) errors.push(chainNowSec(clock, Math.floor(wall / 1000)) - BigInt(genesis + Math.floor(t / 1000)));
    }
    // Never ahead of the real chain time by more than the interpolation from the block just read.
    expect(errors.every((e) => e <= 0n)).toBe(true);
  });

  it("the #38 cases still hold: a late block or a missed slot does not turn the clock back", () => {
    let clock = nextChainClock(undefined, 1200n, 1203.2 * 1000);
    const before = chainNowSec(clock, 1215);
    clock = nextChainClock(clock, 1200n, 1227.0 * 1000); // two slots missed: still within the hold window
    expect(chainNowSec(clock, 1227)).toBeGreaterThanOrEqual(before);
  });
});

// ---------- speed-ups and device sleep ----------

describe("a speed-up is never called 'did nothing' without its receipt", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const S = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;
  const T1: FakeTx = { hash: `0x${"11".repeat(32)}`, from: S, to: CONTRACT, nonce: 5, input: "0x5c36b186", value: 10n ** 16n, fee: 1n };
  const T2: FakeTx = { ...T1, hash: `0x${"22".repeat(32)}`, fee: 3n }; // the wallet's speed-up
  const OTHER: FakeTx = { ...T1, hash: `0x${"33".repeat(32)}`, to: "0x000000000000000000000000000000000000dEaD", input: "0x" };
  const run = async (mined: FakeTx, atMs: number, failReceipt: (h: string) => boolean) => {
    const c = fakeChain({ failReceipt });
    c.broadcast(T1);
    c.mineAt(mined, atMs);
    const out: { value?: TransactionReceipt; error?: Error } = {};
    waitForWrite(c.client, T1.hash, { value: T1.value }).then((v) => { out.value = v; }, (e: Error) => { out.error = e; });
    for (let i = 0; i < 12 * 60 && !out.value && !out.error; i++) await vi.advanceTimersByTimeAsync(1_000);
    c.stop();
    await vi.advanceTimersByTimeAsync(WAIT_SLICE_MS + 5_000);
    return out;
  };

  it("the speed-up's receipt read fails once (a 429 after the block reads): still its receipt, at every point of the sweep", async () => {
    const failed: string[] = [];
    for (let at = 12_000; at <= 6 * 60_000; at += 12_000) {
      let once = false;
      const o = await run(T2, at - 1, (h) => { if (!once && h === T2.hash) { once = true; return true; } return false; });
      if (!o.value) failed.push(`${at / 1000}s: ${o.error?.message.slice(0, 70)}`);
    }
    expect(failed).toEqual([]);
  }, 120_000);

  it("a replacement whose receipt can never be read: 'check your wallet', never 'did nothing'", async () => {
    for (const tx of [T2, OTHER]) {
      for (const at of [60_000, 180_000]) {
        const o = await run(tx, at, (h) => h === tx.hash);
        expect(o.value).toBeUndefined();
        expect(o.error?.message).not.toMatch(/did nothing/);
        expect(o.error?.message).toMatch(/check your wallet/i);
      }
    }
  }, 120_000);

  it("a write resumed after a reload knows its call (to, value, calldata hash): a speed-up mined meanwhile is its receipt", async () => {
    const c = fakeChain();
    c.mineAt(T2, 0); // mined in the first block; T1 is gone from the pool
    await vi.advanceTimersByTimeAsync(13_000);
    const out: { value?: TransactionReceipt; error?: Error } = {};
    waitForWrite(c.client, T1.hash, {
      startedAt: Date.now() - 60_000,
      seen: { from: S, nonce: 5, call: { to: CONTRACT, value: T1.value, inputHash: keccak256(T1.input) } },
    }).then((v) => { out.value = v; }, (e: Error) => { out.error = e; });
    for (let i = 0; i < 600 && !out.value && !out.error; i++) await vi.advanceTimersByTimeAsync(1_000);
    c.stop();
    expect(out.error).toBeUndefined();
    expect(out.value?.transactionHash).toBe(T2.hash);
  }, 60_000);
});

describe("the chain clock keeps real time across a device sleep", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("60 minutes asleep (performance.now() stood still): a switch that went dark meanwhile shows dark before the first poll", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    vi.spyOn(performance, "now").mockReturnValue(5_000);
    const chain0 = 1_800_000_000n;
    const clock = nextChainClock(undefined, chain0, chainClockMs());
    vi.setSystemTime(1_800_000_000_000 + 60 * 60_000);
    const deadline = chain0 + 30n * 60n;
    expect(chainNowSec(clock, Math.floor(chainClockMs() / 1000))).toBeGreaterThanOrEqual(deadline);
  });
});
