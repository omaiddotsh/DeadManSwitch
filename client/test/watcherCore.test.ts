import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEther, parseGwei } from "viem";
import { describe, expect, it } from "vitest";
import type { StateName } from "../src/chain.js";
import { ConfigError } from "../src/config.js";
import {
  assessProfit,
  backoffMs,
  blockRanges,
  capFees,
  chunkEnd,
  classifyLogsError,
  decide,
  DEFAULT_WATCHER_CONFIG,
  jitteredMs,
  newTracked,
  parseWatcherArgs,
  parseWatcherConfig,
  replacementFees,
  shouldPoll,
  trackKey,
  type ChainView,
} from "../src/watcherCore.js";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const now = { chainTime: 1_000n, wallMs: 50_000 };
const view = (state: StateName, extra: Partial<ChainView> = {}): ChainView => ({
  state,
  expiresAt: 900n,
  bounty: parseEther("0.01"),
  published: false,
  ...extra,
});
const fresh = () => ({
  saved: false,
  nextAttemptAtMs: 0 as number,
  profitRecheckAtMs: undefined as number | undefined,
  commitmentMatches: undefined as boolean | undefined,
  keyMismatch: undefined as boolean | undefined,
});
const noPublish = { publish: false };

describe("decide()", () => {
  it("NONE → ignore, not terminal", () => {
    expect(decide(view("NONE"), fresh(), noPublish, now)).toMatchObject({ action: "ignore", terminal: false });
  });

  it("CANCELLED → ignore, terminal (key never released)", () => {
    expect(decide(view("CANCELLED"), fresh(), noPublish, now)).toMatchObject({ action: "ignore", terminal: true });
  });

  it("ALIVE → ignore until the deadline (chain time)", () => {
    const d = decide(view("ALIVE", { expiresAt: 5_000n }), fresh(), noPublish, now);
    expect(d).toEqual({ action: "ignore", reason: "owner alive", terminal: false, recheckAtChainTime: 5_000n });
  });

  it("DARK → mark-dark", () => {
    expect(decide(view("DARK"), fresh(), noPublish, now)).toEqual({ action: "mark-dark" });
  });

  it("DARK_MARKED → reveal", () => {
    expect(decide(view("DARK_MARKED"), fresh(), noPublish, now)).toEqual({ action: "reveal" });
  });

  it("defers every on-chain action while a backoff timer is pending", () => {
    const local = { ...fresh(), nextAttemptAtMs: now.wallMs + 1 };
    for (const s of ["DARK", "DARK_MARKED", "REVEALED"] as const) {
      expect(decide(view(s), local, noPublish, now)).toMatchObject({ action: "wait", untilMs: now.wallMs + 1 });
    }
    // ...but never defers the terminal / passive outcomes
    expect(decide(view("CANCELLED"), local, noPublish, now).action).toBe("ignore");
    expect(decide(view("ALIVE"), local, noPublish, now).action).toBe("ignore");
  });

  it("defers markDark / revealKey while an unprofitable verdict is pending, separately from the failure backoff", () => {
    const local = { ...fresh(), profitRecheckAtMs: now.wallMs + 10 };
    expect(decide(view("DARK"), local, noPublish, now)).toEqual({ action: "wait", reason: "unprofitable; re-checking later", untilMs: now.wallMs + 10 });
    expect(decide(view("DARK_MARKED"), local, noPublish, now)).toMatchObject({ action: "wait", reason: "unprofitable; re-checking later" });
    expect(decide(view("DARK"), { ...local, profitRecheckAtMs: undefined }, noPublish, now)).toEqual({ action: "mark-dark" });
  });

  it("an unprofitable verdict never holds back archive or publish (someone else revealed meanwhile)", () => {
    const local = { ...fresh(), profitRecheckAtMs: now.wallMs + 600_000 };
    expect(decide(view("REVEALED"), local, noPublish, now)).toEqual({ action: "archive" });
    expect(decide(view("REVEALED"), { ...local, saved: true, commitmentMatches: true }, { publish: true }, now)).toEqual({ action: "publish" });
  });

  it("acts again once the timer has expired", () => {
    const local = { ...fresh(), nextAttemptAtMs: now.wallMs };
    expect(decide(view("DARK_MARKED"), local, noPublish, now)).toEqual({ action: "reveal" });
  });

  it("REVEALED and not saved → archive (also for switches someone else revealed)", () => {
    expect(decide(view("REVEALED"), fresh(), noPublish, now)).toEqual({ action: "archive" });
  });

  it("REVEALED, saved, publish off → done", () => {
    expect(decide(view("REVEALED"), { ...fresh(), saved: true, commitmentMatches: true }, noPublish, now)).toMatchObject({ action: "done" });
  });

  it("REVEALED, saved, publish on, unpublished, commitment verified → publish", () => {
    expect(decide(view("REVEALED"), { ...fresh(), saved: true, commitmentMatches: true }, { publish: true }, now)).toEqual({
      action: "publish",
    });
  });

  it("never publishes when already published, the commitment failed, or the key did not open the ciphertext", () => {
    const p = { publish: true };
    expect(decide(view("REVEALED", { published: true }), { ...fresh(), saved: true, commitmentMatches: true }, p, now).action).toBe("done");
    expect(decide(view("REVEALED"), { ...fresh(), saved: true, commitmentMatches: false }, p, now).action).toBe("done");
    expect(decide(view("REVEALED"), { ...fresh(), saved: true, keyMismatch: true }, p, now).action).toBe("done");
  });
});

describe("shouldPoll()", () => {
  it("skips terminal switches and alive switches before their deadline", () => {
    expect(shouldPoll({ terminal: true }, 10n)).toBe(false);
    expect(shouldPoll({ terminal: false, recheckAtChainTime: "11" }, 10n)).toBe(false);
    expect(shouldPoll({ terminal: false, recheckAtChainTime: "10" }, 10n)).toBe(true);
    expect(shouldPoll({ terminal: false }, 10n)).toBe(true);
  });
});

describe("assessProfit()", () => {
  const base = {
    gasUnits: 200_000n,
    gasPriceWei: parseGwei("10"),
    safetyFactor: 1.5,
    minProfitWei: 0n,
    altruistic: false,
    maxGasPriceWei: 0n,
  };
  // cost = 200k × 10 gwei = 0.002 ETH; required = 0.003 ETH

  it("accepts a bounty that covers gas × safety factor", () => {
    const r = assessProfit({ ...base, bountyWei: parseEther("0.003") });
    expect(r.ok).toBe(true);
    expect(r.costWei).toBe(parseEther("0.002"));
    expect(r.requiredWei).toBe(parseEther("0.003"));
  });

  it("rejects one wei less", () => {
    const r = assessProfit({ ...base, bountyWei: parseEther("0.003") - 1n });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/required/);
  });

  it("adds the minimum profit on top", () => {
    expect(assessProfit({ ...base, bountyWei: parseEther("0.004"), minProfitWei: parseEther("0.001") }).ok).toBe(true);
    expect(assessProfit({ ...base, bountyWei: parseEther("0.004") - 1n, minProfitWei: parseEther("0.001") }).ok).toBe(false);
  });

  it("zero bounty is unprofitable unless altruistic", () => {
    expect(assessProfit({ ...base, bountyWei: 0n }).ok).toBe(false);
    expect(assessProfit({ ...base, bountyWei: 0n, altruistic: true })).toMatchObject({ ok: true, reason: "altruistic mode" });
  });

  it("the gas-price cap applies even in altruistic mode", () => {
    const r = assessProfit({ ...base, bountyWei: parseEther("10"), altruistic: true, maxGasPriceWei: parseGwei("5") });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/above the cap/);
  });

  it("adds an extra cost (e.g. self-transfers in front of the action) before applying the safety factor", () => {
    const extraCostWei = parseEther("0.001"); // cost 0.003 ETH; required 0.0045 ETH
    expect(assessProfit({ ...base, bountyWei: parseEther("0.0045"), extraCostWei })).toMatchObject({ ok: true, costWei: parseEther("0.003") });
    const r = assessProfit({ ...base, bountyWei: parseEther("0.0045") - 1n, extraCostWei });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\(\(gas 200000 × 10000000000 wei \+ 1000000000000000 wei\) × 1\.5\)/);
  });

  it("rounds the safety factor up, never down", () => {
    const r = assessProfit({ ...base, gasUnits: 1n, gasPriceWei: 1n, bountyWei: 1n, safetyFactor: 1.5 });
    expect(r.requiredWei).toBe(2n);
    expect(r.ok).toBe(false);
  });
});

describe("timing helpers", () => {
  it("backoff doubles and caps", () => {
    expect(backoffMs(1, 15, 900)).toBe(15_000);
    expect(backoffMs(2, 15, 900)).toBe(30_000);
    expect(backoffMs(3, 15, 900)).toBe(60_000);
    expect(backoffMs(20, 15, 900)).toBe(900_000);
  });

  it("jitter stays within ± pct", () => {
    expect(jitteredMs(30, 10, 0)).toBe(27_000);
    expect(jitteredMs(30, 10, 0.5)).toBe(30_000);
    expect(jitteredMs(30, 10, 0.999999)).toBeLessThanOrEqual(33_000);
    expect(jitteredMs(30, 0, 0)).toBe(30_000);
  });

  it("chunkEnd stops at the chunk size or the head, whichever comes first", () => {
    expect(chunkEnd(0n, 9n, 5n)).toBe(4n);
    expect(chunkEnd(5n, 9n, 5n)).toBe(9n);
    expect(chunkEnd(8n, 9n, 5n)).toBe(9n);
    expect(chunkEnd(3n, 3n, 1n)).toBe(3n);
    expect(chunkEnd(0n, 23_000_000n, 2n)).toBe(1n);
    expect(() => chunkEnd(0n, 9n, 0n)).toThrow();
  });

  it("blockRanges chunks inclusively", () => {
    expect(blockRanges(0n, 9n, 5n)).toEqual([
      [0n, 4n],
      [5n, 9n],
    ]);
    expect(blockRanges(3n, 3n, 100n)).toEqual([[3n, 3n]]);
    expect(blockRanges(10n, 9n, 5n)).toEqual([]);
    expect(blockRanges(0n, 10n, 5n)).toEqual([
      [0n, 4n],
      [5n, 9n],
      [10n, 10n],
    ]);
  });
});

describe("classifyLogsError()", () => {
  it("rate limits, timeouts, network and 5xx errors are transient (retry the same range)", () => {
    expect(classifyLogsError({ message: "HTTP request failed. Status: 429", status: 429 })).toBe("transient");
    expect(classifyLogsError({ message: "daily request count exceeded, request rate limited", code: -32005 })).toBe("transient");
    expect(classifyLogsError({ message: "Too Many Requests" })).toBe("transient");
    expect(classifyLogsError({ message: "The request took too long to respond." })).toBe("transient");
    expect(classifyLogsError({ message: "fetch failed | connect ECONNREFUSED 127.0.0.1:8545" })).toBe("transient");
    expect(classifyLogsError({ message: "Internal server error", status: 502 })).toBe("transient");
  });

  it("a node without the blocks' history (pruned, code 4444; a load-balanced RPC) is its own kind: not halved, not slept on", () => {
    expect(classifyLogsError({ message: "Pruned history unavailable", code: 4444 })).toBe("unavailable");
    expect(classifyLogsError({ message: "RPC Request failed. | history is not available for this block range", code: -32603 })).toBe("unavailable");
    // viem wraps the node's error: its code can sit below another one in the cause chain
    expect(classifyLogsError({ message: "An unknown RPC error occurred. | missing data", code: -1, codes: [-1, 4444] })).toBe("unavailable");
  });

  it("range and result-size limits are range errors (halve the chunk)", () => {
    expect(classifyLogsError({ message: "eth_getLogs is limited to a 10 block range" })).toBe("range");
    expect(classifyLogsError({ message: "query returned more than 10000 results", code: -32005 })).toBe("range");
    expect(classifyLogsError({ message: "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range" })).toBe("range");
    expect(classifyLogsError({ message: "block range is too wide", status: 400 })).toBe("range");
    expect(classifyLogsError({ message: "something unexpected" })).toBe("range");
  });
});

describe("fees", () => {
  const old = { maxFeePerGas: parseGwei("20"), maxPriorityFeePerGas: parseGwei("2") };

  it("a replacement bumps both caps by at least 12.5%, or to the market if higher", () => {
    const r = replacementFees(old, { maxFeePerGas: parseGwei("10"), maxPriorityFeePerGas: parseGwei("1") }, 0n)!;
    expect(r.maxFeePerGas).toBe(parseGwei("22.5") + 1n);
    expect(r.maxPriorityFeePerGas).toBe(parseGwei("2.25") + 1n);
    const m = replacementFees(old, { maxFeePerGas: parseGwei("50"), maxPriorityFeePerGas: parseGwei("5") }, 0n)!;
    expect(m).toEqual({ maxFeePerGas: parseGwei("50"), maxPriorityFeePerGas: parseGwei("5") });
  });

  it("caps the replacement at maxGasPriceGwei, and gives up when the cap leaves no valid bump", () => {
    expect(replacementFees(old, { maxFeePerGas: parseGwei("50"), maxPriorityFeePerGas: parseGwei("5") }, parseGwei("30"))).toEqual({
      maxFeePerGas: parseGwei("30"),
      maxPriorityFeePerGas: parseGwei("5"),
    });
    expect(replacementFees(old, { maxFeePerGas: parseGwei("50"), maxPriorityFeePerGas: parseGwei("5") }, parseGwei("22"))).toBeUndefined();
  });

  it("capFees clamps the max fee and keeps the tip below it", () => {
    expect(capFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 200n }, 0n)).toEqual({ maxFeePerGas: 100n, maxPriorityFeePerGas: 100n });
    expect(capFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 5n }, 50n)).toEqual({ maxFeePerGas: 50n, maxPriorityFeePerGas: 5n });
  });
});

describe("watcher config and flags", () => {
  it("defaults when no config file is given", () => {
    const c = parseWatcherConfig(undefined, { once: false });
    expect(c).toMatchObject({ ...DEFAULT_WATCHER_CONFIG, fromBlock: undefined });
    expect(c.confirmations).toBeUndefined();
  });

  it("parses every field and lets flags override the file", () => {
    const c = parseWatcherConfig(
      {
        pollIntervalSec: 5,
        jitterPct: 0,
        outDir: "/tmp/out",
        stateFile: "/tmp/state.json",
        discover: false,
        fromBlock: 123,
        logChunkBlocks: 1000,
        confirmations: 3,
        switches: [{ owner: OWNER.toLowerCase(), id: "7" }, { owner: OWNER, id: 8 }],
        altruistic: false,
        publish: false,
        safetyFactor: 2,
        minProfitEth: "0.001",
        maxGasPriceGwei: "50",
        revealGasEstimate: 300000,
        decryptTimeoutSec: 60,
        decryptAttemptsPerPass: 3,
        decryptPassBudgetSec: 90,
        txReceiptTimeoutSec: 45,
        backoffBaseSec: 10,
        backoffMaxSec: 600,
        unprofitableRecheckSec: 120,
      },
      { once: true, altruistic: true, publish: true, outDir: "/x", fromBlock: 5n },
    );
    expect(c.switches).toEqual([
      { owner: OWNER, id: 7n },
      { owner: OWNER, id: 8n },
    ]);
    expect(c).toMatchObject({
      outDir: "/x",
      stateFile: "/tmp/state.json",
      discover: false,
      fromBlock: 5n,
      logChunkBlocks: 1000n,
      confirmations: 3,
      altruistic: true,
      publish: true,
      safetyFactor: 2,
      minProfitWei: parseEther("0.001"),
      maxGasPriceWei: parseGwei("50"),
      revealGasEstimate: 300_000n,
      decryptPassBudgetSec: 90,
      txReceiptTimeoutSec: 45,
      once: true,
    });
  });

  it("the shipped watcher.config.example.json is exactly the defaults", () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, "../watcher.config.example.json"), "utf8"));
    expect(parseWatcherConfig(raw, { once: false })).toEqual(parseWatcherConfig(undefined, { once: false }));
    // its note on stuck transactions says that markDark / revealKey replacements are profit-gated, and what frees a held-back nonce
    expect(raw._transactions).toMatch(/only while the bounty still pays/);
    expect(raw._transactions).toMatch(/later markDark \/ revealKey waits behind its nonce whose bounty also pays for freeing it.*self-transfer frees the nonce/);
    // ...and spells out every setting except the two that have no fixed default
    const listed = Object.keys(raw).filter((k) => !k.startsWith("_"));
    expect(listed.sort()).toEqual(
      [
        "pollIntervalSec",
        "jitterPct",
        "outDir",
        "stateFile",
        "discover",
        "logChunkBlocks",
        "altruistic",
        "safetyFactor",
        "minProfitEth",
        "maxGasPriceGwei",
        "revealGasEstimate",
        "publish",
        "txReceiptTimeoutSec",
        "decryptTimeoutSec",
        "decryptAttemptsPerPass",
        "decryptPassBudgetSec",
        "backoffBaseSec",
        "backoffMaxSec",
        "unprofitableRecheckSec",
      ].sort(),
    );
  });

  it("rejects malformed configs with a clear message", () => {
    expect(() => parseWatcherConfig([], { once: false })).toThrow(ConfigError);
    expect(() => parseWatcherConfig({ switches: [{ owner: "nope", id: 1 }] }, { once: false })).toThrow(/owner is not an address/);
    expect(() => parseWatcherConfig({ switches: [{ owner: OWNER, id: 0 }] }, { once: false })).toThrow(/positive integer/);
    expect(() => parseWatcherConfig({ safetyFactor: 0.5 }, { once: false })).toThrow(/safetyFactor/);
    expect(() => parseWatcherConfig({ publish: "yes" }, { once: false })).toThrow(/publish/);
    expect(() => parseWatcherConfig({ minProfitEth: "-1" }, { once: false })).toThrow(/minProfitEth/);
    expect(() => parseWatcherConfig({ altruisitc: true }, { once: false })).toThrow(/unknown key "altruisitc"/);
    expect(parseWatcherConfig({ _comment: "ignored" }, { once: false }).altruistic).toBe(false);
  });

  it("refuses a switch id that a JSON number cannot hold exactly (the frontend's ids are random 64-bit), or that is not a uint256", () => {
    const parsed = (id: string) => parseWatcherConfig(JSON.parse(`{"switches":[{"owner":"${OWNER}","id":${id}}]}`), { once: false });
    // JSON.parse turns 12345678901234567890 into 12345678901234567000: a different switch, watched silently as NONE
    expect(() => parsed("12345678901234567890")).toThrow(/switches\[0\]\.id .*quote it/);
    expect(parsed('"12345678901234567890"').switches[0].id).toBe(12345678901234567890n);
    expect(parsed("9007199254740991").switches[0].id).toBe(9007199254740991n);
    expect(() => parsed(`"${1n << 256n}"`)).toThrow(/switches\[0\]\.id .*uint256/);
  });

  it("parses watcher flags", () => {
    expect(parseWatcherArgs(["--once", "--altruistic", "--publish", "--no-discover", "--from-block", "42", "--config", "c.json"])).toEqual({
      once: true,
      altruistic: true,
      publish: true,
      discover: false,
      fromBlock: 42n,
      config: "c.json",
    });
    expect(parseWatcherArgs(["--rescan-from", "7"])).toEqual({ once: false, rescanFrom: 7n });
    expect(() => parseWatcherArgs(["--from-block", "x"])).toThrow(ConfigError);
    expect(() => parseWatcherArgs(["--rescan-from", "-1"])).toThrow(/--rescan-from must be a block number/);
    expect(() => parseWatcherArgs(["--config"])).toThrow(/needs a value/);
    expect(() => parseWatcherArgs(["--bogus"])).toThrow(/unknown watcher flag/);
  });

  it("tracks switches under a stable key", () => {
    expect(trackKey(OWNER, 5n)).toBe(`${OWNER.toLowerCase()}/5`);
    expect(newTracked(OWNER, 5n)).toEqual({ owner: OWNER, id: "5", attempts: 0, nextAttemptAtMs: 0, saved: false, terminal: false });
  });
});
