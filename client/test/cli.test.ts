// CLI commands (runCli) against a fake JSON-RPC node that answers DeadManSwitch
// reads from a table: what `status` prints, and the checks `reclaim` makes
// before it would send anything.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, decodeFunctionData, encodeFunctionResult, parseAbi, parseEther, parseGwei, toHex, zeroAddress, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dmsAbi } from "../src/abi.js";
import { runCli, type CliContext } from "../src/cli.js";
import { seal } from "../src/envelope.js";
import { exitCodeOf, PartialSuccessError, UsageError, UserFacingError } from "../src/errors.js";
import type { Fhevm } from "../src/fhevm.js";
import { chainSim, fheStub, SIGNER, SIGNER_KEY, type ChainSim } from "./cliChain.js";
import { fakeNode as node } from "./fakeNode.js";
import { decryptFailure, relayerAnswers } from "./relayerErrors.js";
import { DMS, OWNER } from "./watcherStub.js";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;

const FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
const feedAbi = parseAbi(["function decimals() view returns (uint8)"]);

/**
 * A node on `chainId` whose eth_call answers each DeadManSwitch view from `reads` (function name → result),
 * and `decimals()` of the price feed at FEED from `feedDecimals`.
 */
const fakeNode = (chainId: number, reads: Record<string, unknown>, feedDecimals?: number) =>
  node((method, params) => {
    switch (method) {
      case "eth_chainId":
        return toHex(chainId);
      case "eth_getCode":
        return "0x6000";
      case "eth_getBalance":
        return "0x0";
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: Hex };
        if (to.toLowerCase() === FEED.toLowerCase()) {
          if (feedDecimals === undefined) return "0x";
          decodeFunctionData({ abi: feedAbi, data });
          return encodeFunctionResult({ abi: feedAbi, functionName: "decimals", result: feedDecimals });
        }
        const { functionName } = decodeFunctionData({ abi: dmsAbi, data });
        if (!(functionName in reads)) throw new Error(`unexpected read ${functionName}`);
        return encodeFunctionResult({ abi: dmsAbi, functionName, result: reads[functionName] } as never);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  });

const run = async (argv: string[], env: Record<string, string>) => {
  const out: string[] = [];
  const err: string[] = [];
  const result = await runCli(argv, { env: { DMS_ADDRESS: DMS, ...env }, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { result, out, err };
};

describe("dms status", () => {
  const reads = {
    admin: zeroAddress,
    pendingAdmin: zeroAddress,
    minBountyUsd: 0n,
    minBounty: 0n,
    oraclePrice: [false, 0n],
    ethUsdPriceFeed: zeroAddress,
    maxPriceAge: 0n,
    MIN_PING_INTERVAL: 60n,
    MAX_PING_INTERVAL: 365n * 86_400n,
    MAX_PAYLOAD_SIZE: 2048n,
    CIPHERTEXT_OVERHEAD: 61n,
    MAX_CIPHERTEXT_SIZE: 2109n,
    RESCUE_DELAY: 30n * 86_400n,
    MAX_MIN_BOUNTY_USD: 10_000n * 10n ** 8n,
  };
  const relayerLine = (out: string[]) => out.find((l) => l.startsWith("relayer"));

  it("does not call an unset ZAMA_RELAYER_API_KEY missing on Sepolia, whose relayer is open; on mainnet it is", async () => {
    const sepolia = await run(["status"], { CHAIN_ID: "11155111", RPC_URL: await fakeNode(11155111, reads) });
    expect(relayerLine(sepolia.out)).toMatch(/relayer\.testnet\.zama\.org \(api key not needed: the Sepolia relayer is open\)/);
    const keyed = await run(["status"], { CHAIN_ID: "11155111", RPC_URL: await fakeNode(11155111, reads), ZAMA_RELAYER_API_KEY: "k" });
    expect(relayerLine(keyed.out)).toMatch(/\(api key set\)/);
    const mainnet = await run(["status"], { CHAIN_ID: "1", RPC_URL: await fakeNode(1, reads) });
    expect(relayerLine(mainnet.out)).toMatch(/relayer\.mainnet\.zama\.org \(api key MISSING\)/);
  });

  it("formats the oracle price in the feed's own decimals (the contract returns the raw answer), not as 8 decimals", async () => {
    const line = (out: string[], k: string) => out.find((l) => l.startsWith(k));
    for (const dec of [8, 18, 0]) {
      const withFeed = { ...reads, ethUsdPriceFeed: FEED, minBountyUsd: 10n * 10n ** 8n, minBounty: 3_333_333_333_333_333n, oraclePrice: [true, 3000n * 10n ** BigInt(dec)] };
      const r = await run(["status"], { CHAIN_ID: "11155111", RPC_URL: await fakeNode(11155111, withFeed, dec) });
      expect(line(r.out, "oracle price"), `${dec} decimals`).toBe("oracle price   $3000.00");
      expect(line(r.out, "min bounty"), `${dec} decimals`).toBe("min bounty     0.003333333333333333 ETH ($10.00 at ETH = $3000.00)");
      expect((r.result as { feedDecimals: number }).feedDecimals).toBe(dec);
    }
    // a feed address with no code: the raw answer, labelled as such
    const noCode = { ...reads, ethUsdPriceFeed: FEED, minBountyUsd: 10n * 10n ** 8n, oraclePrice: [true, 300_000_000_000n] };
    const r = await run(["status"], { CHAIN_ID: "11155111", RPC_URL: await fakeNode(11155111, noCode) });
    expect(line(r.out, "oracle price")).toBe("oracle price   300000000000 (raw feed answer; the feed's decimals are unknown)");
  });
});

describe("dms reclaim", () => {
  const FUNDER_KEY = `0x${"22".repeat(32)}`;
  const info = (state: number, extra: Record<string, unknown> = {}) => ({
    owner: OWNER,
    state,
    lastPing: 1_000n,
    pingInterval: 60n,
    createdAt: 1_000n,
    expiresAt: 1_060n,
    darkMarkedAt: 0n,
    revealedAt: 0n,
    bounty: 0n,
    ownerStake: 0n,
    plaintextCommitment: `0x${"11".repeat(32)}`,
    encKeyHandle: `0x${"12".repeat(32)}`,
    revealedKey: ZERO32,
    ciphertextLength: 113n,
    published: false,
    rescuable: false,
    ...extra,
  });
  const reclaim = async (reads: Record<string, unknown>) =>
    run(["reclaim", OWNER, "1"], { CHAIN_ID: "31337", PRIVATE_KEY: FUNDER_KEY, RPC_URL: await fakeNode(31337, reads) }).catch((e: unknown) => e as Error);

  it("on a revealed switch says that it was revealed (the contract reverts AlreadyRevealed), not that there is nothing to reclaim", async () => {
    // getFunderStake reads 0 once revealed: the stake went to the revealer
    const e = await reclaim({ getSwitchInfo: info(4), getFunderStake: 0n });
    expect((e as Error).message).toMatch(/the switch was revealed; contributions went to the revealer/);
  });

  it("checks in the contract's order: not yet rescuable before nothing to reclaim", async () => {
    const dark = await reclaim({ getSwitchInfo: info(2), getFunderStake: 0n });
    expect((dark as Error).message).toMatch(/reclaimable after a cancel, or 30 days after going dark/);
    const cancelled = await reclaim({ getSwitchInfo: info(5), getFunderStake: 0n });
    expect((cancelled as Error).message).toMatch(/you have no contribution on this switch/);
  });
});

// ---------- writes (a node that takes signed transactions: test/cliChain.ts) ---------- //

/** getSwitchInfo of a switch of OWNER (or `owner`) in `state` (STATE_NAMES index). */
const switchInfo = (state: number, extra: Record<string, unknown> = {}) => ({
  owner: OWNER,
  state,
  lastPing: 1_000n,
  pingInterval: 3_600n,
  createdAt: 1_000n,
  expiresAt: 4_600n,
  darkMarkedAt: 0n,
  revealedAt: 0n,
  bounty: 10n ** 16n,
  ownerStake: 10n ** 16n,
  plaintextCommitment: `0x${"11".repeat(32)}`,
  encKeyHandle: `0x${"12".repeat(32)}`,
  revealedKey: ZERO32,
  ciphertextLength: 113n,
  published: false,
  rescuable: false,
  ...extra,
});
const NONE = switchInfo(0, { owner: zeroAddress });

const write = async (argv: string[], sim: ChainSim, ctx: Partial<CliContext> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const result = await runCli(argv, {
    env: { DMS_ADDRESS: DMS, CHAIN_ID: "31337", RPC_URL: sim.url, PRIVATE_KEY: SIGNER_KEY },
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    ...ctx,
  }).catch((e: unknown) => e);
  return { result, out, err, error: result instanceof Error ? result : undefined };
};

describe("dms writes while an earlier transaction from the key is not mined yet", () => {
  const stuck = (sim: ChainSim, nonce = 5) => {
    const hash = `0x${"5e".repeat(32)}` as Hex;
    sim.known.set(hash, { hash, from: SIGNER, nonce, maxFeePerGas: parseGwei("10"), maxPriorityFeePerGas: parseGwei("1") });
    return hash;
  };

  it("fund-bounty is refused (it could fund twice) unless --queue sends it behind the pending one", async () => {
    const sim = await chainSim({ nonces: { latest: 5, pending: 6 }, reads: { getSwitchInfo: switchInfo(1) } });
    const r = await write(["fund-bounty", OWNER, "1", "0.5"], sim);
    expect(r.error?.message).toMatch(/not mined yet \(nonce 5\)/);
    expect(r.error?.message).toMatch(/--replace <.*> .*--queue/);
    expect(sim.sent).toEqual([]);
    const q = await write(["fund-bounty", OWNER, "1", "0.5", "--queue"], sim);
    expect(q.error).toBeUndefined();
    expect(sim.sent).toEqual([expect.objectContaining({ functionName: "fundBounty", nonce: 6, value: parseEther("0.5") })]);
  });

  it("create is refused too: a timed-out create may still be mined", async () => {
    const sim = await chainSim({ nonces: { latest: 5, pending: 6 }, reads: { getSwitchInfo: NONE, minBounty: 0n } });
    const r = await write(["create", "7", "3600", "0.05", "secret"], sim, { fhevmFactory: fheStub() });
    expect(r.error?.message).toMatch(new RegExp(`not mined yet .*dms info ${SIGNER} 7`));
    expect(sim.sent).toEqual([]);
  });

  it("ping --replace <hash> sends the ping at the stuck transaction's nonce, with fees above its own and the market's", async () => {
    const sim = await chainSim({ nonces: { latest: 5, pending: 6 }, baseFee: parseGwei("20"), reads: { getSwitchInfo: switchInfo(1, { owner: SIGNER }) } });
    const hash = stuck(sim);
    const r = await write(["ping", "1", "--replace", hash], sim);
    expect(r.error).toBeUndefined();
    expect(sim.sent).toHaveLength(1);
    const [p] = sim.sent;
    expect(p).toMatchObject({ functionName: "ping", nonce: 5 });
    expect(p.maxFeePerGas).toBeGreaterThanOrEqual(parseGwei("41")); // 2 × base fee + tip
    expect(p.maxPriorityFeePerGas).toBeGreaterThanOrEqual(parseGwei("1.125"));
    expect(r.err.join("\n")).toMatch(new RegExp(`replacing ${hash} \\(nonce 5\\)`));
  });

  it("--replace refuses a transaction that is already mined, or that another key sent", async () => {
    const sim = await chainSim({ nonces: { latest: 6, pending: 6 }, reads: { getSwitchInfo: switchInfo(1, { owner: SIGNER }) } });
    const hash = stuck(sim);
    sim.known.get(hash)!.blockNumber = 999n;
    expect((await write(["ping", "1", "--replace", hash], sim)).error?.message).toMatch(/already mined in block 999; nothing to replace/);
    sim.known.set(hash, { ...sim.known.get(hash)!, blockNumber: undefined, from: OWNER });
    expect((await write(["ping", "1", "--replace", hash], sim)).error?.message).toMatch(/was not sent by .*signer/);
    expect(sim.sent).toEqual([]);
  });

  it("ping (no value) still goes out, behind the pending one, with a note pointing to --replace", async () => {
    const sim = await chainSim({ nonces: { latest: 5, pending: 6 }, reads: { getSwitchInfo: switchInfo(1, { owner: SIGNER }) } });
    const r = await write(["ping", "1"], sim);
    expect(r.error).toBeUndefined();
    expect(sim.sent).toEqual([expect.objectContaining({ functionName: "ping", nonce: 6 })]);
    expect(r.err.join("\n")).toMatch(/not mined yet \(nonce 5\).*--replace/);
  });

  it("CLI writes leave room for base-fee rises: max fee = 2 × the latest base fee + the tip", async () => {
    const sim = await chainSim({ reads: { getSwitchInfo: switchInfo(1, { owner: SIGNER }) } });
    expect((await write(["ping", "1"], sim)).error).toBeUndefined();
    expect(sim.sent).toEqual([expect.objectContaining({ nonce: 5, maxFeePerGas: parseGwei("21"), maxPriorityFeePerGas: parseGwei("1") })]);
  });

  it("looks again before refusing: behind a load balancer the mined and pending counts can come from nodes at different heights", async () => {
    const sim = await chainSim({ nonces: { latest: 6, pending: 6 }, reads: { getSwitchInfo: switchInfo(1) } });
    let stale = true; // the first `latest` comes from a node one block behind
    sim.nonceAnswer = (tag) => (tag === "latest" && stale ? ((stale = false), 5) : 6);
    const r = await write(["fund-bounty", OWNER, "1", "0.5"], sim);
    expect(r.error).toBeUndefined();
    expect(sim.sent).toEqual([expect.objectContaining({ functionName: "fundBounty", nonce: 6 })]);
  });

  it("when the balance covers the usual max fee (1.2 × base fee + tip) but not 2 × base fee + tip, sends at the usual one and says so", async () => {
    // fund 0.5 ETH, 200k gas: 2 × 10 + 1 = 21 gwei needs 0.5042 ETH, 1.2 × 10 + 1 = 13 gwei needs 0.5026 ETH
    const sim = await chainSim({ reads: { getSwitchInfo: switchInfo(1) }, balance: parseEther("0.5") + 200_000n * parseGwei("15") });
    const r = await write(["fund-bounty", OWNER, "1", "0.5"], sim);
    expect(r.error).toBeUndefined();
    expect(sim.sent).toEqual([expect.objectContaining({ functionName: "fundBounty", maxFeePerGas: parseGwei("13") })]);
    expect(r.err.join("\n")).toMatch(/balance does not cover .*21 gwei.*13 gwei/);
    // a balance that covers neither still fails, with the node's reason
    const poor = await chainSim({ reads: { getSwitchInfo: switchInfo(1) }, balance: parseEther("0.5") });
    expect((await write(["fund-bounty", OWNER, "1", "0.5"], poor)).error?.message).toMatch(/exceeds the balance of the account/);
    expect(poor.sent).toEqual([]);
  });

  it("a write that is not mined in time says it may still be mined, gives its nonce and the --replace command", async () => {
    const sim = await chainSim({ mines: false, reads: { getSwitchInfo: switchInfo(1) } });
    const r = await write(["fund-bounty", OWNER, "1", "0.5"], sim, { receiptTimeoutMs: 1_000 });
    const [tx] = sim.sent;
    expect(r.error?.message).toMatch(new RegExp(`fundBounty transaction ${tx.hash} \\(nonce 5\\) was not mined within 1s`));
    expect(r.error?.message).toMatch(/may still be mined/);
    expect(r.error?.message).toMatch(/do not simply re-run fund-bounty/i);
    expect(r.error?.message).toMatch(new RegExp(`--replace ${tx.hash}`));
  }, 20_000);

  it("a create that is not mined in time says to check `dms info` before retrying", async () => {
    const sim = await chainSim({ mines: false, reads: { getSwitchInfo: NONE, minBounty: 0n } });
    const r = await write(["create", "7", "3600", "0.05", "secret"], sim, { receiptTimeoutMs: 1_000, fhevmFactory: fheStub() });
    expect(r.error?.message).toMatch(/createSwitch transaction 0x[0-9a-f]{64} \(nonce 5\) was not mined within 1s/);
    expect(r.error?.message).toMatch(new RegExp(`dms info ${SIGNER} 7\` before retrying`));
  }, 20_000);
});

describe("dms create on an id that already has a switch (a create that timed out may have been mined)", () => {
  it("says to ping (or cancel) that switch, not to pick another id for the same secret", async () => {
    const sim = await chainSim({ reads: { getSwitchInfo: switchInfo(1, { owner: SIGNER }), minBounty: 0n } });
    const r = await write(["create", "7", "3600", "0.05", "secret"], sim, { fhevmFactory: fheStub() });
    expect(r.error?.message).toMatch(/you already have switch 7 \(state ALIVE; the owner is alive; the deadline is/);
    expect(r.error?.message).toMatch(/`dms ping 7`/);
    expect(r.error?.message).not.toMatch(/pick another id/);
  });

  it("says the same when the create transaction itself finds the switch (AlreadyExists)", async () => {
    let reads = 0;
    const sim = await chainSim({
      reads: { getSwitchInfo: () => (reads++ === 0 ? NONE : switchInfo(1, { owner: SIGNER })), minBounty: 0n },
      reverts: { createSwitch: "AlreadyExists" },
    });
    const r = await write(["create", "7", "3600", "0.05", "secret"], sim, { fhevmFactory: fheStub() });
    expect(r.error?.message).toMatch(/you already have switch 7 \(state ALIVE.*`dms ping 7`/);
    expect(r.error?.message).not.toMatch(/pick another id/);
    expect(sim.sent).toEqual([]);
  });
});

describe("dms reveal / read after the paid reveal", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dms-cli-test-"));
  });

  /** A DARK_MARKED switch whose key `dek` opens its ciphertext. */
  const revealable = async (reverts: Record<string, string> = {}, state = 3) => {
    const sealed = await seal(new TextEncoder().encode("the launch codes are 0000"));
    const sim = await chainSim({
      reads: {
        getSwitchInfo: switchInfo(state, { plaintextCommitment: sealed.commitment, revealedKey: state === 4 ? bytesToHex(sealed.dek) : ZERO32 }),
        getCiphertext: bytesToHex(sealed.ciphertext),
      },
      reverts,
    });
    return { sim, dek: sealed.dek };
  };

  /** Make the next FileHandle.writeFile fail as on a full disk or past the file size limit. */
  const failNextWrite = async () => {
    const fh = await open(join(dir, "probe"), "w");
    const proto: FileHandle = Object.getPrototypeOf(fh);
    await fh.close();
    return vi.spyOn(proto, "writeFile").mockRejectedValueOnce(Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" }));
  };

  it("reveal --publish: losing the publish race (AlreadyPublished) after the paid reveal is not a failure", async () => {
    const { sim, dek } = await revealable({ publishPlaintext: "AlreadyPublished" });
    const r = await write(["reveal", OWNER, "1", "--publish"], sim, { fhevmFactory: fheStub(dek) });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ txHash: sim.sent[0].hash, published: true });
    expect(r.out.join("\n")).toMatch(/already published by someone else/);
  });

  it("reveal --publish: a real publish failure after the paid reveal exits 3 and says the reveal succeeded", async () => {
    const { sim, dek } = await revealable({ publishPlaintext: "CommitmentMismatch" });
    const r = await write(["reveal", OWNER, "1", "--publish"], sim, { fhevmFactory: fheStub(dek) });
    expect(exitCodeOf(r.error)).toBe(3);
    expect(r.error?.message).toMatch(new RegExp(`revealed the key \\(${sim.sent[0].hash}; bounty paid\\), but publishing failed: .*CommitmentMismatch`));
  });

  it("reveal --out: a write that fails after the paid reveal removes the file and exits 3, naming the reveal and the way to recover", async () => {
    const { sim, dek } = await revealable();
    const out = join(dir, "secret.bin");
    const spy = await failNextWrite();
    try {
      const r = await write(["reveal", OWNER, "1", "--out", out], sim, { fhevmFactory: fheStub(dek) });
      expect(exitCodeOf(r.error)).toBe(3);
      expect(r.error?.message).toMatch(new RegExp(`revealed the key \\(${sim.sent[0].hash}; bounty paid\\), but writing --out .*secret\\.bin failed \\(EFBIG`));
      expect(r.error?.message).toMatch(new RegExp(`dms read ${OWNER} 1 --out`));
      expect(existsSync(out)).toBe(false); // no empty file in the way of that `dms read --out`
    } finally {
      spy.mockRestore();
    }
  });

  it("reveal stops at the second answer in a row showing that ZAMA_RELAYER_URL has no public-decrypt route, and says to check it", async () => {
    const { sim } = await revealable();
    let calls = 0;
    const fhevmFactory = async (): Promise<Fhevm> => ({
      ...(await fheStub()()),
      publicDecryptDek: async () => {
        calls++;
        throw decryptFailure(relayerAnswers.wrongUrl());
      },
    });
    const r = await write(["reveal", OWNER, "1"], sim, { fhevmFactory });
    expect(calls).toBe(2);
    expect(r.error?.message).toMatch(/404.*check ZAMA_RELAYER_URL/);
    expect(r.error?.message).not.toMatch(/retry `reveal` later|ZAMA_RELAYER_API_KEY/);
    expect(sim.sent).toEqual([]);
  }, 30_000);

  it("reveal asks again a few seconds after one 'no route' answer (an edge reloading its routes) and reveals", async () => {
    const { sim, dek } = await revealable();
    let calls = 0;
    const healthy = await fheStub(dek)();
    const fhevmFactory = async (): Promise<Fhevm> => ({
      ...healthy,
      publicDecryptDek: async (handle, opts) => {
        if (calls++ === 0) throw decryptFailure(relayerAnswers.wrongUrl());
        return healthy.publicDecryptDek(handle, opts);
      },
    });
    const t0 = Date.now();
    const r = await write(["reveal", OWNER, "1"], sim, { fhevmFactory });
    expect(r.error).toBeUndefined();
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_500); // time for the edge to finish reloading
    expect(Date.now() - t0).toBeLessThan(5_000); // not the 5 s + 10 s "not served yet" schedule
    expect(sim.sent).toEqual([expect.objectContaining({ functionName: "revealKey" })]);
  }, 30_000);

  it("read --out: a failed write leaves no empty file behind", async () => {
    const { sim } = await revealable({}, 4);
    const out = join(dir, "secret.bin");
    const spy = await failNextWrite();
    try {
      const r = await write(["read", OWNER, "1", "--out", out], sim);
      expect(exitCodeOf(r.error)).toBe(1);
      expect(r.error?.message).toMatch(/EFBIG/);
      expect(existsSync(out)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect((await write(["read", OWNER, "1", "--out", out], sim)).error).toBeUndefined();
    expect(readFileSync(out, "utf8")).toBe("the launch codes are 0000");
  });
});

describe("exit codes", () => {
  it("2 for usage errors, 3 when the reveal succeeded but a follow-up step failed, 1 otherwise", () => {
    expect(exitCodeOf(new UsageError("x"))).toBe(2);
    expect(exitCodeOf(new PartialSuccessError("x"))).toBe(3);
    expect(exitCodeOf(new UserFacingError("x"))).toBe(1);
    expect(exitCodeOf(new Error("x"))).toBe(1);
  });
});
