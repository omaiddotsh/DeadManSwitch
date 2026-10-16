import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChainMismatchError, ContractFunctionExecutionError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult,
  type Hex,
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { ConnectorAccountNotFoundError, ConnectorChainMismatchError, createConfig, http } from "wagmi";
import { connect, writeContract } from "wagmi/actions";
import { mock } from "wagmi/connectors";
import { dmsAbi } from "./abi";
import { isUserRejection, revertName } from "./errors";
import {
  ATTEMPT_POLL_MS, ATTEMPT_STORAGE_KEY, CREATED_STORAGE_KEY, CreateBlockedError, DROP_RECHECK_GAP_MS, DROP_RECHECK_READS, VANISHED_AFTER_POLLS,
  attemptKey, canResend, classifyAttempt, createAttemptStore, deriveCreateView, dropAttempt, errorTitle, mayHaveBroadcast,
  REVERTED_RECHECK_MS, parseAttempt, planSubmit, pollStep, recordCreated, runCreate, serializeAttempt, startNewSession, submitBlock,
  type AttemptObservation, type AttemptOutcome, type CreateAttempt, type CreateContext, type CreateDeps,
  type CreateStage, type KeyValueStorage, type SwitchSnapshot,
} from "./createAttempt";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;
const CTX: CreateContext = { chainId: 11155111, contract: CONTRACT, owner: OWNER };

const attempt = (over: Partial<CreateAttempt> = {}): CreateAttempt =>
  ({ ...CTX, id: 42n, submitted: false, hash: null, ...over });

class MemStorage implements KeyValueStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const revertError = (errorName: string) =>
  new ContractFunctionRevertedError({ abi: dmsAbi, functionName: "createSwitch", data: encodeErrorResult({ abi: dmsAbi, errorName } as never) });

// ---------- persistence ----------

describe("attempt persistence", () => {
  it("round-trips, and stores only chain / contract / owner / id / submitted / hash", () => {
    const a = attempt({ submitted: true, hash: H1, id: (1n << 255n) + 7n });
    const raw = serializeAttempt(a);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["chainId", "contract", "hash", "id", "owner", "submitted", "v"]);
    expect(parseAttempt(raw)).toEqual(a);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["another version", JSON.stringify({ ...JSON.parse(serializeAttempt(attempt())), v: 2 })],
    ["id 0", JSON.stringify({ ...JSON.parse(serializeAttempt(attempt())), id: "0" })],
    ["id ≥ 2^256", JSON.stringify({ ...JSON.parse(serializeAttempt(attempt())), id: (1n << 256n).toString() })],
    ["a numeric id", JSON.stringify({ ...JSON.parse(serializeAttempt(attempt())), id: 42 })],
    ["a bad owner", JSON.stringify({ ...JSON.parse(serializeAttempt(attempt())), owner: "0x12" })],
    ["a bad hash", JSON.stringify({ ...JSON.parse(serializeAttempt(attempt())), hash: "0x1234" })],
    ["a missing submitted", JSON.stringify({ ...JSON.parse(serializeAttempt(attempt())), submitted: undefined })],
  ])("rejects %s", (_what, raw) => {
    expect(parseAttempt(raw)).toBeNull();
  });

  it("store: persists only attempts that reached the wallet; clears on null", () => {
    const storage = new MemStorage();
    const store = createAttemptStore(() => storage);
    store.set(attempt());
    expect(store.get()?.id).toBe(42n);
    expect(storage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
    store.set(attempt({ submitted: true, hash: H1 }));
    expect(parseAttempt(storage.getItem(ATTEMPT_STORAGE_KEY))?.hash).toBe(H1);
    store.set(null);
    expect(storage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
    expect(store.get()).toBeNull();
  });

  it("store: a reload resumes the persisted attempt", () => {
    const storage = new MemStorage();
    createAttemptStore(() => storage).set(attempt({ submitted: true, hash: H1 }));
    const reloaded = createAttemptStore(() => storage);
    expect(reloaded.get()).toEqual(attempt({ submitted: true, hash: H1 }));
  });

  it("store: storage that throws (private mode, blocked site data) is ignored", () => {
    const store = createAttemptStore(() => { throw new Error("SecurityError"); });
    expect(store.get()).toBeNull();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(attempt({ submitted: true }));
    expect(store.get()?.submitted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("store: no secret material ever reaches storage", async () => {
    const storage = new MemStorage();
    const setItem = vi.spyOn(storage, "setItem");
    const d = deps({ storage });
    await runCreate(d, INPUT);
    for (const [, v] of setItem.mock.calls) {
      expect(v).not.toMatch(/SECRET|ciphertext|commitment|inputProof|encKey/i);
      expect(v).not.toContain(PREPARED.ciphertext.slice(2));
      expect(v).not.toContain(PREPARED.encKey.slice(2));
    }
  });
});

// ---------- outcome classification ----------

describe("classifyAttempt", () => {
  const obs = (o: Partial<AttemptObservation>): AttemptObservation =>
    ({ state: 0, receipt: "none", txKnown: true, unknownPolls: 0, ...o });
  const sent = attempt({ submitted: true, hash: H1 });

  it.each<[string, CreateAttempt, Partial<AttemptObservation>, AttemptOutcome]>([
    ["switch exists → landed (whatever the receipt says)", sent, { state: 1, receipt: "reverted" }, "landed"],
    ["a dark or cancelled switch still landed", sent, { state: 5 }, "landed"],
    ["state read failed → unknown", sent, { state: null, receipt: "success" }, "unknown"],
    ["no hash, no switch → absent", attempt({ submitted: true }), { receipt: null, txKnown: null }, "absent"],
    ["receipt reverted, no switch → reverted", sent, { receipt: "reverted" }, "reverted"],
    ["receipt success but state lags → pending", sent, { receipt: "success" }, "pending"],
    ["not mined, tx in mempool → pending", sent, { receipt: "none", txKnown: true }, "pending"],
    ["not mined, tx briefly unknown → still pending", sent, { receipt: "none", txKnown: false, unknownPolls: VANISHED_AFTER_POLLS - 1 }, "pending"],
    ["not mined, tx unknown for long → vanished", sent, { receipt: "none", txKnown: false, unknownPolls: VANISHED_AFTER_POLLS }, "vanished"],
    ["receipt read failed → unknown", sent, { receipt: "error" }, "unknown"],
  ])("%s", (_name, a, o, want) => {
    expect(classifyAttempt(a, obs(o))).toBe(want);
  });

  it("W12: 'vanished' takes about 5 minutes of polls, since private relays hide a pending tx from public nodes", () => {
    // The first poll is immediate, so N polls span (N - 1) intervals.
    expect((VANISHED_AFTER_POLLS - 1) * ATTEMPT_POLL_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(classifyAttempt(sent, obs({ receipt: "none", txKnown: false, unknownPolls: 3 }))).toBe("pending");
    // Not final: a retry may reuse the id, and the poll keeps watching for the switch.
    expect(canResend("vanished")).toBe(true);
    expect(pollStep("vanished", null)).toEqual({ show: "vanished", next: ATTEMPT_POLL_MS, reverted: null });
  });
});

describe("pollStep", () => {
  it("a landed switch ends the poll; before any revert, everything else is polled every ATTEMPT_POLL_MS", () => {
    expect(pollStep("landed", null)).toEqual({ show: "landed", next: null, reverted: null });
    for (const o of ["pending", "vanished", "absent", "unknown"] as const) {
      expect(pollStep(o, null)).toEqual({ show: o, next: ATTEMPT_POLL_MS, reverted: null });
    }
    // R3: reverted is final for the hash, not for the switch (an earlier send of the id may have landed).
    expect(pollStep("reverted", null)).toEqual({ show: "reverted", next: REVERTED_RECHECK_MS[0], reverted: 1 });
  });

  it("W10: a revert the run saw (e.g. a cancel in the wallet) stands against later polls of that hash", () => {
    // A cancelled hash has no receipt: it reads pending, then vanished.
    for (const o of ["pending", "vanished", "absent", "unknown"] as const) {
      expect(pollStep(o, 0)).toMatchObject({ show: "reverted", reverted: 1 });
    }
    // A switch that exists still wins.
    expect(pollStep("landed", 0)).toMatchObject({ show: "landed", next: null });
  });

  it("Q2: a revert a poll found stands too: a later failed or lagging read does not show 'waiting' again", () => {
    // Poll 1 reads the reverted receipt; poll 2 gets a 429 (unknown); poll 3 hits a node that has not seen the receipt.
    const s1 = pollStep("reverted", null);
    const s2 = pollStep("unknown", s1.reverted);
    const s3 = pollStep("pending", s2.reverted);
    expect([s1.show, s2.show, s3.show]).toEqual(["reverted", "reverted", "reverted"]);
    expect(pollStep("landed", s3.reverted).show).toBe("landed");
  });

  it("Q2: after a revert the re-checks back off and stop, whatever the reads say", () => {
    const delays: (number | null)[] = [];
    let mem: number | null = null;
    for (let i = 0; i < 20; i++) {
      const s = pollStep(i % 2 ? "unknown" : "reverted", mem);
      delays.push(s.next);
      mem = s.reverted;
      if (s.next === null) break;
    }
    expect(delays).toEqual([...REVERTED_RECHECK_MS, null]);
    for (let i = 1; i < REVERTED_RECHECK_MS.length; i++) expect(REVERTED_RECHECK_MS[i]!).toBeGreaterThan(REVERTED_RECHECK_MS[i - 1]!);
    // About five minutes, then only "Check again" (which starts over from 0).
    const total = REVERTED_RECHECK_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(5 * 60_000);
    expect(total).toBeLessThanOrEqual(10 * 60_000);
    expect(pollStep("unknown", 0)).toMatchObject({ show: "reverted", next: REVERTED_RECHECK_MS[0] });
  });
});

// ---------- planning ----------

describe("planSubmit", () => {
  it("draws the id once per form session and reuses it on every retry", () => {
    const freshId = vi.fn(() => 7n);
    const p1 = planSubmit(null, CTX, null, freshId);
    expect(p1).toEqual({ ok: true, attempt: { ...CTX, id: 7n, submitted: false, hash: null } });
    const a1 = (p1 as { attempt: CreateAttempt }).attempt;
    const p2 = planSubmit({ ...a1, submitted: true }, CTX, "absent", freshId);
    expect(p2.ok && p2.attempt.id).toBe(7n);
    expect(freshId).toHaveBeenCalledTimes(1);
  });

  it("an attempt that never reached the wallet follows a change of account, keeping its id", () => {
    const p = planSubmit(attempt(), { ...CTX, owner: OTHER }, null, () => 99n);
    expect(p.ok && p.attempt).toEqual({ ...CTX, owner: OTHER, id: 42n, submitted: false, hash: null });
  });

  it("blocks while a sent tx is unconfirmed: no fresh create once a hash exists", () => {
    for (const o of [null, "pending", "unknown"] as const) {
      expect(planSubmit(attempt({ submitted: true, hash: H1 }), CTX, o, () => 1n)).toEqual({ ok: false, block: "pending" });
    }
    // Pending wins over a change of account: the card keeps polling the original chain.
    expect(submitBlock(attempt({ submitted: true, hash: H1 }), { ...CTX, owner: OTHER }, "pending")).toBe("pending");
  });

  it("allows a retry with the SAME id once the tx reverted or vanished", () => {
    for (const o of ["reverted", "vanished"] as const) {
      const p = planSubmit(attempt({ submitted: true, hash: H1 }), CTX, o, () => 1n);
      expect(p.ok && p.attempt.id).toBe(42n);
    }
  });

  it("blocks a submit from another account while a hashless send's outcome is unknown", () => {
    expect(planSubmit(attempt({ submitted: true }), { ...CTX, owner: OTHER }, "absent", () => 1n))
      .toEqual({ ok: false, block: "other-account" });
    expect(planSubmit(attempt({ submitted: true }), { ...CTX, chainId: 1 }, null, () => 1n))
      .toEqual({ ok: false, block: "other-account" });
    // Address case does not matter.
    expect(planSubmit(attempt({ submitted: true }), { ...CTX, owner: OWNER.toLowerCase() as `0x${string}` }, null, () => 1n).ok)
      .toBe(true);
  });

  it("blocks once the switch is known to exist", () => {
    expect(submitBlock(attempt({ submitted: true }), CTX, "landed")).toBe("landed");
  });
});

describe("mayHaveBroadcast", () => {
  it("a wallet rejection or a decoded revert never broadcast; anything else might have", () => {
    expect(mayHaveBroadcast(new UserRejectedRequestError(new Error("no")))).toBe(false);
    expect(mayHaveBroadcast({ code: 4001 })).toBe(false);
    expect(mayHaveBroadcast(revertError("BountyTooLow"))).toBe(false);
    expect(mayHaveBroadcast(new Error("WalletConnect: request expired"))).toBe(true);
  });

  it("the wallet refusing the pinned account or chain before signing is not a send", () => {
    // The create pins `account` to the attempt's owner: an account switched in the wallet during the
    // FHE step is refused by wagmi instead of sending a tx whose input proof is bound to another account.
    expect(mayHaveBroadcast(new ConnectorAccountNotFoundError({ address: OTHER, connector: { name: "MetaMask" } as never }))).toBe(false);
    expect(mayHaveBroadcast(new ConnectorChainMismatchError({ connectionChainId: 11155111, connectorChainId: 1 }))).toBe(false);
    // viem wraps its own pre-flight chain check in ContractFunctionExecutionError → TransactionExecutionError.
    const wrapped = new ContractFunctionExecutionError(
      new ChainMismatchError({ chain: sepolia, currentChainId: 1 }),
      { abi: dmsAbi, functionName: "createSwitch", args: [{ id: 42n, pingInterval: 60n, plaintextCommitment: H1 }, "0x01", H2, "0x01"] },
    );
    expect(mayHaveBroadcast(wrapped)).toBe(false);
    expect(mayHaveBroadcast({ code: 4100, message: "The requested account and/or method has not been authorized by the user." })).toBe(false);
  });
});

describe("deriveCreateView", () => {
  const view = (o: Partial<Parameters<typeof deriveCreateView>[0]>) =>
    deriveCreateView({ local: "idle", localError: null, attempt: null, outcome: null, created: false, ...o });
  const sent = attempt({ submitted: true, hash: H1 });

  it("a running create shows its own stage", () => {
    expect(view({ local: "mining", attempt: sent }).stage).toBe("mining");
  });
  it("a sent tx is unconfirmed, never failed, until its outcome says so (also after a reload)", () => {
    expect(view({ local: "idle", attempt: sent })).toEqual({ stage: "unconfirmed", error: null });
    expect(view({ local: "error", localError: "Timed out", attempt: sent, outcome: "pending" }).stage).toBe("unconfirmed");
    expect(view({ attempt: sent, outcome: "unknown" }).stage).toBe("unconfirmed");
  });
  it("reverted / vanished → error that says the retry reuses the id", () => {
    for (const o of ["reverted", "vanished"] as const) {
      const v = view({ attempt: sent, outcome: o });
      expect(v.stage).toBe("error");
      expect(v.error).toMatch(/#42/);
      expect(v.error).toMatch(/reuses the same id/);
    }
    // A retry that then failed before the wallet reports its own error.
    expect(view({ local: "error", localError: "relayer down", attempt: sent, outcome: "reverted" }).error).toBe("relayer down");
  });
  it("W12: vanished is not called a failure: it may be private, so check the wallet first", () => {
    const v = view({ attempt: sent, outcome: "vanished" });
    expect(v.error).toMatch(/privately/);
    expect(v.error).toMatch(/Check your wallet's activity/);
    expect(v.error).toMatch(/keeps checking/);
    expect(v.error).not.toMatch(/no longer known/);
    expect(errorTitle(sent, "vanished")).toBe("Not confirmed");
  });
  it("error titles: never sent / sent without a known result / known revert", () => {
    expect(errorTitle(null, null)).toBe("Could not create the switch");
    expect(errorTitle(attempt(), null)).toBe("Could not create the switch");
    expect(errorTitle(attempt({ submitted: true }), "absent")).toBe("Not confirmed");
    expect(errorTitle(sent, "reverted")).toBe("The switch was not created");
  });
  it("created → done", () => {
    expect(view({ created: true, attempt: null }).stage).toBe("done");
  });
  it("an error before anything was sent is a plain error", () => {
    expect(view({ local: "error", localError: "x", attempt: attempt() })).toEqual({ stage: "error", error: "x" });
  });
});

// ---------- runCreate: the F1 scenarios ----------

const PREPARED = {
  commitment: `0x${"aa".repeat(32)}` as Hex,
  ciphertext: `0x01${"bb".repeat(80)}` as Hex,
  encKey: `0x${"cc".repeat(32)}` as Hex,
  inputProof: `0x${"dd".repeat(64)}` as Hex,
};
const INPUT = { pingInterval: 86400n, bountyWei: 10n ** 16n };
const NONE: SwitchSnapshot = { exists: false, state: "none", pingInterval: 0n };
const ALIVE: SwitchSnapshot = { exists: true, state: "alive", pingInterval: 86400n * 30n };

interface Harness extends CreateDeps {
  stages: CreateStage[];
  storage: MemStorage;
  /** Switches on "chain", keyed by `${owner}:${id}`. */
  chain: Map<string, SwitchSnapshot>;
  prepare: ReturnType<typeof vi.fn<() => Promise<typeof PREPARED>>>;
  send: ReturnType<typeof vi.fn<CreateDeps["send"]>>;
  freshId: ReturnType<typeof vi.fn<() => bigint>>;
}

const deps = (over: Partial<CreateDeps> & { storage?: MemStorage } = {}): Harness => {
  const storage = over.storage ?? new MemStorage();
  const chain = new Map<string, SwitchSnapshot>();
  const stages: CreateStage[] = [];
  let ids = 1000n;
  const h: Harness = {
    ctx: CTX,
    store: createAttemptStore(() => storage),
    outcome: null,
    freshId: vi.fn(() => ++ids),
    readSwitch: async (owner, id) => chain.get(`${owner}:${id}`) ?? NONE,
    readMinBounty: async () => 0n,
    prepare: vi.fn(async () => PREPARED),
    send: vi.fn(async () => H1),
    waitForReceipt: async () => "success" as const,
    onStage: (s) => { stages.push(s); },
    stages,
    storage,
    chain,
    ...over,
  } as Harness;
  return h;
};

describe("runCreate", () => {
  it("happy path: one id, created, attempt cleared", async () => {
    const d = deps();
    const r = await runCreate(d, INPUT);
    expect(r).toMatchObject({ kind: "created", adopted: false, hash: H1, pingInterval: 86400n, state: "alive" });
    expect(d.send.mock.calls[0]![0].id).toBe(1001n);
    expect(d.stages).toEqual(["sealing", "confirm-in-wallet", "mining"]);
    expect(d.store.get()).toBeNull();
    expect(d.storage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
  });

  it("F1: receipt wait times out after broadcast → unconfirmed, not failed; a retry is blocked; nothing is sent twice", async () => {
    const d = deps({ waitForReceipt: async () => { throw new Error('Timed out while waiting for transaction with hash "0x…"'); } });
    const r1 = await runCreate(d, INPUT);
    expect(r1.kind).toBe("unconfirmed");
    const stored = d.store.get()!;
    expect(stored).toMatchObject({ id: 1001n, submitted: true, hash: H1 });
    expect(parseAttempt(d.storage.getItem(ATTEMPT_STORAGE_KEY))).toEqual(stored); // survives a reload
    expect(deriveCreateView({ local: "unconfirmed", localError: null, attempt: stored, outcome: null, created: false }).stage)
      .toBe("unconfirmed");

    // The owner clicks again while it is pending: refused before any reseal.
    d.outcome = "pending";
    await expect(runCreate(d, INPUT)).rejects.toBeInstanceOf(CreateBlockedError);
    expect(d.prepare).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.freshId).toHaveBeenCalledTimes(1);

    // The first tx lands: the poll classifies it, and a retry would adopt it.
    d.chain.set(`${OWNER}:1001`, ALIVE);
    expect(classifyAttempt(stored, { state: 1, receipt: "success", txKnown: null, unknownPolls: 0 })).toBe("landed");
  });

  it("F1: the follow-up read after a successful receipt can no longer fail the create", async () => {
    // The old flow read switchKey after the receipt; an RPC error there showed "could not create".
    const d = deps({ readSwitch: vi.fn(async () => NONE) });
    const r = await runCreate(d, INPUT);
    expect(r.kind).toBe("created");
    expect(d.readSwitch).toHaveBeenCalledTimes(1); // pre-flight only
  });

  it("F1: ambiguous wallet error (no hash) → retry reuses the id, finds the switch, and sends nothing new", async () => {
    const d = deps();
    d.send.mockRejectedValueOnce(new Error("WalletConnect: session expired"));
    await expect(runCreate(d, INPUT)).rejects.toThrow(/session expired/);
    expect(d.store.get()).toMatchObject({ id: 1001n, submitted: true, hash: null });

    // The wallet had broadcast it after all, and it was mined.
    d.chain.set(`${OWNER}:1001`, ALIVE);
    const r = await runCreate(d, INPUT);
    expect(r).toMatchObject({ kind: "created", adopted: true, pingInterval: ALIVE.pingInterval });
    expect(r.kind === "created" && r.attempt.id).toBe(1001n);
    expect(d.prepare).toHaveBeenCalledTimes(1); // no reseal
    expect(d.send).toHaveBeenCalledTimes(1); // no second tx
    expect(d.freshId).toHaveBeenCalledTimes(1);
    expect(d.store.get()).toBeNull();
  });

  it("F1: ambiguous wallet error, tx never landed → retry resends under the SAME id", async () => {
    const d = deps();
    d.send.mockRejectedValueOnce(new Error("internal JSON-RPC error"));
    await expect(runCreate(d, INPUT)).rejects.toThrow();
    const r = await runCreate(d, INPUT);
    expect(r.kind).toBe("created");
    expect(d.send.mock.calls.map((c) => c[0].id)).toEqual([1001n, 1001n]);
    expect(d.prepare).toHaveBeenCalledTimes(2); // a fresh DEK each send; the id is what dedups
  });

  it("a rejection in the wallet un-marks the attempt (nothing was sent), and the retry keeps the id", async () => {
    const d = deps();
    d.send.mockRejectedValueOnce(new UserRejectedRequestError(new Error("User rejected")));
    await expect(runCreate(d, INPUT)).rejects.toThrow();
    expect(d.store.get()).toMatchObject({ id: 1001n, submitted: false });
    expect(d.storage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
    await runCreate(d, INPUT);
    expect(d.send.mock.calls.map((c) => c[0].id)).toEqual([1001n, 1001n]);
  });

  it("a rejection on a retry does not un-mark an earlier ambiguous send", async () => {
    const d = deps();
    d.send.mockRejectedValueOnce(new Error("timeout"));
    d.send.mockRejectedValueOnce({ code: 4001 });
    await expect(runCreate(d, INPUT)).rejects.toBeDefined();
    await expect(runCreate(d, INPUT)).rejects.toBeDefined();
    expect(d.store.get()).toMatchObject({ id: 1001n, submitted: true });
  });

  it("a revert decoded from the wallet's estimate leaves the attempt unsent", async () => {
    const d = deps();
    d.send.mockRejectedValueOnce(revertError("BountyTooLow"));
    await expect(runCreate(d, INPUT)).rejects.toBeDefined();
    expect(d.store.get()?.submitted).toBe(false);
  });

  it("a send refused before broadcast (account switched in the wallet mid-create) leaves the attempt unsent", async () => {
    const d = deps();
    d.send.mockRejectedValueOnce(new ConnectorAccountNotFoundError({ address: OWNER, connector: { name: "MetaMask" } as never }));
    await expect(runCreate(d, INPUT)).rejects.toBeDefined();
    expect(d.store.get()?.submitted).toBe(false);
    // So the owner's next submit is not blocked as "sent from another account".
    expect(submitBlock(d.store.get(), { ...CTX, owner: OTHER }, null)).toBeNull();
  });

  it("receipt reverted and no switch → reverted; the retry reuses the id", async () => {
    const d = deps({ waitForReceipt: async () => "reverted" as const });
    const r1 = await runCreate(d, INPUT);
    expect(r1.kind).toBe("reverted");
    expect(d.store.get()).toMatchObject({ id: 1001n, hash: H1 });
    d.outcome = "reverted";
    d.waitForReceipt = async () => "success";
    d.send.mockResolvedValueOnce(H2);
    const r2 = await runCreate(d, INPUT);
    expect(r2).toMatchObject({ kind: "created", hash: H2 });
    expect(d.send.mock.calls.map((c) => c[0].id)).toEqual([1001n, 1001n]);
  });

  it("W9: a resend after a revert drops the old hash, so an ambiguous failure reads as sent-without-hash and is polled", async () => {
    const d = deps({ waitForReceipt: async () => "reverted" as const });
    expect((await runCreate(d, INPUT)).kind).toBe("reverted");
    d.outcome = "reverted";
    // The wallet broadcasts H2, but the dapp only sees an ambiguous error.
    d.send.mockRejectedValueOnce(new Error("WalletConnect: request expired"));
    await expect(runCreate(d, INPUT)).rejects.toThrow(/request expired/);
    const a = d.store.get()!;
    expect(a).toMatchObject({ id: 1001n, submitted: true, hash: null });
    expect(parseAttempt(d.storage.getItem(ATTEMPT_STORAGE_KEY))).toEqual(a); // also after a reload
    // H1's reverted outcome no longer applies: a new key, polled as "absent" until the switch lands.
    expect(attemptKey(a)).not.toBe(attemptKey({ ...a, hash: H1 }));
    const o = classifyAttempt(a, { state: 0, receipt: null, txKnown: null, unknownPolls: 0 });
    expect(o).toBe("absent");
    expect(pollStep(o, null).next).toBe(ATTEMPT_POLL_MS);
    expect(errorTitle(a, o)).toBe("Not confirmed");
    expect(deriveCreateView({ local: "error", localError: "request expired", attempt: a, outcome: o, created: false }))
      .toEqual({ stage: "error", error: "request expired" });
    // H2 lands later: the poll sees the switch.
    expect(classifyAttempt(a, { state: 1, receipt: null, txKnown: null, unknownPolls: 0 })).toBe("landed");
  });

  it("W9: a rejection on a resend after a revert leaves the reverted attempt as it was", async () => {
    const d = deps({ waitForReceipt: async () => "reverted" as const });
    await runCreate(d, INPUT);
    const reverted = d.store.get();
    expect(reverted).toMatchObject({ submitted: true, hash: H1 });
    d.outcome = "reverted";
    d.send.mockRejectedValueOnce(new UserRejectedRequestError(new Error("User rejected")));
    await expect(runCreate(d, INPUT)).rejects.toThrow();
    expect(d.store.get()).toEqual(reverted);
    expect(errorTitle(d.store.get(), "reverted")).toBe("The switch was not created");
  });

  it("receipt reverted because an earlier send of the same id landed first → that switch is the success", async () => {
    const d = deps({ waitForReceipt: async () => "reverted" as const });
    let reads = 0;
    d.readSwitch = async () => (reads++ === 0 ? NONE : ALIVE);
    const r = await runCreate(d, INPUT);
    expect(r).toMatchObject({ kind: "created", adopted: true, hash: H1 });
  });

  it("reverted, but the follow-up read fails → unconfirmed (polled), not failed", async () => {
    const d = deps({ waitForReceipt: async () => "reverted" as const });
    let reads = 0;
    d.readSwitch = async () => { if (reads++ === 0) return NONE; throw new Error("429"); };
    expect((await runCreate(d, INPUT)).kind).toBe("unconfirmed");
  });

  it("after a reload with an unconfirmed hash, nothing can be created until the outcome is known", async () => {
    const storage = new MemStorage();
    storage.setItem(ATTEMPT_STORAGE_KEY, serializeAttempt(attempt({ id: 555n, submitted: true, hash: H1 })));
    const d = deps({ storage });
    await expect(runCreate(d, INPUT)).rejects.toMatchObject({ block: "pending" });
    expect(d.prepare).not.toHaveBeenCalled();
    // It landed meanwhile: the poll says so and the switch is shown.
    d.chain.set(`${OWNER}:555`, ALIVE);
    d.outcome = "vanished"; // e.g. sped up in the wallet: the original hash is gone, the switch exists
    const r = await runCreate(d, INPUT);
    expect(r).toMatchObject({ kind: "created", adopted: true });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a switch already at a never-sent id is not claimed: AlreadyExists, and the next submit draws a new id", async () => {
    const d = deps();
    d.chain.set(`${OWNER}:1001`, ALIVE);
    await expect(runCreate(d, INPUT)).rejects.toThrow(/already have a switch with this id/);
    expect(d.store.get()).toBeNull();
    await runCreate(d, INPUT);
    expect(d.send.mock.calls[0]![0].id).toBe(1002n);
  });

  it("success ends the form session: the next create draws a new id", async () => {
    const d = deps();
    await runCreate(d, INPUT);
    await runCreate(d, INPUT);
    expect(d.send.mock.calls.map((c) => c[0].id)).toEqual([1001n, 1002n]);
  });

  it("checks run before the FHE step: a low bounty or bad interval never reaches prepare", async () => {
    const d = deps({ readMinBounty: async () => 10n ** 18n });
    await expect(runCreate(d, INPUT)).rejects.toThrow(/below the current minimum/);
    await expect(runCreate(deps(), { ...INPUT, pingInterval: 59n })).rejects.toThrow(/Ping interval/);
    expect(d.prepare).not.toHaveBeenCalled();
  });

  it("attemptKey changes with the hash, so a poll result never applies to a newer send", () => {
    expect(attemptKey(attempt({ hash: H1 }))).not.toBe(attemptKey(attempt({ hash: H2 })));
    expect(attemptKey(attempt())).toBe(attemptKey({ ...attempt(), owner: OWNER.toLowerCase() as `0x${string}` }));
  });
});

// ---------- R3: "reverted" is never final from one read ----------

describe("R3: a reverted outcome is re-checked before it can lead to a second switch", () => {
  /**
   * useCreateSwitch's poll loop (hooks.ts), minus React: observe, adopt on
   * landed, else show pollStep's outcome and poll again while it says so.
   */
  const pollLoop = (a: CreateAttempt, observe: () => AttemptObservation, sawRevert: boolean, maxTicks: number) => {
    let ticks = 0;
    let shown: AttemptOutcome | null = null;
    let reverted: number | null = sawRevert ? 0 : null;
    while (ticks < maxTicks) {
      ticks++;
      const o = classifyAttempt(a, observe());
      if (o === "landed") return { ticks, landed: true, shown };
      const step = pollStep(o, reverted);
      shown = step.show;
      reverted = step.reverted;
      if (step.next === null) break;
    }
    return { ticks, landed: false, shown };
  };

  /** An ambiguous first send (Hx, broadcast without a hash), then a retry H1 whose receipt wait times out. */
  const ambiguousThenUnconfirmed = async () => {
    const d = deps({ send: vi.fn(async () => { throw new Error("WalletConnect: request expired"); }) });
    await expect(runCreate(d, INPUT)).rejects.toThrow(/expired/);
    d.outcome = "absent";
    d.send.mockResolvedValueOnce(H1);
    d.waitForReceipt = async () => { throw new Error("timeout"); };
    expect((await runCreate(d, INPUT)).kind).toBe("unconfirmed");
    return d;
  };

  it("a stale state read next to H1's reverted receipt is corrected by a later poll: the switch Hx created is adopted", async () => {
    const d = await ambiguousThenUnconfirmed();
    const a = d.store.get()!;
    expect(a).toMatchObject({ submitted: true, hash: H1 });
    // Hx landed; H1 reverted AlreadyExists. The first state read hits a node one block behind.
    let call = 0;
    const r = pollLoop(a, () => (++call === 1
      ? { state: 0, receipt: "reverted", txKnown: null, unknownPolls: 0 }
      : { state: 1, receipt: "reverted", txKnown: null, unknownPolls: 0 }), false, 10);
    expect(r).toMatchObject({ ticks: 2, landed: true });
  });

  it("the same for a revert the run itself saw (sawRevert)", () => {
    const a = attempt({ submitted: true, hash: H1 });
    let call = 0;
    const r = pollLoop(a, () => (++call < 3
      ? { state: 0, receipt: "none", txKnown: false, unknownPolls: call }
      : { state: 1, receipt: "none", txKnown: null, unknownPolls: 0 }), true, 10);
    expect(r).toMatchObject({ ticks: 3, landed: true });
  });

  const sent = () => attempt({ submitted: true, hash: H1 });
  const seeded = (a: CreateAttempt) => {
    const store = createAttemptStore(() => new MemStorage());
    store.set(a);
    return store;
  };
  const noSleep = vi.fn(async (_ms: number) => {});

  it("dropAttempt: a switch found by any re-read is adopted, never dropped", async () => {
    const a = sent();
    const store = seeded(a);
    let reads = 0;
    const r = await dropAttempt(store, async () => (++reads === 1 ? NONE : ALIVE), noSleep);
    expect(r).toEqual({ kind: "landed", attempt: a, snapshot: ALIVE });
    expect(reads).toBe(2);
    expect(store.get()).toBe(a); // still there: the caller shows it as created
  });

  it("dropAttempt: dropped only after every re-read found nothing; then another account draws a new id", async () => {
    const a = sent();
    const store = seeded(a);
    const readFresh = vi.fn(async () => NONE);
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await dropAttempt(store, readFresh, sleep)).toEqual({ kind: "dropped" });
    expect(readFresh).toHaveBeenCalledTimes(DROP_RECHECK_READS);
    expect(readFresh).toHaveBeenCalledWith(a);
    expect(sleep.mock.calls).toEqual(Array.from({ length: DROP_RECHECK_READS - 1 }, () => [DROP_RECHECK_GAP_MS]));
    expect(DROP_RECHECK_READS).toBeGreaterThan(1);
    expect(store.get()).toBeNull();
    expect(planSubmit(store.get(), { ...CTX, owner: OTHER }, null, () => 7n)).toMatchObject({ ok: true, attempt: { id: 7n } });
  });

  it("dropAttempt: a failed re-read drops nothing", async () => {
    const a = sent();
    const store = seeded(a);
    await expect(dropAttempt(store, async () => { throw new Error("429"); }, noSleep)).rejects.toThrow("429");
    expect(store.get()).toBe(a);
  });

  it("dropAttempt: an attempt that changed during the re-reads (the poll adopted it) is left alone", async () => {
    const a = sent();
    const store = seeded(a);
    const r = await dropAttempt(store, async () => { store.set(null); return NONE; }, noSleep);
    expect(r).toEqual({ kind: "changed" });
    const b = sent();
    const store2 = seeded(b);
    const newer = { ...b, hash: H2 };
    expect(await dropAttempt(store2, async () => { store2.set(newer); return NONE; }, noSleep)).toEqual({ kind: "changed" });
    expect(store2.get()).toBe(newer);
  });

  it("dropAttempt: an attempt that never reached the wallet is dropped without reads", async () => {
    const store = seeded(attempt());
    const readFresh = vi.fn(async () => ALIVE);
    expect(await dropAttempt(store, readFresh, noSleep)).toEqual({ kind: "dropped" });
    expect(readFresh).not.toHaveBeenCalled();
    expect(store.get()).toBeNull();
  });
});

describe("pre-broadcast refusals, end to end through wagmi's writeContract (what useCreateSwitch's send calls)", () => {
  // Chains whose RPC is a dead local port, and fetch stubbed: nothing can leave the test.
  const local = <C extends typeof mainnet | typeof sepolia>(c: C) => ({ ...c, rpcUrls: { default: { http: ["http://127.0.0.1:9"] } } });
  const sent: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}").method ?? "?");
      throw new TypeError("fetch failed (blocked in tests)");
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const createArgs = [{ id: 42n, pingInterval: 86_400n, plaintextCommitment: H1 }, "0x01", H2, "0x01"] as const;
  const setup = async (accounts: readonly `0x${string}`[]) => {
    const config = createConfig({
      chains: [local(mainnet), local(sepolia)],
      connectors: [mock({ accounts: accounts as [`0x${string}`, ...`0x${string}`[]] })],
      transports: { [mainnet.id]: http(), [sepolia.id]: http() },
    });
    await connect(config, { connector: config.connectors[0]! }); // the wallet is on mainnet
    return config;
  };

  it("(3a) the wallet was switched to another network between encryption and the prompt: refused before signing, classified unsent", async () => {
    const config = await setup([OWNER]);
    // The create captured Sepolia when it started; the wallet is now on mainnet.
    const err = await writeContract(config, {
      address: CONTRACT, abi: dmsAbi, chainId: sepolia.id, account: OWNER, functionName: "createSwitch", args: createArgs, value: 0n,
    }).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(sent).not.toContain("eth_sendTransaction");
    // Neither a rejection nor a decoded revert: before refusedBeforeSigning this read as "may have been sent".
    expect(isUserRejection(err) || !!revertName(err)).toBe(false);
    expect(mayHaveBroadcast(err)).toBe(false);
  });

  it("the wallet was switched to another account: refused before signing, classified unsent", async () => {
    const config = await setup([OTHER]);
    const err = await writeContract(config, {
      address: CONTRACT, abi: dmsAbi, chainId: mainnet.id, account: OWNER, functionName: "createSwitch", args: createArgs, value: 0n,
    }).then(() => null, (e: unknown) => e);
    expect(sent).not.toContain("eth_sendTransaction");
    expect(mayHaveBroadcast(err)).toBe(false);
  });
});

describe("(3b) 'Switch created' survives leaving the form while the create is mining", () => {
  /** What a freshly mounted form renders: it knows only what the store says. */
  const remountedView = (store: ReturnType<typeof createAttemptStore>) =>
    deriveCreateView({ local: "idle", localError: null, attempt: store.get(), outcome: null, created: !!store.created() });

  it("the run finishes while the form is unmounted: the form mounted next shows the created switch, not an empty form", async () => {
    const d = deps();
    // The run keeps going after the page that started it unmounted; its result goes through recordCreated (useCreateSwitch's succeed).
    const r = await runCreate(d, INPUT);
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    recordCreated(d.store, r.attempt, r, r.hash, r.adopted);
    expect(remountedView(d.store).stage).toBe("done");
    expect(d.store.created()).toEqual({
      chainId: CTX.chainId, contract: CONTRACT, owner: OWNER, id: r.attempt.id, pingInterval: INPUT.pingInterval,
      state: "alive", hash: H1, adopted: false,
    });
  });

  it("also after a reload in that tab (sessionStorage), with no secret material stored; 'start over' clears it", async () => {
    const d = deps();
    const r = await runCreate(d, INPUT);
    if (r.kind !== "created") throw new Error("not created");
    recordCreated(d.store, r.attempt, r, r.hash, r.adopted);
    const reloaded = createAttemptStore(() => d.storage);
    expect(reloaded.created()?.id).toBe(r.attempt.id);
    expect(remountedView(reloaded).stage).toBe("done");
    const raw = [...d.storage.map.values()].join("");
    expect(raw).not.toContain(PREPARED.ciphertext);
    expect(raw).not.toContain(PREPARED.inputProof.slice(2));
    reloaded.setCreated(null);
    expect(createAttemptStore(() => d.storage).created()).toBeNull();
    expect(remountedView(createAttemptStore(() => d.storage)).stage).toBe("idle");
  });

  it("a poll that adopts the switch (the user came back before the receipt) records it the same way", () => {
    const d = deps();
    const a = attempt({ submitted: true, hash: H1 });
    d.store.set(a);
    recordCreated(d.store, a, { pingInterval: 86_400n, state: "alive" }, a.hash, true);
    expect(d.store.get()).toBeNull();
    expect(d.store.created()).toMatchObject({ id: 42n, adopted: true });
  });

  it("a success recorded late leaves alone an attempt for another switch that started since", () => {
    const d = deps();
    const newer = attempt({ id: 777n, submitted: true, hash: H2 });
    d.store.set(newer);
    recordCreated(d.store, attempt({ submitted: true, hash: H1 }), { pingInterval: 86_400n, state: "alive" }, H1, false);
    expect(d.store.get()).toEqual(newer);
  });

  it.each([
    ["not JSON", "{"],
    ["another version", '{"v":2}'],
    ["a bad state", (c: string) => c.replace('"state":"alive"', '"state":"pwned"')],
    ["a bad id", (c: string) => c.replace(/"id":"\d+"/, '"id":"0x1"')],
  ])("a tampered created record (%s) reads as none", async (_what, bad) => {
    const d = deps();
    recordCreated(d.store, attempt({ submitted: true, hash: H1 }), { pingInterval: 86_400n, state: "alive" }, H1, false);
    const [k, v] = [...d.storage.map.entries()].find(([key]) => key === CREATED_STORAGE_KEY)!;
    d.storage.setItem(k, typeof bad === "string" ? bad : bad(v));
    expect(createAttemptStore(() => d.storage).created()).toBeNull();
  });
});

describe("a create run that finishes late never erases or overwrites a newer attempt (through runCreate)", () => {
  // Another form instance dropped #42 and account OTHER sent #777 while this run was still going.
  const newer = (): CreateAttempt => ({ ...CTX, owner: OTHER, id: 777n, submitted: true, hash: H2 });

  it("H1 mines after #777 was sent: the run reports created, and #777 stays tracked (also after the hook's recordCreated)", async () => {
    let release!: (s: "success" | "reverted") => void;
    const d = deps({ waitForReceipt: () => new Promise((r) => { release = r; }) });
    const run = runCreate(d, INPUT);
    await vi.waitFor(() => expect(d.send).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    const n = newer();
    d.store.set(n);
    release("success");
    const r = await run;
    expect(r.kind).toBe("created");
    expect(d.store.get()).toEqual(n);
    if (r.kind === "created") recordCreated(d.store, r.attempt, r, r.hash, r.adopted);
    expect(d.store.get()).toEqual(n);
  });

  it("H1 reverted but an earlier send of #42 landed (adopted): #777 stays tracked", async () => {
    let release!: (s: "success" | "reverted") => void;
    const d = deps({ waitForReceipt: () => new Promise((r) => { release = r; }) });
    const run = runCreate(d, INPUT);
    await vi.waitFor(() => expect(d.send).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    const n = newer();
    d.store.set(n);
    d.chain.set(`${OWNER}:1001`, { exists: true, state: "alive", pingInterval: 86_400n });
    release("reverted");
    const r = await run;
    expect(r).toMatchObject({ kind: "created", adopted: true });
    expect(d.store.get()).toEqual(n);
  });

  it("#777 was sent while this run's wallet prompt was open: the run's hash does not overwrite #777's record", async () => {
    const n = newer();
    const d = deps();
    d.send.mockImplementationOnce(async () => { d.store.set(n); return H1; });
    const r = await runCreate(d, INPUT);
    expect(r.kind).toBe("created");
    expect(d.store.get()).toEqual(n);
  });

  it("the attempt was replaced during the FHE step: no wallet prompt at all", async () => {
    const n = newer();
    const d = deps();
    d.prepare.mockImplementationOnce(async () => { d.store.set(n); return PREPARED; });
    await expect(runCreate(d, INPUT)).rejects.toThrow(/replaced|newer/i);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.store.get()).toEqual(n);
  });

  it("the resend's switch turns out to exist already, found while #777 was being sent: #777 stays tracked", async () => {
    const n = newer();
    const sent = attempt({ submitted: true, hash: null });
    const d = deps();
    d.store.set(sent);
    d.readSwitch = async () => { d.store.set(n); return { exists: true, state: "alive", pingInterval: 86_400n }; };
    const r = await runCreate({ ...d, outcome: "absent" }, INPUT);
    expect(r).toMatchObject({ kind: "created", adopted: true });
    expect(d.store.get()).toEqual(n);
  });
});

describe("K3: an attempt whose wallet prompt is still open cannot be dropped (its send would be tracked nowhere)", () => {
  it("account A's prompt for #42 is open; back as B, 'forget' is refused; A approves: H1 is recorded", async () => {
    const storage = new MemStorage();
    let approve!: (h: Hex) => void;
    const d = deps({ storage, waitForReceipt: () => Promise.reject(new Error("receipt timeout")) });
    d.send.mockImplementationOnce(() => new Promise<Hex>((r) => { approve = r; }));
    const run = runCreate(d, INPUT);
    await vi.waitFor(() => expect(d.send).toHaveBeenCalled());
    const a = d.store.get()!;
    expect(a).toMatchObject({ submitted: true, hash: null });
    // The form was left and re-entered as account B: the other-account card's "forget" re-reads find nothing yet.
    const r = await dropAttempt(d.store, async () => NONE, async () => {});
    expect(r).toEqual({ kind: "awaiting-wallet", attempt: a });
    expect(d.store.get()).toEqual(a);
    approve(H1);
    expect(await run).toMatchObject({ kind: "unconfirmed" });
    expect(d.store.get()).toMatchObject({ id: a.id, hash: H1 });
    expect(storage.getItem(ATTEMPT_STORAGE_KEY)).toContain(H1.slice(2));
  });

  it("once the wallet answered (rejected, or sent), the attempt can be dropped again as before", async () => {
    const d = deps();
    d.send.mockImplementationOnce(async () => { throw new UserRejectedRequestError(new Error("no")); });
    await expect(runCreate(d, INPUT)).rejects.toBeDefined();
    d.store.set({ ...d.store.get()!, submitted: true, hash: null });
    expect(await dropAttempt(d.store, async () => NONE, async () => {})).toEqual({ kind: "dropped" });
  });
});

describe("G18: a cancel (or leaving the page) late in the FHE step stops the create before its wallet prompt", () => {
  it("the FHE step returns after the abort: nothing is sent, no wallet stage, and the attempt keeps its id, unsubmitted", async () => {
    const ac = new AbortController();
    const d = deps({ signal: ac.signal, prepare: vi.fn(async () => { ac.abort(); return PREPARED; }) });
    const e = await runCreate(d, INPUT).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/cancelled/i);
    expect((e as Error).message).toMatch(/nothing was sent/i);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.stages).not.toContain("confirm-in-wallet");
    expect(d.store.get()).toMatchObject({ id: 1001n, submitted: false, hash: null });
    expect(d.storage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
    // The next submit of the form runs under the same id.
    const again = deps({ store: d.store, storage: d.storage });
    await runCreate(again, INPUT);
    expect(again.send.mock.calls[0]![0].id).toBe(1001n);
  });

  it("control: an abort once the wallet has answered changes nothing (the transaction exists and is followed)", async () => {
    const ac = new AbortController();
    const d = deps({ signal: ac.signal, send: vi.fn(async () => { ac.abort(); return H1; }) });
    await expect(runCreate(d, INPUT)).resolves.toMatchObject({ kind: "created", hash: H1 });
  });
});

describe("G12: 'Create another' re-reads the switch it leaves: a create hidden by a reorg goes back to being followed", () => {
  const CREATED = { chainId: CTX.chainId, contract: CONTRACT, owner: OWNER, id: 42n, pingInterval: 86_400n, state: "alive" as const, hash: H1, adopted: false };

  it("the switch is there: the finished create is cleared, and the next create draws a new id", async () => {
    const d = deps();
    d.store.setCreated(CREATED);
    await expect(startNewSession(d.store, async () => ALIVE)).resolves.toEqual({ kind: "cleared" });
    expect(d.store.created()).toBeNull();
    expect(d.store.get()).toBeNull();
    expect(planSubmit(d.store.get(), CTX, null, () => 9n)).toMatchObject({ ok: true, attempt: { id: 9n } });
  });

  it("the switch reads as missing (its block was reorganised away): the attempt is back, same id and hash, and no new create is offered", async () => {
    const d = deps();
    d.store.setCreated(CREATED);
    const r = await startNewSession(d.store, async () => NONE);
    expect(r).toEqual({ kind: "reopened", attempt: { ...CTX, id: 42n, submitted: true, hash: H1 } });
    expect(d.store.created()).toBeNull();
    expect(d.store.get()).toEqual({ ...CTX, id: 42n, submitted: true, hash: H1 });
    expect(parseAttempt(d.storage.getItem(ATTEMPT_STORAGE_KEY))).toEqual({ ...CTX, id: 42n, submitted: true, hash: H1 });
    expect(planSubmit(d.store.get(), CTX, null, () => 9n)).toEqual({ ok: false, block: "pending" });
    expect(deriveCreateView({ local: "idle", localError: null, attempt: d.store.get(), outcome: null, created: false }).stage).toBe("unconfirmed");
  });

  it("the read fails: nothing changes (the card stays, no new session)", async () => {
    const d = deps();
    d.store.setCreated(CREATED);
    await expect(startNewSession(d.store, async () => { throw new Error("429"); })).rejects.toThrow("429");
    expect(d.store.created()).toEqual(CREATED);
    expect(d.store.get()).toBeNull();
  });

  it("another switch's attempt started meanwhile is never overwritten", async () => {
    const d = deps();
    d.store.setCreated(CREATED);
    const other = attempt({ id: 777n, submitted: true, hash: H2 });
    d.store.set(other);
    await expect(startNewSession(d.store, async () => NONE)).resolves.toEqual({ kind: "changed" });
    expect(d.store.get()).toEqual(other);
  });
});
