import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesToHex, encodePacked, hexToBytes, keccak256, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CIPHERTEXT_OVERHEAD,
  commitmentOf,
  dekFromBytes32,
  dekToBigInt,
  EnvelopeError,
  KEY_MISMATCH_WARNING,
  MAX_CIPHERTEXT_SIZE,
  MAX_PAYLOAD_SIZE,
  open,
  parseCiphertext,
  seal,
  verifyCommitment,
  verifyKeyOpensCiphertext,
} from "../src/envelope.js";

interface Vector {
  dek: Hex;
  nonce: Hex;
  salt: Hex;
  plaintextUtf8: string;
  plaintext: Hex;
  commitment: Hex;
  ciphertext: Hex;
  plaintextLength: number;
  ciphertextLength: number;
}

const vector = JSON.parse(readFileSync(resolve(__dirname, "../../docs/ciphertext-test-vector.json"), "utf8")) as Vector;

const expectCode = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(EnvelopeError);
  await expect(p).rejects.toMatchObject({ code });
};

describe("v1 test vector (docs/ciphertext-test-vector.json)", () => {
  it("decrypts the vector to the expected salt, plaintext and commitment", async () => {
    const opened = await open(hexToBytes(vector.ciphertext), hexToBytes(vector.dek));
    expect(bytesToHex(opened.salt)).toBe(vector.salt);
    expect(bytesToHex(opened.plaintext)).toBe(vector.plaintext);
    expect(new TextDecoder().decode(opened.plaintext)).toBe(vector.plaintextUtf8);
    expect(opened.plaintext.length).toBe(vector.plaintextLength);
    expect(opened.commitment).toBe(vector.commitment);
  });

  it("re-encrypts byte-for-byte with the fixed DEK, salt and nonce", async () => {
    const sealed = await seal(hexToBytes(vector.plaintext), {
      dek: hexToBytes(vector.dek),
      salt: hexToBytes(vector.salt),
      nonce: hexToBytes(vector.nonce),
    });
    expect(bytesToHex(sealed.ciphertext)).toBe(vector.ciphertext);
    expect(sealed.ciphertext.length).toBe(vector.ciphertextLength);
    expect(sealed.commitment).toBe(vector.commitment);
  });

  it("encodes the layout version ‖ nonce ‖ GCM output", () => {
    const ct = hexToBytes(vector.ciphertext);
    const p = parseCiphertext(ct);
    expect(p.version).toBe(1);
    expect(bytesToHex(p.nonce)).toBe(vector.nonce);
    expect(p.sealed.length).toBe(32 + vector.plaintextLength + 16);
    expect(p.plaintextLength).toBe(vector.plaintextLength);
  });
});

describe("commitment", () => {
  it("equals keccak256(abi.encodePacked(bytes32 salt, bytes payload))", () => {
    const salt = hexToBytes(vector.salt);
    const pt = hexToBytes(vector.plaintext);
    expect(commitmentOf(salt, pt)).toBe(keccak256(encodePacked(["bytes32", "bytes"], [vector.salt, vector.plaintext])));
    expect(verifyCommitment(salt, pt, vector.commitment)).toBe(true);
    expect(verifyCommitment(salt, pt.slice(1), vector.commitment)).toBe(false);
  });

  it("rejects a salt that is not 32 bytes", () => {
    expect(() => commitmentOf(new Uint8Array(31), new Uint8Array(1))).toThrow(EnvelopeError);
  });
});

describe("size bounds", () => {
  it("accepts exactly MAX_PAYLOAD_SIZE and yields MAX_CIPHERTEXT_SIZE", async () => {
    const pt = new Uint8Array(MAX_PAYLOAD_SIZE).fill(0x41);
    const sealed = await seal(pt);
    expect(sealed.ciphertext.length).toBe(MAX_CIPHERTEXT_SIZE);
    expect(MAX_CIPHERTEXT_SIZE).toBe(2109);
    const opened = await open(sealed.ciphertext, sealed.dek);
    expect(opened.plaintext).toEqual(pt);
  });

  it("rejects MAX_PAYLOAD_SIZE + 1", async () => {
    await expectCode(seal(new Uint8Array(MAX_PAYLOAD_SIZE + 1)), "payload-too-large");
  });

  it("ciphertext = plaintext + 61 for every size class", async () => {
    expect(CIPHERTEXT_OVERHEAD).toBe(61);
    for (const n of [0, 1, 15, 16, 17, 1000, 2047]) {
      const sealed = await seal(new Uint8Array(n));
      expect(sealed.ciphertext.length).toBe(n + 61);
    }
  });

  it("an empty plaintext still round-trips (the contract allows a 61-byte ciphertext)", async () => {
    const sealed = await seal(new Uint8Array(0));
    const opened = await open(sealed.ciphertext, sealed.dek);
    expect(opened.plaintext.length).toBe(0);
    expect(opened.commitment).toBe(sealed.commitment);
  });

  it("parseCiphertext rejects too-short, too-long and unknown versions", () => {
    expect(() => parseCiphertext(new Uint8Array(60))).toThrow(/at least 61/);
    expect(() => parseCiphertext(new Uint8Array(MAX_CIPHERTEXT_SIZE + 1).fill(1))).toThrow(/at most 2109/);
    const ct = hexToBytes(vector.ciphertext);
    ct[0] = 0x02;
    expect(() => parseCiphertext(ct)).toThrow(/version 0x02/);
  });

  it("rejects keys, salts and nonces of the wrong length", async () => {
    await expectCode(seal(new Uint8Array(1), { dek: new Uint8Array(16) }), "bad-key-length");
    await expectCode(seal(new Uint8Array(1), { salt: new Uint8Array(16) }), "bad-salt-length");
    await expectCode(seal(new Uint8Array(1), { nonce: new Uint8Array(16) }), "bad-nonce-length");
    await expectCode(open(hexToBytes(vector.ciphertext), new Uint8Array(31)), "bad-key-length");
  });
});

describe("tamper detection", () => {
  const ct = hexToBytes(vector.ciphertext);
  const dek = hexToBytes(vector.dek);
  const flip = (i: number) => {
    const c = ct.slice();
    c[i] ^= 0x01;
    return c;
  };

  it("detects a flipped bit in the nonce, the encrypted salt, the encrypted plaintext and the tag", async () => {
    for (const i of [1, 12, 13, 13 + 31, 13 + 32, 13 + 32 + 10, ct.length - 16, ct.length - 1]) {
      await expectCode(open(flip(i), dek), "auth-failed");
    }
  });

  it("detects a flipped version byte", async () => {
    await expectCode(open(flip(0), dek), "bad-version");
  });

  it("detects truncation and extension", async () => {
    await expectCode(open(ct.slice(0, ct.length - 1), dek), "auth-failed");
    await expectCode(open(new Uint8Array([...ct, 0]), dek), "auth-failed");
  });

  it("rejects the wrong key", async () => {
    const wrong = dek.slice();
    wrong[31] ^= 0x80;
    await expectCode(open(ct, wrong), "auth-failed");
  });
});

describe("verifyKeyOpensCiphertext", () => {
  const ct = hexToBytes(vector.ciphertext);

  it("reports ok + commitment match for the right key", async () => {
    const r = await verifyKeyOpensCiphertext(ct, hexToBytes(vector.dek), vector.commitment);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.commitmentMatches).toBe(true);
      expect(bytesToHex(r.opened.plaintext)).toBe(vector.plaintext);
    }
  });

  it("reports a commitment mismatch without failing the tag check", async () => {
    const r = await verifyKeyOpensCiphertext(ct, hexToBytes(vector.dek), keccak256("0x01"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commitmentMatches).toBe(false);
  });

  it("returns ok:false (never throws) for a key that does not open the ciphertext", async () => {
    const r = await verifyKeyOpensCiphertext(ct, new Uint8Array(32).fill(7), vector.commitment);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("auth-failed");
  });

  it("returns ok:false for a structurally invalid ciphertext", async () => {
    const r = await verifyKeyOpensCiphertext(new Uint8Array(10), hexToBytes(vector.dek));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ciphertext-too-short");
  });

  it("has the warning text the security review asks for", () => {
    expect(KEY_MISMATCH_WARNING).toContain("key accepted by the KMS proof but does not open the ciphertext");
    expect(KEY_MISMATCH_WARNING).toContain("Zama's KMS signer set was compromised");
  });
});

describe("random sealing", () => {
  it("uses fresh DEK, salt and nonce each time and round-trips", async () => {
    const pt = new TextEncoder().encode("hello");
    const a = await seal(pt);
    const b = await seal(pt);
    expect(bytesToHex(a.dek)).not.toBe(bytesToHex(b.dek));
    expect(bytesToHex(a.nonce)).not.toBe(bytesToHex(b.nonce));
    expect(bytesToHex(a.salt)).not.toBe(bytesToHex(b.salt));
    expect(a.commitment).not.toBe(b.commitment);
    expect((await open(a.ciphertext, a.dek)).plaintext).toEqual(pt);
  });
});

describe("DEK encoding", () => {
  it("bigint ↔ bytes32 is lossless, including leading zero bytes", () => {
    const dek = new Uint8Array(32);
    dek[5] = 0xab;
    dek[31] = 0x01;
    const n = dekToBigInt(dek);
    const hex = `0x${n.toString(16).padStart(64, "0")}` as Hex;
    expect(dekFromBytes32(hex)).toEqual(dek);
    expect(dekToBigInt(hexToBytes(vector.dek))).toBe(BigInt(vector.dek));
  });

  it("rejects malformed bytes32", () => {
    expect(() => dekFromBytes32("0x1234")).toThrow(EnvelopeError);
  });
});
