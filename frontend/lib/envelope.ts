// Ciphertext format v1 (WebCrypto AES-256-GCM). Byte-exact with
// docs/ciphertext-test-vector.json and the contract's size accounting:
//
//   ciphertext = 0x01 ‖ nonce(12) ‖ AES-256-GCM(dek, nonce, salt(32) ‖ plaintext)
//                                   └─ GCM output: body ‖ tag(16), no AAD
//   commitment = keccak256(salt ‖ plaintext)   (= abi.encodePacked(bytes32, bytes))
//   |ciphertext| = |plaintext| + 61,  |plaintext| ≤ MAX_PAYLOAD_SIZE (2048)
//
// The salt sits INSIDE the encryption so that a short guessable secret cannot
// be confirmed against the public commitment before the switch goes dark, and
// so that whoever decrypts also learns the salt needed for publishPlaintext.
//
// Works in browsers and Node ≥ 20 (globalThis.crypto.subtle). No SDK imports.

import { keccak256 } from "viem";
import {
  CIPHERTEXT_OVERHEAD, DEK_BYTES, ENVELOPE_VERSION, MAX_CIPHERTEXT_SIZE, MAX_PAYLOAD_SIZE,
  NONCE_BYTES, SALT_BYTES, TAG_BYTES,
} from "./switch";

export type Hex = `0x${string}`;

export type EnvelopeErrorCode =
  | "EMPTY_PLAINTEXT"
  | "PLAINTEXT_TOO_LARGE"
  | "BAD_KEY_LENGTH"
  | "BAD_PARAM_LENGTH"
  | "CIPHERTEXT_TOO_SHORT"
  | "CIPHERTEXT_TOO_LARGE"
  | "UNSUPPORTED_VERSION"
  /** AES-GCM authentication failed: wrong key or tampered ciphertext. */
  | "TAG_MISMATCH";

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;
  constructor(code: EnvelopeErrorCode, message: string) {
    super(message);
    this.name = "EnvelopeError";
    this.code = code;
  }
}

/**
 * Shown/logged whenever a DEK that passed the on-chain KMS proof check (or
 * came from `getRevealedKey`) fails to open the stored ciphertext.
 */
export const INVALID_KEY_WARNING =
  "Key accepted by the KMS proof but does not open the ciphertext — the owner uploaded an invalid " +
  "ciphertext, or Zama's KMS signer set was compromised.";

// ---------- byte helpers ----------

export const bytesToHex = (b: Uint8Array): Hex => {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as Hex;
};

export const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const asBytes = (v: Uint8Array | string): Uint8Array => (typeof v === "string" ? hexToBytes(v) : v);

/** Fresh ArrayBuffer-backed copy: WebCrypto's BufferSource typing rejects SharedArrayBuffer views. */
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto unavailable: a secure context (https or localhost) is required");
  return s;
};

const randomBytes = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

const importDek = (dek: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> => {
  if (dek.length !== DEK_BYTES) {
    throw new EnvelopeError("BAD_KEY_LENGTH", `data key must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  return subtle().importKey("raw", buf(dek), { name: "AES-GCM" }, false, usage);
};

// ---------- commitment ----------

/** keccak256(salt ‖ plaintext) — byte-identical to keccak256(abi.encodePacked(bytes32 salt, bytes payload)). */
export const commitmentOf = (salt: Uint8Array, plaintext: Uint8Array): Hex => {
  if (salt.length !== SALT_BYTES) {
    throw new EnvelopeError("BAD_PARAM_LENGTH", `salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
  }
  return keccak256(concat(salt, plaintext));
};

export const verifyCommitment = (salt: Uint8Array, plaintext: Uint8Array, expected: string): boolean =>
  commitmentOf(salt, plaintext).toLowerCase() === expected.toLowerCase();

// ---------- seal ----------

export interface Sealed {
  /** The 32-byte AES key. Goes to the FHE SDK (encryptDek), never on-chain in clear while alive. */
  dek: Uint8Array;
  dekHex: Hex;
  salt: Uint8Array;
  nonce: Uint8Array;
  plaintext: Uint8Array;
  /** The full v1 blob for `createSwitch(…, ciphertext, …)`. */
  ciphertext: Uint8Array;
  ciphertextHex: Hex;
  /** For `CreateParams.plaintextCommitment`. */
  commitment: Hex;
}

export interface SealOptions {
  /** Deterministic inputs for tests / test vectors. Production callers omit these. */
  dek?: Uint8Array;
  salt?: Uint8Array;
  nonce?: Uint8Array;
}

/**
 * Encrypt `plaintext` under a fresh random DEK, salt and nonce.
 * Throws EnvelopeError on an empty or oversized plaintext.
 */
export const seal = async (plaintext: Uint8Array, opts: SealOptions = {}): Promise<Sealed> => {
  if (plaintext.length === 0) throw new EnvelopeError("EMPTY_PLAINTEXT", "nothing to seal: the secret is empty");
  if (plaintext.length > MAX_PAYLOAD_SIZE) {
    throw new EnvelopeError(
      "PLAINTEXT_TOO_LARGE",
      `secret is ${plaintext.length} bytes; the limit is ${MAX_PAYLOAD_SIZE} bytes (${plaintext.length - MAX_PAYLOAD_SIZE} over)`,
    );
  }
  const dek = opts.dek ?? randomBytes(DEK_BYTES);
  const salt = opts.salt ?? randomBytes(SALT_BYTES);
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES);
  if (salt.length !== SALT_BYTES) throw new EnvelopeError("BAD_PARAM_LENGTH", `salt must be ${SALT_BYTES} bytes`);
  if (nonce.length !== NONCE_BYTES) throw new EnvelopeError("BAD_PARAM_LENGTH", `nonce must be ${NONCE_BYTES} bytes`);

  const key = await importDek(dek, ["encrypt"]);
  const sealedBody = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: buf(nonce), tagLength: TAG_BYTES * 8 }, key, buf(concat(salt, plaintext))),
  );
  const ciphertext = concat(new Uint8Array([ENVELOPE_VERSION]), nonce, sealedBody);
  if (ciphertext.length !== plaintext.length + CIPHERTEXT_OVERHEAD) {
    throw new Error("internal: unexpected ciphertext length"); // unreachable with AES-GCM/128-bit tag
  }
  return {
    dek: new Uint8Array(dek),
    dekHex: bytesToHex(dek),
    salt: new Uint8Array(salt),
    nonce: new Uint8Array(nonce),
    plaintext: new Uint8Array(plaintext),
    ciphertext,
    ciphertextHex: bytesToHex(ciphertext),
    commitment: commitmentOf(salt, plaintext),
  };
};

/** Convenience: UTF-8 encode a string and seal it. */
export const sealText = (text: string, opts?: SealOptions): Promise<Sealed> =>
  seal(new TextEncoder().encode(text), opts);

// ---------- open ----------

export interface Opened {
  salt: Uint8Array;
  /** Hex salt for `publishPlaintext(owner, id, salt, payload)`. */
  saltHex: Hex;
  /** Attacker-controlled bytes. Render only as text (see `toDisplayText`). */
  plaintext: Uint8Array;
  plaintextHex: Hex;
  /** keccak256(salt ‖ plaintext) of what was decrypted. */
  commitment: Hex;
}

/** Validate the v1 framing without decrypting. Throws EnvelopeError. */
export const parseCiphertext = (ciphertext: Uint8Array | string): { nonce: Uint8Array; body: Uint8Array } => {
  const ct = asBytes(ciphertext);
  if (ct.length < CIPHERTEXT_OVERHEAD) {
    throw new EnvelopeError("CIPHERTEXT_TOO_SHORT", `ciphertext is ${ct.length} bytes; v1 needs at least ${CIPHERTEXT_OVERHEAD}`);
  }
  if (ct.length > MAX_CIPHERTEXT_SIZE) {
    throw new EnvelopeError("CIPHERTEXT_TOO_LARGE", `ciphertext is ${ct.length} bytes; the limit is ${MAX_CIPHERTEXT_SIZE}`);
  }
  if (ct[0] !== ENVELOPE_VERSION) {
    throw new EnvelopeError("UNSUPPORTED_VERSION", `unsupported ciphertext version 0x${ct[0].toString(16).padStart(2, "0")}`);
  }
  return { nonce: ct.slice(1, 1 + NONCE_BYTES), body: ct.slice(1 + NONCE_BYTES) };
};

/**
 * Decrypt a v1 ciphertext. Throws EnvelopeError — `TAG_MISMATCH` when the key
 * does not open it (wrong key, or a ciphertext that was never encrypted under it).
 */
export const open = async (dek: Uint8Array | string, ciphertext: Uint8Array | string): Promise<Opened> => {
  const { nonce, body } = parseCiphertext(ciphertext);
  const key = await importDek(asBytes(dek), ["decrypt"]);
  let inner: Uint8Array;
  try {
    inner = new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: buf(nonce), tagLength: TAG_BYTES * 8 }, key, buf(body)),
    );
  } catch {
    throw new EnvelopeError("TAG_MISMATCH", "AES-GCM authentication failed: this key does not open this ciphertext");
  }
  const salt = inner.slice(0, SALT_BYTES);
  const plaintext = inner.slice(SALT_BYTES);
  return {
    salt,
    saltHex: bytesToHex(salt),
    plaintext,
    plaintextHex: bytesToHex(plaintext),
    commitment: commitmentOf(salt, plaintext),
  };
};

// ---------- revealed-key verification ----------

export type KeyCheck =
  /** Key opens the ciphertext and the plaintext matches the on-chain commitment. */
  | ({ status: "ok"; commitmentMatches: true } & Opened)
  /**
   * Key opens the ciphertext but keccak256(salt ‖ plaintext) differs from the
   * commitment: the owner committed to something else. The plaintext is still
   * what was encrypted; `publishPlaintext` would revert CommitmentMismatch.
   */
  | ({ status: "commitment-mismatch"; commitmentMatches: false } & Opened)
  /** Key does NOT open the ciphertext. Surface INVALID_KEY_WARNING. */
  | { status: "invalid-key"; warning: string }
  /** Stored bytes are not a well-formed v1 ciphertext. */
  | { status: "malformed"; reason: string };

/**
 * Verify a DEK obtained from the KMS (`publicDecryptDek`) or from
 * `getRevealedKey` by decrypting the on-chain ciphertext. Never throws for a
 * bad key / ciphertext; returns a status the UI must show.
 */
export const checkKey = async (
  dek: Uint8Array | string,
  ciphertext: Uint8Array | string,
  expectedCommitment: string,
): Promise<KeyCheck> => {
  try {
    const opened = await open(dek, ciphertext);
    return opened.commitment.toLowerCase() === expectedCommitment.toLowerCase()
      ? { status: "ok", commitmentMatches: true, ...opened }
      : { status: "commitment-mismatch", commitmentMatches: false, ...opened };
  } catch (e) {
    if (e instanceof EnvelopeError) {
      if (e.code === "TAG_MISMATCH") {
        if (typeof console !== "undefined") console.warn(INVALID_KEY_WARNING);
        return { status: "invalid-key", warning: INVALID_KEY_WARNING };
      }
      return { status: "malformed", reason: e.message };
    }
    throw e;
  }
};

// ---------- untrusted plaintext → display text ----------

export interface DisplayText {
  /** Safe to render as a React text child (never via dangerouslySetInnerHTML). */
  text: string;
  /** The bytes were valid UTF-8 (otherwise invalid sequences became U+FFFD). */
  validUtf8: boolean;
  /** Control characters (other than \n and \t) were replaced with U+FFFD. */
  hadControlChars: boolean;
  /** Bidirectional override/isolate characters were present (text may display misleadingly) and were removed. */
  hadBidiControls: boolean;
  /**
   * Invisible characters that can carry hidden text (format and tag
   * characters, zero-width characters, variation selectors outside an emoji,
   * ideograph or Mongolian letter, Hangul fillers, line/paragraph separators,
   * a byte-order mark after the start) were present; each is shown as a
   * visible `\u{…}` escape, so neither the display nor the copied text hides
   * anything.
   */
  hadInvisibleChars: boolean;
  /**
   * Ideographic variation selectors (after a CJK ideograph) or Mongolian
   * variation selectors were present. They are kept, as real text uses them,
   * but one per character can carry a hidden byte, so the text is flagged and
   * the UI warns on this as well as on hadInvisibleChars.
   */
  hadVariationSequences: boolean;
}

// C0 except \t \n, CR handled separately; DEL; C1.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/*
 * Invisible characters (the client's sanitiser, client/src/sanitize.ts,
 * escapes the same set): every format character (\p{Cf}: zero-width
 * characters, word joiner, soft hyphen, invisible operators, byte-order mark,
 * the tag characters U+E0000–E007F that spell ASCII invisibly), every
 * default-ignorable code point (variation selectors U+FE00–FE0F and
 * U+E0100–E01EF, which carry one hidden byte each; the Hangul fillers U+115F,
 * U+1160, U+3164, U+FFA0), and the line/paragraph separators U+2028/2029.
 *
 * Kept where they are ordinary text, so emoji and scripts still render:
 *   - one presentation selector (VS15/VS16) after an emoji: ❤️, 1️⃣
 *   - one ideographic variation selector after a CJK ideograph (Japanese
 *     name variants), and one Mongolian free variation selector or vowel
 *     separator after a Mongolian letter: kept, but flagged
 *     (hadVariationSequences), since one per character carries a byte
 *   - a ZWJ joining emoji: 👨‍👩‍👧, 👩🏽‍💻, 🏳️‍🌈
 *   - a ZWJ / ZWNJ between letters or marks (Persian, Indic scripts)
 *   - the three subdivision flags (England, Scotland, Wales: black flag + tags)
 *   - format characters that are drawn (VISIBLE_FORMAT)
 *
 * No regex lookbehind: Safari before 16.4 rejects it, and this module loads on
 * every page. The neighbours of a ZWJ / ZWNJ are checked in the callback.
 */
const INVISIBLE = String.raw`[\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]`;
/** Ordinary sequences, matched whole with their base character. */
const ORDINARY = [
  String.raw`\p{Emoji}[\uFE0E\uFE0F]`,
  String.raw`\p{Ideographic}[\u{E0100}-\u{E01EF}]`,
  String.raw`(?=\p{L})\p{Script=Mongolian}[\u180B-\u180F]`,
  String.raw`\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}`,
];
const INVISIBLE_RE = new RegExp(`(${ORDINARY.join("|")})|${INVISIBLE}`, "gu");
/**
 * Format characters that are drawn: the prepended concatenation marks
 * (Arabic number signs U+0600–0605 and end of ayah U+06DD, the Syriac
 * abbreviation mark, the Arabic pound/piastre marks, the Kaithi number signs).
 */
const VISIBLE_FORMAT: ReadonlySet<number> = new Set([
  0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x110bd, 0x110cd,
]);
/** An ordinary sequence that ends in an ideographic or Mongolian variation selector (can carry a byte). */
const VARIATION_SEQUENCE_END = /[\u{E0100}-\u{E01EF}\u180B-\u180F]$/u;
const EMOJI_BEFORE_ZWJ = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]/u;
const EMOJI_AFTER_ZWJ = /\p{Extended_Pictographic}/u;
const LETTER = /[\p{L}\p{M}]/u;

/** The code point that ends just before index `i` of `s`. */
const charBefore = (s: string, i: number): string => {
  if (i <= 0) return "";
  const lo = s.charCodeAt(i - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s.charAt(i - 1);
};
/** The code point that starts at index `i` of `s`. */
const charAt = (s: string, i: number): string => {
  const cp = s.codePointAt(i);
  return cp === undefined ? "" : String.fromCodePoint(cp);
};

/** A ZWJ / ZWNJ that is part of an emoji sequence or a word, judged by its neighbours. */
const ordinaryJoiner = (j: string, s: string, at: number): boolean => {
  const prev = charBefore(s, at);
  const next = charAt(s, at + j.length);
  if (j === "\u200D" && EMOJI_BEFORE_ZWJ.test(prev) && EMOJI_AFTER_ZWJ.test(next)) return true;
  return (j === "\u200C" || j === "\u200D") && LETTER.test(prev) && LETTER.test(next);
};

/**
 * Revealed plaintext is attacker-controlled. Decode it for display as plain
 * text: lossy UTF-8, CRLF → LF, control and bidi-override characters
 * neutralised, invisible characters shown as `\u{…}` escapes. Render the
 * result as a text node only; never turn it into a link or HTML without an
 * explicit user action.
 */
export const toDisplayText = (plaintext: Uint8Array): DisplayText => {
  let validUtf8 = true;
  let text: string;
  // A leading byte-order mark is dropped, as text editors write and read it (the download keeps the exact bytes).
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    validUtf8 = false;
    text = new TextDecoder("utf-8", { fatal: false }).decode(plaintext);
  }
  text = text.replace(/\r\n?/g, "\n");
  const hadBidiControls = BIDI_RE.test(text);
  BIDI_RE.lastIndex = 0;
  text = text.replace(BIDI_RE, "");
  const hadControlChars = CONTROL_RE.test(text);
  CONTROL_RE.lastIndex = 0;
  text = text.replace(CONTROL_RE, "�");
  let hadInvisibleChars = false;
  let hadVariationSequences = false;
  text = text.replace(INVISIBLE_RE, (m: string, ordinary: string | undefined, at: number, s: string) => {
    if (ordinary) {
      if (VARIATION_SEQUENCE_END.test(m)) hadVariationSequences = true;
      return m;
    }
    if (VISIBLE_FORMAT.has(m.codePointAt(0)!) || ordinaryJoiner(m, s, at)) return m;
    hadInvisibleChars = true;
    return `\\u{${m.codePointAt(0)!.toString(16)}}`;
  });
  return { text, validUtf8, hadControlChars, hadBidiControls, hadInvisibleChars, hadVariationSequences };
};
