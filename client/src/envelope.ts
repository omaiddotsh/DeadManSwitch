// Ciphertext format v1 — the only thing the contract stores about the secret
// besides the FHE-encrypted data key (DEK).
//
//   ciphertext = 0x01 ‖ nonce(12) ‖ AES-256-GCM(dek, nonce, salt(32) ‖ plaintext)
//                                   └ GCM output = body ‖ tag(16), no AAD
//   commitment = keccak256(salt ‖ plaintext)          (== keccak256(abi.encodePacked(salt, payload)))
//
// Sizes mirror the contract: plaintext ≤ MAX_PAYLOAD_SIZE (2048) bytes and
// ciphertext = plaintext + CIPHERTEXT_OVERHEAD (61) bytes. The reference vector
// lives in docs/ciphertext-test-vector.json and is checked byte-for-byte by
// test/envelope.test.ts.

import { webcrypto } from "node:crypto";
import { bytesToHex, concat, keccak256, type Hex } from "viem";

export const ENVELOPE_VERSION = 0x01;
export const VERSION_BYTES = 1;
export const NONCE_BYTES = 12;
export const SALT_BYTES = 32;
export const TAG_BYTES = 16;
export const DEK_BYTES = 32;

/** Mirrors DeadManSwitch.MAX_PAYLOAD_SIZE. */
export const MAX_PAYLOAD_SIZE = 2048;
/** Mirrors DeadManSwitch.CIPHERTEXT_OVERHEAD: version + nonce + salt + tag. */
export const CIPHERTEXT_OVERHEAD = VERSION_BYTES + NONCE_BYTES + SALT_BYTES + TAG_BYTES; // 61
/** Mirrors DeadManSwitch.MAX_CIPHERTEXT_SIZE. */
export const MAX_CIPHERTEXT_SIZE = MAX_PAYLOAD_SIZE + CIPHERTEXT_OVERHEAD; // 2109

/**
 * Shown whenever a DEK that the KMS proof vouched for (or that the contract
 * recorded as revealed) fails to open the on-chain ciphertext.
 */
export const KEY_MISMATCH_WARNING =
  "key accepted by the KMS proof but does not open the ciphertext — the owner uploaded an invalid ciphertext, " +
  "or Zama's KMS signer set was compromised";

export type EnvelopeErrorCode =
  | "bad-key-length"
  | "bad-nonce-length"
  | "bad-salt-length"
  | "payload-too-large"
  | "ciphertext-too-short"
  | "ciphertext-too-large"
  | "bad-version"
  | "auth-failed";

export class EnvelopeError extends Error {
  constructor(public readonly code: EnvelopeErrorCode, message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

const subtle = webcrypto.subtle;
const random = (n: number): Uint8Array => webcrypto.getRandomValues(new Uint8Array(n));

const importKey = (dek: Uint8Array) => {
  if (dek.length !== DEK_BYTES) throw new EnvelopeError("bad-key-length", `DEK must be ${DEK_BYTES} bytes, got ${dek.length}`);
  return subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
};

/** keccak256(salt ‖ plaintext) — the on-chain plaintextCommitment. */
export const commitmentOf = (salt: Uint8Array, plaintext: Uint8Array): Hex => {
  if (salt.length !== SALT_BYTES) throw new EnvelopeError("bad-salt-length", `salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
  return keccak256(concat([salt, plaintext]));
};

export const verifyCommitment = (salt: Uint8Array, plaintext: Uint8Array, commitment: Hex): boolean =>
  commitmentOf(salt, plaintext).toLowerCase() === commitment.toLowerCase();

/** Ciphertext length for a plaintext of `plaintextLength` bytes. */
export const ciphertextLengthFor = (plaintextLength: number): number => plaintextLength + CIPHERTEXT_OVERHEAD;

export const assertPayloadSize = (plaintext: Uint8Array): void => {
  if (plaintext.length > MAX_PAYLOAD_SIZE) {
    throw new EnvelopeError(
      "payload-too-large",
      `plaintext is ${plaintext.length} bytes; the contract accepts at most ${MAX_PAYLOAD_SIZE}`,
    );
  }
};

export interface SealOptions {
  /** Fixed DEK (tests only). Default: 32 fresh random bytes. */
  dek?: Uint8Array;
  /** Fixed salt (tests only). Default: 32 fresh random bytes. */
  salt?: Uint8Array;
  /** Fixed nonce (tests only). Default: 12 fresh random bytes. NEVER reuse a nonce under one DEK. */
  nonce?: Uint8Array;
}

export interface Sealed {
  /** v1 ciphertext, ready for createSwitch. */
  ciphertext: Uint8Array;
  /** keccak256(salt ‖ plaintext). */
  commitment: Hex;
  /** The data key. Secret: FHE-encrypt it, then drop it. */
  dek: Uint8Array;
  salt: Uint8Array;
  nonce: Uint8Array;
}

/** Encrypt `plaintext` into a v1 ciphertext under a (fresh) DEK. */
export const seal = async (plaintext: Uint8Array, opts: SealOptions = {}): Promise<Sealed> => {
  assertPayloadSize(plaintext);
  const dek = opts.dek ?? random(DEK_BYTES);
  const salt = opts.salt ?? random(SALT_BYTES);
  const nonce = opts.nonce ?? random(NONCE_BYTES);
  if (salt.length !== SALT_BYTES) throw new EnvelopeError("bad-salt-length", `salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
  if (nonce.length !== NONCE_BYTES) throw new EnvelopeError("bad-nonce-length", `nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);

  const key = await importKey(dek);
  const inner = concat([salt, plaintext]);
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: TAG_BYTES * 8 }, key, inner));
  const ciphertext = concat([new Uint8Array([ENVELOPE_VERSION]), nonce, sealed]);
  return { ciphertext, commitment: commitmentOf(salt, plaintext), dek, salt, nonce };
};

export interface ParsedCiphertext {
  version: number;
  nonce: Uint8Array;
  /** GCM output: encrypted (salt ‖ plaintext) followed by the 16-byte tag. */
  sealed: Uint8Array;
  /** Plaintext length implied by the ciphertext length. */
  plaintextLength: number;
}

/** Structural checks only (no key needed). */
export const parseCiphertext = (ciphertext: Uint8Array): ParsedCiphertext => {
  if (ciphertext.length < CIPHERTEXT_OVERHEAD) {
    throw new EnvelopeError(
      "ciphertext-too-short",
      `ciphertext is ${ciphertext.length} bytes; a v1 ciphertext is at least ${CIPHERTEXT_OVERHEAD}`,
    );
  }
  if (ciphertext.length > MAX_CIPHERTEXT_SIZE) {
    throw new EnvelopeError(
      "ciphertext-too-large",
      `ciphertext is ${ciphertext.length} bytes; a v1 ciphertext is at most ${MAX_CIPHERTEXT_SIZE}`,
    );
  }
  const version = ciphertext[0];
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError("bad-version", `unsupported ciphertext version 0x${version.toString(16).padStart(2, "0")} (expected 0x01)`);
  }
  return {
    version,
    nonce: ciphertext.slice(VERSION_BYTES, VERSION_BYTES + NONCE_BYTES),
    sealed: ciphertext.slice(VERSION_BYTES + NONCE_BYTES),
    plaintextLength: ciphertext.length - CIPHERTEXT_OVERHEAD,
  };
};

export interface Opened {
  salt: Uint8Array;
  plaintext: Uint8Array;
  commitment: Hex;
}

/** Decrypt a v1 ciphertext. Throws EnvelopeError("auth-failed") when the GCM tag does not verify. */
export const open = async (ciphertext: Uint8Array, dek: Uint8Array): Promise<Opened> => {
  const { nonce, sealed } = parseCiphertext(ciphertext);
  const key = await importKey(dek);
  let inner: Uint8Array;
  try {
    inner = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: TAG_BYTES * 8 }, key, sealed));
  } catch {
    throw new EnvelopeError("auth-failed", "AES-GCM authentication failed: wrong key or tampered ciphertext");
  }
  const salt = inner.slice(0, SALT_BYTES);
  const plaintext = inner.slice(SALT_BYTES);
  return { salt, plaintext, commitment: commitmentOf(salt, plaintext) };
};

export type KeyCheck =
  | { ok: true; opened: Opened; commitmentMatches: boolean | undefined }
  | { ok: false; reason: string; code: EnvelopeErrorCode | "unknown" };

/**
 * Check that `dek` opens `ciphertext` (GCM tag verifies) and, when a
 * commitment is given, that the decrypted (salt, plaintext) matches it.
 * Never throws for a bad key; callers decide how loudly to warn
 * (see KEY_MISMATCH_WARNING).
 */
export const verifyKeyOpensCiphertext = async (
  ciphertext: Uint8Array,
  dek: Uint8Array,
  commitment?: Hex,
): Promise<KeyCheck> => {
  try {
    const opened = await open(ciphertext, dek);
    const commitmentMatches = commitment === undefined ? undefined : opened.commitment.toLowerCase() === commitment.toLowerCase();
    return { ok: true, opened, commitmentMatches };
  } catch (err) {
    if (err instanceof EnvelopeError) return { ok: false, reason: err.message, code: err.code };
    return { ok: false, reason: (err as Error).message, code: "unknown" };
  }
};

/** bytes32 hex (as returned by getRevealedKey / the KMS) → 32 key bytes. */
export const dekFromBytes32 = (hex: Hex): Uint8Array => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new EnvelopeError("bad-key-length", `expected a 32-byte hex key, got ${hex.length} chars`);
  return Uint8Array.from(Buffer.from(clean, "hex"));
};

/** 32 key bytes → the uint256 the FHE input encrypts (big-endian). */
export const dekToBigInt = (dek: Uint8Array): bigint => {
  if (dek.length !== DEK_BYTES) throw new EnvelopeError("bad-key-length", `DEK must be ${DEK_BYTES} bytes, got ${dek.length}`);
  return BigInt(bytesToHex(dek));
};

/** Best-effort wipe of key material held in a Uint8Array. */
export const wipe = (buf: Uint8Array | undefined): void => {
  if (buf) buf.fill(0);
};
