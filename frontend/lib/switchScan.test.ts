// SwitchCreated discovery against a fake RPC: chunking at range boundaries,
// provider errors (rate limits vs range limits), bounded concurrency, and the
// incremental scan that a page load resumes instead of starting over.

import { describe, expect, it } from "vitest";
import {
  HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError, createPublicClient, custom, encodeAbiParameters,
  encodeEventTopics, encodePacked, keccak256, numberToHex, type Hex, type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { dmsAbi } from "./abi";
import { scanSwitchCreated } from "./hooks";
import {
  REORG_OVERLAP, createScanStore, findPublishedPlaintext, syncSwitchScan, type PublishedTarget, type ScanTarget,
} from "./switchScan";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const b32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** A SwitchCreated log as viem decodes it (strict). */
const log = (block: bigint, id: bigint) => ({
  blockNumber: block,
  transactionHash: b32(block * 1000n + id),
  args: {
    switchKey: b32(id), owner: OWNER, switchId: id, pingInterval: 86400n, timestamp: 1_700_000_000n + block,
    bounty: 10n ** 16n, plaintextCommitment: b32(7n), encKeyHandle: b32(9n), ciphertext: "0x01" as Hex,
  },
});

const rateLimited = () =>
  new HttpRequestError({ url: "https://rpc.example", status: 429, body: { method: "eth_getLogs" }, details: "Too Many Requests" });
const tooManyResults = () =>
  new LimitExceededRpcError(new RpcRequestError({
    body: { method: "eth_getLogs" }, url: "https://rpc.example",
    error: { code: -32005, message: "query returned more than 10000 results" },
  }));

/**
 * eth_getLogs over `logs`. `fail(from, to, call)` may throw for a call (1-based).
 * Records every accepted range and the most requests ever in flight at once.
 */
const fakeLogsRpc = (logs: ReturnType<typeof log>[], fail?: (from: bigint, to: bigint, call: number) => Error | null) => {
  const ok: [bigint, bigint][] = [];
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      const n = ++calls;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 0));
        const err = fail?.(fromBlock, toBlock, n);
        if (err) throw err;
        ok.push([fromBlock, toBlock]);
        return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      } finally {
        inFlight--;
      }
    },
  } as unknown as PublicClient;
  return { client, ok, stats: () => ({ calls, maxInFlight }) };
};

const noSleep = async () => {};

/** The accepted ranges tile [from, to] exactly: no gap, no overlap. */
const expectTiles = (ranges: [bigint, bigint][], from: bigint, to: bigint) => {
  const sorted = [...ranges].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let next = from;
  for (const [s, e] of sorted) {
    expect(s).toBe(next);
    expect(e >= s).toBe(true);
    next = e + 1n;
  }
  expect(next).toBe(to + 1n);
};

describe("scanSwitchCreated: chunk boundaries", () => {
  it("finds a switch on every chunk boundary exactly once", async () => {
    const logs = [log(0n, 1n), log(4_999n, 2n), log(5_000n, 3n), log(9_999n, 4n), log(10_000n, 5n), log(12_345n, 6n)];
    const rpc = fakeLogsRpc(logs);
    const found = await scanSwitchCreated(rpc.client, CONTRACT, 0n, 12_345n, 5_000n, undefined, { sleep: noSleep });
    expect(found.map((f) => f.id).sort()).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    expectTiles(rpc.ok, 0n, 12_345n);
  });
});

describe("scanSwitchCreated: provider errors", () => {
  it("a rate limit (429) is retried on the same range after a pause, without shrinking the chunk", async () => {
    // The public RPC throttles the first two requests, then serves 5,000-block ranges.
    const rpc = fakeLogsRpc([log(42_000n, 1n)], (_f, _t, call) => (call <= 2 ? rateLimited() : null));
    const slept: number[] = [];
    const found = await scanSwitchCreated(rpc.client, CONTRACT, 0n, 49_999n, 5_000n, undefined, {
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(found.map((f) => f.id)).toEqual([1n]);
    expectTiles(rpc.ok, 0n, 49_999n);
    // 10 ranges of 5,000 blocks, not 40 of 1,250 (the old code halved twice and never grew back).
    expect(rpc.ok.length).toBe(10);
    expect(slept.length).toBeGreaterThan(0);
  });

  it("an RPC that throttles every other request still completes the scan (the old code gave up at the 7th 429)", async () => {
    const rpc = fakeLogsRpc([log(31_000n, 1n)], (_f, _t, call) => (call % 2 === 1 && call < 30 ? rateLimited() : null));
    const found = await scanSwitchCreated(rpc.client, CONTRACT, 0n, 49_999n, 5_000n, undefined, { sleep: noSleep });
    expect(found.map((f) => f.id)).toEqual([1n]);
    expectTiles(rpc.ok, 0n, 49_999n);
  });

  it("timeouts and network failures are transient too", async () => {
    const errs = [new TimeoutError({ body: {}, url: "https://rpc.example" }),
      new HttpRequestError({ url: "https://rpc.example", body: {}, details: "Failed to fetch" })];
    const rpc = fakeLogsRpc([], (_f, _t, call) => errs[call - 1] ?? null);
    await scanSwitchCreated(rpc.client, CONTRACT, 0n, 4_999n, 5_000n, undefined, { sleep: noSleep });
    expect(rpc.ok).toEqual([[0n, 4_999n]]);
  });

  it("a range limit halves the chunk, then the chunk grows back to the cap", async () => {
    // Too many results in any span over 2,500 blocks below block 20,000 only.
    const rpc = fakeLogsRpc([], (f, t) => (t - f + 1n > 2_500n && f < 20_000n ? tooManyResults() : null));
    await scanSwitchCreated(rpc.client, CONTRACT, 0n, 99_999n, 5_000n, undefined, { sleep: noSleep, concurrency: 1 });
    expectTiles(rpc.ok, 0n, 99_999n);
    // Without growing back, 100,000 blocks would take 40 requests of 2,500.
    expect(rpc.ok.length).toBeLessThan(30);
    expect(rpc.ok.at(-1)![1] - rpc.ok.at(-1)![0] + 1n).toBe(5_000n);
  });

  it("an error that persists down to single blocks is thrown, not looped on", async () => {
    const rpc = fakeLogsRpc([], () => tooManyResults());
    await expect(scanSwitchCreated(rpc.client, CONTRACT, 0n, 9_999n, 5_000n, undefined, { sleep: noSleep })).rejects.toThrow();
    expect(rpc.stats().calls).toBeLessThan(40);
  });

  // G5: viem's Sepolia default (sepolia.drpc.org, free plan) answers any span over 101 blocks with an HTTP 400
  // whose text names 10,000 blocks. The chunk settles at 78; the old code then ran one request at a time for the
  // rest of the scan and probed 156 again after every 4 accepted ranges (3,469 requests, 3,466 rounds, ~14 min).
  it("a provider that caps every span (drpc's free plan, 101 blocks): few doomed probes, and concurrency comes back", async () => {
    const DAYS_30 = 216_000n;
    const drpc = () => new HttpRequestError({
      url: "https://sepolia.drpc.org", status: 400, body: { method: "eth_getLogs" },
      details: JSON.stringify({ message: "ranges over 10000 blocks are not supported on free plan", code: 35 }),
    });
    const spans: bigint[] = [];
    let small = 0;
    let maxSmall = 0;
    const rpc = fakeLogsRpc([log(100_000n, 1n)], (f, t) => (t - f + 1n > 101n ? drpc() : null));
    const inner = rpc.client.getContractEvents.bind(rpc.client);
    const client = {
      getContractEvents: async (a: { fromBlock: bigint; toBlock: bigint }) => {
        const span = a.toBlock - a.fromBlock + 1n;
        spans.push(span);
        const counted = span <= 101n;
        if (counted) { small++; maxSmall = Math.max(maxSmall, small); }
        try { return await inner(a as never); } finally { if (counted) small--; }
      },
    } as unknown as PublicClient;
    const found = await scanSwitchCreated(client, CONTRACT, 0n, DAYS_30 - 1n, 5_000n, undefined, { sleep: noSleep });
    expect(found.map((f) => f.id)).toEqual([1n]);
    expectTiles(rpc.ok, 0n, DAYS_30 - 1n);
    expect(spans.length).toBeLessThanOrEqual(Math.ceil(1.1 * Math.ceil(216_000 / 78)));
    // Spans the provider rejects are tried O(log n) times, not every 312 blocks (~690 times).
    expect(spans.filter((s) => s > 101n).length).toBeLessThanOrEqual(20);
    // Once a working chunk is found, the scan keeps SCAN_CONCURRENCY requests in flight again.
    expect(maxSmall).toBe(4);
  });

  // G5: publicnode (the Zama SDK's Sepolia default) load-balances over nodes that randomly answer "pruned history
  // unavailable" (code 4444) for older blocks. That is not a range problem: another node serves the same range.
  it("'pruned history unavailable' (code 4444) is retried on the same range, never halves the chunk, never fails the scan", async () => {
    const pruned = () => new RpcRequestError({
      body: { method: "eth_getLogs" }, url: "https://ethereum-sepolia-rpc.publicnode.com",
      error: { code: 4444, message: "pruned history unavailable" },
    });
    // 40% of all requests, never more than two in a row for one range.
    const rpc = fakeLogsRpc([log(150_000n, 1n)], (_f, _t, call) => (call % 5 === 1 || call % 5 === 3 ? pruned() : null));
    const found = await scanSwitchCreated(rpc.client, CONTRACT, 0n, 215_999n, 5_000n, undefined, { sleep: noSleep });
    expect(found.map((f) => f.id)).toEqual([1n]);
    expectTiles(rpc.ok, 0n, 215_999n);
    expect(rpc.ok.every(([s, e]) => e - s + 1n === 5_000n || e === 215_999n)).toBe(true);
  });
});

describe("scanSwitchCreated: bounded concurrency", () => {
  it("a long first scan keeps a few requests in flight, never more than `concurrency`", async () => {
    const logs = Array.from({ length: 40 }, (_, i) => log(BigInt(i) * 2_500n + 7n, BigInt(i + 1)));
    const rpc = fakeLogsRpc(logs);
    const found = await scanSwitchCreated(rpc.client, CONTRACT, 0n, 99_999n, 5_000n, undefined, { sleep: noSleep, concurrency: 4 });
    expect(found.length).toBe(40);
    expectTiles(rpc.ok, 0n, 99_999n);
    expect(rpc.stats().maxInFlight).toBe(4);
  });

  it("drops to one request at a time once the provider rate-limits", async () => {
    let throttled = false;
    let inFlightAfter = 0;
    let maxAfter = 0;
    const rpc = fakeLogsRpc([], (_f, _t, call) => {
      if (call === 3) { throttled = true; return rateLimited(); }
      return null;
    });
    const inner = rpc.client.getContractEvents.bind(rpc.client);
    const client = {
      getContractEvents: async (a: never) => {
        const track = throttled;
        if (track) { inFlightAfter++; maxAfter = Math.max(maxAfter, inFlightAfter); }
        try { return await inner(a); } finally { if (track) inFlightAfter--; }
      },
    } as unknown as PublicClient;
    await scanSwitchCreated(client, CONTRACT, 0n, 99_999n, 5_000n, undefined, { sleep: noSleep, concurrency: 4 });
    expectTiles(rpc.ok, 0n, 99_999n);
    expect(maxAfter).toBe(1);
  });

  it("reports progress in block order, one call per accepted range", async () => {
    const logs = [log(3n, 1n), log(5_003n, 2n), log(10_003n, 3n)];
    const rpc = fakeLogsRpc(logs, (_f, _t, call) => (call === 2 ? rateLimited() : null));
    const seen: [bigint, bigint[]][] = [];
    await scanSwitchCreated(rpc.client, CONTRACT, 0n, 14_999n, 5_000n, undefined, {
      sleep: noSleep, concurrency: 3, onProgress: (to, found) => seen.push([to, found.map((f) => f.id)]),
    });
    expect(seen).toEqual([[4_999n, [1n]], [9_999n, [2n]], [14_999n, [3n]]]);
  });
});

// ---------- the incremental scan a list resumes ----------

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const SEPOLIA = 11155111;
const DEPLOY = 7_000_000n;
const target = (over: Partial<ScanTarget> = {}): ScanTarget =>
  ({ chainId: SEPOLIA, contract: CONTRACT, fromBlock: DEPLOY, rangeCap: 5_000n, ...over });

/**
 * A chain at `head` whose SwitchCreated logs are `logs`; counts eth_getLogs requests. With `finalized`, the
 * node also answers getBlock({ blockTag: "finalized" }); without it, it has no getBlock (an older fake).
 */
const fakeChain = (
  head: bigint, logs: ReturnType<typeof log>[], fail?: (from: bigint, to: bigint, call: number) => Error | null, finalized?: bigint,
) => {
  const rpc = fakeLogsRpc(logs, fail);
  const st = { head };
  const client = Object.assign(rpc.client, {
    getBlockNumber: async () => st.head,
    ...(finalized === undefined ? {} : {
      getBlock: async ({ blockTag }: { blockTag?: string }) => {
        if (blockTag !== "finalized") throw new Error(`unexpected getBlock ${blockTag}`);
        return { number: finalized };
      },
    }),
  }) as PublicClient;
  return { client, st, rpc };
};

describe("syncSwitchScan: incremental, persisted discovery", () => {
  // 90 days of Sepolia since the deploy: 648,000 blocks = 130 requests of 5,000.
  const HEAD = DEPLOY + 648_000n - 1n;

  it("a page load after an earlier visit scans only the blocks since then (1 request, not 130)", async () => {
    const storage = new MemStorage();
    const logs = [log(DEPLOY + 5n, 1n), log(DEPLOY + 300_000n, 2n)];
    const first = fakeChain(HEAD, logs);
    const s1 = await syncSwitchScan(first.client, target(), createScanStore(() => storage, () => true), { sleep: noSleep });
    expect(s1.items.map((i) => i.id)).toEqual([2n, 1n]);
    expect(first.rpc.stats().calls).toBe(130);

    // Reload (fresh in-memory state, same localStorage), 100 blocks and one new switch later.
    const later = fakeChain(HEAD + 100n, [...logs, log(HEAD + 50n, 3n)]);
    const s2 = await syncSwitchScan(later.client, target(), createScanStore(() => storage, () => true), { sleep: noSleep });
    expect(s2.items.map((i) => i.id)).toEqual([3n, 2n, 1n]);
    expect(s2.scannedTo).toBe(HEAD + 100n);
    expect(later.rpc.stats().calls).toBe(1);
    expect(later.rpc.ok[0]![0]).toBe(HEAD + 1n - REORG_OVERLAP);
  });

  it("a scan that fails part-way keeps what it fetched: the retry resumes there", async () => {
    const storage = new MemStorage();
    const store = createScanStore(() => storage, () => true);
    // The provider breaks for good at the 60th range (a non-transient error at single-block size too).
    let broken = true;
    const chain = fakeChain(HEAD, [log(DEPLOY + 10n, 1n)], (f) => (broken && f >= DEPLOY + 300_000n ? new Error("boom") : null));
    await expect(syncSwitchScan(chain.client, target(), store, { sleep: noSleep, concurrency: 1 })).rejects.toThrow();
    broken = false;
    const before = chain.rpc.ok.length;
    const s = await syncSwitchScan(chain.client, target(), store, { sleep: noSleep, concurrency: 1 });
    expect(s.items.map((i) => i.id)).toEqual([1n]);
    expect(s.scannedTo).toBe(HEAD);
    // Resumed near block DEPLOY + 300,000, not from the deploy block.
    expect(chain.rpc.ok[before]![0] > DEPLOY + 290_000n).toBe(true);
    // ...and a reload resumes from the persisted progress too.
    expect(createScanStore(() => storage, () => true).get(SEPOLIA, CONTRACT, DEPLOY)?.scannedTo).toBe(HEAD);
  });

  it("a switch the re-scanned overlap no longer contains (reorged out) is dropped", async () => {
    const store = createScanStore(() => new MemStorage(), () => true);
    const a = fakeChain(DEPLOY + 1_000n, [log(DEPLOY + 995n, 1n), log(DEPLOY + 10n, 2n)]);
    expect((await syncSwitchScan(a.client, target(), store, { sleep: noSleep })).items.map((i) => i.id)).toEqual([1n, 2n]);
    const b = fakeChain(DEPLOY + 1_010n, [log(DEPLOY + 10n, 2n)]);
    expect((await syncSwitchScan(b.client, target(), store, { sleep: noSleep })).items.map((i) => i.id)).toEqual([2n]);
  });

  it("an RPC node behind the last scan returns the last scan, recent switches included", async () => {
    const store = createScanStore(() => new MemStorage(), () => true);
    const a = fakeChain(DEPLOY + 1_000n, [log(DEPLOY + 999n, 1n)]);
    await syncSwitchScan(a.client, target(), store, { sleep: noSleep });
    const lagging = fakeChain(DEPLOY + 997n, []);
    const s = await syncSwitchScan(lagging.client, target(), store, { sleep: noSleep });
    expect(s.items.map((i) => i.id)).toEqual([1n]);
    expect(s.scannedTo).toBe(DEPLOY + 1_000n);
  });

  it("ignores a stored scan for another FROM_BLOCK or contract, or one that does not parse; never persists Anvil", async () => {
    const storage = new MemStorage();
    const chain = fakeChain(DEPLOY + 20_000n, [log(DEPLOY + 1n, 1n)]);
    await syncSwitchScan(chain.client, target(), createScanStore(() => storage, () => true), { sleep: noSleep });
    expect(storage.map.size).toBe(1);
    const [k, raw] = [...storage.map.entries()][0]!;
    expect(createScanStore(() => storage, () => true).get(SEPOLIA, CONTRACT, DEPLOY - 1n)).toBeNull();
    expect(createScanStore(() => storage, () => true).get(SEPOLIA, "0x000000000000000000000000000000000000beef", DEPLOY)).toBeNull();
    for (const bad of ["{", raw.replace(/"v":1/, '"v":2'), raw.replace(/"owner":"0x[0-9a-fA-F]{40}"/, '"owner":"0x12"'),
      raw.replace(/"blockNumber":"\d+"/, `"blockNumber":"${DEPLOY + 30_000n}"`)]) {
      storage.setItem(k, bad);
      expect(createScanStore(() => storage, () => true).get(SEPOLIA, CONTRACT, DEPLOY)).toBeNull();
    }
    const anvil = new MemStorage();
    await syncSwitchScan(fakeChain(100n, []).client, target({ chainId: 31337, fromBlock: 0n }), createScanStore(() => anvil, (c) => c !== 31337), { sleep: noSleep });
    expect(anvil.map.size).toBe(0);
  });

  it("storage that throws (private mode, quota) is ignored", async () => {
    const store = createScanStore(() => { throw new Error("SecurityError"); }, () => true);
    const s = await syncSwitchScan(fakeChain(DEPLOY + 10n, [log(DEPLOY + 3n, 1n)]).client, target(), store, { sleep: noSleep });
    expect(s.items.map((i) => i.id)).toEqual([1n]);
  });
});

// G13: a reorg deeper than REORG_OVERLAP. The resume point is anchored at the last finalized block the previous
// scan saw, so a stored scan never keeps a phantom or misses a re-included switch below its 12-block overlap.
describe("syncSwitchScan: resume from finality, not a fixed 12 blocks", () => {
  const H = DEPLOY + 1_000n;
  const F = H - 64n;
  /** Each scan in a fresh in-memory store over the same localStorage: a reload. */
  const reloadScan = (storage: MemStorage, chain: ReturnType<typeof fakeChain>) =>
    syncSwitchScan(chain.client, target(), createScanStore(() => storage, () => true), { sleep: noSleep });

  it("a create orphaned below the overlap is dropped, and one the new fork placed there is found", async () => {
    const storage = new MemStorage();
    expect((await reloadScan(storage, fakeChain(H, [log(H - 30n, 1n)], undefined, F))).items.map((i) => i.id)).toEqual([1n]);
    // A 40-block reorg (still above finality): switch 1's create is gone, switch 2 was created at H - 40.
    const after = await reloadScan(storage, fakeChain(H + 1n, [log(H - 40n, 2n)], undefined, F + 1n));
    expect(after.items.map((i) => i.id)).toEqual([2n]);
  });

  it("the same create re-included at a lower block stays listed", async () => {
    const storage = new MemStorage();
    expect((await reloadScan(storage, fakeChain(H, [log(H - 5n, 1n)], undefined, F))).items.map((i) => i.id)).toEqual([1n]);
    const after = await reloadScan(storage, fakeChain(H + 1n, [log(H - 20n, 1n)], undefined, F + 1n));
    expect(after.items.map((i) => [i.id, i.blockNumber])).toEqual([[1n, H - 20n]]);
  });

  it("a repeat visit is still one request, from the block after the finalized one the last scan saw", async () => {
    const storage = new MemStorage();
    await reloadScan(storage, fakeChain(H, [log(DEPLOY + 5n, 1n)], undefined, F));
    const later = fakeChain(H + 100n, [log(DEPLOY + 5n, 1n), log(H + 50n, 2n)], undefined, F + 100n);
    expect((await reloadScan(storage, later)).items.map((i) => i.id)).toEqual([2n, 1n]);
    expect(later.rpc.stats().calls).toBe(1);
    expect(later.rpc.ok[0]![0]).toBe(F + 1n);
  });

  it("a long stall of finality costs at most one range more per refresh", async () => {
    const storage = new MemStorage();
    const head = DEPLOY + 50_000n;
    await reloadScan(storage, fakeChain(head, [], undefined, DEPLOY));
    const later = fakeChain(head + 10n, [], undefined, DEPLOY);
    await reloadScan(storage, later);
    expect(later.rpc.ok[0]![0]).toBe(head + 1n - 5_000n);
    expect(later.rpc.stats().calls).toBe(2);
  });
});

// ---------- with viem's real client (its 4 s block-number cache included) ----------

/**
 * A chain served through viem's own client: a head the test moves, and SwitchCreated logs encoded as a node
 * returns them. `methods` records every JSON-RPC call.
 */
const viemChain = (head: bigint, logs: ReturnType<typeof log>[]) => {
  const st = { head, logs: [...logs], methods: [] as string[] };
  const rpcLog = (l: ReturnType<typeof log>) => ({
    address: CONTRACT, blockNumber: numberToHex(l.blockNumber), blockHash: b32(l.blockNumber), transactionHash: l.transactionHash,
    transactionIndex: "0x0", logIndex: "0x0", removed: false,
    topics: encodeEventTopics({
      abi: dmsAbi, eventName: "SwitchCreated", args: { switchKey: l.args.switchKey, owner: l.args.owner, switchId: l.args.switchId },
    }),
    data: encodeAbiParameters(
      [{ type: "uint64" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }],
      [l.args.pingInterval, l.args.timestamp, l.args.bounty, l.args.plaintextCommitment, l.args.encKeyHandle, l.args.ciphertext],
    ),
  });
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      st.methods.push(method);
      if (method === "eth_chainId") return numberToHex(sepolia.id);
      if (method === "eth_blockNumber") return numberToHex(st.head);
      if (method === "eth_getBlockByNumber") {
        const n = params?.[0] === "finalized" ? st.head - 64n : st.head;
        return { number: numberToHex(n), hash: b32(n), parentHash: b32(n - 1n), timestamp: numberToHex(1_700_000_000n + n), transactions: [] };
      }
      if (method === "eth_getLogs") {
        const { fromBlock, toBlock } = (params?.[0] ?? {}) as { fromBlock: Hex; toBlock: Hex };
        return st.logs.filter((l) => l.blockNumber >= BigInt(fromBlock) && l.blockNumber <= BigInt(toBlock)).map(rpcLog);
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  return { client: createPublicClient({ chain: sepolia, transport }) as PublicClient, st };
};

// E2 / F1: the create's invalidation re-ran the scan, but the scan read viem's cached block number (4 s), got
// the previous scan's head and returned the previous list, so "Your switches" lacked the new switch for 60 s.
describe("syncSwitchScan right after a create", () => {
  it("reads the head uncached: a re-scan just after a block was mined includes the switch created in it", async () => {
    const store = createScanStore(() => new MemStorage(), () => true);
    const chain = viemChain(DEPLOY + 14n, [log(DEPLOY + 3n, 1n)]);
    expect((await syncSwitchScan(chain.client, target(), store, { sleep: noSleep })).items.map((i) => i.id)).toEqual([1n]);
    // createSwitch is mined in the next block; its receipt came back at the first look (no block-number poll).
    chain.st.head = DEPLOY + 15n;
    chain.st.logs.push(log(DEPLOY + 15n, 2n));
    const s = await syncSwitchScan(chain.client, target(), store, { sleep: noSleep });
    expect(s.items.map((i) => i.id)).toEqual([2n, 1n]);
    expect(s.scannedTo).toBe(DEPLOY + 15n);
  });
});

// ---------- the PlaintextPublished event of one switch ----------

describe("findPublishedPlaintext", () => {
  const ID = 42n;
  // DeadManSwitch._key: keccak256(abi.encodePacked(owner, id)).
  const KEY = keccak256(encodePacked(["address", "uint256"], [OWNER, ID]));
  const OTHER_KEY = keccak256(encodePacked(["address", "uint256"], [OWNER, ID + 1n]));
  const PUBLISHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
  const T = 1_800_000_000n;
  const H = DEPLOY + 1_000_000n;
  const DAYS_30 = 30n * 86_400n;

  /** Head H at time T. One PlaintextPublished for KEY in `publishIn` (and one for another switch next to it). */
  const chain = (o: { publishIn: bigint | null; head?: bigint; fail?: (from: bigint, to: bigint, call: number) => Error | null }) => {
    const head = o.head ?? H;
    const getLogs: { fromBlock: bigint; toBlock: bigint; key: unknown }[] = [];
    let calls = 0;
    let other = 0;
    const client = {
      getBlock: async () => { other++; return { number: head, timestamp: T }; },
      getBlockNumber: async () => { other++; return head; },
      readContract: async () => { other++; return KEY; },
      getContractEvents: async ({ fromBlock, toBlock, args }: { fromBlock: bigint; toBlock: bigint; args?: { switchKey?: Hex } }) => {
        const n = ++calls;
        await new Promise((r) => setTimeout(r, 0));
        const err = o.fail?.(fromBlock, toBlock, n);
        if (err) throw err;
        getLogs.push({ fromBlock, toBlock, key: args?.switchKey });
        const all = [
          ...(o.publishIn !== null ? [{ key: KEY, block: o.publishIn }] : []),
          { key: OTHER_KEY, block: (o.publishIn ?? H) - 1n },
        ];
        return all
          .filter((e) => e.key === args?.switchKey && e.block >= fromBlock && e.block <= toBlock)
          .map((e) => ({ blockNumber: e.block, transactionHash: b32(e.block), args: { switchKey: e.key, publisher: PUBLISHER, payload: "0x68656c6c6f" as Hex } }));
      },
    } as unknown as PublicClient;
    return { client, getLogs, stats: () => ({ calls, other }) };
  };
  const t = (over: Partial<PublishedTarget> = {}): PublishedTarget => ({
    chainId: SEPOLIA, contract: CONTRACT, owner: OWNER, id: ID, revealedAt: T - DAYS_30,
    fromBlock: DEPLOY, rangeCap: 5_000n, ...over,
  });
  // 30 days of 12 s slots, none missed: the reveal was in block H - 216,000.
  const REVEALED_IN = H - DAYS_30 / 12n;

  it("published right after a reveal 30 days ago: found in one round trip, filtered by this switch's key (was 44 getLogs walking back)", async () => {
    const c = chain({ publishIn: REVEALED_IN + 3n });
    const p = await findPublishedPlaintext(c.client, t(), { sleep: noSleep });
    expect(p).toMatchObject({ payload: "0x68656c6c6f", publisher: PUBLISHER, blockNumber: REVEALED_IN + 3n });
    expect(c.getLogs.length).toBeLessThanOrEqual(2);
    expect(c.getLogs.every((g) => g.key === KEY)).toBe(true);
    expect(c.stats().calls + c.stats().other).toBeLessThanOrEqual(3);
  });

  it("published just before the head: also one round trip", async () => {
    const c = chain({ publishIn: H - 10n });
    expect((await findPublishedPlaintext(c.client, t(), { sleep: noSleep }))?.blockNumber).toBe(H - 10n);
    expect(c.getLogs.length).toBeLessThanOrEqual(2);
  });

  it("published in the middle: every block from the reveal to the head is searched once, never before the reveal", async () => {
    const c = chain({ publishIn: REVEALED_IN + 100_000n });
    expect((await findPublishedPlaintext(c.client, t(), { sleep: noSleep }))?.blockNumber).toBe(REVEALED_IN + 100_000n);
    expect(c.getLogs.every((g) => g.fromBlock >= REVEALED_IN)).toBe(true);
  });

  it("the time bound never skips the event: published in the reveal block itself, with or without missed slots", async () => {
    // No missed slot: the bound is exactly the reveal block.
    const exact = chain({ publishIn: REVEALED_IN });
    expect((await findPublishedPlaintext(exact.client, t(), { sleep: noSleep }))?.blockNumber).toBe(REVEALED_IN);
    // 16,000 missed slots: fewer blocks since the reveal than slots, so the reveal block is above the bound.
    const missed = chain({ publishIn: H - 200_000n });
    expect((await findPublishedPlaintext(missed.client, t(), { sleep: noSleep }))?.blockNumber).toBe(H - 200_000n);
  });

  it("not published in [reveal, head] (e.g. pruned logs): null, after searching that span once", async () => {
    const c = chain({ publishIn: null });
    expect(await findPublishedPlaintext(c.client, t(), { sleep: noSleep })).toBeNull();
    expectTiles(c.getLogs.map((g) => [g.fromBlock, g.toBlock] as [bigint, bigint]), REVEALED_IN, H);
  });

  it("an RPC node whose head is older than the reveal answers null at once (re-checked later), without a blind search", async () => {
    const c = chain({ publishIn: null });
    expect(await findPublishedPlaintext(c.client, t({ revealedAt: T + 24n }), { sleep: noSleep })).toBeNull();
    expect(c.getLogs.length).toBe(0);
  });

  it("a 429 during the lookup is retried, not reported as 'not published'", async () => {
    const c = chain({ publishIn: REVEALED_IN + 3n, fail: (_f, _t, call) => (call <= 2 ? rateLimited() : null) });
    expect((await findPublishedPlaintext(c.client, t(), { sleep: noSleep }))?.blockNumber).toBe(REVEALED_IN + 3n);
  });

  it("an RPC that keeps failing makes the lookup fail (the query errors), never a null", async () => {
    const c = chain({ publishIn: REVEALED_IN + 3n, fail: () => rateLimited() });
    await expect(findPublishedPlaintext(c.client, t(), { sleep: noSleep })).rejects.toThrow();
  });

  it("Anvil (no fixed slot time, many blocks per second): no time bound, the whole deployment is searched", async () => {
    const c = chain({ publishIn: 101n, head: 5_000n });
    const p = await findPublishedPlaintext(c.client, t({ chainId: 31337, fromBlock: 0n, revealedAt: T - 10n, rangeCap: 1_000_000n }), { sleep: noSleep });
    expect(p?.blockNumber).toBe(101n);
  });
});
