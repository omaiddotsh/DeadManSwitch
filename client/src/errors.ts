// Human-readable errors. Custom errors from DeadManSwitch are decoded by viem
// from dmsAbi; reverts that bubble up from Zama's host contracts (ACL,
// KMSVerifier, InputVerifier) are decoded with hostErrorsAbi.

import { BaseError, ContractFunctionRevertedError, decodeErrorResult, parseAbi, type Hex } from "viem";
import { dmsAbi } from "./abi.js";
import { ConfigError } from "./config.js";
import { EnvelopeError } from "./envelope.js";
import { sanitizeForTerminal } from "./sanitize.js";

/** Errors that the fhEVM host contracts can revert with during our calls. */
export const hostErrorsAbi = parseAbi([
  "error ACLNotAllowed(bytes32 handle, address account)",
  "error SenderNotAllowed(address sender)",
  "error SenderDenied(address sender)",
  "error EnforcedPause()",
  "error KMSInvalidSigner(address invalidSigner)",
  "error KMSSignatureThresholdNotReached(uint256 numSignatures)",
  "error KMSZeroSignature()",
  "error InvalidKMSContext(uint256 kmsContextId)",
  "error EmptyDecryptionProof()",
  "error DeserializingDecryptionProofFail()",
  "error DeserializingExtraDataFail()",
  "error UnsupportedExtraDataVersion(uint8 version)",
  "error DeserializingInputProofFail()",
  "error InvalidInputHandle()",
  "error InvalidType()",
  "error InvalidChainId()",
  "error InvalidHandleVersion()",
  "error InvalidSigner(address signerRecovered)",
  "error SignatureThresholdNotReached(uint256 numSignatures)",
  "error SignaturesVerificationFailed()",
  "error ZeroSignature()",
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256 length)",
  "error ECDSAInvalidSignatureS(bytes32 s)",
  "error HCUTransactionLimitExceeded()",
  "error HCUTransactionDepthLimitExceeded()",
  "error HCUBlockLimitExceeded()",
]);

/** dmsAbi plus the host errors, for simulate/estimate calls so reverts decode either way. */
export const dmsAbiWithHostErrors = [...dmsAbi, ...hostErrorsAbi] as const;

export const ERROR_HINTS: Record<string, string> = {
  InvalidSwitchId: "switch id must be a non-zero integer",
  AlreadyExists:
    "you already have a switch with this id (an earlier create that timed out may have been mined since): check it with `dms info`, and ping or cancel it rather than creating another switch for the same secret",
  DoesNotExist: "no switch exists for this owner and id",
  InvalidInterval: "ping interval must be between 60 seconds and 365 days",
  CiphertextTooSmall: "ciphertext is shorter than the 61-byte v1 overhead",
  CiphertextTooLarge: "plaintext exceeds the 2048-byte limit",
  PayloadTooLarge: "plaintext exceeds the 2048-byte limit",
  EmptyCommitment: "plaintext commitment must not be zero",
  EmptyInputProof: "the FHE input proof is empty",
  KeyHandleReused: "this encrypted key is already bound to another switch; encrypt a fresh key",
  BountyTooLow: "bounty is below the contract's minimum (see `dms status`)",
  ZeroValue: "amount must be greater than zero",
  Unauthorized: "caller is not allowed to do this",
  NotActive: "switch is not active (cancelled or already revealed)",
  Expired: "the owner's deadline has passed; the switch can no longer be pinged, funded or cancelled",
  NotDark: "the owner's deadline has not passed yet",
  AlreadyDarkMarked: "markDark was already called for this switch; go straight to `reveal`",
  NotDarkMarked: "call `mark-dark` first; the key is not publicly decryptable until then",
  AlreadyRevealed: "the key was already revealed (someone else may have been faster)",
  NotRevealed: "the key has not been revealed yet",
  AlreadyPublished: "the plaintext was already published",
  CommitmentMismatch: "the (salt, plaintext) do not match the creation-time commitment",
  NotRescuable: "rescue opens only 30 days after the switch went dark without a reveal",
  NothingToReclaim: "you have nothing to reclaim on this switch",
  TransferFailed: "the ETH transfer to the recipient failed",
  Reentrancy: "reentrant call rejected",
  InvalidKMSSignatures: "the KMS decryption proof does not verify for this switch's key handle",
  SenderNotAllowedToUseHandle: "the encrypted input is not bound to this sender/contract",
  ZamaProtocolUnsupported: "this chain has no Zama fhEVM host",
  ACLNotAllowed: "the fhEVM ACL rejected the handle (input not bound to this sender/contract?)",
  SenderNotAllowed: "Zama's ACL does not let this contract use the encrypted handle",
  SenderDenied: "Zama's ACL has deny-listed this contract or sender",
  EnforcedPause: "Zama's fhEVM host is paused; retry later (depositors can rescue after 30 days)",
  KMSInvalidSigner: "the decryption proof is signed by a key that is not in the KMS signer set",
  KMSSignatureThresholdNotReached: "the decryption proof has too few KMS signatures",
  KMSZeroSignature: "the decryption proof has no signatures",
  EmptyDecryptionProof: "the decryption proof is empty",
  DeserializingDecryptionProofFail: "the decryption proof is malformed",
  InvalidInputHandle: "the encrypted input handle is not in the input proof",
  InvalidType: "the encrypted key is not a euint256 (relayer SDK and host version mismatch?)",
  SignaturesVerificationFailed: "the input proof signatures do not verify",
  ECDSAInvalidSignature: "a signature in the proof is malformed",
  ECDSAInvalidSignatureLength: "a signature in the proof has the wrong length",
  ECDSAInvalidSignatureS: "a signature in the proof is malleable/invalid",
};

const allErrorsAbi = dmsAbiWithHostErrors;

/** Decode raw revert data against our ABI and the host error ABI. */
export const decodeRevertData = (data: Hex): { errorName: string; args: readonly unknown[] } | undefined => {
  try {
    const r = decodeErrorResult({ abi: allErrorsAbi, data });
    return { errorName: r.errorName, args: (r.args ?? []) as readonly unknown[] };
  } catch {
    return undefined;
  }
};

const fmtArgs = (args: readonly unknown[] | undefined): string =>
  args && args.length ? `(${args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ")})` : "";

/** Raw revert data (selector + args) carried anywhere inside a viem error, if any. */
export const rawRevertData = (err: unknown): Hex | undefined => {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  const raw = reverted?.raw ?? (err.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data;
  return raw && raw.length >= 10 ? raw : undefined;
};

/** The custom error name inside a viem error (or a TxRevertedError), if any. */
export const revertErrorName = (err: unknown): string | undefined => {
  if (err instanceof TxRevertedError) return err.errorName;
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (reverted?.data?.errorName) return reverted.data.errorName;
  const raw = rawRevertData(err);
  return raw ? decodeRevertData(raw)?.errorName : undefined;
};

/**
 * One-line, actionable description of any error thrown by the client. Terminal-safe: the text can come
 * from an RPC node or the relayer, and the CLI prints it.
 */
export const describeError = (err: unknown): string => sanitizeForTerminal(describeRaw(err));

const describeRaw = (err: unknown): string => {
  if (err instanceof ConfigError) return `config: ${err.message}`;
  if (err instanceof EnvelopeError) return err.message;
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted) {
      let name = reverted.data?.errorName;
      let args = reverted.data?.args as readonly unknown[] | undefined;
      if (!name && reverted.raw) {
        const d = decodeRevertData(reverted.raw);
        name = d?.errorName;
        args = d?.args;
      }
      if (name) {
        const hint = ERROR_HINTS[name];
        return `reverted: ${name}${fmtArgs(args)}${hint ? ` — ${hint}` : ""}`;
      }
      if (reverted.reason) return `reverted: ${reverted.reason}`;
      if (reverted.signature) return `reverted with unknown error ${reverted.signature}`;
    }
    return err.shortMessage || err.message;
  }
  if (err instanceof UserFacingError || err instanceof UsageError || (err instanceof Error && err.name === "FhevmError")) return err.message;
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    return `${name}${err.message}`;
  }
  return String(err);
};

/** Thrown by the CLI for bad user input (prints usage-style help, exit code 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Thrown for a precondition the chain state does not meet (exit code 1, no stack). */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/**
 * A transaction was mined but reverted. The custom error is decoded by
 * replaying the same call (from, to, data, value) with eth_call against the
 * state of the block that included it — which is the state that made it fail,
 * e.g. a competitor's markDark / revealKey earlier in the same block.
 */
export class TxRevertedError extends UserFacingError {
  constructor(
    readonly functionName: string,
    readonly hash: Hex,
    readonly blockNumber: bigint,
    readonly gasUsed: bigint,
    /** Decoded custom error, when the replay reproduced the revert. */
    readonly errorName?: string,
    readonly errorArgs?: readonly unknown[],
    /** How the replay went when it could not use the block's own state (e.g. the node pruned it). */
    readonly replayNote?: string,
  ) {
    const hint = errorName ? ERROR_HINTS[errorName] : undefined;
    super(
      `${functionName} transaction ${hash} reverted on-chain in block ${blockNumber} (gas used ${gasUsed}): ` +
        (errorName
          ? `${errorName}${fmtArgs(errorArgs)}${hint ? ` — ${hint}` : ""}${replayNote ? ` (${replayNote})` : ""}`
          : `the revert reason could not be reproduced (${replayNote ?? "out of gas, or state changed again since"})`),
    );
    this.name = "TxRevertedError";
  }
}

/**
 * Another transaction from the same key took a sent transaction's nonce (it was cancelled or replaced, e.g.
 * in a wallet sharing the key), so the call never ran. A repriced copy of the same call is not this error.
 */
export class TxReplacedError extends UserFacingError {
  constructor(
    readonly functionName: string,
    readonly hash: Hex,
    readonly replacement: Hex,
    readonly reason: "cancelled" | "replaced",
  ) {
    super(`${functionName} transaction ${hash} was ${reason} by ${replacement} (same nonce, same key), so the call did not run`);
    this.name = "TxReplacedError";
  }
}

/** A sent transaction was not mined within the receipt timeout. It may still be mined later. */
export class TxTimeoutError extends UserFacingError {
  constructor(
    readonly functionName: string,
    readonly hash: Hex,
    readonly timeoutMs: number,
    readonly nonce?: number,
  ) {
    super(
      `${functionName} transaction ${hash}${nonce !== undefined ? ` (nonce ${nonce})` : ""} was not mined within ${Math.round(timeoutMs / 1000)}s ` +
        "(still pending; fees too low?)",
    );
    this.name = "TxTimeoutError";
  }
}

/**
 * The irreversible part of a command succeeded (`reveal`: revealKey mined, bounty paid), but a follow-up it
 * was asked for (writing --out, --publish) did not. Exit code 3, so a script can tell it from "nothing happened".
 */
export class PartialSuccessError extends UserFacingError {
  constructor(
    message: string,
    /** What the command returns on success, as far as it got. */
    readonly result?: unknown,
  ) {
    super(message);
    this.name = "PartialSuccessError";
  }
}

/** The CLI's exit code for an error: 2 usage, 3 partial success (see PartialSuccessError), 1 anything else. */
export const exitCodeOf = (err: unknown): number => (err instanceof UsageError ? 2 : err instanceof PartialSuccessError ? 3 : 1);
