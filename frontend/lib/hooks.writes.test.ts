// The write lifecycle (lib/hooks.ts):
//   - a write from a contract account (a Safe over WalletConnect answers eth_sendTransaction with its
//     safeTxHash, which no node knows) is followed through the wallet, never called "dropped, send it again";
//   - writes are dry-run on the app's RPC before the wallet prompt, and a mined revert says why;
//   - the viewer's own contribution is re-read whenever the switch's bounty or state moves;
//   - a top-up whose wallet answer was lost, and which then lands, is reported to the run that sent it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import {
  HttpRequestError, InternalRpcError, RawContractError, TransactionNotFoundError, TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError, createPublicClient, custom, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData,
  getContractError, keccak256, toBytes,
  type BaseError, type Hex, type PublicClient, type TransactionReceipt,
} from "viem";
import { dmsAbi } from "./abi";
import { WouldRevertError, dmsWriteAbi, errMsg, mayHaveBroadcast } from "./errors";
import {
  DROP_GRACE_MS, DRY_RUN_TIMEOUT_MS, TxDroppedError, TxUnconfirmedError, WRITE_WAIT_MS, createWriteFollower, funderStakeQuery, isContractCode,
  runWrite, sendIfSimulated, waitForUnconfirmedTopUp, waitForWrite, walletAnswerOf, type WriteTracking,
} from "./hooks";
import { WriteUnconfirmedError, createPendingWriteStore, createWriteWatchers, type PendingWrite, type WriteTarget } from "./pendingWrites";
import { toSwitchInfo, type RawSwitchInfo, type SwitchHandle } from "./switch";
import { switchKeyOf } from "./switchScan";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const SAFE = "0x5a5A000000000000000000000000000000005a5A" as const;
const FUNDER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const SAFE_TX = `0x${"5a".repeat(32)}` as Hex;
const REAL_TX = `0x${"d0".repeat(32)}` as Hex;
/** A Safe proxy's runtime code (a delegatecall forwarder), and an EIP-7702 delegated EOA's designator. */
const SAFE_CODE = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e" as Hex;
const DELEGATED_EOA = `0xef0100${"63".repeat(20)}` as Hex;

/** An address as a node returns it in logs (and as encodePacked takes any address: all lowercase skips the checksum). */
const lower = (a: Hex): Hex => a.toLowerCase() as Hex;
/** A DeadManSwitch Pinged event of switch (owner, id), as `address` logged it. */
const pinged = (owner: Hex, id: bigint, address: Hex = CONTRACT) => ({
  address, topics: encodeEventTopics({ abi: dmsAbi, eventName: "Pinged", args: { switchKey: switchKeyOf(lower(owner), id) } }),
  data: encodeAbiParameters([{ type: "uint64" }, { type: "uint64" }], [1_000n, 87_400n]),
});
/** A BountyFunded event of switch (owner, id) by `funder`. */
const bountyFunded = (owner: Hex, id: bigint, funder: Hex) => ({
  address: CONTRACT, topics: encodeEventTopics({ abi: dmsAbi, eventName: "BountyFunded", args: { switchKey: switchKeyOf(lower(owner), id), funder: lower(funder) } }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [10n ** 15n, 10n ** 16n]),
});
/** What a Safe's ping of its switch #11 logs (the G9 tests' write). */
const DMS_LOG = pinged(SAFE, 11n);
/** The G9 tests' write: the Safe pings its own switch #11. */
const SAFE_PING: WriteTarget = { chainId: 11155111, contract: CONTRACT, fn: "ping", owner: SAFE, id: 11n };
/** A Safe's ExecutionFailure(bytes32,uint256): its inner call failed (safeTxGas > 0), the outer transaction did not. */
const SAFE_EXECUTION_FAILURE = { address: SAFE, topics: [keccak256(toBytes("ExecutionFailure(bytes32,uint256)"))], data: "0x" };
const receiptOf = (hash: Hex, status: "success" | "reverted" = "success", logs: readonly unknown[] = [DMS_LOG]) =>
  ({ status, blockNumber: 100n, transactionHash: hash, logs }) as unknown as TransactionReceipt;

/** Settle `p` while advancing fake time by `ms`; returns the outcome and when it settled. */
const settle = async <T,>(p: Promise<T>, ms: number) => {
  const t0 = Date.now();
  const out: { value?: T; error?: Error; atMs?: number } = {};
  p.then((v) => { out.value = v; out.atMs = Date.now() - t0; }, (e: Error) => { out.error = e; out.atMs = Date.now() - t0; });
  await vi.advanceTimersByTimeAsync(ms);
  return out;
};

/**
 * The app's read RPC: it knows only real transactions. REAL_TX (the owner EOA's execTransaction that
 * executed the SafeTx) is mined from `realMinedAt`; the Safe's id SAFE_TX is never known to any node.
 */
const rpc = (o: { code: Hex | undefined; realMinedAt?: number; realLogs?: readonly unknown[] }) => {
  const t0 = Date.now();
  const mined = (h: Hex) => h === REAL_TX && o.realMinedAt !== undefined && Date.now() - t0 >= o.realMinedAt;
  const client = {
    chain: { id: 11155111 },
    waitForTransactionReceipt: ({ hash, timeout }: { hash: Hex; timeout: number }) => new Promise((resolve, reject) => {
      const iv = setInterval(() => { if (mined(hash)) { clearInterval(iv); clearTimeout(to); resolve(receiptOf(hash, "success", o.realLogs)); } }, 4_000);
      const to = setTimeout(() => { clearInterval(iv); reject(new WaitForTransactionReceiptTimeoutError({ hash })); }, timeout);
    }),
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (mined(hash)) return { from: OWNER, nonce: 3, hash };
      throw new TransactionNotFoundError({ hash });
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (mined(hash)) return receiptOf(hash, "success", o.realLogs);
      throw new TransactionReceiptNotFoundError({ hash });
    },
    getTransactionCount: async () => 3,
    getBlockNumber: async () => 100n,
    getCode: async () => o.code,
  } as unknown as PublicClient;
  return client;
};

beforeEach(() => { vi.useFakeTimers({ now: 1_700_000_000_000 }); });
afterEach(() => { vi.useRealTimers(); });

describe("G9: a write from a contract account (a Safe answers with its safeTxHash) is followed through the wallet", () => {
  it("a 2-of-3 Safe whose owners never sign: no 'dropped… send it again', ever; after 30 minutes a neutral 'check the Safe's queue'", async () => {
    const walletTx = vi.fn(async () => null);
    const out = await settle(waitForWrite(rpc({ code: SAFE_CODE }), SAFE_TX, { from: SAFE, walletTx, value: 10n ** 16n }), WRITE_WAIT_MS + 120_000);
    expect(out.error).toBeDefined();
    expect(out.error).not.toBeInstanceOf(TxDroppedError);
    expect(out.error).toBeInstanceOf(TxUnconfirmedError);
    expect(out.error?.message).not.toMatch(/send it again|did not happen/i);
    expect(out.error?.message).toMatch(/Safe/);
    expect(out.error?.message).toMatch(/queue/i);
    expect(out.atMs).toBeGreaterThanOrEqual(WRITE_WAIT_MS);
    expect(walletTx).toHaveBeenCalledWith(SAFE_TX);
  });

  it("the wallet names the transaction that executed it: that transaction's receipt is the write's outcome", async () => {
    // The co-signers execute 40 s after the send; from then the wallet maps the safeTxHash to the real tx.
    const t0 = Date.now();
    const walletTx = vi.fn(async () => (Date.now() - t0 >= 40_000 ? { hash: REAL_TX, failed: false } : null));
    const out = await settle(waitForWrite(rpc({ code: SAFE_CODE, realMinedAt: 40_000 }), SAFE_TX, { from: SAFE, walletTx, target: SAFE_PING }), 5 * 60_000);
    expect(out.error).toBeUndefined();
    expect(out.value).toMatchObject({ status: "success", transactionHash: REAL_TX });
    expect(out.atMs).toBeLessThan(DROP_GRACE_MS);
  });

  it("runWrite hands the executed transaction's hash on (for the explorer link), not the Safe's id", async () => {
    const client = rpc({ code: SAFE_CODE, realMinedAt: 0 });
    const store = createPendingWriteStore(() => null);
    const follower = createWriteFollower(store, createWriteWatchers<TransactionReceipt | null>());
    const target: WriteTarget = { chainId: 11155111, contract: CONTRACT, fn: "ping", owner: SAFE, id: 11n };
    const track: WriteTracking = { store, target, value: 0n, from: SAFE, watch: (w) => follower.follow(client, w, { walletTx: async () => ({ hash: REAL_TX, failed: false }) }) };
    const out = await settle(runWrite(async () => SAFE_TX, client, async () => {}, {}, track), 60_000);
    expect(out.value?.hash).toBe(REAL_TX);
    expect(store.all()).toEqual([]);
  });

  it("controls: an EOA, and an EIP-7702 delegated EOA, whose tx no node knows still get 'dropped' after about 5 minutes", async () => {
    for (const code of [undefined, "0x" as Hex, DELEGATED_EOA]) {
      const out = await settle(waitForWrite(rpc({ code }), SAFE_TX, { from: OWNER, walletTx: async () => null }), 10 * 60_000);
      expect(out.error).toBeInstanceOf(TxDroppedError);
    }
  });

  it("the wallet's answers: wallet_getCallsStatus receipts (a Safe's, once executed) or an eth_getTransactionReceipt answer", () => {
    const ok = { hash: REAL_TX, failed: false };
    expect(walletAnswerOf({ version: "2.0.0", id: SAFE_TX, status: 200, atomic: true, receipts: [{ status: "0x1", transactionHash: REAL_TX }] })).toEqual(ok);
    expect(walletAnswerOf({ status: "CONFIRMED", receipts: [{ transactionHash: REAL_TX }] })).toEqual(ok);
    expect(walletAnswerOf({ status: 100, receipts: [] })).toBeNull(); // still waiting for its owners
    expect(walletAnswerOf({ transactionHash: REAL_TX, status: "0x1" })).toEqual(ok);
    for (const none of [null, undefined, "0x", 7, { receipts: [{ transactionHash: "0x1234" }] }]) expect(walletAnswerOf(none)).toBeNull();
  });

  it("isContractCode: code that is not a 7702 designator", () => {
    expect(isContractCode(SAFE_CODE)).toBe(true);
    expect(isContractCode(undefined)).toBe(false);
    expect(isContractCode("0x")).toBe(false);
    expect(isContractCode(DELEGATED_EOA)).toBe(false);
  });
});

describe("E1: writes are dry-run before the wallet prompt; a revert says why, before and after mining", () => {
  /** What simulateContract throws when the node's eth_call reverts with `errorName`. */
  const simulationRevert = (errorName: string, functionName = "markDark") => getContractError(
    new RawContractError({ data: encodeErrorResult({ abi: dmsAbi, errorName } as never) }) as BaseError,
    { abi: dmsWriteAbi, functionName, args: [OWNER, 11n], address: CONTRACT },
  );

  it("a stale 'Mark dark' (another hunter marked first): refused before the wallet, with the reason", async () => {
    const send = vi.fn(async () => REAL_TX);
    const e = await sendIfSimulated(async () => { throw simulationRevert("AlreadyDarkMarked"); }, send).catch((x: unknown) => x);
    expect(send).not.toHaveBeenCalled();
    expect(errMsg(e)).toBe("Key release was already requested for this switch.");
  });

  it("a stale 'Reclaim' (reclaimed elsewhere): refused with NothingToReclaim; runWrite refreshes the switch at once", async () => {
    const send = vi.fn(async () => REAL_TX);
    const refresh = vi.fn(async () => {});
    const e = await runWrite(
      () => sendIfSimulated(async () => { throw simulationRevert("NothingToReclaim", "reclaimContribution"); }, send),
      rpc({ code: undefined }), refresh,
    ).catch((x: unknown) => x);
    expect(send).not.toHaveBeenCalled();
    expect(errMsg(e)).toBe("You have nothing to reclaim on this switch.");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("the dry run through a real viem client: the node's revert data decodes to the contract's error", async () => {
    vi.useRealTimers();
    const node = createPublicClient({
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === "eth_call") throw Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi: dmsAbi, errorName: "AlreadyRevealed" } as never) });
          if (method === "eth_chainId") return "0xaa36a7";
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    const send = vi.fn(async () => REAL_TX);
    const e = await sendIfSimulated(
      () => node.simulateContract({ address: CONTRACT, abi: dmsWriteAbi, functionName: "revealKey", args: [OWNER, 11n, `0x${"07".repeat(32)}`, "0x01"], account: FUNDER }),
      send,
    ).catch((x: unknown) => x);
    expect(send).not.toHaveBeenCalled();
    expect(errMsg(e)).toBe("The key has already been revealed.");
  });

  it("a revert only the next block's time lifts (NotDark at the deadline, NotRescuable at the rescue time) is left to the wallet", async () => {
    // The card's clock runs ahead of the latest block by up to a slot: "Mark dark" is offered once the
    // deadline passed by that clock, and the transaction is mined in a block at least that late.
    const send = vi.fn(async () => REAL_TX);
    await expect(sendIfSimulated(async () => { throw simulationRevert("NotDark"); }, send)).resolves.toBe(REAL_TX);
    await expect(sendIfSimulated(async () => { throw simulationRevert("NotRescuable", "reclaimContribution"); }, send)).resolves.toBe(REAL_TX);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("an RPC that fails the dry run (429, down) says nothing about the write: the wallet is asked as before", async () => {
    const send = vi.fn(async () => REAL_TX);
    await expect(sendIfSimulated(async () => { throw new HttpRequestError({ url: "https://rpc.example", status: 429 }); }, send)).resolves.toBe(REAL_TX);
    // Nor does a wallet-style internal error without revert data.
    await expect(sendIfSimulated(async () => { throw new InternalRpcError(new Error("internal")); }, send)).resolves.toBe(REAL_TX);
    // No client or account to dry-run with: straight to the wallet.
    await expect(sendIfSimulated(null, send)).resolves.toBe(REAL_TX);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("a revert mined after a passed dry run (the race was lost in the same block): the replay at its block says why", async () => {
    const replay = createPublicClient({
      transport: custom({
        request: async ({ method, params }: { method: string; params: unknown[] }) => {
          if (method === "eth_call" && params[1] === "0x64") {
            throw Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi: dmsAbi, errorName: "AlreadyRevealed" } as never) });
          }
          throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
        },
      }),
    });
    const client = {
      ...rpc({ code: undefined }),
      waitForTransactionReceipt: async () => receiptOf(REAL_TX, "reverted"),
      getTransaction: async () => ({ from: FUNDER, to: CONTRACT, input: "0x12345678", value: 0n, nonce: 3, hash: REAL_TX }),
      call: (args: Parameters<PublicClient["call"]>[0]) => replay.call(args),
    } as unknown as PublicClient;
    const out = await settle(waitForWrite(client, REAL_TX), 5_000);
    expect(out.error?.message).toMatch(/reverted/);
    expect(out.error?.message).toContain("The key has already been revealed.");
  });
});

describe("F5: the viewer's own contribution follows the switch's bounty and state", () => {
  const H: SwitchHandle = { contractAddr: CONTRACT, owner: OWNER, id: 11n };
  const info = (bounty: bigint, state = 1) => toSwitchInfo({
    owner: OWNER, state, lastPing: 0n, pingInterval: 86_400n, createdAt: 0n, expiresAt: 86_400n, darkMarkedAt: 0n, revealedAt: 0n,
    bounty, ownerStake: 10n ** 16n, plaintextCommitment: `0x${"00".repeat(32)}`, encKeyHandle: `0x${"00".repeat(32)}`,
    revealedKey: `0x${"00".repeat(32)}`, ciphertextLength: 113n, published: false, rescuable: false,
  } as RawSwitchInfo);

  it("the CLI adds 0.002 ETH: the switch's info poll sees the bounty move, and the stake is read again at once", async () => {
    vi.useRealTimers();
    let stake = 5n * 10n ** 15n;
    let reads = 0;
    const client = { chain: { id: 11155111 }, readContract: async () => { reads++; return stake; } } as unknown as PublicClient;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const obs = new QueryObserver<bigint, Error, bigint, bigint, QueryKey>(qc, funderStakeQuery(client, 11155111, H, FUNDER, info(15n * 10n ** 15n)));
    const unsubscribe = obs.subscribe(() => {});
    await vi.waitFor(() => expect(obs.getCurrentResult().data).toBe(5n * 10n ** 15n));
    expect(reads).toBe(1);

    stake = 7n * 10n ** 15n;
    obs.setOptions(funderStakeQuery(client, 11155111, H, FUNDER, info(17n * 10n ** 15n)));
    // The old figure stays shown while the new one loads (no flicker of the "Reclaim" button)…
    expect(obs.getCurrentResult().data).toBe(5n * 10n ** 15n);
    await vi.waitFor(() => expect(obs.getCurrentResult().data).toBe(7n * 10n ** 15n));
    expect(reads).toBe(2);

    // …the same info again reads nothing new…
    obs.setOptions(funderStakeQuery(client, 11155111, H, FUNDER, info(17n * 10n ** 15n)));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads).toBe(2);

    // …and another account never sees this one's figure, even for a moment.
    obs.setOptions(funderStakeQuery(client, 11155111, H, OWNER, info(17n * 10n ** 15n)));
    expect(obs.getCurrentResult().data).toBeUndefined();
    unsubscribe();
    qc.clear();
  });

  it("a cancelled switch whose funder reclaimed from the CLI: the bounty drops, the stake is read again (no doomed 'Reclaim')", async () => {
    vi.useRealTimers();
    let stake = 5n * 10n ** 15n;
    const client = { chain: { id: 11155111 }, readContract: async () => stake } as unknown as PublicClient;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const obs = new QueryObserver<bigint, Error, bigint, bigint, QueryKey>(qc, funderStakeQuery(client, 11155111, H, FUNDER, info(5n * 10n ** 15n, 5)));
    const unsubscribe = obs.subscribe(() => {});
    await vi.waitFor(() => expect(obs.getCurrentResult().data).toBe(5n * 10n ** 15n));
    stake = 0n;
    obs.setOptions(funderStakeQuery(client, 11155111, H, FUNDER, info(0n, 5)));
    await vi.waitFor(() => expect(obs.getCurrentResult().data).toBe(0n));
    unsubscribe();
    qc.clear();
  });
});

describe("F2b: a top-up whose wallet answer was lost, then landed, is reported to the run that sent it", () => {
  /** viem's wrapping of a wallet's internal error (-32603) without revert data. */
  const lostAnswer = () => getContractError(
    new InternalRpcError(Object.assign(new Error("broadcast, then the response was lost"), { code: -32603 })) as BaseError,
    { abi: dmsAbi, functionName: "fundBounty", args: [OWNER, 11n], address: CONTRACT },
  );
  const VALUE = 5n * 10n ** 15n;
  /** The funder's stake grows by the top-up `landsAt` ms after the send (null: never). */
  const chainWith = (landsAt: number | null) => {
    const t0 = Date.now();
    return {
      chain: { id: 11155111 },
      readContract: async () => (landsAt !== null && Date.now() - t0 >= landsAt ? VALUE : 0n),
      getTransactionCount: async () => (landsAt !== null && Date.now() - t0 >= landsAt ? 8 : 7),
    } as unknown as PublicClient;
  };
  const tracking = (client: PublicClient): WriteTracking => {
    const store = createPendingWriteStore(() => null);
    const follower = createWriteFollower(store, createWriteWatchers<TransactionReceipt | null>());
    return {
      store, target: { chainId: 11155111, contract: CONTRACT, fn: "fundBounty", owner: OWNER, id: 11n }, value: VALUE, from: FUNDER,
      before: async () => ({ nonce: 7, stakeBefore: 0n }),
      watch: (w) => follower.follow(client, w),
    };
  };

  it("the stake grows by its value: `landed` is called once, after the run already reported 'may have been sent'", async () => {
    const client = chainWith(15_000);
    const landed = vi.fn();
    const out = await settle(runWrite(async () => { throw lostAnswer(); }, client, async () => {}, { landed }, tracking(client)), 1_000);
    expect(out.error).toBeInstanceOf(WriteUnconfirmedError);
    expect(landed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it("it never shows up (the nonce moved without it): `landed` is never called", async () => {
    const client = { ...chainWith(null), getTransactionCount: async () => 8 } as unknown as PublicClient;
    const landed = vi.fn();
    await settle(runWrite(async () => { throw lostAnswer(); }, client, async () => {}, { landed }, tracking(client)), 5 * 60_000);
    expect(landed).not.toHaveBeenCalled();
  });
});

// ---------- dry runs, smart accounts and lost answers ----------

describe("the dry run cannot hold the wallet prompt back", () => {
  it(`a read RPC that never answers: the wallet is asked after ${DRY_RUN_TIMEOUT_MS} ms, not after viem's retries (41 s and more)`, async () => {
    const send = vi.fn(async () => REAL_TX);
    const p = sendIfSimulated(() => new Promise(() => {}), send);
    await vi.advanceTimersByTimeAsync(DRY_RUN_TIMEOUT_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(REAL_TX);
    expect(DRY_RUN_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });

  it("the cap covers the read-floor block lookup the dry run makes first", async () => {
    const send = vi.fn(async () => REAL_TX);
    const hangingHead = () => new Promise<bigint>(() => {});
    const p = sendIfSimulated(async () => { await hangingHead(); await hangingHead(); }, send);
    await vi.advanceTimersByTimeAsync(DRY_RUN_TIMEOUT_MS);
    await expect(p).resolves.toBe(REAL_TX);
  });

  it("a top-up's own reads before the wallet (nonce, stake) are capped too: no verdict, the top-up is sent", async () => {
    const store = createPendingWriteStore(() => null);
    const follower = createWriteFollower(store, createWriteWatchers<TransactionReceipt | null>());
    const client = rpc({ code: undefined, realMinedAt: 0 });
    const send = vi.fn(async () => REAL_TX);
    const track: WriteTracking = {
      store, target: { chainId: 11155111, contract: CONTRACT, fn: "fundBounty", owner: OWNER, id: 11n }, value: 10n ** 15n, from: FUNDER,
      before: () => new Promise(() => {}),
      watch: (w) => follower.follow(client, w),
    };
    void runWrite(send, client, async () => {}, {}, track).catch(() => {});
    await vi.advanceTimersByTimeAsync(DRY_RUN_TIMEOUT_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("a smart account's request counts only if the wallet and the chain show it did this write", () => {
  it("the wallet reports the calls failed (EIP-5792 400 / 500, or a receipt with status 0x0)", () => {
    expect(walletAnswerOf({ version: "2.0.0", id: SAFE_TX, status: 500, receipts: [{ status: "0x0", transactionHash: REAL_TX }] })).toEqual({ hash: REAL_TX, failed: true });
    expect(walletAnswerOf({ status: 400 })).toEqual({ hash: null, failed: true });
    expect(walletAnswerOf({ status: "CONFIRMED", receipts: [{ status: "0x0", transactionHash: REAL_TX }] })).toEqual({ hash: REAL_TX, failed: true });
    expect(walletAnswerOf({ transactionHash: REAL_TX, status: "0x0" })).toEqual({ hash: REAL_TX, failed: true });
  });

  it("a failure the wallet reports is never a success: a neutral 'check your wallet'", async () => {
    const walletTx = vi.fn(async () => walletAnswerOf({ status: 500, receipts: [{ status: "0x0", transactionHash: REAL_TX }] }));
    const out = await settle(waitForWrite(rpc({ code: SAFE_CODE, realMinedAt: 0 }), SAFE_TX, { from: SAFE, walletTx, target: SAFE_PING }), 60_000);
    expect(out.value).toBeUndefined();
    expect(out.error).toBeInstanceOf(TxUnconfirmedError);
    expect(out.error?.message).toMatch(/check your wallet/i);
  });

  it("the outer transaction succeeded but logged nothing from the switch's contract (a Safe's inner call failed, a 4337 bundle's call reverted)", async () => {
    for (const realLogs of [[SAFE_EXECUTION_FAILURE], [], [{ ...DMS_LOG, address: FUNDER }]]) {
      const walletTx = vi.fn(async () => ({ hash: REAL_TX, failed: false }));
      const out = await settle(waitForWrite(rpc({ code: SAFE_CODE, realMinedAt: 0, realLogs }), SAFE_TX, { from: SAFE, walletTx, target: SAFE_PING }), 60_000);
      expect(out.value).toBeUndefined();
      expect(out.error).toBeInstanceOf(TxUnconfirmedError);
      expect(out.error?.message).toMatch(/check your wallet/i);
    }
  });

  it("an unrelated transaction the wallet names is not this top-up: runWrite does not report it as one", async () => {
    const store = createPendingWriteStore(() => null);
    const follower = createWriteFollower(store, createWriteWatchers<TransactionReceipt | null>());
    const client = rpc({ code: SAFE_CODE, realMinedAt: 0, realLogs: [] });
    const track: WriteTracking = {
      store, target: { chainId: 11155111, contract: CONTRACT, fn: "fundBounty", owner: OWNER, id: 11n }, value: 10n ** 16n, from: SAFE,
      watch: (w) => follower.follow(client, w, { walletTx: async () => ({ hash: REAL_TX, failed: false }) }),
    };
    const out = await settle(runWrite(async () => SAFE_TX, client, async () => {}, {}, track), 60_000);
    expect(out.value).toBeUndefined();
    expect(out.error).toBeInstanceOf(TxUnconfirmedError);
  });
});

describe("a Safe write resumed after a reload asks the wallet that is connected now", () => {
  it("the first follow ran while wagmi was reconnecting (no usable connector); a later follow's wallet is the one asked", async () => {
    const store = createPendingWriteStore(() => null);
    const follower = createWriteFollower(store, createWriteWatchers<TransactionReceipt | null>());
    const w: PendingWrite = {
      chainId: 11155111, contract: CONTRACT, fn: "ping", owner: SAFE, id: 11n, hash: SAFE_TX, from: SAFE, nonce: null, value: 0n,
      sentAt: Date.now() - 60_000, stakeBefore: null, call: null,
    };
    store.put(w);
    const client = rpc({ code: SAFE_CODE, realMinedAt: 0 });
    const stale = vi.fn(async () => { throw new TypeError("connector.getProvider is not a function"); });
    const first = follower.follow(client, w, { resumed: true, walletTx: stale });
    const live = vi.fn(async () => ({ hash: REAL_TX, failed: false }));
    const second = follower.follow(client, w, { resumed: true, walletTx: live });
    expect(second).toBe(first); // one wait per record…
    const out = await settle(second, 5 * 60_000);
    expect(live).toHaveBeenCalled(); // …asking the wallet connected now
    expect(out.value).toMatchObject({ status: "success", transactionHash: REAL_TX });
  });
});

describe("only a revert of this contract (or Zama's host) blocks a write in the dry run", () => {
  const nodeFailing = (err: Record<string, unknown>) => createPublicClient({
    transport: custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_call") throw Object.assign(new Error(String(err.message)), err);
        if (method === "eth_chainId") return "0xaa36a7";
        throw new Error(`unexpected ${method}`);
      },
    }, { retryCount: 0 }),
  });
  const verdict = async (err: Record<string, unknown>) => {
    const send = vi.fn(async () => REAL_TX);
    const node = nodeFailing(err);
    return sendIfSimulated(
      () => node.simulateContract({ address: CONTRACT, abi: dmsWriteAbi, functionName: "fundBounty", args: [OWNER, 11n], value: 1n, account: FUNDER }),
      send,
    ).then(() => "sent", (e: unknown) => `blocked${mayHaveBroadcast(e) ? " (as maybe sent!)" : ""}: ${errMsg(e)}`);
  };
  const EXPIRED = encodeErrorResult({ abi: dmsAbi, errorName: "Expired" } as never);

  it.each([
    ["-32603 Internal error, no data", { code: -32603, message: "Internal error" }],
    ["-32603 with a text `data` (a node's detail)", { code: -32603, message: "Internal error", data: "header not found" }],
    ["-32603 with hex-ish `data` that is no known error", { code: -32603, message: "Internal error", data: "0xdeadbeef" }],
    ["-32000 header not found", { code: -32000, message: "header not found" }],
    ["code 3, execution reverted, empty data (out of gas in eth_call)", { code: 3, message: "execution reverted", data: "0x" }],
  ])("infrastructure, not a verdict: %s → sent", async (_label, err) => {
    vi.useRealTimers();
    expect(await verdict(err)).toBe("sent");
  });

  it.each([
    ["code 3 with Expired()", { code: 3, message: "execution reverted", data: EXPIRED }],
    ["-32000 'execution reverted' with Expired() (geth style)", { code: -32000, message: "execution reverted", data: EXPIRED }],
  ])("a revert of the contract: %s → blocked, with its reason, and counted as not sent", async (_label, err) => {
    vi.useRealTimers();
    expect(await verdict(err)).toBe(`blocked: ${"The deadline has passed: the switch is dark and can no longer be pinged, funded or cancelled."}`);
  });
});

describe("a lost-answer top-up that 'landed' is matched to the transaction at its nonce", () => {
  const VALUE = 5n * 10n ** 15n;
  const OTHER_CALL = `0x${"ab".repeat(32)}` as Hex;
  const unconfirmed: PendingWrite = {
    chainId: 11155111, contract: CONTRACT, fn: "fundBounty", owner: OWNER, id: 11n, hash: null, from: FUNDER, nonce: 7, value: VALUE,
    sentAt: 1_700_000_000_000, stakeBefore: 0n, call: null,
  };
  /** The funder's stake grows by VALUE at 20 s; its nonce-7 transaction is in block 105 (head 110). */
  const chainWith = (atNonce7: { to: string; value: bigint; input: Hex } | null) => {
    const t0 = Date.now();
    const landed = () => Date.now() - t0 >= 20_000;
    return {
      chain: { id: 11155111 },
      readContract: async () => (landed() ? VALUE : 0n),
      getBlockNumber: async () => 110n,
      getTransactionCount: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) =>
        blockTag === "latest" || blockNumber === undefined ? (landed() ? 8 : 7) : blockNumber >= 105n ? 8 : 7,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        if (blockNumber !== 105n || !atNonce7) return { transactions: [] };
        return { transactions: [{ hash: OTHER_CALL, from: FUNDER, nonce: 7, ...atNonce7 }] };
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: "success", blockNumber: 105n, transactionHash: hash, logs: [DMS_LOG] }),
    } as unknown as PublicClient;
  };
  const THIS_CALL = { to: CONTRACT, value: VALUE, input: encodeFunctionData({ abi: dmsAbi, functionName: "fundBounty", args: [OWNER, 11n] }) };

  it("the transaction at (sender, nonce) is this top-up's call: its receipt (matched)", async () => {
    const out = await settle(waitForUnconfirmedTopUp(chainWith(THIS_CALL), unconfirmed), 60_000);
    expect(out.value).toMatchObject({ status: "success", transactionHash: OTHER_CALL, blockNumber: 105n });
  });

  it("another call took that nonce (the stake grew from another tab, device or the CLI): landed, but not matched", async () => {
    for (const other of [
      { ...THIS_CALL, value: VALUE * 2n },
      { ...THIS_CALL, input: encodeFunctionData({ abi: dmsAbi, functionName: "fundBounty", args: [OWNER, 12n] }) },
      { ...THIS_CALL, to: FUNDER },
    ]) {
      const out = await settle(waitForUnconfirmedTopUp(chainWith(other), unconfirmed), 60_000);
      expect(out.error).toBeUndefined();
      expect(out.value).toBeNull();
    }
  });

  it("runWrite tells the run whether it was matched: `landed({ matched })`", async () => {
    const lostAnswer = () => getContractError(
      new InternalRpcError(Object.assign(new Error("request expired before the wallet saw it"), { code: -32603 })) as BaseError,
      { abi: dmsAbi, functionName: "fundBounty", args: [OWNER, 11n], address: CONTRACT },
    );
    for (const [atNonce7, matched] of [[THIS_CALL, true], [{ ...THIS_CALL, value: 1n }, false]] as const) {
      const client = chainWith(atNonce7);
      const store = createPendingWriteStore(() => null);
      const follower = createWriteFollower(store, createWriteWatchers<TransactionReceipt | null>());
      const track: WriteTracking = {
        store, target: { chainId: 11155111, contract: CONTRACT, fn: "fundBounty", owner: OWNER, id: 11n }, value: VALUE, from: FUNDER,
        before: async () => ({ nonce: 7, stakeBefore: 0n }), watch: (w) => follower.follow(client, w),
      };
      const landed = vi.fn();
      const out = await settle(runWrite(async () => { throw lostAnswer(); }, client, async () => {}, { landed }, track), 60_000);
      expect(out.error).toBeInstanceOf(WriteUnconfirmedError);
      expect(landed).toHaveBeenCalledTimes(1);
      expect(landed).toHaveBeenCalledWith({ matched });
    }
  });
});

// ---------- contract-account receipts and revert reasons ----------

describe("a contract account's write counts only if its receipt shows this write on this switch", () => {
  const FUND: WriteTarget = { chainId: 11155111, contract: CONTRACT, fn: "fundBounty", owner: OWNER, id: 11n };
  const viaWallet = (realLogs: readonly unknown[], target: WriteTarget = SAFE_PING) => settle(
    waitForWrite(rpc({ code: SAFE_CODE, realMinedAt: 0, realLogs }), SAFE_TX, { from: SAFE, walletTx: async () => ({ hash: REAL_TX, failed: false }), target }),
    60_000,
  );

  it("the executed transaction logged another switch's ping (another operation of the same bundle): not this write", async () => {
    const out = await viaWallet([pinged(OWNER, 99n)]);
    expect(out.value).toBeUndefined();
    expect(out.error).toBeInstanceOf(TxUnconfirmedError);
    expect(out.error?.message).toMatch(/check your wallet/i);
  });

  it("the right event from another contract, another event for this switch, or a top-up of this switch by someone else: not this write", async () => {
    for (const [logs, target] of [
      [[pinged(SAFE, 11n, FUNDER)], SAFE_PING],
      [[bountyFunded(SAFE, 11n, SAFE)], SAFE_PING],
      [[bountyFunded(OWNER, 11n, FUNDER)], FUND],
    ] as const) {
      const out = await viaWallet(logs, target);
      expect(out.error).toBeInstanceOf(TxUnconfirmedError);
    }
  });

  it("this switch's own event, among others of the bundle, is the write's outcome", async () => {
    expect((await viaWallet([pinged(OWNER, 99n), pinged(SAFE, 11n)])).value).toMatchObject({ status: "success", transactionHash: REAL_TX });
    expect((await viaWallet([bountyFunded(OWNER, 11n, SAFE)], FUND)).value).toMatchObject({ status: "success" });
  });

  it("a contract account whose wallet returned a hash the node knows (the outer transaction): checked the same way", async () => {
    const known = (realLogs: readonly unknown[]) => settle(
      waitForWrite(rpc({ code: SAFE_CODE, realMinedAt: 0, realLogs }), REAL_TX, { from: SAFE, walletTx: async () => null, target: SAFE_PING }),
      60_000,
    );
    const empty = await known([]);
    expect(empty.value).toBeUndefined();
    expect(empty.error).toBeInstanceOf(TxUnconfirmedError);
    expect((await known([pinged(OWNER, 99n)])).error).toBeInstanceOf(TxUnconfirmedError);
    expect((await known([pinged(SAFE, 11n)])).value).toMatchObject({ status: "success", transactionHash: REAL_TX });
  });

  it("control: an EOA (or a 7702-delegated one) is not asked for an event: its successful call is the write", async () => {
    for (const code of [undefined, "0x" as Hex, DELEGATED_EOA]) {
      const out = await settle(
        waitForWrite(rpc({ code, realMinedAt: 0, realLogs: [] }), REAL_TX, { from: OWNER, walletTx: async () => null, target: SAFE_PING }),
        60_000,
      );
      expect(out.value).toMatchObject({ status: "success" });
    }
  });
});

describe("a plain Solidity revert in the dry run keeps its reason", () => {
  const ERROR_STRING = [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }] as const;
  const errorString = (reason: string) => encodeErrorResult({ abi: ERROR_STRING, errorName: "Error", args: [reason] });
  const dryRun = async (data: Hex, code = 3) => {
    vi.useRealTimers();
    const node = createPublicClient({
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === "eth_call") throw Object.assign(new Error("execution reverted"), { code, data });
          if (method === "eth_chainId") return "0xaa36a7";
          throw new Error(`unexpected ${method}`);
        },
      }, { retryCount: 0 }),
    });
    const send = vi.fn(async () => REAL_TX);
    const e = await sendIfSimulated(
      () => node.simulateContract({ address: CONTRACT, abi: dmsWriteAbi, functionName: "fundBounty", args: [OWNER, 11n], value: 1n, account: FUNDER }),
      send,
    ).catch((x: unknown) => x);
    expect(send).not.toHaveBeenCalled();
    expect(e).toBeInstanceOf(WouldRevertError);
    expect(mayHaveBroadcast(e)).toBe(false);
    return errMsg(e);
  };

  it("Error(\"nope\"): blocked with the reason, not 'would revert (Error)'", async () => {
    for (const code of [3, -32000]) {
      const msg = await dryRun(errorString("nope"), code);
      expect(msg).toContain("nope");
      expect(msg).not.toMatch(/\(Error\)/);
      expect(msg).toMatch(/nothing was sent/i);
    }
  });

  it("the reason is shown as one plain line: control, bidi and invisible characters removed, at most 160 characters", async () => {
    const hostile = `pay\u202Eevil\u200B\u0007\n${"x".repeat(500)}`;
    const msg = await dryRun(errorString(hostile));
    expect(msg).not.toMatch(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/);
    expect(msg).toContain("pay evil");
    const quoted = /"([^"]*)"/.exec(msg)?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(160);
  });

  it("the wallet's own estimate refusing with Error(string) says the reason too (errMsg)", () => {
    const e = getContractError(new RawContractError({ data: errorString("paused by admin") }) as BaseError, {
      abi: dmsWriteAbi, functionName: "fundBounty", args: [OWNER, 11n], address: CONTRACT,
    });
    expect(errMsg(e)).toContain("paused by admin");
  });
});
