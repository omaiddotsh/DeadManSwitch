// The Watcher I/O class against an in-memory chain + KMS (test/watcherStub.ts):
// races lost at simulation time and on-chain, archiving switches others
// revealed, discovery between passes, restarts, stuck transactions, relayer
// failures, getLogs chunking and output files.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, LimitExceededRpcError, parseEther, parseGwei, RpcRequestError } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { ConfigError } from "../src/config.js";
import { TxReplacedError } from "../src/errors.js";
import { FhevmError } from "../src/fhevm.js";
import { createWatcher, lockStateFile, Watcher, type LockEnv } from "../src/watcher.js";
import { newTracked, parseWatcherConfig, trackKey, type WatcherFlags } from "../src/watcherCore.js";
import { decryptFailure, relayerAnswers } from "./relayerErrors.js";
import { COMPETITOR, DMS, OWNER, simulatedRevert, StubChain, StubKms } from "./watcherStub.js";

const cfg: Config = { chainId: 31337, rpcUrl: "http://127.0.0.1:1", dmsAddress: DMS, fromBlock: 0n, privateKey: `0x${"11".repeat(32)}` };

let dir: string;
let chain: StubChain;
let kms: StubKms;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dms-watcher-test-"));
  chain = new StubChain();
  kms = new StubKms(chain);
  logs = [];
});

afterEach(() => {
  chain.beforeMine = undefined;
});

const make = (raw: Record<string, unknown> = {}, flags: Partial<WatcherFlags> = {}, config: Config = cfg, lockEnv?: Partial<LockEnv>): Watcher => {
  const wcfg = parseWatcherConfig(
    { outDir: join(dir, "out"), stateFile: join(dir, "state.json"), decryptAttemptsPerPass: 1, ...raw },
    { once: true, ...flags },
  );
  return new Watcher(config, wcfg, chain, async () => kms, (m) => logs.push(m), lockEnv);
};

const tracked = (w: Watcher, id: bigint) => w.state.switches[trackKey(OWNER, id)];
const outFile = (id: bigint, ext: "bin" | "json", chainId = 31337) => join(dir, "out", `${chainId}-${DMS.toLowerCase()}`, `${OWNER.toLowerCase()}-${id}.${ext}`);
const savedState = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));

describe("Watcher: happy path", () => {
  it("marks a DARK switch dark, reveals it, archives the plaintext and publishes it", async () => {
    const { plaintext } = await chain.addSwitch(1n);
    const w = make({ publish: true });
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.markedDark).toEqual([trackKey(OWNER, 1n)]);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
    expect(s.saved).toEqual([trackKey(OWNER, 1n)]);
    expect(s.published).toEqual([trackKey(OWNER, 1n)]);
    expect(readFileSync(outFile(1n, "bin"), "utf8")).toBe(plaintext);
    const meta = JSON.parse(readFileSync(outFile(1n, "json"), "utf8"));
    expect(meta).toMatchObject({ revealedByUs: true, contract: DMS, keyMismatch: false, commitmentMatches: true, lostRaces: [] });
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealedByUs: true });
    expect(tracked(w, 1n).pendingTx).toBeUndefined();
    // explicit EIP-1559 fees on every transaction
    for (const tx of chain.sent) expect(tx.fees).toEqual(chain.market);
  });
});

describe("Watcher: lost races", () => {
  it("an on-chain markDark revert (competitor in the same block) is a lost race, not an error; it goes on to reveal", async () => {
    await chain.addSwitch(1n);
    chain.beforeMine = (tx) => {
      if (tx.kind === "markDark") chain.competitor("markDark", 1n);
    };
    const w = make();
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.markedDark).toEqual([]);
    expect(s.lostRaces).toHaveLength(1);
    expect(s.lostRaces[0]).toMatch(/lost the markDark race: 0x[0-9a-f]{64} reverted on-chain with AlreadyDarkMarked/);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
    const t = tracked(w, 1n);
    expect(t.attempts).toBe(0);
    expect(t.lostRaces).toEqual([expect.objectContaining({ action: "markDark", errorName: "AlreadyDarkMarked", gasUsed: "30000" })]);
  });

  it("an on-chain revealKey revert archives the plaintext with revealedByUs=false and records the lost race", async () => {
    const { plaintext } = await chain.addSwitch(2n);
    chain.beforeMine = (tx) => {
      if (tx.kind === "revealKey") chain.competitor("revealKey", 2n);
    };
    const w = make();
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.revealed).toEqual([]);
    expect(s.lostRaces).toEqual([expect.stringMatching(/lost the revealKey race: .* AlreadyRevealed/)]);
    expect(s.saved).toEqual([trackKey(OWNER, 2n)]);
    expect(readFileSync(outFile(2n, "bin"), "utf8")).toBe(plaintext);
    const meta = JSON.parse(readFileSync(outFile(2n, "json"), "utf8"));
    expect(meta.revealedByUs).toBe(false);
    expect(meta.lostRaces).toEqual([expect.objectContaining({ action: "revealKey", errorName: "AlreadyRevealed" })]);
    expect(tracked(w, 2n).terminal).toBe(true);
  });

  it("a revealKey race seen at simulation time re-reads the switch and archives it", async () => {
    await chain.addSwitch(3n, { state: "DARK_MARKED" });
    kms.onDecrypt = () => chain.competitor("revealKey", 3n);
    const w = make();
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.lostRaces).toEqual([]); // nothing was broadcast, so no gas was lost
    expect(s.saved).toEqual([trackKey(OWNER, 3n)]);
    expect(chain.sent).toEqual([]);
    expect(JSON.parse(readFileSync(outFile(3n, "json"), "utf8")).revealedByUs).toBe(false);
  });

  it("publishes a switch that an earlier run archived without --publish once a run has --publish; then never reads it again", async () => {
    await chain.addSwitch(1n, { state: "REVEALED" });
    await chain.addSwitch(2n, { state: "REVEALED" });
    await make().pass(); // archived; nothing more to do under that policy
    chain.sw(2n).published = true; // someone else publishes switch 2 meanwhile
    const s = await make({ publish: true }).pass();
    expect(s.published).toEqual([trackKey(OWNER, 1n)]);
    expect(chain.sw(1n).published).toBe(true);
    expect(chain.sent.map((x) => x.kind)).toEqual(["publishPlaintext"]);
    const info = chain.info.bind(chain);
    let reads = 0;
    chain.info = async (o, id) => (reads++, info(o, id));
    await make({ publish: true }).pass();
    expect(reads).toBe(0);
  });

  it("archives a switch someone else revealed before the watcher saw it", async () => {
    const { plaintext } = await chain.addSwitch(4n, { state: "REVEALED" });
    const s = await make().pass();
    expect(s.saved).toEqual([trackKey(OWNER, 4n)]);
    expect(readFileSync(outFile(4n, "bin"), "utf8")).toBe(plaintext);
    expect(kms.calls).toBe(0);
  });
});

describe("Watcher: order of work in a pass (a backlog of floor-bounty switches does not starve another)", () => {
  const VICTIM = getAddress("0x00000000000000000000000000000000000000a1");

  it("another owner's switch that goes dark during a long pass is marked in that pass, not after the whole backlog", async () => {
    await chain.addSwitch(1n, { owner: VICTIM, state: "ALIVE" }); // discovered first
    const g = chain.sw(1n, VICTIM);
    g.expiresAt = chain.time + 30n;
    for (let id = 1n; id <= 30n; id++) await chain.addSwitch(id); // 30 dark switches, same 0.01 ETH bounty
    // the contract judges the deadline by block time: G is DARK once the chain passes it
    const info = chain.info.bind(chain);
    chain.info = async (owner, id, blockTag) => {
      if (g.state === "ALIVE" && chain.time >= g.expiresAt) g.state = "DARK";
      return info(owner, id, blockTag);
    };
    let markedAt: bigint | undefined;
    const mine = chain.mine.bind(chain);
    chain.mine = () => {
      mine();
      if (markedAt === undefined && g.state === "DARK_MARKED") markedAt = chain.time;
    };
    const s = await make().pass();
    expect(s.markedDark).toContain(trackKey(VICTIM, 1n));
    expect(markedAt! - g.expiresAt).toBeLessThanOrEqual(36n); // three 12 s blocks: the switch in progress, then its own
    expect(s.revealed).toHaveLength(31);
  });

  it("a switch going dark is sent for before the reads of dark switches whose unprofitable verdict is still pending", async () => {
    await chain.addSwitch(1n, { owner: VICTIM, bounty: parseEther("1"), state: "ALIVE" });
    for (let id = 1n; id <= 50n; id++) await chain.addSwitch(id, { bounty: 1n }); // dust: never worth marking
    const w = make();
    await w.pass(); // the dust gets its unprofitable verdicts, re-checked after unprofitableRecheckSec
    chain.sw(1n, VICTIM).state = "DARK"; // its deadline passes
    let reads = 0;
    let readsBeforeSend: number | undefined;
    const info = chain.info.bind(chain);
    chain.info = async (owner, id, blockTag) => (reads++, info(owner, id, blockTag));
    const send = chain.send.bind(chain);
    chain.send = async (fn, args, opts) => ((readsBeforeSend ??= reads), send(fn, args, opts));
    const s = await w.pass();
    expect(readsBeforeSend).toBeLessThanOrEqual(2); // its own reads only
    expect(s.markedDark).toEqual([trackKey(VICTIM, 1n)]);
    expect(s.unprofitable).toHaveLength(50); // the dust is still read, and reported, in the same pass
    expect(s.polled).toBe(51);
  });

  it("a higher bounty goes first, whatever the order switches were discovered in", async () => {
    for (let id = 1n; id <= 30n; id++) await chain.addSwitch(id); // 0.01 ETH each
    await chain.addSwitch(1n, { owner: VICTIM, bounty: parseEther("0.05") }); // discovered last
    const s = await make().pass();
    expect(chain.sent.slice(0, 2).map((x) => [x.kind, ...x.args.slice(0, 2)])).toEqual([
      ["markDark", VICTIM, 1n],
      ["revealKey", VICTIM, 1n],
    ]);
    expect(s.revealed).toHaveLength(31);
  });
});

describe("Watcher: reorganisations after an outcome is booked (Sepolia: final at the finalized block)", () => {
  const sepolia: Config = { ...cfg, chainId: 11155111 };
  const k1 = trackKey(OWNER, 1n);
  /** Switch 1, created two blocks back (discovery stays 2 confirmations behind the head). */
  const addSwitch1 = async (opts: Parameters<StubChain["addSwitch"]>[1] = {}) => {
    await chain.addSwitch(1n, opts);
    chain.head += 2n;
  };

  it("keeps a revealed switch polled until the finalized block shows it revealed, then never reads it again", async () => {
    await addSwitch1();
    chain.holdFinality();
    const w = make({}, {}, sepolia);
    let s = await w.pass();
    expect(s.revealed).toEqual([k1]);
    expect(tracked(w, 1n).terminal).toBe(false);
    s = await w.pass();
    expect(s.polled).toBe(1);
    expect(tracked(w, 1n).terminal).toBe(false);
    chain.finalizeAll();
    s = await w.pass();
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealedByUs: true });
    expect(logs).toContainEqual(expect.stringMatching(/done \(revealed\)/));
    expect((await w.pass()).polled).toBe(0);
  });

  it("sends the reveal again when a reorganisation dropped it, and the archive record names the reveal that stayed", async () => {
    await addSwitch1();
    chain.holdFinality();
    const w = make({}, {}, sepolia);
    await w.pass();
    const dropped = tracked(w, 1n).revealTx!;
    // a 1-block reorganisation drops the block with the reveal (its receipt and its event), and nothing includes it again
    chain.receipts.delete(dropped);
    chain.actions = chain.actions.filter((a) => a.hash !== dropped);
    Object.assign(chain.sw(1n), { state: "DARK_MARKED", revealedKey: `0x${"00".repeat(32)}`, bounty: parseEther("0.01") });
    logs = [];
    const s = await w.pass();
    expect(logs).toContainEqual(expect.stringMatching(/WARNING: state went back from REVEALED to DARK_MARKED/));
    expect(s.revealed).toEqual([k1]);
    const stayed = tracked(w, 1n).revealTx;
    expect(stayed).not.toBe(dropped);
    expect(chain.sent.filter((x) => x.kind === "revealKey")).toHaveLength(2);
    chain.finalizeAll();
    await w.pass();
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealTx: stayed, revealedByUs: true });
    expect(JSON.parse(readFileSync(outFile(1n, "json", 11155111), "utf8"))).toMatchObject({ revealTx: stayed, revealedByUs: true });
  });

  it("a read from a node behind its own mined reveal (back to DARK_MARKED) is stale: no second KMS request, no second revealKey", async () => {
    await addSwitch1();
    chain.holdFinality();
    const w = make({}, {}, sepolia);
    await w.pass();
    const ours = tracked(w, 1n).revealTx;
    // the next pass's reads reach a backend a few blocks behind the reveal; the receipt is served
    let lag = true;
    const info = chain.info.bind(chain);
    chain.info = async (owner, id, blockTag) => {
      const i = await info(owner, id, blockTag);
      return lag && blockTag !== "finalized" ? { ...i, state: 3, stateName: "DARK_MARKED", revealedKey: `0x${"00".repeat(32)}`, bounty: parseEther("0.01") } : i;
    };
    const kmsCalls = kms.calls;
    logs = [];
    const s = await w.pass();
    expect(kms.calls).toBe(kmsCalls);
    expect(chain.sent.filter((x) => x.kind === "revealKey")).toHaveLength(1);
    expect(s.lostRaces).toEqual([]);
    expect(logs).toContainEqual(expect.stringMatching(/read DARK_MARKED, but its revealKey 0x[0-9a-f]+ is mined: the node read is behind/));
    lag = false;
    chain.finalizeAll();
    await w.pass();
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealTx: ours, revealedByUs: true, lastState: "REVEALED" });
  });

  it("a read from a node behind someone else's reveal (back to DARK_MARKED) is stale: no KMS request, no revealKey", async () => {
    await addSwitch1({ state: "DARK_MARKED" });
    chain.holdFinality();
    chain.competitor("revealKey", 1n); // revealed by someone else before the watcher's first read
    const w = make({}, {}, sepolia);
    await w.pass(); // archived, not final yet
    let lag = true;
    const info = chain.info.bind(chain);
    chain.info = async (owner, id, blockTag) => {
      const i = await info(owner, id, blockTag);
      return lag && blockTag !== "finalized" ? { ...i, state: 3, stateName: "DARK_MARKED", revealedKey: `0x${"00".repeat(32)}`, bounty: parseEther("0.01") } : i;
    };
    logs = [];
    let s = await w.pass();
    expect(kms.calls).toBe(0);
    expect(chain.sent).toEqual([]);
    expect(s.lostRaces).toEqual([]);
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`read DARK_MARKED, but revealKey 0x[0-9a-f]{64} by ${COMPETITOR} is in block \\d+: the node read is behind`)));
    // the reveal is final now; a lagging read still comes first, and the event cannot be found (say, logs pruned)
    chain.finalizeAll();
    chain.actions = [];
    logs = [];
    s = await w.pass();
    expect(kms.calls).toBe(0);
    expect(logs).toContainEqual(expect.stringMatching(/read DARK_MARKED, but the finalized block shows it REVEALED: the node read is behind/));
    lag = false;
    await w.pass();
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, lastState: "REVEALED" });
  });

  it("the search for the event of a reveal whose receipt is not served halves its range on a provider that caps it", async () => {
    await addSwitch1();
    chain.holdFinality();
    const w = make({}, {}, sepolia);
    await w.pass();
    const ours = tracked(w, 1n).revealTx!;
    const txOutcome = chain.txOutcome.bind(chain);
    chain.txOutcome = async (fn, hash) => (hash === ours ? undefined : txOutcome(fn, hash));
    const actionLogs = chain.actionLogs.bind(chain);
    chain.actionLogs = async (kind, owner, id, from, to) => {
      if (to - from + 1n > 10n) throw new Error("query exceeds max block range 10");
      return actionLogs(kind, owner, id, from, to);
    };
    chain.finalizeAll();
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealTx: ours, revealedByUs: true });
  });

  it("a search for the event that keeps failing (pruned range) is given up after 3 passes: kept as booked, terminal, with a WARNING", async () => {
    await addSwitch1();
    chain.holdFinality();
    const w = make({}, {}, sepolia);
    await w.pass();
    const ours = tracked(w, 1n).revealTx!;
    const txOutcome = chain.txOutcome.bind(chain);
    chain.txOutcome = async (fn, hash) => (hash === ours ? undefined : txOutcome(fn, hash));
    chain.actionLogs = async () => {
      throw Object.assign(new Error("RPC Request failed."), { cause: Object.assign(new Error("pruned history unavailable"), { code: 4444 }) });
    };
    chain.finalizeAll();
    logs = [];
    const errors: number[] = [];
    for (let p = 0; p < 3; p++) {
      tracked(w, 1n).nextAttemptAtMs = 0; // its backoff ran out
      errors.push((await w.pass()).errors.length);
    }
    expect(errors).toEqual([1, 1, 0]);
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealTx: ours, revealedByUs: true });
    expect(logs).toContainEqual(expect.stringMatching(/WARNING: revealKey 0x[0-9a-f]{64}: no receipt, and the search for its event failed 3 times .*; kept as booked/));
    expect((await w.pass()).polled).toBe(0);
  });

  it("does not unbook a reveal whose receipt the node does not serve: the final KeyRevealed names this watcher", async () => {
    await addSwitch1();
    chain.holdFinality();
    const w = make({}, {}, sepolia);
    await w.pass();
    const ours = tracked(w, 1n).revealTx!;
    const archived = readFileSync(outFile(1n, "json", 11155111), "utf8");
    // mined and canonical, but the backend answering eth_getTransactionReceipt lacks it (behind, or pruned receipts)
    const txOutcome = chain.txOutcome.bind(chain);
    chain.txOutcome = async (fn, hash) => (hash === ours ? undefined : txOutcome(fn, hash));
    chain.finalizeAll();
    const s = await w.pass();
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealTx: ours, revealedByUs: true });
    expect(s.lostRaces).toEqual([]);
    expect(readFileSync(outFile(1n, "json", 11155111), "utf8")).toBe(archived);
  });

  it("books the original reveal when a reorganisation included it instead of its fee-bumped replacement", async () => {
    await addSwitch1({ state: "DARK_MARKED" });
    chain.stuck = true;
    const w = make({}, {}, sepolia);
    await w.pass(); // revealKey O, not mined in time
    const original = chain.sent.find((x) => x.kind === "revealKey")!.hash;
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    chain.market = { maxFeePerGas: parseGwei("20"), maxPriorityFeePerGas: parseGwei("2") };
    await w.pass(); // replaced by R, same nonce
    const replacement = chain.sent[chain.sent.length - 1].hash;
    chain.stuck = false;
    chain.holdFinality();
    chain.mine(); // R is mined
    await w.pass();
    expect(tracked(w, 1n).revealTx).toBe(replacement);
    // a 1-block reorganisation: the new fork carries O (still in other nodes' mempools), not R; the same call either way
    chain.receipts.set(original, chain.receipts.get(replacement)!);
    chain.receipts.delete(replacement);
    chain.actions.find((a) => a.hash === replacement)!.hash = original;
    chain.finalizeAll();
    logs = [];
    const s = await w.pass();
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealTx: original, revealedByUs: true });
    expect(s.lostRaces).toEqual([]);
    expect(JSON.parse(readFileSync(outFile(1n, "json", 11155111), "utf8"))).toMatchObject({ revealTx: original, revealedByUs: true });
  });

  it("unbooks a reveal that is not mined when the final KeyRevealed names another revealer", async () => {
    await addSwitch1();
    chain.holdFinality();
    const w = make({}, {}, sepolia);
    await w.pass();
    const ours = tracked(w, 1n).revealTx!;
    // the reorganisation dropped ours; a competitor's reveal is in the new fork
    chain.receipts.delete(ours);
    Object.assign(chain.actions.find((a) => a.hash === ours)!, { actor: COMPETITOR, hash: `0x${"c0".repeat(32)}` });
    chain.finalizeAll();
    logs = [];
    await w.pass();
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealedByUs: false });
    expect(tracked(w, 1n).revealTx).toBeUndefined();
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`WARNING: revealKey ${ours} is not mined on the final chain: revealKey 0x(c0){32} by ${COMPETITOR} is`)));
    expect(JSON.parse(readFileSync(outFile(1n, "json", 11155111), "utf8"))).toMatchObject({ revealTx: null, revealedByUs: false });
  });

  it("books a reveal that a reorganisation put behind a competitor's as a lost race, in the state file and the archive record", async () => {
    await addSwitch1();
    chain.holdFinality();
    const w = make({}, {}, sepolia);
    await w.pass();
    const ours = tracked(w, 1n).revealTx!;
    // the new fork has a competitor's reveal first; ours is included after it and reverts
    const r = chain.receipts.get(ours)!;
    chain.receipts.set(ours, { ...r, ok: false, errorName: "AlreadyRevealed", gasUsed: 30_000n, events: [] });
    chain.finalizeAll();
    const s = await w.pass();
    expect(s.lostRaces).toEqual([expect.stringMatching(/lost the revealKey race: .* reverted on-chain with AlreadyRevealed/)]);
    expect(tracked(w, 1n)).toMatchObject({ terminal: true, revealedByUs: false });
    expect(tracked(w, 1n).revealTx).toBeUndefined();
    const meta = JSON.parse(readFileSync(outFile(1n, "json", 11155111), "utf8"));
    expect(meta).toMatchObject({ revealedByUs: false, revealTx: null });
    expect(meta.lostRaces).toEqual([expect.objectContaining({ action: "revealKey", hash: ours, errorName: "AlreadyRevealed" })]);
  });

  it("notices a cancel that a reorganisation dropped: the switch goes dark later and is released", async () => {
    await addSwitch1({ state: "ALIVE" });
    chain.holdFinality();
    chain.sw(1n).state = "CANCELLED";
    const w = make({}, {}, sepolia);
    await w.pass();
    expect(tracked(w, 1n).terminal).toBe(false);
    chain.sw(1n).state = "DARK"; // the owner's cancel did not survive the reorganisation, and the deadline passed
    const s = await w.pass();
    expect(s.markedDark).toEqual([k1]);
    expect(s.revealed).toEqual([k1]);
  });
});

describe("Watcher: discovery and restarts", () => {
  it("discovers a switch created between two passes", async () => {
    await chain.addSwitch(1n, { state: "ALIVE" });
    const w = make();
    await w.pass();
    expect(logs.filter((l) => l.startsWith("discovered switch"))).toHaveLength(1);
    await chain.addSwitch(2n, { state: "ALIVE" });
    await w.pass();
    expect(logs.filter((l) => l.startsWith("discovered switch"))).toHaveLength(2);
    expect(Object.keys(w.state.switches)).toEqual([trackKey(OWNER, 1n), trackKey(OWNER, 2n)]);
    expect(savedState().lastScannedBlock).toBe(chain.head.toString());
  });

  describe("one watcher per state file (<stateFile>.lock)", () => {
    const state = () => join(dir, "state.json");
    const lockFile = () => join(dir, "state.json.lock");
    const lockNow = () => JSON.parse(readFileSync(lockFile(), "utf8"));
    /** This process's identity, injected: boot "boot-1", PID namespace "ns-1", hostname "host-a", machine id "machine-a". */
    const here = { bootId: () => "boot-1", pidNs: () => "ns-1", host: () => "host-a", machineId: () => "machine-a" };
    /** The holder's heartbeat, as its timer would refresh the lock file while a contender watches it: one period (5 s) later. */
    const beat = () => {
      const next = new Date(statSync(lockFile()).mtimeMs + 5_000);
      utimesSync(lockFile(), next, next);
    };
    const writeLock = (lock: Record<string, unknown>, ageMs = 0) => {
      writeFileSync(lockFile(), JSON.stringify({ token: "theirs", startedAt: new Date().toISOString(), heartbeatMs: 5_000, ...lock }));
      const t = new Date(Date.now() - ageMs);
      utimesSync(lockFile(), t, t);
    };
    /** A monotonic clock that only moves when the contender sleeps, running `onSleep` (say, the holder's heartbeat) each time. */
    const fakeTime = (onSleep?: () => void) => {
      let mono = 0;
      let slept = 0;
      return {
        monoMs: () => mono,
        sleepMs: (ms: number) => {
          mono += ms;
          slept++;
          onSleep?.();
        },
        slept: () => slept,
      };
    };

    it("refuses a state file that a live watcher holds (overlapping cron runs), and takes over a lock left by a dead one", async () => {
      writeLock({ pid: process.ppid, bootId: "boot-1", pidNs: "ns-1", host: "host-a" }); // a live process that is not this one
      expect(() => make({}, {}, cfg, here)).toThrow(/state\.json is in use by another watcher \(pid \d+\)/);
      expect(existsSync(state())).toBe(false);
      const gone = spawnSync(process.execPath, ["-e", "0"]).pid; // exited: its pid is free
      writeLock({ pid: gone, bootId: "boot-1", pidNs: "ns-1", host: "host-a" });
      const w = make({}, {}, cfg, here);
      expect(lockNow()).toMatchObject({ pid: process.pid, bootId: "boot-1", pidNs: "ns-1", host: "host-a" });
      await w.close();
      expect(existsSync(lockFile())).toBe(false);
    });

    it("never takes a live lock because its pid number equals ours: in another PID namespace (container) that proves nothing", () => {
      // `docker run --rm … --once` from cron: node is PID 1 in every container; containers share the host's boot id
      writeLock({ pid: 1, bootId: "boot-1", pidNs: "ns-container-1", host: "c0ffee01" }, 2_000);
      const t = fakeTime(beat);
      expect(() => lockStateFile(state(), { ...here, pid: 1, pidNs: () => "ns-container-2", host: () => "c0ffee02", alive: () => false, ...t })).toThrow(
        /in use by another watcher \(pid 1\)/,
      );
      expect(lockNow().token).toBe("theirs");
    });

    it("never takes a live lock from another machine sharing the state file (NFS, a ReadWriteMany volume) for its other boot id", () => {
      writeLock({ pid: 4242, bootId: "boot-B", pidNs: "ns-1", host: "host-b", machine: "machine-b" }, 2_000);
      const t = fakeTime(beat);
      expect(() => lockStateFile(state(), { ...here, pid: 4242, alive: () => false, ...t })).toThrow(/in use by another watcher \(pid 4242\)/);
      expect(lockNow().token).toBe("theirs");
    });

    it("a lock it cannot check by pid is judged by its heartbeat: a clock that jumped makes it look old, but it is still refreshed", () => {
      // same machine, another container; NTP set the clock 5 hours forward since the holder last refreshed
      writeLock({ pid: 1, bootId: "boot-1", pidNs: "ns-container-1", host: "host-a" }, 5 * 3_600_000);
      let beats = 0;
      const t = fakeTime(() => {
        if (beats++ === 3) beat(); // the holder's next heartbeat
      });
      expect(() => lockStateFile(state(), { ...here, pid: 1, pidNs: () => "ns-container-2", alive: () => false, ...t })).toThrow(/in use by another watcher \(pid 1\)/);
      expect(lockNow().token).toBe("theirs");
      // its holder is gone: the heartbeat stays put for the whole watch (3 heartbeats), then it is taken over
      writeLock({ pid: 1, bootId: "boot-1", pidNs: "ns-container-1", host: "host-a" }, 60_000);
      const t2 = fakeTime();
      lockStateFile(state(), { ...here, pid: 1, pidNs: () => "ns-container-2", alive: () => false, ...t2 });
      expect(lockNow()).toMatchObject({ pid: 1, pidNs: "ns-container-2" });
      expect(t2.monoMs()).toBeGreaterThanOrEqual(15_000);
    });

    it("same machine and boot, same PID namespace: a dead holder is taken over at once, a live one never, whatever the clock says", () => {
      writeLock({ pid: 1001, bootId: "boot-1", pidNs: "ns-1", host: "host-a" }, 5 * 3_600_000); // NTP jumped: looks 5 h old
      const t = fakeTime();
      expect(() => lockStateFile(state(), { ...here, pid: 1002, alive: () => true, ...t })).toThrow(/in use by another watcher \(pid 1001\)/);
      lockStateFile(state(), { ...here, pid: 1002, alive: (pid) => pid === 1002, ...t });
      expect(lockNow().pid).toBe(1002);
      expect(t.slept()).toBe(0); // no waiting: the pid says it all
    });

    it("a reused pid (another process now has it) does not keep a dead holder's lock alive when the start times differ", () => {
      writeLock({ pid: 1001, bootId: "boot-1", pidNs: "ns-1", host: "host-a", startTime: "12345" });
      lockStateFile(state(), { ...here, pid: 1002, alive: () => true, startTime: (pid) => (pid === 1001 ? "99999" : "500"), ...fakeTime() });
      expect(lockNow().pid).toBe(1002);
    });

    it("a lock from before this machine last booted is stale at once, although its pid is live and its clock looks fine", () => {
      writeLock({ pid: 1001, bootId: "boot-0", pidNs: "ns-1", host: "host-a", machine: "machine-a" });
      lockStateFile(state(), { ...here, pid: 1002, alive: () => true, ...fakeTime() });
      expect(lockNow()).toMatchObject({ pid: 1002, bootId: "boot-1" });
    });

    it("an old-format lock (no heartbeat, no PID namespace) left by a killed watcher with our pid number (PID 1 in a container) is taken over", () => {
      writeFileSync(lockFile(), JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), token: "old", bootId: "boot-1" }));
      // pid 1 is alive here: it is this process
      lockStateFile(state(), { ...here, pid: 1, pidNs: () => "ns-container-2", alive: () => true, ...fakeTime() });
      expect(lockNow()).toMatchObject({ pid: 1, pidNs: "ns-container-2" });
    });

    it("whatever the clocks of two machines say, a heartbeat that moves while it is watched is live: refused at once, saying how to check", () => {
      // machine A's clock runs a minute ahead of this one: its heartbeat looks a minute in the future, or (behind) a minute old
      for (const skewMs of [60_000, -60_000]) {
        writeLock({ pid: 7, bootId: "boot-A", pidNs: "ns-A", host: "machine-a" }, -skewMs);
        const t = fakeTime(beat);
        let err: unknown;
        try {
          lockStateFile(state(), { ...here, pid: 9, alive: () => false, ...t });
        } catch (e) {
          err = e;
        }
        expect((err as Error).message).toMatch(/in use by another watcher \(pid 7\) on machine-a/);
        expect((err as Error).message).toMatch(/modification time/); // how to tell that no watcher runs before deleting the lock
        expect(t.slept()).toBeLessThanOrEqual(2);
        expect(lockNow().token).toBe("theirs");
      }
    });

    it("a fresh heartbeat it cannot check by pid (a container killed, then restarted in a new PID namespace) is watched, not trusted", () => {
      writeLock({ pid: 1, bootId: "boot-1", pidNs: "ns-container-1", host: "c0ffee01" }); // refreshed just before the kill
      const t = fakeTime();
      lockStateFile(state(), { ...here, pid: 1, pidNs: () => "ns-container-2", host: () => "c0ffee01", alive: () => true, ...t });
      expect(lockNow()).toMatchObject({ pid: 1, pidNs: "ns-container-2" });
      expect(t.monoMs()).toBeGreaterThanOrEqual(15_000); // 3 heartbeats without a beat
    });

    it("two machines with the same hostname and no machine id never take each other's live lock as one from before a reboot", () => {
      writeLock({ pid: 7, bootId: "boot-A", pidNs: "ns-1", host: "dms-watcher" });
      const t = fakeTime(beat);
      expect(() =>
        lockStateFile(state(), { ...here, pid: 9, host: () => "dms-watcher", machineId: () => undefined, bootId: () => "boot-B", alive: () => false, ...t }),
      ).toThrow(/in use by another watcher \(pid 7\)/);
      expect(lockNow().token).toBe("theirs");
    });

    it("a lock from an older watcher (no heartbeat) on this boot whose pid is live is still held", () => {
      writeFileSync(lockFile(), JSON.stringify({ pid: 1001, startedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), token: "old", bootId: "boot-1" }));
      expect(() => lockStateFile(state(), { ...here, pid: 1002, alive: () => true, ...fakeTime() })).toThrow(/in use by another watcher \(pid 1001\)/);
    });

    it("two watchers taking over the same stale lock at once: exactly one gets it, in either order of arrival", () => {
      const alive = (pid: number) => pid === 1001 || pid === 1002; // both contenders; the old holder is gone
      for (const [late, early] of [
        [1002, 1001],
        [1001, 1002],
      ]) {
        writeLock({ pid: 999_001, bootId: "boot-1", pidNs: "ns-1", host: "host-a" });
        let earlyGot = false;
        // `late` judges the lock stale, then is descheduled while `early` takes it over completely
        const lateTakeover = () =>
          lockStateFile(state(), {
            ...here,
            pid: late,
            alive,
            beforeTakeover: () => {
              if (earlyGot) return;
              lockStateFile(state(), { ...here, pid: early, alive });
              earlyGot = true;
            },
          });
        expect(lateTakeover).toThrow(new RegExp(`in use by another watcher \\(pid ${early}\\)`));
        expect(earlyGot).toBe(true);
        expect(lockNow().pid).toBe(early);
        expect(readdirSync(dir).filter((f) => f.includes(".lock."))).toEqual([]); // no claim left behind
      }
    });

    it("refreshes its lock while it waits (a long receipt or KMS wait), so a contender elsewhere sees it alive", async () => {
      await chain.addSwitch(1n);
      const w = make({}, {}, cfg, { heartbeatMs: 20 });
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockFile(), old, old);
      const waitFor = chain.waitFor.bind(chain);
      chain.waitFor = async (fn, hash, timeoutMs) => {
        await new Promise((r) => setTimeout(r, 150));
        return waitFor(fn, hash, timeoutMs);
      };
      await w.pass();
      expect(statSync(lockFile()).mtimeMs).toBeGreaterThan(Date.now() - 1_000);
      await w.close();
    });

    it("a watcher whose lock another took over (it seemed dead) stops: no more transactions, and it does not overwrite the state file", async () => {
      await chain.addSwitch(1n);
      const w = make();
      const theirs = '{"written by": "the watcher that took over"}';
      chain.waitFor = async (fn, hash) => {
        // while this one waits for its markDark receipt, another watcher takes the state file over
        writeLock({ pid: 4242, bootId: "boot-9", pidNs: "ns-9", host: "host-9" });
        writeFileSync(state(), theirs);
        chain.mine();
        const mined = await chain.txOutcome(fn, hash);
        if (!mined) throw new Error("not mined");
        return mined;
      };
      const s = await w.pass();
      expect(chain.sent.map((x) => x.kind)).toEqual(["markDark"]); // no revealKey after the lock was lost
      expect(readFileSync(state(), "utf8")).toBe(theirs);
      expect(s.errors).toContainEqual(expect.stringMatching(/lost .*state\.json\.lock to another watcher/));
      expect(logs.some((l) => /lost .*state\.json\.lock to another watcher/.test(l))).toBe(true);
      const again = await w.pass();
      expect(again.polled).toBe(0);
      expect(chain.sent).toHaveLength(1);
      await w.close();
      expect(lockNow().token).toBe("theirs"); // close() does not delete another watcher's lock
    });
  });

  describe("the lock across real processes", () => {
    const clientDir = fileURLToPath(new URL("..", import.meta.url));
    const contender = fileURLToPath(new URL("./lockContender.ts", import.meta.url));
    type Report = { pid: number; held: boolean; error?: string };
    /** Start a contender process; resolves with its report line once it exits (or is killed). */
    const spawnContender = (opts: Record<string, unknown>) => {
      const child = spawn(process.execPath, ["--import", "tsx", contender, join(dir, "state.json"), JSON.stringify(opts)], { cwd: clientDir });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const reported = new Promise<Report>((resolve) => {
        child.stdout.on("data", () => {
          const line = out.split("\n").find((l) => l.startsWith("{"));
          if (line) resolve(JSON.parse(line) as Report);
        });
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
      return { child, reported, exited };
    };
    const until = async (path: string) => {
      for (let i = 0; i < 6_000 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 10));
    };
    /** A real watcher that took the lock and was then killed (OOM, SIGKILL): its lock stays, its pid is free. */
    const killedHolder = async (opts: Record<string, unknown> = {}) => {
      const h = spawnContender({ holdMs: 60_000, ...opts });
      expect((await h.reported).held).toBe(true);
      h.child.kill("SIGKILL");
      await h.exited;
      return JSON.parse(readFileSync(join(dir, "state.json.lock"), "utf8")) as { pid: number; token: string };
    };
    const leftovers = () => readdirSync(dir).filter((f) => f.startsWith("state.json.lock."));

    it("several processes taking over a dead watcher's lock at the same moment: exactly one holds it", async () => {
      const dead = await killedHolder();
      const go = join(dir, "go");
      const cs = Array.from({ length: 6 }, (_, i) => spawnContender({ ready: join(dir, `ready-${i}`), go, holdMs: 3_000 }));
      for (let i = 0; i < cs.length; i++) await until(join(dir, `ready-${i}`));
      writeFileSync(go, "");
      const reports = await Promise.all(cs.map((c) => c.reported));
      const holders = reports.filter((r) => r.held);
      expect(holders).toHaveLength(1);
      const [winner] = holders;
      for (const r of reports.filter((x) => !x.held)) expect(r.error).toMatch(new RegExp(`in use by another watcher \\(pid ${winner.pid}\\)`));
      const lock = JSON.parse(readFileSync(join(dir, "state.json.lock"), "utf8"));
      expect(lock.pid).toBe(winner.pid);
      expect(lock.token).not.toBe(dead.token);
      expect(leftovers()).toEqual([]);
      await Promise.all(cs.map((c) => c.exited));
    }, 60_000);

    it("a contender descheduled after judging the lock stale does not take it from the one that took it over meanwhile", async () => {
      await killedHolder();
      const b = spawnContender({ pause: { signal: join(dir, "b-judged"), resume: join(dir, "b-go") } });
      await until(join(dir, "b-judged"));
      const a = spawnContender({ holdMs: 3_000 });
      const ra = await a.reported;
      expect(ra.held).toBe(true);
      writeFileSync(join(dir, "b-go"), "");
      const rb = await b.reported;
      expect(rb.held).toBe(false);
      expect(rb.error).toMatch(new RegExp(`in use by another watcher \\(pid ${ra.pid}\\)`));
      expect(JSON.parse(readFileSync(join(dir, "state.json.lock"), "utf8")).pid).toBe(ra.pid);
      await Promise.all([a.exited, b.exited]);
    }, 60_000);

    it("containers that cannot check each other's pids: several racing over a dead one's lock, exactly one holds it", async () => {
      // each contender is in its own PID namespace (as a container); they judge by heartbeat, then race through claims
      await killedHolder({ pidNs: "ns-dead", heartbeatMs: 100 });
      await new Promise((r) => setTimeout(r, 400)); // the dead holder's heartbeat is now older than 3 heartbeats
      const go = join(dir, "go");
      // their own heartbeat is longer than the dead one's: a loaded test machine can stall a process for a few hundred ms
      const cs = Array.from({ length: 4 }, (_, i) => spawnContender({ ready: join(dir, `ready-${i}`), go, pidNs: `ns-${i}`, heartbeatMs: 400, holdMs: 5_000 }));
      for (let i = 0; i < cs.length; i++) await until(join(dir, `ready-${i}`));
      writeFileSync(go, "");
      const reports = await Promise.all(cs.map((c) => c.reported));
      const holders = reports.filter((r) => r.held);
      expect(holders).toHaveLength(1);
      for (const r of reports.filter((x) => !x.held)) expect(r.error).toMatch(new RegExp(`in use by another watcher \\(pid ${holders[0].pid}\\)`));
      expect(leftovers()).toEqual([]);
      await Promise.all(cs.map((c) => c.exited));
    }, 60_000);

    it("a takeover killed half-way (after claiming the stale lock, before removing it) does not block later starts", async () => {
      await killedHolder();
      const lockPath = join(dir, "state.json.lock");
      const crashed = spawnContender({ crashOnUnlinkOf: lockPath });
      expect((await crashed.exited).signal).toBe("SIGKILL");
      expect(existsSync(lockPath)).toBe(true); // the stale lock, and whatever claim the crash left
      const next = spawnContender({ holdMs: 500 });
      const r = await next.reported;
      expect(r).toMatchObject({ held: true });
      expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(r.pid);
      expect(leftovers()).toEqual([]);
      await next.exited;
    }, 60_000);

    it("takes over a dead watcher's lock on a filesystem without hard links (SMB/CIFS, some FUSE mounts)", async () => {
      await killedHolder();
      const c = spawnContender({ noLink: true, holdMs: 500 });
      const r = await c.reported;
      expect(r).toMatchObject({ held: true });
      expect(JSON.parse(readFileSync(join(dir, "state.json.lock"), "utf8")).pid).toBe(r.pid);
      await c.exited;
    }, 60_000);
  });

  it("a restarted watcher resumes from the state file: no rescan, finished switches untouched", async () => {
    await chain.addSwitch(1n);
    await make().pass();
    const scannedTo = BigInt(savedState().lastScannedBlock);
    const calls = chain.logCalls.length;
    const sentBefore = chain.sent.length;
    logs = [];
    const w2 = make();
    const s = await w2.pass();
    // only the blocks mined since (our own transactions) are scanned, from lastScannedBlock + 1
    expect(chain.logCalls.slice(calls)).toEqual([[scannedTo + 1n, chain.head]]);
    expect(s.polled).toBe(0); // terminal
    expect(chain.sent.length).toBe(sentBefore);
    expect(logs.some((l) => l.startsWith("discovered"))).toBe(false);
  });

  it("warns that FROM_BLOCK no longer applies, and --rescan-from finds a switch below lastScannedBlock", async () => {
    await chain.addSwitch(1n, { state: "ALIVE" }); // block 101
    await chain.addSwitch(2n, { state: "ALIVE" }); // block 102
    await make({ fromBlock: 102 }).pass(); // too high: misses switch 1
    expect(Object.keys(savedState().switches)).toEqual([trackKey(OWNER, 2n)]);

    // the same FROM_BLOCK on every start (the documented steady state, e.g. cron --once) is not worth a note
    logs = [];
    await make({ fromBlock: 102 }).pass();
    await make({}, {}, { ...cfg, fromBlock: 102n }).pass();
    expect(logs.some((l) => l.startsWith("note:"))).toBe(false);

    logs = [];
    await make({ fromBlock: 0 }).pass();
    expect(logs.find((l) => l.startsWith("note:"))).toMatch(/only applies to the first run.*--rescan-from 0/);
    expect(Object.keys(savedState().switches)).toHaveLength(1);

    logs = [];
    const w = make({}, { rescanFrom: 100n });
    await w.pass();
    expect(Object.keys(w.state.switches)).toContain(trackKey(OWNER, 1n));
    expect(savedState().lastScannedBlock).toBe(chain.head.toString()); // never moved backwards
    expect(logs.some((l) => l.startsWith("note:"))).toBe(false);
  });

  it("--rescan-from above the last scanned block does not skip the blocks in between", async () => {
    await chain.addSwitch(1n, { state: "ALIVE" }); // block 101
    await make().pass();
    expect(savedState().lastScannedBlock).toBe("101");
    chain.head = 200n;
    await chain.addSwitch(2n, { state: "ALIVE" }); // block 201
    chain.head = 300n;
    const calls = chain.logCalls.length;
    logs = [];
    const w = make({}, { rescanFrom: 250n });
    await w.pass();
    expect(chain.logCalls.slice(calls)).toEqual([[102n, 300n]]);
    expect(Object.keys(w.state.switches)).toContain(trackKey(OWNER, 2n));
    expect(logs.some((l) => l.includes("--rescan-from 250: blocks from 102 on have not been scanned yet"))).toBe(true);
  });

  describe("reorganisations deeper than the confirmations (Sepolia: 2 confirmations, 64 blocks scanned again)", () => {
    const sepolia: Config = { ...cfg, chainId: 11155111 };

    it("finds a SwitchCreated log that a 3-block reorganisation moved to a block already scanned", async () => {
      const w = make({}, {}, sepolia);
      await w.pass(); // head 100: scans 0-98
      await chain.addSwitch(1n, { state: "ALIVE" }); // block 101, the head
      await w.pass();
      expect(savedState().lastScannedBlock).toBe("99");
      chain.logs[0].blockNumber = 99n; // the new fork carries the create in block 99
      chain.head += 4n;
      await w.pass();
      expect(tracked(w, 1n)).toBeDefined();
      expect(logs.filter((l) => l.startsWith(`discovered switch ${OWNER}/1 `))).toHaveLength(1);
    });

    it("finds one that a node lagging behind the head had not served yet when its range was scanned", async () => {
      await chain.addSwitch(1n, { state: "ALIVE" }); // block 101
      chain.head = 104n;
      let lag = 4n;
      const getLogs = chain.switchCreatedLogs.bind(chain);
      chain.switchCreatedLogs = async (from, to) => (await getLogs(from, to)).filter((l) => l.blockNumber <= chain.head - lag);
      const w = make({}, {}, sepolia);
      await w.pass(); // scans 0-102, served up to 100
      expect(tracked(w, 1n)).toBeUndefined();
      lag = 0n;
      chain.head += 1n;
      await w.pass();
      expect(tracked(w, 1n)).toBeDefined();
    });

    it("scans nothing again on a pass without new blocks, and never below the block discovery first started from", async () => {
      chain.head = 300n;
      const w = make({ fromBlock: 250 }, {}, sepolia);
      await w.pass();
      expect(chain.logCalls).toEqual([[250n, 298n]]);
      await w.pass();
      expect(chain.logCalls).toHaveLength(1); // nothing new: no request
      chain.head = 301n;
      await w.pass();
      chain.head = 400n;
      await w.pass();
      chain.head = 500n;
      await w.pass();
      expect(chain.logCalls.slice(1)).toEqual([
        [250n, 299n], // 299 - 64 is below FROM_BLOCK
        [250n, 398n],
        [399n - 64n, 498n],
      ]);
      expect(savedState()).toMatchObject({ firstScannedBlock: "250", lastScannedBlock: "498" });
    });
  });

  it("stop() during a long discovery stops at the current chunk and keeps the progress", async () => {
    chain.head = 1_000n;
    const w = make({ logChunkBlocks: 10 });
    chain.failLogs = (_f, _t, call) => {
      if (call === 3) w.stop();
      return undefined;
    };
    const s = await w.pass();
    expect(chain.logCalls).toHaveLength(3);
    expect(s.polled).toBe(0);
    expect(savedState().lastScannedBlock).toBe("29");
  });

  it("saves discovery progress every 20 chunks, so a hard kill loses little", async () => {
    chain.head = 1_000n;
    const w = make({ logChunkBlocks: 10 });
    let seen: string | undefined;
    chain.failLogs = (_f, _t, call) => {
      if (call === 25) seen = savedState().lastScannedBlock;
      return undefined;
    };
    await w.pass();
    expect(seen).toBe("199");
  });
});

describe("Watcher: getLogs chunking", () => {
  it("halves on a range-limit error, grows back after successes, and remembers the working size", async () => {
    chain.head = 400n;
    chain.failLogs = (f, t) => (t - f + 1n > 16n ? new Error("eth_getLogs block range is too large, max 16 blocks") : undefined);
    const w = make({ logChunkBlocks: 64 });
    await w.pass();
    const ok = chain.logCalls.filter(([f, t]) => t - f + 1n <= 16n);
    // contiguous coverage of [0, head], never above the provider's limit
    expect(ok[0][0]).toBe(0n);
    for (let i = 1; i < ok.length; i++) expect(ok[i][0]).toBe(ok[i - 1][1] + 1n);
    expect(ok[ok.length - 1][1]).toBe(400n);
    expect(chain.logCalls.some(([f, t]) => t - f + 1n === 32n)).toBe(true); // it tried to grow back
    expect(Number(savedState().logChunkBlocks)).toBeLessThanOrEqual(32);
  });

  it("a reduced chunk grows back across passes and processes that each cover only a few blocks", async () => {
    chain.head = 100n;
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ version: 1, chainId: 31337, contract: DMS, lastScannedBlock: "100", logChunkBlocks: "1", switches: {} }),
    );
    for (let run = 1; run <= 4; run++) {
      chain.head += 1n;
      await make({ logChunkBlocks: 64 }).pass(); // a fresh process each time, like cron --once
      if (run === 2) expect(savedState()).toMatchObject({ logChunkBlocks: "1", logChunkSuccesses: 2 });
    }
    expect(chain.logCalls).toHaveLength(4); // one single-block request per pass
    expect(savedState().logChunkBlocks).toBe("2");
    expect(savedState().logChunkSuccesses).toBeUndefined();
  });

  it("retries the same range after a transient (rate-limit) error instead of shrinking it", async () => {
    chain.head = 50n;
    chain.failLogs = (_f, _t, call) => (call === 1 ? Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 }) : undefined);
    const w = make({ logChunkBlocks: 100 });
    await w.pass();
    expect(chain.logCalls).toEqual([
      [0n, 50n],
      [0n, 50n],
    ]);
    expect(savedState().logChunkBlocks).toBeUndefined();
  }, 10_000);

  it("retries the same range when the node answering lacks the blocks' history (pruned, code 4444 below viem's own error)", async () => {
    chain.head = 50n;
    const pruned = () => Object.assign(new Error("RPC Request failed."), { code: -32603, cause: Object.assign(new Error("missing data"), { code: 4444 }) });
    chain.failLogs = (_f, _t, call) => (call === 1 ? pruned() : undefined);
    await make({ logChunkBlocks: 100 }).pass();
    expect(chain.logCalls).toEqual([
      [0n, 50n],
      [0n, 50n],
    ]);
    expect(savedState().logChunkBlocks).toBeUndefined();
  });

  const sepolia: Config = { ...cfg, chainId: 11155111 };
  const pruned = () => Object.assign(new Error("RPC Request failed."), { code: -32603, cause: Object.assign(new Error("missing data"), { code: 4444 }) });

  it("a range the node never serves (pruned history): no sleep before the transactions, a configuration error naming FROM_BLOCK, backoff across passes", async () => {
    chain.head = 6000n;
    await chain.addSwitch(1n); // DARK, block 6001, listed in the config
    chain.head = 6010n;
    let serves = false;
    chain.failLogs = (f) => (!serves && f < 5000n ? pruned() : undefined);
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      const w = make({ switches: [{ owner: OWNER, id: "1" }] }, {}, sepolia);
      const t0 = realNow();
      let s = await w.pass();
      expect(realNow() - t0).toBeLessThan(1_000);
      expect(s.markedDark).toEqual([trackKey(OWNER, 1n)]);
      expect(chain.logCalls).toEqual([
        [0n, 4999n],
        [0n, 4999n], // at once, twice: another backend of a load-balanced RPC may have it
        [0n, 4999n],
      ]);
      expect(s.errors).toEqual([expect.stringMatching(/^discovery: .*blocks 0-4999 .*pruned.*FROM_BLOCK.*again in 15 s/)]);
      s = await w.pass(); // backing off: not asked again yet, still reported
      expect(chain.logCalls).toHaveLength(3);
      expect(s.errors).toEqual([expect.stringMatching(/FROM_BLOCK/)]);
      skew += 16_000;
      await w.pass();
      expect(chain.logCalls).toHaveLength(6);
      skew += 16_000; // the second failure backs off for 30 s
      await w.pass();
      expect(chain.logCalls).toHaveLength(6);
      serves = true; // say, FROM_BLOCK raised on a fresh state file, or an archive RPC
      skew += 30_000;
      s = await w.pass();
      expect(s.errors).toEqual([]);
      expect(savedState().lastScannedBlock).toBe(String(chain.head - 2n));
    } finally {
      clock.mockRestore();
    }
  });

  it("an RPC URL containing 'pruned' does not make a range error look like missing history (viem puts the URL in its message)", async () => {
    chain.head = 20_000n;
    const rangeError = () =>
      new LimitExceededRpcError(
        new RpcRequestError({
          body: { method: "eth_getLogs", params: [] },
          error: { code: -32005, message: "query exceeds max block range 2000" },
          url: "https://eth-sepolia-pruned.example.net/v1/KEY",
        }),
      );
    chain.failLogs = (f, t) => (t - f + 1n > 2000n ? rangeError() : undefined);
    const t0 = Date.now();
    const s = await make({}, {}, sepolia).pass();
    expect(Date.now() - t0).toBeLessThan(1_000); // no retry waits
    expect(s.errors).toEqual([]);
    expect(chain.logCalls.slice(0, 3).map(([f, t]) => t - f + 1n)).toEqual([5000n, 2500n, 1250n]); // halved until accepted
    expect(savedState().lastScannedBlock).toBe("19998");
  });

  it("a rate-limited discovery is retried after the pass's transactions, not before them", async () => {
    await chain.addSwitch(1n); // DARK
    chain.failLogs = (_f, _t, call) => (call === 1 ? Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 }) : undefined);
    let logCallsAtFirstSend: number | undefined;
    const send = chain.send.bind(chain);
    chain.send = async (fn, args, opts) => ((logCallsAtFirstSend ??= chain.logCalls.length), send(fn, args, opts));
    const s = await make({ switches: [{ owner: OWNER, id: "1" }] }).pass();
    expect(logCallsAtFirstSend).toBe(1);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
    expect(chain.logCalls.map(([from]) => from)).toEqual([0n, 0n]); // then the same range again
    expect(s.errors).toEqual([]);
  }, 10_000);

  it("a doubled chunk accepted at full width resets the wait before the next doubling", async () => {
    chain.head = 30_000n;
    let cap = 1000n;
    chain.failLogs = (f, t) => (t - f + 1n > cap ? new Error("query exceeds max block range") : undefined);
    const w = make({ logChunkBlocks: 8000 }, {}, sepolia);
    await w.pass(); // 8000 -> 1000; each doubling to 2000 refused, so each waits twice as long
    expect(savedState().logChunkGrowAfter).toBeGreaterThan(4);
    cap = 100_000n; // the cap is gone (or that refusal was a dense range)
    chain.head += 60_000n;
    await w.pass();
    expect(savedState().logChunkGrowAfter).toBeUndefined();
    expect(savedState().logChunkBlocks).toBeUndefined(); // back to logChunkBlocks
  });

  it("on a provider that caps ranges at 10 blocks, the re-scan below the last scanned block fits the working chunk", async () => {
    chain.head = 1000n;
    chain.failLogs = (f, t) => (t - f + 1n > 10n ? new Error("query exceeds max block range 10") : undefined);
    const w = make({ fromBlock: 900 }, {}, sepolia);
    await w.pass();
    const perPass: number[] = [];
    for (let i = 0; i < 12; i++) {
      const scanned = BigInt(savedState().lastScannedBlock);
      chain.head += 3n; // one 30 s poll of 12 s blocks
      const before = chain.logCalls.length;
      await w.pass();
      perPass.push(chain.logCalls.length - before);
      expect(chain.logCalls[before][0]).toBeLessThan(scanned); // still scans below the last scanned block
    }
    expect(perPass.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(18);
  });
});

describe("Watcher: stuck and pending transactions", () => {
  it("a receipt timeout leaves the tx pending (not an error), persisted before waiting", async () => {
    await chain.addSwitch(1n);
    chain.stuck = true;
    const w = make();
    const waitFor = chain.waitFor.bind(chain);
    let onDiskWhileWaiting: unknown;
    chain.waitFor = async (fn, hash, timeoutMs) => {
      onDiskWhileWaiting = savedState().switches[trackKey(OWNER, 1n)].pendingTx?.hashes;
      return waitFor(fn, hash, timeoutMs);
    };
    const s = await w.pass();
    expect(onDiskWhileWaiting).toEqual([chain.sent[0].hash]);
    expect(s.errors).toEqual([]);
    expect(s.pending).toEqual([expect.stringMatching(/markDark 0x[0-9a-f]+ not mined after 120s/)]);
    const p = savedState().switches[trackKey(OWNER, 1n)].pendingTx;
    expect(p).toMatchObject({ kind: "markDark", nonce: 0, hashes: [chain.sent[0].hash], maxFeePerGas: parseGwei("10").toString() });
  });

  it("a still-pending tx is replaced with the same nonce and bumped fees, then resolved once mined", async () => {
    await chain.addSwitch(1n);
    chain.stuck = true;
    const w = make();
    await w.pass();
    // young: wait, do not send anything new
    let s = await w.pass();
    expect(s.pending).toEqual([expect.stringMatching(/markDark 0x[0-9a-f]+ pending for \d+s/)]);
    expect(chain.sent).toHaveLength(1);
    // old: replace
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    s = await w.pass();
    expect(chain.sent).toHaveLength(2);
    const [orig, repl] = chain.sent;
    expect(repl.nonce).toBe(orig.nonce);
    expect(repl.kind).toBe("markDark");
    expect(repl.fees!.maxFeePerGas).toBeGreaterThanOrEqual((orig.fees!.maxFeePerGas * 1125n) / 1000n);
    expect(repl.fees!.maxPriorityFeePerGas).toBeGreaterThanOrEqual((orig.fees!.maxPriorityFeePerGas * 1125n) / 1000n);
    expect(s.pending).toEqual([expect.stringMatching(/replaced by 0x/)]);
    // mined: the next pass picks up the replacement's receipt and moves on to reveal
    chain.stuck = false;
    chain.mine();
    s = await w.pass();
    expect(s.markedDark).toEqual([trackKey(OWNER, 1n)]);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
    expect(tracked(w, 1n).markDarkTx).toBe(repl.hash);
  });

  it("does not raise fees past maxGasPriceGwei", async () => {
    await chain.addSwitch(1n);
    chain.stuck = true;
    const w = make({ maxGasPriceGwei: "10" });
    await w.pass();
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    const s = await w.pass();
    expect(chain.sent).toHaveLength(1);
    expect(s.pending).toEqual([expect.stringMatching(/maxGasPriceGwei leaves no room/)]);
  });

  it("a pending tx whose call would now revert is replaced by a self-transfer and counted as a lost race", async () => {
    await chain.addSwitch(1n);
    chain.stuck = true;
    const w = make();
    await w.pass();
    chain.competitor("markDark", 1n);
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    let s = await w.pass();
    expect(chain.sent[1]).toMatchObject({ kind: "cancel", nonce: 0 });
    expect(s.pending).toEqual([expect.stringMatching(/would now revert \(AlreadyDarkMarked\); freed nonce 0/)]);
    chain.stuck = false;
    chain.mine();
    s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.lostRaces).toEqual([expect.stringMatching(/lost the markDark race: .* was cancelled \(AlreadyDarkMarked\)/)]);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]); // nonce freed: the reveal went through
  });

  it("does not replace a stuck revealKey at fees the bounty cannot pay; the original can still be mined", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" }); // bounty 0.01 ETH
    chain.stuck = true;
    const w = make();
    await w.pass();
    const [orig] = chain.sent;
    expect(tracked(w, 1n).pendingTx).toMatchObject({ kind: "revealKey", profitGas: "150000" });
    // fees spike: a replacement at 2000 gwei would cost ~0.3 ETH of gas for a 0.01 ETH bounty
    chain.market = { maxFeePerGas: parseGwei("2000"), maxPriorityFeePerGas: parseGwei("2") };
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    let s = await w.pass();
    expect(chain.sent).toHaveLength(1);
    expect(s.errors).toEqual([]);
    expect(s.unprofitable).toEqual([expect.stringMatching(/not replacing pending revealKey 0x[0-9a-f]+ at max fee 2000 gwei: bounty .* < required/)]);
    // re-checked only after unprofitableRecheckSec; still reported meanwhile
    const fees = chain.fees.bind(chain);
    let feeLookups = 0;
    chain.fees = async () => (feeLookups++, fees());
    s = await w.pass();
    expect(feeLookups).toBe(0);
    expect(chain.sent).toHaveLength(1);
    expect(s.unprofitable).toHaveLength(1);
    // the base fee falls back and the original is mined at its own fees
    chain.mineOnly(orig.hash);
    s = await w.pass();
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
    expect(tracked(w, 1n)).toMatchObject({ revealTx: orig.hash, revealedByUs: true });
    expect(tracked(w, 1n).note).toBeUndefined();
  });

  it("does not replace a stuck markDark when markDark + reveal no longer pay at the replacement fees", async () => {
    await chain.addSwitch(1n);
    chain.stuck = true;
    const w = make();
    await w.pass();
    expect(tracked(w, 1n).pendingTx).toMatchObject({ kind: "markDark", profitGas: "460000" }); // 60k + revealGasEstimate
    chain.market = { maxFeePerGas: parseGwei("20"), maxPriorityFeePerGas: parseGwei("2") };
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    const s = await w.pass();
    expect(chain.sent).toHaveLength(1);
    expect(s.unprofitable).toEqual([expect.stringMatching(/not replacing pending markDark .* at max fee 20 gwei/)]);
  });

  // Switch 1's bounty pays for markDark + reveal at 10 gwei (0.0069 ETH needed) but not at 13 gwei (0.00897).
  const SMALL = parseEther("0.007");
  const feesAt = (gwei: string) => ({ maxFeePerGas: parseGwei(gwei), maxPriorityFeePerGas: parseGwei("1") });

  it("frees the nonce of a markDark held back as unprofitable when a later transaction waits behind it", async () => {
    await chain.addSwitch(1n, { bounty: SMALL });
    await chain.addSwitch(2n, { bounty: parseEther("1"), state: "ALIVE" });
    chain.baseFee = parseGwei("8"); // mined in nonce order, only at or above the base fee
    chain.stuck = true;
    const w = make();
    await w.pass();
    chain.sw(2n).state = "DARK"; // a pass later: its markDark goes out behind switch 1's
    await w.pass();
    expect(chain.sent.map((x) => [x.kind, x.nonce])).toEqual([
      ["markDark", 0],
      ["markDark", 1],
    ]);
    // the base fee rises past both max fees before either is mined
    chain.baseFee = parseGwei("12");
    chain.market = feesAt("13");
    chain.mine();
    for (const id of [1n, 2n]) tracked(w, id).pendingTx!.sentAtMs -= 121_000;
    let s = await w.pass();
    // switch 1: not worth replacing, but switch 2's markDark (nonce 1) cannot be mined before nonce 0
    expect(chain.sent[2]).toMatchObject({ kind: "cancel", nonce: 0, fees: { maxFeePerGas: parseGwei("13") } });
    expect(s.pending).toContainEqual(
      expect.stringMatching(/not replacing markDark .* at max fee 13 gwei .*; markDark 0x[0-9a-f]+ of .*\/2 waits behind nonce 0 and pays for freeing it: freed it with self-transfer/),
    );
    chain.mine();
    expect([chain.sw(1n).state, chain.sw(2n).state]).toEqual(["DARK", "DARK_MARKED"]);
    chain.stuck = false;
    s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.lostRaces).toEqual([]); // giving up an unprofitable markDark is not a lost race
    expect(s.revealed).toEqual([trackKey(OWNER, 2n)]);
    expect(tracked(w, 1n).pendingTx).toBeUndefined();
    // switch 1 is judged afresh at market fees
    expect(s.unprofitable).toEqual([expect.stringMatching(new RegExp(`^${trackKey(OWNER, 1n)}: not marking dark: bounty`))]);
  });

  it("frees a held-back nonce before sending another switch's transaction behind it", async () => {
    await chain.addSwitch(1n, { bounty: SMALL });
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make();
    await w.pass();
    chain.baseFee = parseGwei("12");
    chain.market = feesAt("13");
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    let s = await w.pass();
    // nothing waits behind it yet: held back at its own fees
    expect(s.unprofitable).toEqual([expect.stringMatching(/not replacing pending markDark .* it can still be mined at its own fees/)]);
    expect(chain.sent).toHaveLength(1);
    // another switch goes dark: its markDark must not queue up behind nonce 0
    await chain.addSwitch(2n, { bounty: parseEther("1") });
    chain.stuck = false;
    s = await w.pass();
    expect(chain.sent.map((x) => [x.kind, x.nonce])).toEqual([
      ["markDark", 0],
      ["cancel", 0],
      ["markDark", 1],
      ["revealKey", 2],
    ]);
    expect(s.errors).toEqual([]);
    expect(s.revealed).toEqual([trackKey(OWNER, 2n)]);
  });

  it("does not pay to free held-back nonces when what waits behind them is itself held back (fee spike)", async () => {
    for (const id of [1n, 2n, 3n]) await chain.addSwitch(id); // 0.01 ETH each: pays at 10 gwei only
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make();
    await w.pass(); // markDark nonces 0, 1, 2 at 10 gwei
    // the base fee spikes past all three before any is mined: a 21k-gas self-transfer at 2000 gwei costs 0.042 ETH
    chain.baseFee = parseGwei("1600");
    chain.market = { maxFeePerGas: parseGwei("2000"), maxPriorityFeePerGas: parseGwei("2") };
    chain.mine();
    for (const id of [1n, 2n, 3n]) tracked(w, id).pendingTx!.sentAtMs -= 121_000;
    let s = await w.pass();
    expect(chain.sent.map((x) => x.kind)).toEqual(["markDark", "markDark", "markDark"]);
    // nonce 0 does not pay at the new fees; nonces 1 and 2 cannot be mined before it, whatever their fees
    expect(s.unprofitable).toEqual([expect.stringMatching(new RegExp(`^${trackKey(OWNER, 1n)}: not replacing pending markDark`))]);
    expect(s.pending).toEqual([
      expect.stringMatching(new RegExp(`^${trackKey(OWNER, 2n)}: markDark .* not raising its fees: nonce 0 in front of it is held back`)),
      expect.stringMatching(new RegExp(`^${trackKey(OWNER, 3n)}: markDark .* not raising its fees: nonce 0 in front of it is held back`)),
    ]);
    expect([1n, 2n, 3n].map((id) => tracked(w, id).pendingTx?.heldBack)).toEqual([true, true, true]);
    s = await w.pass();
    expect(chain.sent).toHaveLength(3);
    expect(s.unprofitable).toHaveLength(1);
    expect(s.pending).toHaveLength(2);
    // fees fall back: all three are mined at their own fees, in nonce order
    chain.baseFee = parseGwei("8");
    chain.mine();
    expect([1n, 2n, 3n].map((id) => chain.sw(id).state)).toEqual(["DARK_MARKED", "DARK_MARKED", "DARK_MARKED"]);
  });

  it("a publishPlaintext (no bounty) waits behind a held-back revealKey instead of having it given up", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED", bounty: parseEther("0.5") });
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make({ publish: true });
    await w.pass(); // revealKey at 10 gwei
    chain.baseFee = parseGwei("2500");
    chain.market = { maxFeePerGas: parseGwei("3000"), maxPriorityFeePerGas: parseGwei("2") };
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    let s = await w.pass();
    expect(s.unprofitable).toEqual([expect.stringMatching(/not replacing pending revealKey/)]);
    // someone else reveals switch 2; the watcher archives and publishes it
    await chain.addSwitch(2n, { state: "REVEALED", bounty: 0n });
    s = await w.pass();
    expect(chain.sent.map((x) => [x.kind, x.nonce])).toEqual([
      ["revealKey", 0],
      ["publishPlaintext", 1],
    ]);
    expect(tracked(w, 1n).pendingTx).toMatchObject({ kind: "revealKey", heldBack: true });
    // the publish cannot be mined before nonce 0: its fees are not raised meanwhile
    tracked(w, 2n).pendingTx!.sentAtMs -= 121_000;
    s = await w.pass();
    expect(chain.sent).toHaveLength(2);
    expect(s.pending).toEqual([expect.stringMatching(/publishPlaintext .* not raising its fees while nonce 0 in front of it is held back/)]);
    chain.baseFee = parseGwei("8");
    chain.mine();
    expect(chain.sw(1n).state).toBe("REVEALED");
    expect(chain.sw(2n).published).toBe(true);
  });

  it("does not raise the fees of a transaction behind a nonce that is not being mined (the node evicted the held-back one in front)", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED", bounty: parseEther("0.5") });
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make({ publish: true, revealGasEstimate: 150_000 });
    await w.pass(); // revealKey, nonce 0
    chain.baseFee = parseGwei("2500");
    chain.market = { maxFeePerGas: parseGwei("3000"), maxPriorityFeePerGas: parseGwei("2") };
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    await w.pass(); // held back
    await chain.addSwitch(2n, { state: "REVEALED", bounty: 0n });
    await w.pass(); // publishPlaintext, nonce 1, waits behind it
    // the node evicts the cheapest transaction in its pool (the held-back revealKey); like geth, its pending
    // nonce no longer counts the publish queued behind the gap
    chain.pool = chain.pool.filter((x) => x.nonce !== 0);
    chain.nonce = async () => chain.latestNonce;
    let s = await w.pass(); // the revealKey is noticed as dropped (and not re-sent: unprofitable at 3000 gwei)
    for (let i = 0; i < 4; i++) {
      for (const t of Object.values(w.state.switches)) {
        if (t.pendingTx) t.pendingTx.sentAtMs -= 700_000;
        t.profitRecheckAtMs = undefined;
      }
      s = await w.pass();
    }
    // higher fees cannot get nonce 1 mined while nonce 0 is empty: the publish keeps its own fees
    expect(chain.sent.filter((x) => x.nonce === 1)).toHaveLength(1);
    expect(tracked(w, 2n).pendingTx).toMatchObject({ kind: "publishPlaintext", nonce: 1, maxFeePerGas: parseGwei("3000").toString() });
    expect(s.pending).toContainEqual(expect.stringMatching(/publishPlaintext .* not raising its fees: nonce 0 in front of it is not one the watcher is waiting on/));
  });

  it("does not raise the fees of a transaction that earns nothing (publishPlaintext) above the market rate", async () => {
    await chain.addSwitch(1n, { state: "REVEALED", bounty: 0n });
    chain.stuck = true; // e.g. a lagging RPC: it is next to be mined, and at the market rate, but not mined
    const w = make({ publish: true });
    await w.pass();
    expect(chain.sent.map((x) => [x.kind, x.nonce])).toEqual([["publishPlaintext", 0]]);
    let s;
    for (let i = 0; i < 4; i++) {
      tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
      s = await w.pass();
    }
    expect(chain.sent).toHaveLength(1); // not +12.5% a pass, compounding
    expect(s!.pending).toEqual([expect.stringMatching(/publishPlaintext .* not raising its fees above the market rate \(10 gwei\)/)]);
    // the market moves up: the fees follow it, and no further
    chain.market = { maxFeePerGas: parseGwei("15"), maxPriorityFeePerGas: parseGwei("1") };
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    await w.pass();
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]).toMatchObject({ kind: "publishPlaintext", nonce: 0, fees: { maxFeePerGas: parseGwei("15"), maxPriorityFeePerGas: parseGwei("1.125") + 1n } });
  });

  /** Like geth: the pending nonce is the first one no pooled transaction holds, so the next send refills a dropped one's nonce. */
  const gethNonces = () => {
    const firstFree = () => {
      let n = chain.latestNonce;
      while (chain.pool.some((x) => x.nonce === n)) n++;
      return n;
    };
    const send = chain.send.bind(chain);
    chain.send = (fn, args, opts = {}) => send(fn, args, { ...opts, nonce: opts.nonce ?? firstFree() });
    chain.nonce = async (tag = "latest") => (tag === "latest" ? chain.latestNonce : firstFree());
  };
  /** A publishPlaintext (switch 1) at nonce 0 and a revealKey (switch 2) behind it at nonce 1, both at the market rate and unmined. */
  const publishThenReveal = async () => {
    await chain.addSwitch(1n, { state: "REVEALED", bounty: 0n });
    await chain.addSwitch(2n, { state: "ALIVE", bounty: parseEther("0.5") });
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make({ publish: true });
    await w.pass(); // publishPlaintext, nonce 0
    chain.sw(2n).state = "DARK_MARKED";
    await w.pass(); // revealKey, nonce 1
    expect(chain.sent.map((x) => [x.kind, x.nonce])).toEqual([
      ["publishPlaintext", 0],
      ["revealKey", 1],
    ]);
    return w;
  };

  it("notices that the node dropped a publishPlaintext priced at the market and sends it again, so the revealKey behind it is mined", async () => {
    gethNonces();
    const w = await publishThenReveal();
    chain.pool = chain.pool.filter((x) => x.nonce !== 0); // dropped (a node restart without a journal, an eviction): nonce 0 is a gap
    chain.stuck = false;
    for (let i = 0; i < 2; i++) {
      for (const t of Object.values(w.state.switches)) if (t.pendingTx) t.pendingTx.sentAtMs -= 121_000;
      await w.pass();
      chain.mine();
    }
    expect(logs.some((l) => /publishPlaintext 0x[0-9a-f]+ was dropped from the mempool/.test(l))).toBe(true);
    expect(chain.sw(1n).published).toBe(true);
    expect(chain.sw(2n).state).toBe("REVEALED");
    expect(tracked(w, 2n)).toMatchObject({ revealedByUs: true });
  });

  it("sends a dropped transaction's action again while settling pending ones, in nonce order, so the one behind it is re-priced the same pass", async () => {
    gethNonces();
    await chain.addSwitch(1n, { bounty: parseEther("1") });
    await chain.addSwitch(2n, { bounty: parseEther("0.5") });
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make();
    await w.pass(); // markDark: switch 1 at nonce 0, switch 2 at nonce 1, both at 10 gwei
    expect(chain.sent.map((x) => [x.args[1], x.nonce])).toEqual([
      [1n, 0],
      [2n, 1],
    ]);
    // the node restarted without a journal and lost nonce 0; fees spiked: nonce 1 (10 gwei) is under the base fee
    const lost = tracked(w, 1n).pendingTx!.hashes[0];
    chain.pool = chain.pool.filter((x) => x.hash !== lost);
    for (const id of [1n, 2n]) tracked(w, id).pendingTx!.sentAtMs -= 121_000;
    chain.baseFee = parseGwei("12");
    chain.market = feesAt("13");
    chain.stuck = false;
    kms.failWith = () => decryptFailure(relayerAnswers.notYet()); // the relayer lags the markDark for a while
    await w.pass();
    expect(chain.sent.slice(2).map((x) => [x.kind, x.args[1], x.nonce, x.fees!.maxFeePerGas])).toEqual([
      ["markDark", 1n, 0, parseGwei("13")], // nonce 0 refilled first
      ["markDark", 2n, 1, parseGwei("13")], // then the one behind it, judged behind a transaction being mined
    ]);
  });

  it("does not re-price a transaction behind a nonce whose transaction the node dropped (a gap the state file does not show)", async () => {
    const w = await publishThenReveal();
    chain.pool = chain.pool.filter((x) => x.nonce !== 0);
    tracked(w, 2n).pendingTx!.sentAtMs -= 121_000; // the publish is still young, so its own check waits this pass
    const s = await w.pass();
    expect(chain.sent).toHaveLength(2);
    expect(s.pending).toContainEqual(expect.stringMatching(/revealKey .* not raising its fees: nonce 0 in front of it .*dropped/));
  });

  it("raises the tip of a publishPlaintext when the market's tip rose, although its max fee then goes one bump past the market's", async () => {
    await chain.addSwitch(1n, { state: "REVEALED", bounty: 0n });
    chain.stuck = true;
    const w = make({ publish: true });
    await w.pass(); // at 10 / 1 gwei
    chain.market = { maxFeePerGas: parseGwei("10"), maxPriorityFeePerGas: parseGwei("2") };
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    await w.pass();
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]).toMatchObject({ kind: "publishPlaintext", nonce: 0, fees: { maxFeePerGas: parseGwei("11.25") + 1n, maxPriorityFeePerGas: parseGwei("2") } });
    // the tip is now at the market's: no further raise while the market stays put
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    await w.pass();
    expect(chain.sent).toHaveLength(2);
  });

  it("after a base-fee spike, one pass re-prices a publish and the revealKey behind it: pending transactions go in nonce order", async () => {
    await chain.addSwitch(1n, { state: "ALIVE", bounty: parseEther("0.5") }); // tracked first, reveals later (nonce 1)
    await chain.addSwitch(2n, { state: "REVEALED", bounty: 0n }); // publishes first (nonce 0)
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make({ publish: true });
    await w.pass();
    chain.sw(1n).state = "DARK_MARKED";
    await w.pass();
    expect(chain.sent.map((x) => [x.kind, x.nonce])).toEqual([
      ["publishPlaintext", 0],
      ["revealKey", 1],
    ]);
    chain.baseFee = parseGwei("12");
    chain.market = feesAt("13");
    for (const id of [1n, 2n]) tracked(w, id).pendingTx!.sentAtMs -= 121_000;
    await w.pass();
    expect(chain.sent.slice(2).map((x) => [x.kind, x.nonce, x.fees!.maxFeePerGas])).toEqual([
      ["publishPlaintext", 0, parseGwei("13")],
      ["revealKey", 1, parseGwei("13")],
    ]);
    chain.mine(); // the next block takes both
    expect(chain.sw(2n).published).toBe(true);
    expect(chain.sw(1n).state).toBe("REVEALED");
  });

  describe("held-back nonces and the base fee", () => {
    // A (0.007 ETH) holds nonce 0 at 10 gwei; B (0.0095 ETH) goes DARK later, so its markDark is nonce 1 at 13 gwei.
    // B pays for its own markDark + reveal and a 21k self-transfer at ~13 gwei, but not for a +12.5% replacement of itself.
    const setup = async (order: "A-first" | "B-first") => {
      const addA = () => chain.addSwitch(2n, { bounty: parseEther("0.007") });
      const addB = () => chain.addSwitch(1n, { bounty: parseEther("0.0095"), state: "ALIVE" });
      if (order === "A-first") await addA().then(addB);
      else await addB().then(addA);
      chain.baseFee = parseGwei("8");
      chain.stuck = true;
      const w = make();
      await w.pass(); // A: markDark nonce 0 at 10 gwei
      chain.baseFee = parseGwei("12");
      chain.market = feesAt("13");
      chain.mine();
      chain.sw(1n).state = "DARK";
      await w.pass(); // B: markDark nonce 1 at 13 gwei
      return w;
    };
    const run = async (w: Watcher, passes = 4) => {
      for (let i = 0; i < passes; i++) {
        for (const t of Object.values(w.state.switches)) {
          if (t.pendingTx) t.pendingTx.sentAtMs -= 700_000; // past txReceiptTimeoutSec and unprofitableRecheckSec
          t.profitRecheckAtMs = undefined;
        }
        await w.pass();
        chain.mine();
      }
    };

    for (const order of ["A-first", "B-first"] as const) {
      it(`frees the held nonce for a later markDark that pays at its own fees, even when that one is held back too (${order})`, async () => {
        const w = await setup(order);
        await run(w);
        expect(chain.latestNonce).toBeGreaterThan(0); // the queue moved
        expect(chain.sw(1n).state).not.toBe("DARK");
        expect(chain.sent.some((x) => x.kind === "cancel" && x.nonce === 0)).toBe(true);
      });
    }

    it("values a later markDark at its own fees while they still cover the base fee (base fee crept up)", async () => {
      const w = await setup("A-first");
      chain.baseFee = parseGwei("12.3"); // B at 13 gwei is still includable, no longer at the market estimate
      chain.market = feesAt("13.5");
      await run(w);
      expect(chain.latestNonce).toBeGreaterThan(0);
      expect(chain.sw(1n).state).not.toBe("DARK");
    });

    it("does not free a held nonce whose own max fee covers the base fee again: no self-transfer is wasted", async () => {
      const w = await setup("A-first");
      chain.baseFee = parseGwei("9"); // A (10 gwei) is minable again; its replacement still would not pay
      chain.market = feesAt("11.8");
      await run(w, 1);
      expect(chain.sent.filter((x) => x.kind === "cancel")).toEqual([]);
      expect(chain.sw(2n).state).not.toBe("DARK"); // A's own markDark was mined at its own fees
      expect(chain.sw(1n).state).not.toBe("DARK");
    });
  });

  it("frees a held-back nonce only when the transaction behind it can pay for the self-transfer too", async () => {
    await chain.addSwitch(1n, { bounty: SMALL });
    // pays for markDark + reveal at 13 gwei (0.00897 ETH needed), not for that plus a self-transfer at 13 gwei (0.00938)
    await chain.addSwitch(2n, { bounty: parseEther("0.009"), state: "ALIVE" });
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make();
    await w.pass();
    chain.sw(2n).state = "DARK"; // a pass later: its markDark goes out behind switch 1's
    await w.pass();
    chain.baseFee = parseGwei("12");
    chain.market = feesAt("13");
    chain.mine();
    for (const id of [1n, 2n]) tracked(w, id).pendingTx!.sentAtMs -= 121_000;
    const s = await w.pass();
    // switch 2 would still pay at 13 gwei on its own, but it cannot be mined before the held-back nonce 0:
    // a replacement would only raise what it pays once nonce 0 is mined
    expect(chain.sent.map((x) => [x.kind, x.nonce])).toEqual([
      ["markDark", 0],
      ["markDark", 1],
    ]);
    expect(s.unprofitable).toEqual([expect.stringMatching(/not replacing pending markDark .* nothing waiting behind nonce 0 pays for freeing it/)]);
    expect(s.pending).toEqual([expect.stringMatching(/markDark .* not raising its fees: nonce 0 in front of it is held back/)]);
  });

  it("frees a held-back nonce for a transaction it did not send only within what the held-back action was allowed to cost", async () => {
    await chain.addSwitch(1n, { bounty: SMALL }); // markDark sent at 10 gwei for 460k gas: allowed 0.0046 ETH
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make();
    await w.pass();
    chain.baseFee = parseGwei("12");
    chain.market = feesAt("300"); // a self-transfer at 300 gwei: 0.0063 ETH
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    await w.pass(); // held back
    // another user of the same key: a transaction at nonce 1 joins the pool
    chain.pool.push({ hash: `0x${"ab".repeat(32)}`, nonce: 1, kind: "cancel", args: [], fees: feesAt("300") });
    let s = await w.pass();
    expect(chain.sent).toHaveLength(1);
    expect(s.unprofitable).toEqual([expect.stringMatching(/nothing waiting behind nonce 0 pays for freeing it/)]);
    chain.market = feesAt("13"); // 0.000273 ETH
    s = await w.pass();
    expect(chain.sent[1]).toMatchObject({ kind: "cancel", nonce: 0, fees: { maxFeePerGas: parseGwei("13") } });
    expect(s.pending).toEqual([expect.stringMatching(/a transaction the watcher did not send waits behind nonce 0/)]);
  });

  it("does not raise the fees of a self-transfer that freed a held-back nonce once nothing behind it pays for that", async () => {
    await chain.addSwitch(1n, { bounty: SMALL });
    await chain.addSwitch(2n, { bounty: parseEther("1"), state: "ALIVE" });
    chain.baseFee = parseGwei("8");
    chain.stuck = true;
    const w = make();
    await w.pass();
    chain.sw(2n).state = "DARK"; // a pass later: its markDark goes out behind switch 1's
    await w.pass();
    chain.baseFee = parseGwei("12");
    chain.market = feesAt("13");
    chain.mine();
    for (const id of [1n, 2n]) tracked(w, id).pendingTx!.sentAtMs -= 121_000;
    await w.pass(); // nonce 0 freed for switch 2's markDark (re-sent at 13 gwei)
    expect(chain.sent.slice(2).map((x) => [x.kind, x.nonce])).toEqual([
      ["cancel", 0],
      ["markDark", 1],
    ]);
    // a spike before either is mined: switch 2's markDark no longer pays (1.725 ETH needed at 2500 gwei)
    chain.baseFee = parseGwei("2000");
    chain.market = { maxFeePerGas: parseGwei("2500"), maxPriorityFeePerGas: parseGwei("2") };
    chain.mine();
    for (const id of [1n, 2n]) tracked(w, id).pendingTx!.sentAtMs -= 121_000;
    const s = await w.pass();
    expect(chain.sent).toHaveLength(4);
    expect(s.unprofitable).toEqual([expect.stringMatching(/not raising the fees of self-transfer .* nothing waiting behind nonce 0 pays for that/)]);
    // switch 2's markDark waits behind it at its own fees
    expect(s.pending).toEqual([expect.stringMatching(/markDark .* not raising its fees: nonce 0 in front of it is held back/)]);
    chain.baseFee = parseGwei("8");
    chain.mine();
    expect([chain.sw(1n).state, chain.sw(2n).state]).toEqual(["DARK", "DARK_MARKED"]);
  });

  it("notices that the node dropped a held-back markDark and sends it again at market fees", async () => {
    await chain.addSwitch(1n, { bounty: SMALL });
    chain.stuck = true;
    const w = make();
    await w.pass();
    const [orig] = chain.sent;
    chain.market = feesAt("13");
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    let s = await w.pass();
    expect(s.unprofitable).toEqual([expect.stringMatching(/not replacing pending markDark/)]);
    // the node drops it (restart without a journal, pool overflow, ...) and fees fall below the original's
    chain.pool = [];
    chain.market = feesAt("9");
    chain.stuck = false;
    s = await w.pass(); // still within unprofitableRecheckSec
    expect(logs.some((l) => l.includes(`markDark ${orig.hash} was dropped from the mempool`))).toBe(true);
    expect(chain.sent.slice(1)).toEqual([
      expect.objectContaining({ kind: "markDark", nonce: 0, fees: feesAt("9") }),
      expect.objectContaining({ kind: "revealKey", nonce: 1 }),
    ]);
    expect(s.unprofitable).toEqual([]);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
  });

  it("a held-back markDark whose nonce another transaction took leaves no stale note behind", async () => {
    await chain.addSwitch(1n, { bounty: SMALL });
    chain.stuck = true;
    const w = make();
    await w.pass();
    chain.market = feesAt("13");
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    await w.pass(); // held back
    // a transaction the watcher did not send takes nonce 0
    chain.pool = [];
    chain.latestNonce = 1;
    const s = await w.pass();
    expect(logs.some((l) => /nonce 0 was taken .* is void/.test(l))).toBe(true);
    expect(tracked(w, 1n).pendingTx).toBeUndefined();
    // judged afresh at market fees: no "not replacing pending markDark" for a tx that is gone
    expect(s.unprofitable).toEqual([expect.stringMatching(/not marking dark: bounty/)]);
  });

  it("a replacement racing the original's inclusion books the original as ours (node forgot the replacement)", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" });
    chain.stuck = true;
    const w = make();
    await w.pass();
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    await w.pass(); // replaced once
    expect(chain.sent).toHaveLength(2);
    const [orig] = chain.sent;
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    const replace = chain.replace.bind(chain);
    // the original is mined between the receipt check and the next replacement; the node evicts the replacement
    chain.replace = async (hash, nonce, fees) => {
      chain.mineOnly(orig.hash);
      return replace(hash, nonce, fees);
    };
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
    expect(tracked(w, 1n)).toMatchObject({ revealTx: orig.hash, revealedByUs: true });
    expect(JSON.parse(readFileSync(outFile(1n, "json"), "utf8"))).toMatchObject({ revealedByUs: true, revealTx: orig.hash });
    expect(logs.some((l) => l.includes("dropped from the mempool"))).toBe(false);
  });

  it("a replacement rejected with 'nonce too low' because an earlier broadcast was just mined is not an error", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" });
    chain.stuck = true;
    const w = make();
    await w.pass();
    const [orig] = chain.sent;
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    chain.replace = async () => {
      chain.mineOnly(orig.hash);
      throw new Error("nonce too low: next nonce 1, tx nonce 0");
    };
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
    expect(tracked(w, 1n).attempts).toBe(0);
  });

  it("when a cancel is itself replaced and the earlier cancel is mined, it is a lost race, not a markDark", async () => {
    await chain.addSwitch(1n);
    chain.stuck = true;
    const w = make();
    await w.pass(); // markDark stuck
    chain.competitor("markDark", 1n);
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    await w.pass(); // cancel #1
    tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
    chain.market = { maxFeePerGas: parseGwei("20"), maxPriorityFeePerGas: parseGwei("2") }; // a cancel's fees only follow the market up
    await w.pass(); // cancel #2 replaces cancel #1
    expect(chain.sent.map((t) => t.kind)).toEqual(["markDark", "cancel", "cancel"]);
    expect(tracked(w, 1n).pendingTx).toMatchObject({ cancelled: "AlreadyDarkMarked", cancelFrom: 1 });
    chain.stuck = false;
    chain.mineOnly(chain.sent[1].hash);
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(s.markedDark).toEqual([]);
    expect(s.lostRaces).toEqual([expect.stringMatching(/lost the markDark race: .* was cancelled \(AlreadyDarkMarked\)/)]);
    expect(tracked(w, 1n).markDarkTx).toBeUndefined();
  });

  it("a markDark whose nonce another transaction from the key took (cancelled in a wallet) is void, not booked as marked", async () => {
    await chain.addSwitch(1n);
    const waitFor = chain.waitFor.bind(chain);
    const foreign = `0x${"ef".repeat(32)}` as const;
    let first = true;
    chain.waitFor = async (fn, hash, timeoutMs) => {
      if (!first) return waitFor(fn, hash, timeoutMs);
      first = false;
      // someone else's 0-value self-transfer takes nonce 0; the markDark never runs
      chain.pool = chain.pool.filter((p) => p.hash !== hash);
      chain.latestNonce = 1;
      throw new TxReplacedError(fn, hash, foreign, "cancelled");
    };
    const w = make();
    const s = await w.pass();
    expect(s.errors).toEqual([]);
    expect(logs.some((l) => l.includes(`was cancelled by ${foreign}`))).toBe(true);
    // re-read: still DARK, so it marks again (nonce 1) and goes on to reveal
    expect(chain.sent.filter((x) => x.kind === "markDark").map((x) => x.nonce)).toEqual([0, 1]);
    expect(tracked(w, 1n).markDarkTx).toBe(chain.sent[1].hash);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
  });

  describe("a transaction it does not track in front of its own (the watcher moved to a new contract, same key)", () => {
    const OLD_DMS = "0x00000000000000000000000000000000000000B2";

    it("refuses the old deployment's state file, naming the nonces it still has pending and what to do first", () => {
      const pendingAt = (nonce: number) => ({ kind: "markDark", hashes: [`0x${"ab".repeat(32)}`], nonce, maxFeePerGas: "1", maxPriorityFeePerGas: "1", sentAtMs: 0, heldBack: true });
      const switches = { a: { ...newTracked(OWNER, 1n), pendingTx: pendingAt(7) }, b: newTracked(OWNER, 2n), c: { ...newTracked(OWNER, 3n), pendingTx: pendingAt(9) } };
      writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, chainId: 31337, contract: OLD_DMS, switches }));
      expect(() => make()).toThrow(/belongs to chain 31337 \/ contract 0x0+B2.*use --state-file.*nonces 7, 9.*run the watcher of contract 0x0+B2 until .*no pendingTx.*another PRIVATE_KEY/);
    });

    it("warns at startup and while its own transaction waits behind it, and does not raise fees that cannot get it mined", async () => {
      // the old watcher's markDark at nonce 0, held back at 10 gwei in a fee spike; its state file is not this one
      chain.pool.push({ hash: `0x${"cd".repeat(32)}`, nonce: 0, kind: "cancel", args: [], fees: feesAt("10") });
      chain.baseFee = parseGwei("12");
      chain.market = feesAt("13");
      await chain.addSwitch(1n, { bounty: parseEther("1") });
      const w = make();
      await w.pass();
      expect(logs).toContainEqual(expect.stringMatching(/^WARNING: nonce 0 of this signer is pending but not tracked by .*state\.json/));
      expect(chain.sent.map((x) => [x.kind, x.nonce])).toEqual([["markDark", 1]]);
      logs = [];
      tracked(w, 1n).pendingTx!.sentAtMs -= 121_000;
      const s = await w.pass();
      expect(chain.sent).toHaveLength(1);
      expect(logs).toContainEqual(expect.stringMatching(/WARNING: markDark .* not raising its fees: nonce 0 in front of it is held by a transaction .*state\.json does not track/));
      expect(s.pending).toHaveLength(1);
      // the spike ends: the old transaction is mined at its own fees, then this one
      chain.baseFee = parseGwei("8");
      chain.mine();
      const after = await w.pass();
      expect(after.markedDark).toEqual([trackKey(OWNER, 1n)]);
      expect(after.revealed).toEqual([trackKey(OWNER, 1n)]);
    });
  });

  it("a new process resolves the pending tx it finds in the state file instead of sending another", async () => {
    await chain.addSwitch(1n);
    chain.stuck = true;
    await make().pass();
    chain.stuck = false;
    chain.mine();
    const w2 = make();
    const s = await w2.pass();
    expect(s.markedDark).toEqual([trackKey(OWNER, 1n)]);
    expect(chain.sent.filter((t) => t.kind === "markDark")).toHaveLength(1);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
  });

  it("logs and reports a switch that makes no progress in 8 steps", async () => {
    await chain.addSwitch(1n);
    // Every markDark simulation hits a race that a re-read does not resolve.
    chain.estimateMarkDark = async () => {
      throw simulatedRevert("markDark", "AlreadyDarkMarked");
    };
    const s = await make().pass();
    expect(s.pending).toEqual([expect.stringMatching(/no progress after 8 steps \(state DARK, last action mark-dark\)/)]);
    expect(logs.some((l) => l.includes("no progress after 8 steps"))).toBe(true);
  });
});

describe("Watcher: relayer failures and economics", () => {
  it("a fatal relayer error (HTTP 401) is an error, and markDark pauses instead of spending gas", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" });
    await chain.addSwitch(2n, { state: "DARK" });
    kms.failWith = () => new FhevmError("public decryption refused: 401 Unauthorized", { fatal: true });
    const s = await make().pass();
    expect(s.errors).toEqual([expect.stringMatching(/public decrypt: .*401/)]);
    expect(s.pending).toEqual([expect.stringMatching(/not marking dark while public decryption fails/)]);
    expect(chain.sent).toEqual([]);
    expect(chain.sw(2n).state).toBe("DARK");
  });

  it("the markDark pause after a rejected relayer key survives restarts (cron --once) until the relayer settings change", async () => {
    for (const id of [1n, 2n, 3n]) await chain.addSwitch(id);
    kms.failWith = () => new FhevmError("public decryption refused: 401 Unauthorized", { fatal: true });
    const oldKey = { ...cfg, relayerApiKey: "relayer-key-one" };
    for (let run = 0; run < 3; run++) await make({}, {}, oldKey).pass(); // three separate --once processes
    expect(chain.sent.filter((t) => t.kind === "markDark")).toHaveLength(1);
    expect([chain.sw(2n).state, chain.sw(3n).state]).toEqual(["DARK", "DARK"]);
    expect(savedState().decryptBroken).toMatchObject({ reason: expect.stringMatching(/401/), untilMs: expect.any(Number) });
    expect(readFileSync(join(dir, "state.json"), "utf8")).not.toContain("relayer-key-one");

    // the operator fixes the key: the next run marks (and reveals) again at once
    kms.failWith = undefined;
    logs = [];
    const s = await make({}, {}, { ...cfg, relayerApiKey: "relayer-key-two" }).pass();
    expect(logs.some((l) => l.includes("relayer settings changed"))).toBe(true);
    expect(s.markedDark).toEqual([trackKey(OWNER, 2n), trackKey(OWNER, 3n)]);
    expect(s.revealed).toEqual([trackKey(OWNER, 2n), trackKey(OWNER, 3n)]);
    expect(savedState().decryptBroken).toBeUndefined();
  });

  it("a relayer URL with no public-decrypt route (HTTP 404) pauses markDark like a rejected key, instead of a markDark per dark switch", async () => {
    for (const id of [1n, 2n, 3n]) await chain.addSwitch(id);
    kms.failWith = () => decryptFailure(relayerAnswers.wrongUrl());
    for (let run = 0; run < 3; run++) {
      const s = await make().pass(); // three separate --once processes
      if (run === 0) expect(s.errors).toEqual([expect.stringMatching(/public decrypt: .*404/)]);
    }
    expect(chain.sent.filter((t) => t.kind === "markDark")).toHaveLength(1);
    expect([chain.sw(2n).state, chain.sw(3n).state]).toEqual(["DARK", "DARK"]);
    expect(savedState().decryptBroken).toMatchObject({ reason: expect.stringMatching(/ZAMA_RELAYER_URL/) });
  }, 15_000);

  it("asks again a few seconds after a 'no route' answer: an edge reloading its routes for a second or two does not pause markDark", async () => {
    await chain.addSwitch(1n);
    const reloadingUntil = Date.now() + 2_000;
    const asked: number[] = [];
    kms.onDecrypt = () => {
      asked.push(Date.now());
      if (Date.now() < reloadingUntil) throw decryptFailure(relayerAnswers.wrongUrl());
    };
    const s = await make().pass();
    expect(asked).toHaveLength(2);
    expect(asked[1] - asked[0]).toBeGreaterThanOrEqual(2_500);
    expect(s.errors).toEqual([]);
    expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
    expect(savedState().decryptBroken).toBeUndefined();
  }, 15_000);

  it("one 'no route' answer (an edge reloading its routes) does not pause markDark: only two in a row do", async () => {
    for (const id of [1n, 2n, 3n]) await chain.addSwitch(id);
    let first = true;
    kms.onDecrypt = () => {
      if (!first) return;
      first = false;
      throw decryptFailure(relayerAnswers.wrongUrl());
    };
    const s = await make().pass();
    expect(s.errors).toEqual([]);
    expect(s.revealed).toEqual([1n, 2n, 3n].map((id) => trackKey(OWNER, id)));
    expect(savedState().decryptBroken).toBeUndefined();
  }, 15_000);

  it("dark switches read while markDark was paused are marked in the same pass once a public decryption works again", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" });
    await chain.addSwitch(2n);
    await chain.addSwitch(3n);
    const w = make();
    kms.failWith = () => new FhevmError("public decryption refused: 401 Unauthorized", { fatal: true });
    await w.pass(); // switch 1's reveal is refused: markDark paused; 2 and 3 wait
    expect(chain.sent).toEqual([]);
    kms.failWith = undefined; // the operator fixed the key; switch 1's backoff ran out
    tracked(w, 1n).nextAttemptAtMs = 0;
    const s = await w.pass();
    expect(s.revealed).toEqual([1n, 2n, 3n].map((id) => trackKey(OWNER, id)));
    expect(s.markedDark).toEqual([2n, 3n].map((id) => trackKey(OWNER, id)));
  });

  it("the relayer's normal lag after markDark (HTTP 400 not_allowed_on_host_acl) stays pending, and markDark goes on", async () => {
    for (const id of [1n, 2n, 3n]) await chain.addSwitch(id);
    kms.failWith = () => decryptFailure(relayerAnswers.notYet());
    const s = await make().pass();
    expect(s.errors).toEqual([]);
    expect(s.pending).toEqual([1n, 2n, 3n].map((id) => expect.stringMatching(new RegExp(`^${trackKey(OWNER, id)}: public decrypt: .*not_allowed_on_host_acl`))));
    expect(chain.sent.filter((t) => t.kind === "markDark")).toHaveLength(3);
    expect(savedState().decryptBroken).toBeUndefined();
  });

  it("the KMS time budget counts only time spent on the KMS, not discovery or receipt waits", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" });
    await chain.addSwitch(2n, { state: "DARK_MARKED" });
    await chain.addSwitch(3n, { state: "DARK_MARKED" });
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      // discovery "takes" 3 s, more than the whole 2 s budget
      const logsFn = chain.switchCreatedLogs.bind(chain);
      chain.switchCreatedLogs = async (from, to) => ((skew += 3_000), logsFn(from, to));
      // switch 1's KMS request is quick; switch 2's takes 1.5 s and fails; switch 3 has no budget left
      kms.onDecrypt = (handle) => {
        if (handle === chain.sw(2n).handle) {
          skew += 1_500;
          throw new FhevmError("public decryption refused: not ready");
        }
      };
      const s = await make({ decryptPassBudgetSec: 2 }).pass();
      expect(s.revealed).toEqual([trackKey(OWNER, 1n)]);
      expect(kms.calls).toBe(2);
      expect(s.pending).toEqual([
        expect.stringMatching(new RegExp(`^${trackKey(OWNER, 2n)}: public decrypt: .*not ready`)),
        expect.stringMatching(new RegExp(`^${trackKey(OWNER, 3n)}: public decrypt deferred \\(KMS time budget`)),
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("a transient relayer error (key not served yet) is pending, not an error", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" });
    kms.failWith = () => new FhevmError("public decryption refused: not ready");
    const s = await make().pass();
    expect(s.errors).toEqual([]);
    expect(s.pending).toEqual([expect.stringMatching(/public decrypt/)]);
  });

  it("honours the relayer's Retry-After when backing off", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" });
    kms.failWith = () => new FhevmError("429", { retryAfterSec: 600 });
    const w = make();
    const before = Date.now();
    await w.pass();
    expect(tracked(w, 1n).nextAttemptAtMs).toBeGreaterThanOrEqual(before + 600_000);
  });

  it("caps the relayer's Retry-After at backoffMaxSec, so a hostile or buggy relayer cannot park a switch", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED" });
    kms.failWith = () => new FhevmError("429", { retryAfterSec: 10 * 365 * 86_400 }); // ten years
    const w = make({ decryptAttemptsPerPass: 2 });
    await w.pass();
    expect(tracked(w, 1n).nextAttemptAtMs).toBeLessThanOrEqual(Date.now() + 900_000); // backoffMaxSec
    expect(logs.some((l) => /retrying in 900s/.test(l))).toBe(true);
    // a Retry-After that is not a number falls back to the normal backoff instead of disabling it
    tracked(w, 1n).nextAttemptAtMs = 0;
    kms.failWith = () => new FhevmError("429", { retryAfterSec: Number.NaN });
    const before = Date.now();
    await w.pass();
    expect(tracked(w, 1n).nextAttemptAtMs).toBeGreaterThanOrEqual(before + 15_000);
  });

  it("skips the KMS entirely when the revealGasEstimate pre-check already says unprofitable", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED", bounty: 0n });
    const s = await make().pass();
    expect(kms.calls).toBe(0);
    expect(s.unprofitable).toEqual([expect.stringMatching(/not revealing: bounty 0 wei/)]);
  });

  it("an unprofitable verdict does not delay archiving once someone else reveals", async () => {
    await chain.addSwitch(1n, { state: "DARK_MARKED", bounty: 0n });
    const w = make();
    await w.pass();
    expect(tracked(w, 1n).profitRecheckAtMs).toBeGreaterThan(Date.now());
    chain.competitor("revealKey", 1n);
    const s = await w.pass();
    expect(s.saved).toEqual([trackKey(OWNER, 1n)]);
    expect(s.unprofitable).toEqual([]);
    expect(tracked(w, 1n).note).toBeUndefined();
  });

  it("createWatcher fails fast without ZAMA_RELAYER_API_KEY on mainnet only (Sepolia's relayer is open)", () => {
    const env = { RPC_URL: "http://127.0.0.1:1", DMS_ADDRESS: DMS, PRIVATE_KEY: cfg.privateKey, CHAIN_ID: "1" };
    expect(() => createWatcher(env, { once: true, stateFile: join(dir, "s.json") })).toThrow(ConfigError);
    expect(() => createWatcher(env, { once: true, stateFile: join(dir, "s.json") })).toThrow(/ZAMA_RELAYER_API_KEY is required/);
    expect(() => createWatcher({ ...env, CHAIN_ID: "11155111" }, { once: true, stateFile: join(dir, "s.json") })).not.toThrow();
    expect(() => createWatcher({ ...env, CHAIN_ID: "31337" }, { once: true, stateFile: join(dir, "s.json") })).not.toThrow();
  });
});

describe("Watcher: output files", () => {
  it("writes into a per-contract directory and never overwrites another switch's archive", async () => {
    const { plaintext } = await chain.addSwitch(1n, { state: "REVEALED" });
    const d = join(dir, "out", `31337-${DMS.toLowerCase()}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${OWNER.toLowerCase()}-1.json`), JSON.stringify({ contract: DMS, owner: OWNER, id: "1", revealedKey: "0xdead" }));
    writeFileSync(join(d, `${OWNER.toLowerCase()}-1.bin`), "someone else's secret");
    await make().pass();
    expect(readFileSync(join(d, `${OWNER.toLowerCase()}-1.bin`), "utf8")).toBe("someone else's secret");
    expect(readFileSync(join(d, `${OWNER.toLowerCase()}-1.1.bin`), "utf8")).toBe(plaintext);
    expect(logs.some((l) => /WARNING: .* already exists for a different switch/.test(l))).toBe(true);
  });

  it("re-archiving the same switch (e.g. after a crash before the state was saved) leaves the files as they are", async () => {
    await chain.addSwitch(1n, { state: "REVEALED" });
    await make({ stateFile: join(dir, "a.json") }).pass();
    const before = readFileSync(outFile(1n, "json"), "utf8");
    await make({ stateFile: join(dir, "b.json") }).pass();
    expect(readFileSync(outFile(1n, "json"), "utf8")).toBe(before);
    expect(existsSync(outFile(1n, "bin").replace(/\.bin$/, ".1.bin"))).toBe(false);
    expect(logs.some((l) => l.includes("already archived"))).toBe(true);
  });
});

describe("Watcher: RPC and disk cost of a pass", () => {
  /** Count calls to every WatcherDms method of the stub. */
  const countCalls = () => {
    const calls: Record<string, number> = {};
    for (const m of ["blockNumber", "switchCreatedLogs", "latestTimestamp", "info", "ciphertext", "fees", "latestBaseFee", "nonce", "estimateMarkDark"] as const) {
      const f = (chain[m] as (...a: unknown[]) => unknown).bind(chain);
      (chain as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => ((calls[m] = (calls[m] ?? 0) + 1), f(...a));
    }
    return calls;
  };

  it("a steady-state pass over switches that are waiting costs one read each and no state-file write", async () => {
    for (const id of [1n, 2n, 3n, 4n, 5n]) await chain.addSwitch(id, { bounty: 1n }); // DARK, never worth marking
    const w = make();
    await w.pass(); // unprofitable verdicts, re-checked after unprofitableRecheckSec
    // the same state, compact: any rewrite by the watcher would pretty-print it again
    const compact = JSON.stringify(savedState());
    writeFileSync(join(dir, "state.json"), compact);
    const calls = countCalls();
    const s = await w.pass();
    expect(s.unprofitable).toHaveLength(5);
    // discovery (the head; no new blocks to scan), the pass's chain time, then getSwitchInfo per switch: nothing per step besides
    expect(calls).toEqual({ blockNumber: 1, latestTimestamp: 1, info: 5 });
    // nothing changed: the state file is not rewritten
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(compact);
  });

  it("a pass writes the state file once, at its end, not once per switch that changed (nor does the periodic profit re-check)", async () => {
    const N = 20;
    for (let id = 1n; id <= BigInt(N); id++) await chain.addSwitch(id, { bounty: 0n }); // DARK, never worth marking
    const w = make();
    // what the state file holds each time a switch is read during the pass
    const seen = new Set<string>();
    const info = chain.info.bind(chain);
    chain.info = async (owner, id) => {
      seen.add(readFileSync(join(dir, "state.json"), "utf8"));
      return info(owner, id);
    };
    let s = await w.pass();
    expect(s.unprofitable).toHaveLength(N);
    expect(seen.size).toBe(1); // written after discovery, then not again while the switches are processed
    expect(savedState().switches[trackKey(OWNER, BigInt(N))].note).toMatch(/not marking dark/); // all saved at the end
    // every unprofitableRecheckSec each of them gets a new verdict: still one write
    for (const t of Object.values(w.state.switches)) t.profitRecheckAtMs = Date.now() - 1;
    seen.clear();
    s = await w.pass();
    expect(s.unprofitable).toHaveLength(N);
    expect(seen.size).toBe(1);
    expect(savedState().switches[trackKey(OWNER, 1n)].profitRecheckAtMs).toBe(tracked(w, 1n).profitRecheckAtMs);
  });

  it("markDark and revealKey are sent with the gas the watcher already estimated (no second eth_estimateGas)", async () => {
    await chain.addSwitch(1n);
    await make().pass();
    expect(chain.sent.map((x) => [x.kind, x.gas])).toEqual([
      ["markDark", 60_000n],
      ["revealKey", 150_000n],
    ]);
  });
});

describe("Watcher: entry point", () => {
  it("runs when started through a symlink (npm's dms-watcher bin link, a symlinked deploy directory)", () => {
    const clientDir = fileURLToPath(new URL("..", import.meta.url));
    const link = join(dir, "dms-watcher.ts");
    symlinkSync(join(clientDir, "src", "watcher.ts"), link);
    const r = spawnSync(process.execPath, ["--import", "tsx", link, "--help"], { cwd: clientDir, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: watcher");
  }, 70_000);
});

describe("Watcher: bounty with profit", () => {
  it("does not mark dark when the bounty cannot pay for markDark + reveal", async () => {
    await chain.addSwitch(1n, { bounty: parseEther("0.000001") });
    const s = await make().pass();
    expect(s.unprofitable).toEqual([expect.stringMatching(/not marking dark/)]);
    expect(chain.sent).toEqual([]);
  });
});
