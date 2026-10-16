import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, RawContractError } from "viem";
import { describe, expect, it } from "vitest";
import { dmsAbi } from "../src/abi.js";
import { decodeRevertData, describeError, hostErrorsAbi, revertErrorName, TxRevertedError } from "../src/errors.js";
import { Dms, STATE_NAMES } from "../src/chain.js";

const artifactPath = resolve(__dirname, "../../contracts/out/DeadManSwitch.sol/DeadManSwitch.json");
const haveArtifact = existsSync(artifactPath);
// Locally the drift check needs a `forge build` and is skipped without one. In CI it
// must run, so a missing artifact fails instead of skipping.
const inCI = !!process.env.CI && process.env.CI !== "false" && process.env.CI !== "0";

describe("ABI", () => {
  it.skipIf(!haveArtifact && !inCI)("src/abi.ts matches the forge artifact exactly (run `npm run abi`)", () => {
    if (!haveArtifact) {
      throw new Error(`CI is set but ${artifactPath} is missing: run \`forge build\` in contracts/ before the client tests`);
    }
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { abi: unknown };
    expect(JSON.parse(JSON.stringify(dmsAbi))).toEqual(artifact.abi);
  });

  it("has every function the client calls", () => {
    const fns = new Set(dmsAbi.filter((x) => x.type === "function").map((x) => (x as { name: string }).name));
    for (const f of [
      "createSwitch",
      "ping",
      "fundBounty",
      "cancel",
      "reclaimContribution",
      "reclaimOwnerStake",
      "markDark",
      "revealKey",
      "publishPlaintext",
      "getSwitchInfo",
      "getState",
      "getCiphertext",
      "getRevealedKey",
      "getEncKeyHandle",
      "getFunderStake",
      "switchKey",
      "minBounty",
      "oraclePrice",
      "admin",
      "pendingAdmin",
      "minBountyUsd",
      "MAX_PAYLOAD_SIZE",
      "CIPHERTEXT_OVERHEAD",
    ]) {
      expect(fns.has(f), f).toBe(true);
    }
  });

  it("State enum order matches the contract (NONE, ALIVE, DARK, DARK_MARKED, REVEALED, CANCELLED)", () => {
    expect(STATE_NAMES).toEqual(["NONE", "ALIVE", "DARK", "DARK_MARKED", "REVEALED", "CANCELLED"]);
  });
});

describe("error decoding", () => {
  it("decodes DeadManSwitch custom errors from raw revert data", () => {
    expect(decodeRevertData(encodeErrorResult({ abi: dmsAbi, errorName: "NotDark" }))?.errorName).toBe("NotDark");
    expect(decodeRevertData(encodeErrorResult({ abi: dmsAbi, errorName: "InvalidKMSSignatures" }))?.errorName).toBe("InvalidKMSSignatures");
  });

  it("decodes fhEVM host errors bubbling up through the contract", () => {
    const data = encodeErrorResult({ abi: hostErrorsAbi, errorName: "KMSInvalidSigner", args: ["0x0000000000000000000000000000000000000001"] });
    const d = decodeRevertData(data);
    expect(d?.errorName).toBe("KMSInvalidSigner");
  });

  it("returns undefined for unknown selectors", () => {
    expect(decodeRevertData("0xdeadbeef")).toBeUndefined();
  });

  it("describeError explains a ContractFunctionRevertedError with a hint", () => {
    const data = encodeErrorResult({ abi: dmsAbi, errorName: "NotDarkMarked" });
    const err = new ContractFunctionRevertedError({ abi: dmsAbi, data, functionName: "revealKey" });
    const wrapped = new BaseError("call failed", { cause: err });
    expect(describeError(wrapped)).toBe("reverted: NotDarkMarked — call `mark-dark` first; the key is not publicly decryptable until then");
    expect(revertErrorName(wrapped)).toBe("NotDarkMarked");
  });

  it("describeError falls back to the host ABI when the contract ABI cannot decode", () => {
    const data = encodeErrorResult({ abi: hostErrorsAbi, errorName: "EnforcedPause" });
    const err = new ContractFunctionRevertedError({ abi: dmsAbi, data, functionName: "markDark" });
    expect(describeError(new BaseError("x", { cause: err }))).toMatch(/^reverted: EnforcedPause — Zama's fhEVM host is paused/);
  });
});

describe("mined-but-reverted transactions", () => {
  const DMS = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
  const FROM = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
  const hash = `0x${"ab".repeat(32)}` as const;
  const receipt = { status: "reverted", transactionHash: hash, blockNumber: 42n, gasUsed: 31_000n, logs: [] };

  const dmsWith = (call: (args: Record<string, unknown>) => Promise<unknown>) => {
    const calls: Record<string, unknown>[] = [];
    const publicClient = {
      getTransactionReceipt: async () => receipt,
      getTransaction: async () => ({ from: FROM, to: DMS, input: "0x1234", value: 0n }),
      call: async (a: Record<string, unknown>) => {
        calls.push(a);
        return call(a);
      },
    };
    return { dms: new Dms({ chain: {} as never, publicClient: publicClient as never }, DMS), calls };
  };

  it("are explained by replaying the call at the receipt's block: a typed error with hash, error name and gas", async () => {
    const data = encodeErrorResult({ abi: dmsAbi, errorName: "AlreadyRevealed" });
    const { dms, calls } = dmsWith(async () => {
      throw new RawContractError({ data });
    });
    const err = await dms.txOutcome("revealKey", hash).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TxRevertedError);
    expect(err).toMatchObject({ hash, errorName: "AlreadyRevealed", gasUsed: 31_000n, blockNumber: 42n, functionName: "revealKey" });
    expect(calls).toEqual([{ account: FROM, to: DMS, data: "0x1234", value: 0n, blockNumber: 42n }]);
    expect(revertErrorName(err)).toBe("AlreadyRevealed");
    expect(describeError(err)).toMatch(/revealKey transaction 0xabab.* reverted on-chain in block 42 \(gas used 31000\): AlreadyRevealed — the key was already revealed/);
  });

  it("still fail clearly when the replay does not reproduce the revert (e.g. out of gas)", async () => {
    const { dms } = dmsWith(async () => ({ data: "0x" }));
    const err = (await dms.txOutcome("markDark", hash).catch((e: unknown) => e)) as TxRevertedError;
    expect(err).toBeInstanceOf(TxRevertedError);
    expect(err.errorName).toBeUndefined();
    expect(err.message).toMatch(/could not be reproduced/);
  });
});
