// Reverts from Zama's host contracts (ACL, InputVerifier, KMSVerifier) bubble
// up through DeadManSwitch: they must decode to a message, and a refusal at
// the wallet's gas estimate must not read as "may have been sent". A wallet
// error that carries no revert data stays ambiguous (it may have broadcast).
// Errors are built with viem's own getContractError, as writeContract does.

import { describe, expect, it } from "vitest";
import {
  BaseError, InsufficientFundsError, InternalRpcError, RawContractError, RpcRequestError, TransactionExecutionError,
  encodeErrorResult, getContractError, parseAbi, type Abi, type Hex,
} from "viem";
import { dmsAbi } from "./abi";
import { mayHaveBroadcast } from "./createAttempt";
import { DMS_ERROR_MESSAGES, dmsWriteAbi, errMsg, hostErrorsAbi, revertName } from "./errors";

const CONTRACT = "0x00000000000000000000000000000000000d3ad5";
const SENDER = "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0";

/** What writeContract throws when the wallet's eth_estimateGas / eth_sendTransaction fails with `cause`. */
const writeError = (cause: Error, functionName = "createSwitch", abi: Abi = dmsAbi) =>
  getContractError(cause as BaseError, { abi, functionName, args: [], address: CONTRACT });

const hostRevert = (errorName: string, args?: readonly unknown[]): Hex =>
  encodeErrorResult({ abi: hostErrorsAbi, errorName, args } as never);

/** MetaMask's shape for a failed estimate: -32603 wrapping {code: 3, data: <revert>}. */
const metamaskEstimateRevert = (data: Hex) => new InternalRpcError(new RpcRequestError({
  body: {}, url: "wallet", error: { code: -32603, message: "Internal JSON-RPC error.", data: { code: 3, message: "execution reverted", data } },
}));

const HOST_CASES: [string, readonly unknown[] | undefined, RegExp][] = [
  ["EnforcedPause", undefined, /paused/i],
  ["SenderDenied", [SENDER], /deny-listed/i],
  ["InvalidSigner", [SENDER], /input proof/i],
  ["InvalidType", undefined, /input/i],
  ["SenderNotAllowed", [SENDER], /input/i],
  ["KMSInvalidSigner", [SENDER], /KMS/],
  ["KMSSignatureThresholdNotReached", [1n], /KMS/],
  ["InvalidKMSContext", [3n], /KMS/],
];

describe("Zama host-contract reverts decode to a message", () => {
  it.each(HOST_CASES)("%s, seen at the wallet's estimate (raw data, unknown to dmsAbi)", (name, args, message) => {
    for (const cause of [new RawContractError({ data: hostRevert(name, args) }), metamaskEstimateRevert(hostRevert(name, args))]) {
      const e = writeError(cause);
      expect(revertName(e)).toBe(name);
      expect(errMsg(e)).toMatch(message);
      expect(errMsg(e)).not.toMatch(/signature:/);
      // Refused at the estimate: nothing was signed, so a create is not left "may have been sent".
      expect(mayHaveBroadcast(e)).toBe(false);
    }
  });

  it("the ABI the app writes with decodes them directly", () => {
    const e = writeError(new RawContractError({ data: hostRevert("SenderDenied", [SENDER]) }), "markDark", dmsWriteAbi);
    expect(revertName(e)).toBe("SenderDenied");
  });

  it("every message has an error in that ABI, and every error in it has a message", () => {
    const names = new Set(dmsWriteAbi.filter((x) => x.type === "error").map((x) => (x as { name: string }).name));
    expect(Object.keys(DMS_ERROR_MESSAGES).filter((k) => !names.has(k))).toEqual([]);
    expect([...names].filter((n) => !DMS_ERROR_MESSAGES[n])).toEqual([]);
    // The DeadManSwitch errors are all in it.
    for (const x of dmsAbi) if (x.type === "error") expect(names.has(x.name)).toBe(true);
  });

  it("an unknown selector is still refused before signing, and named as such", () => {
    const unknown = encodeErrorResult({ abi: parseAbi(["error Mystery(uint256)"]), errorName: "Mystery", args: [1n] });
    const e = writeError(new RawContractError({ data: unknown }));
    expect(mayHaveBroadcast(e)).toBe(false);
    expect(errMsg(e)).toMatch(/would revert/i);
  });
});

describe("refused before signing vs. may have been sent", () => {
  it("an estimate that reverted without data ('execution reverted', code 3) was refused", () => {
    expect(mayHaveBroadcast(writeError(new RawContractError({ data: "0x", message: "execution reverted" }), "markDark"))).toBe(false);
  });

  it("insufficient funds for the value + gas: refused", () => {
    const e = writeError(new TransactionExecutionError(new InsufficientFundsError({ cause: new BaseError("insufficient funds for gas * price + value") }), {} as never), "fundBounty");
    expect(mayHaveBroadcast(e)).toBe(false);
  });

  it("a wallet error with no revert data (WalletConnect expired after the phone approved, an RPC failing after broadcast) stays ambiguous", () => {
    // The wallet's own error object carries code -32603 (viem then words it "reverted with the following reason"),
    // or viem's InternalRpcError wraps an error without one.
    const walletError = Object.assign(new Error("test wallet: the transaction was broadcast, then the response was lost."), { code: -32603 });
    for (const cause of [new InternalRpcError(walletError), new InternalRpcError(new Error("response lost"))]) {
      const lost = writeError(cause, "fundBounty");
      expect(mayHaveBroadcast(lost)).toBe(true);
      expect(errMsg(lost)).not.toMatch(/revert/i);
      expect(errMsg(lost)).toMatch(/may (still )?have been sent/i);
      expect(errMsg(lost)).toMatch(/wallet/i);
    }
  });
});
