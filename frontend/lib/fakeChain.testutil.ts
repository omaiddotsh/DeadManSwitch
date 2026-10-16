// Test helper (not app code): a tiny fake EIP-1193 chain that drives REAL viem
// actions (waitForTransactionReceipt, getTransaction, …) under fake timers.
// One block every `blockMs`; txs enter the pool with broadcast() and are mined
// with mineAt() (evicting any pool tx with the same sender and nonce, as a
// replacement does).
import { createPublicClient, custom, type Hex, type PublicClient } from "viem";
import { sepolia } from "viem/chains";

export interface FakeTx { hash: Hex; from: Hex; to: Hex; nonce: number; input: Hex; value: bigint; fee: bigint; reverted?: boolean }

const hx = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const h32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

export const fakeChain = (opts: {
  blockMs?: number; latencyMs?: number; startBlock?: number; startTime?: number;
  /** Make one eth_getTransactionReceipt for `hash` fail (a 429) when this returns true. */
  failReceipt?: (hash: string) => boolean;
  /** Collects the block numbers fetched with full transactions. */
  getBlockLog?: number[];
} = {}) => {
  const blockMs = opts.blockMs ?? 12_000;
  const latency = opts.latencyMs ?? 0;
  const t0 = Date.now();
  const blocks: { number: number; time: number; txs: FakeTx[] }[] = [{ number: opts.startBlock ?? 100, time: Math.floor((opts.startTime ?? t0) / 1000), txs: [] }];
  const mempool = new Map<string, FakeTx>();
  const minedIn = new Map<string, number>();
  const nonces = new Map<string, number>();
  /** txs to include in the next block (by hash), e.g. a replacement. */
  const scheduled: { atMs: number; tx: FakeTx }[] = [];
  const timer = setInterval(() => {
    const head = blocks[blocks.length - 1]!;
    const now = Date.now() - t0;
    const include: FakeTx[] = [];
    for (const s of scheduled.splice(0)) { if (s.atMs <= now) include.push(s.tx); else scheduled.push(s); }
    for (const tx of include) {
      // drop anything in the pool at the same (from, nonce)
      for (const [h, p] of mempool) if (p.from.toLowerCase() === tx.from.toLowerCase() && p.nonce === tx.nonce) mempool.delete(h);
      minedIn.set(tx.hash.toLowerCase(), head.number + 1);
      nonces.set(tx.from.toLowerCase(), Math.max(nonces.get(tx.from.toLowerCase()) ?? 0, tx.nonce + 1));
    }
    blocks.push({ number: head.number + 1, time: head.time + blockMs / 1000, txs: include });
  }, blockMs);
  const allTxs = () => blocks.flatMap((b) => b.txs.map((t) => ({ t, b })));
  const txJson = (t: FakeTx, b?: { number: number }) => ({
    hash: t.hash, from: t.from, to: t.to, nonce: hx(t.nonce), input: t.input, value: hx(t.value),
    gas: hx(100000), gasPrice: hx(t.fee), maxFeePerGas: hx(t.fee), maxPriorityFeePerGas: hx(1), type: "0x2", chainId: hx(11155111),
    v: "0x0", r: h32(1), s: h32(2), yParity: "0x0", accessList: [],
    blockNumber: b ? hx(b.number) : null, blockHash: b ? h32(b.number) : null, transactionIndex: b ? "0x0" : null,
  });
  const receiptJson = (t: FakeTx, n: number) => ({
    transactionHash: t.hash, blockNumber: hx(n), blockHash: h32(n), from: t.from, to: t.to, status: t.reverted ? "0x0" : "0x1",
    contractAddress: null, cumulativeGasUsed: hx(50000), effectiveGasPrice: hx(t.fee), gasUsed: hx(50000), logs: [],
    logsBloom: `0x${"00".repeat(256)}`, transactionIndex: "0x0", type: "0x2",
  });
  const calls: string[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
    calls.push(method);
    if (latency) await new Promise((r) => setTimeout(r, latency));
    const p = (params ?? []) as never[];
    switch (method) {
      case "eth_chainId": return hx(11155111);
      case "eth_blockNumber": return hx(blocks[blocks.length - 1]!.number);
      case "eth_getTransactionByHash": {
        const h = (p[0] as string).toLowerCase();
        const m = allTxs().find(({ t }) => t.hash.toLowerCase() === h);
        if (m) return txJson(m.t, m.b);
        const pool = mempool.get(h);
        return pool ? txJson(pool) : null;
      }
      case "eth_getTransactionReceipt": {
        const h = (p[0] as string).toLowerCase();
        if (opts.failReceipt?.(h)) throw Object.assign(new Error("HTTP request failed. Status: 429"), { code: -32005 });
        const m = allTxs().find(({ t }) => t.hash.toLowerCase() === h);
        return m ? receiptJson(m.t, m.b.number) : null;
      }
      case "eth_getBlockByNumber": {
        const tag = p[0] as string;
        const n = tag === "latest" || tag === "pending" ? blocks[blocks.length - 1]!.number : Number(BigInt(tag));
        const b = blocks.find((x) => x.number === n);
        if (!b) return null;
        if (p[1]) opts.getBlockLog?.push(n);
        return {
          number: hx(b.number), hash: h32(b.number), parentHash: h32(b.number - 1), timestamp: hx(b.time),
          transactions: p[1] ? b.txs.map((t) => txJson(t, b)) : b.txs.map((t) => t.hash),
          baseFeePerGas: hx(1), gasLimit: hx(30_000_000), gasUsed: hx(0), miner: `0x${"00".repeat(20)}`, extraData: "0x",
          logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0",
          sha3Uncles: h32(0), stateRoot: h32(0), transactionsRoot: h32(0), receiptsRoot: h32(0), size: "0x1", uncles: [], mixHash: h32(0),
        };
      }
      case "eth_getTransactionCount": {
        const a = (p[0] as string).toLowerCase();
        const mined = nonces.get(a) ?? 0;
        if (p[1] === "pending") { let n = mined; for (const t of mempool.values()) if (t.from.toLowerCase() === a) n = Math.max(n, t.nonce + 1); return hx(n); }
        return hx(mined);
      }
      default: throw new Error(`fake chain: unsupported ${method}`);
    }
  };
  const client = createPublicClient({ chain: sepolia, transport: custom({ request }, { retryCount: 0 }), pollingInterval: 4_000 }) as unknown as PublicClient;
  return {
    client, calls,
    nowMs: () => Date.now() - t0,
    /** put a tx into the pool now (the wallet broadcast it). */
    broadcast: (tx: FakeTx) => { mempool.set(tx.hash.toLowerCase(), tx); },
    /** mine `tx` in the first block at or after `atMs` (it evicts any pool tx with the same from/nonce). */
    mineAt: (tx: FakeTx, atMs: number) => { scheduled.push({ atMs, tx }); },
    /** the pool forgets a tx (dropped). */
    forget: (hash: Hex) => { mempool.delete(hash.toLowerCase()); },
    head: () => blocks[blocks.length - 1]!,
    stop: () => clearInterval(timer),
  };
};
