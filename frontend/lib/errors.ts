// Human-readable errors for contract reverts, wallet rejections, SDK failures.
// viem decodes DeadManSwitch custom errors (they are in dmsAbi) into
// ContractFunctionRevertedError with `data.errorName`; reverts that bubble up
// from Zama's host contracts (ACL, InputVerifier, KMSVerifier) decode with
// hostErrorsAbi. Writes use dmsWriteAbi (both), and revertName also decodes
// raw revert data a wallet returned against it.

import {
  BaseError, ContractFunctionRevertedError, InternalRpcError, UserRejectedRequestError, decodeErrorResult, parseAbi, type Hex,
} from "viem";
import { dmsAbi } from "./abi";

/**
 * Errors the fhEVM host contracts can revert with during our calls (the
 * client's list, client/src/errors.ts, plus the InputVerifier's InvalidType and
 * the ACL's SenderNotAllowed).
 */
export const hostErrorsAbi = parseAbi([
  "error ACLNotAllowed(bytes32 handle, address account)",
  "error SenderDenied(address sender)",
  "error SenderNotAllowed(address sender)",
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

/** dmsAbi plus the host errors: what every write (and estimate) uses, so a host revert decodes either way. */
export const dmsWriteAbi = [...dmsAbi, ...hostErrorsAbi] as const;

const HOST_DOWN = "Nothing was sent. Existing switches are not lost: depositors can rescue their ETH 30 days after a switch goes dark without a reveal.";

/** Every custom error in DeadManSwitch.sol and the host errors → what it means for the user. */
export const DMS_ERROR_MESSAGES: Record<string, string> = {
  InvalidSwitchId: "Switch id must be non-zero.",
  AlreadyExists: "You already have a switch with this id.",
  DoesNotExist: "No switch exists for this owner and id.",
  InvalidInterval: "Ping interval must be between 1 minute and 365 days.",
  CiphertextTooSmall: "The encrypted secret is malformed (too short).",
  CiphertextTooLarge: "The secret is too large (max 2,048 bytes).",
  PayloadTooLarge: "The plaintext is too large (max 2,048 bytes).",
  EmptyCommitment: "Missing plaintext commitment.",
  EmptyInputProof: "Missing FHE input proof.",
  KeyHandleReused: "This encrypted key is already bound to another switch. Encrypt a fresh key.",
  BountyTooLow: "Bounty is below the current minimum.",
  ZeroValue: "Amount must be greater than zero.",
  Unauthorized: "Your account is not allowed to do this.",
  NotActive: "The switch is no longer active (cancelled or revealed).",
  Expired: "The deadline has passed: the switch is dark and can no longer be pinged, funded or cancelled.",
  NotDark: "The switch is not dark yet: the owner is still within the ping interval.",
  AlreadyDarkMarked: "Key release was already requested for this switch.",
  NotDarkMarked: "Request key release (markDark) before revealing.",
  AlreadyRevealed: "The key has already been revealed.",
  NotRevealed: "The key has not been revealed yet.",
  AlreadyPublished: "The plaintext has already been published.",
  CommitmentMismatch: "The plaintext does not match the owner's commitment.",
  NotRescuable: "Rescue opens 30 days after the switch went dark without a reveal.",
  NothingToReclaim: "You have nothing to reclaim on this switch.",
  TransferFailed: "The ETH transfer failed.",
  InvalidConfig: "Invalid configuration (no price feed for a non-zero minimum).",
  MinBountyUsdTooHigh: "Minimum bounty cannot exceed $10,000.",
  Reentrancy: "Reentrant call rejected.",
  InvalidKMSSignatures: "The KMS decryption proof did not verify for this switch's key.",
  SenderNotAllowedToUseHandle: "The encrypted key is not bound to your account and this contract. Encrypt it again.",
  ZamaProtocolUnsupported: "Zama's fhEVM is not available on this chain.",
  // fhEVM host errors surfaced through the contract
  EnforcedPause: `Zama's fhEVM host is paused, so switches cannot be created or marked dark until it is lifted. ${HOST_DOWN}`,
  SenderDenied: `Zama's fhEVM access list has deny-listed this contract or your account. ${HOST_DOWN}`,
  SenderNotAllowed: "Zama's fhEVM access list refused the encrypted input for this account. Encrypt the key again.",
  ACLNotAllowed: "Zama's fhEVM access list refused the encrypted key (not bound to this account and contract?).",
  InvalidSigner: "Zama's network rejected the encrypted key's input proof (its signers changed). Encrypt the key again.",
  SignatureThresholdNotReached: "The encrypted key's input proof has too few signatures. Encrypt the key again.",
  SignaturesVerificationFailed: "The encrypted key's input proof signatures do not verify. Encrypt the key again.",
  ZeroSignature: "The encrypted key's input proof has no signatures. Encrypt the key again.",
  DeserializingInputProofFail: "The encrypted key's input proof is malformed. Encrypt the key again.",
  InvalidInputHandle: "The encrypted key is not in its input proof. Encrypt the key again.",
  InvalidType: "The encrypted input is not a 256-bit value. Encrypt the key again.",
  InvalidChainId: "The encrypted input was made for another chain. Encrypt the key again on this network.",
  InvalidHandleVersion: "The encrypted input has an unsupported version. Encrypt the key again.",
  KMSInvalidSigner: "The KMS decryption proof is signed by a key outside the KMS signer set. Fetch the key again.",
  KMSSignatureThresholdNotReached: "The KMS decryption proof has too few signatures. Fetch the key again.",
  KMSZeroSignature: "The KMS decryption proof has no signatures. Fetch the key again.",
  InvalidKMSContext: "The KMS decryption proof names a KMS signer set the host does not accept. Fetch the key again.",
  EmptyDecryptionProof: "The KMS decryption proof is empty. Fetch the key again.",
  DeserializingDecryptionProofFail: "The KMS decryption proof is malformed. Fetch the key again.",
  DeserializingExtraDataFail: "The KMS decryption proof's extra data is malformed. Fetch the key again.",
  UnsupportedExtraDataVersion: "The KMS decryption proof has an unsupported format. Fetch the key again.",
  ECDSAInvalidSignature: "A signature in the proof is malformed.",
  ECDSAInvalidSignatureLength: "A signature in the proof has the wrong length.",
  ECDSAInvalidSignatureS: "A signature in the proof is invalid.",
  HCUTransactionLimitExceeded: "Zama's fhEVM refused the transaction: too much FHE work in one transaction.",
  HCUTransactionDepthLimitExceeded: "Zama's fhEVM refused the transaction: FHE operations nested too deep.",
  HCUBlockLimitExceeded: "Zama's fhEVM block limit for FHE work is used up. Try again in a later block.",
};

const revertedError = (e: unknown): ContractFunctionRevertedError | null => {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r : null;
};

/** The decoded custom error name of a revert, if any: from viem's decode, else the raw data against dmsWriteAbi. */
export const revertName = (e: unknown): string | undefined => {
  const r = revertedError(e);
  if (!r) return undefined;
  if (r.data?.errorName) return r.data.errorName;
  if (r.raw && r.raw.length >= 10) {
    try { return decodeErrorResult({ abi: dmsWriteAbi, data: r.raw }).errorName; } catch { /* unknown selector */ }
  }
  return undefined;
};

/**
 * The wallet refused at its gas estimate, or the app's own dry run
 * (simulateContract) reverted: a revert that carries revert data (decoded or
 * not), or an "execution reverted" with none. Nothing was signed. A
 * ContractFunctionRevertedError with neither is viem's wrapping of an
 * internal wallet error (-32603), which can come after the broadcast.
 */
export const revertedAtEstimate = (e: unknown): boolean => {
  const r = revertedError(e);
  return !!r && (r.raw !== undefined || r.signature !== undefined || /^execution reverted\b/i.test(r.reason ?? ""));
};

/**
 * An internal wallet error (-32603) with no revert data, which viem words as
 * "reverted with the following reason: …" when the wallet's error carries the
 * code: it can come after the broadcast (a WalletConnect request that expired
 * while the phone approved, a wallet RPC failing after sending). The reason, if any.
 */
const opaqueWalletError = (e: unknown): { reason?: string } | null => {
  if (!(e instanceof BaseError) || revertedAtEstimate(e)) return null;
  const r = revertedError(e);
  if (r) return r.data ? null : { reason: r.reason };
  return e.walk((x) => x instanceof InternalRpcError) ? {} : null;
};

/** Raw revert data (selector and arguments) anywhere inside a viem error, e.g. a replayed eth_call's. */
const rawRevertData = (e: unknown): Hex | undefined => {
  if (!(e instanceof BaseError)) return undefined;
  const r = revertedError(e);
  const raw = r?.raw ?? (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data;
  return raw && /^0x[0-9a-fA-F]{8,}$/.test(raw) ? raw : undefined;
};

/**
 * The DeadManSwitch or host error a failed call reverted with, decoded against dmsWriteAbi: viem's decode,
 * else revert data anywhere in the error (a geth-style -32000 "execution reverted" carries it outside the
 * contract error). undefined for anything that is not such a revert (an RPC failure, unknown data).
 */
export const revertErrorName = (e: unknown): string | undefined => {
  const name = revertName(e);
  if (name) return name;
  const raw = rawRevertData(e);
  if (!raw) return undefined;
  try { return decodeErrorResult({ abi: dmsWriteAbi, data: raw }).errorName; } catch { return undefined; }
};

/** What a failed call's revert means for the user (lib/hooks.ts replays a mined revert), if it decodes. */
export const revertReason = (e: unknown): string | undefined => {
  const name = revertErrorName(e);
  return name ? DMS_ERROR_MESSAGES[name] ?? name : undefined;
};

/** At most this many characters of a revert's own text are shown. */
export const REVERT_TEXT_MAX = 160;

/**
 * Text from a call's revert as one short plain line: control, format (bidi, zero-width, tag) and other
 * invisible characters (variation selectors, Hangul fillers, line and paragraph separators) become spaces,
 * runs of space one, at most REVERT_TEXT_MAX characters. It comes from whatever code the call reached, so it
 * is shown as data and must not reorder or hide anything around it.
 */
const plainLine = (s: string): string => {
  const t = s
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > REVERT_TEXT_MAX ? `${t.slice(0, REVERT_TEXT_MAX - 1)}\u2026` : t;
};

/**
 * The text of a plain Solidity revert in `e`: an Error(string)'s message, or a Panic's description (viem
 * decodes both, also from revert data outside a contract error), as a plain line. undefined for a custom
 * error, or no such revert.
 */
export const revertText = (e: unknown): string | undefined => {
  const r = revertedError(e);
  let text: string | undefined;
  if (r?.data?.errorName === "Error" || r?.data?.errorName === "Panic") text = r.reason;
  else {
    const raw = r?.raw ?? rawRevertData(e);
    if (raw) {
      try {
        const d = decodeErrorResult({ abi: dmsWriteAbi, data: raw });
        // viem adds Solidity's Error(string) and Panic(uint256) to the ABI it decodes against; its types do not.
        const name: string = d.errorName;
        const args: readonly unknown[] = d.args ?? [];
        const first = args[0];
        if (name === "Error" && typeof first === "string") text = first;
        if (name === "Panic" && typeof first === "bigint") text = `panic code 0x${first.toString(16)}`;
      } catch { /* not Error / Panic */ }
    }
  }
  const line = text === undefined ? "" : plainLine(text);
  return line || undefined;
};

/**
 * The app's dry run (lib/hooks.ts sendIfSimulated) showed the write would revert with `errorName`: refused
 * before the wallet, nothing sent. The message says why: the contract's own message for its errors, the
 * revert's text for a plain Error(string) or Panic.
 */
export class WouldRevertError extends Error {
  constructor(readonly errorName: string, cause: unknown) {
    const text = DMS_ERROR_MESSAGES[errorName] ? undefined : revertText(cause);
    super(
      DMS_ERROR_MESSAGES[errorName]
        ?? (text ? `The transaction would revert: "${text}". Nothing was sent.` : `The transaction would revert (${errorName}); nothing was sent.`),
      { cause },
    );
    this.name = "WouldRevertError";
  }
}

export const isUserRejection = (e: unknown): boolean =>
  e instanceof BaseError
    ? !!e.walk((x) => x instanceof UserRejectedRequestError || (x as { code?: number })?.code === 4001)
    : (e as { code?: number })?.code === 4001;

/**
 * Pre-flight refusals by wagmi / viem / the wallet, before anything is signed:
 * the pinned account is not the wallet's (switched during the FHE step), the
 * wallet is on another chain, the account is not authorised (EIP-1193 4100),
 * or it cannot pay the value plus gas.
 */
const PRE_BROADCAST_ERRORS = new Set([
  "ConnectorAccountNotFoundError", "ConnectorChainMismatchError", "ConnectorNotConnectedError", "ChainMismatchError",
  "InsufficientFundsError", "WouldRevertError",
]);

const refusedBeforeSigning = (e: unknown): boolean => {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    const x = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if ((typeof x.name === "string" && PRE_BROADCAST_ERRORS.has(x.name)) || x.code === 4100) return true;
    cur = x.cause;
  }
  return false;
};

/**
 * Whether a failed wallet request may still have broadcast the transaction.
 * A rejection, a revert at the wallet's gas estimate (revertedAtEstimate) or
 * a pre-flight refusal (refusedBeforeSigning) happens before broadcast.
 * Anything else (a dropped WalletConnect session, an internal wallet error, an
 * RPC error, a timeout) is ambiguous.
 */
export const mayHaveBroadcast = (e: unknown): boolean =>
  !isUserRejection(e) && !revertedAtEstimate(e) && !refusedBeforeSigning(e);

/** One line for a toast / inline error. */
export const errMsg = (e: unknown): string => {
  if (isUserRejection(e)) return "Request rejected in the wallet.";
  const name = revertName(e);
  if (name) {
    const text = DMS_ERROR_MESSAGES[name] ? undefined : revertText(e);
    return DMS_ERROR_MESSAGES[name] ?? (text ? `Transaction would revert: "${text}"` : `Transaction would revert: ${name}`);
  }
  const r = revertedError(e);
  if (r?.signature) return `Transaction would revert with an unknown error (${r.signature}); nothing was sent.`;
  const opaque = opaqueWalletError(e);
  if (opaque) {
    return `The wallet returned an error instead of a transaction hash${opaque.reason ? ` (${opaque.reason})` : ""}. `
      + "The transaction may still have been sent: check your wallet's activity before trying again.";
  }
  const err = e as { shortMessage?: string; message?: string };
  return err?.shortMessage ?? err?.message ?? String(e);
};
