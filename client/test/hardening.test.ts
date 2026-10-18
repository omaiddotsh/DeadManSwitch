// Regression tests from the 2026-10 review: address checksums, watcher config numbers, state file shape, and
// the ciphertext test vector re-derived with node:crypto alone (independent of envelope.ts).

import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { parseOwner } from "../src/args.js";
import { ConfigError, parseAddress } from "../src/config.js";
import { UsageError } from "../src/errors.js";
import { loadState } from "../src/watcher.js";
import { DEFAULT_WATCHER_CONFIG, parseWatcherConfig } from "../src/watcherCore.js";

const DMS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
// The same address with one checksum letter in the wrong case: EIP-55 says this is invalid.
const BAD_CHECKSUM = "0x5fbDB2315678afecb367f032d93F642f64180aa3";

describe("review: addresses", () => {
  it("args.ts parseOwner rejects a mixed-case address whose EIP-55 checksum is wrong", () => {
    expect(() => parseOwner(BAD_CHECKSUM)).toThrow(UsageError);
  });

  it("config.ts parseAddress rejects a DMS_ADDRESS whose EIP-55 checksum is wrong", () => {
    expect(() => parseAddress("DMS_ADDRESS", BAD_CHECKSUM)).toThrow(ConfigError);
  });

  it("all-lowercase and correctly checksummed addresses are accepted (this is the intended leniency)", () => {
    expect(parseOwner(DMS.toLowerCase())).toBe(DMS);
    expect(parseOwner(DMS)).toBe(DMS);
  });
});

describe("review: watcher config numbers", () => {
  it("a large JSON number (1e21 in JS) is formatted without an exponent", () => {
    const fromNumber = parseWatcherConfig(JSON.parse('{"maxGasPriceGwei": 1000000000000000000000}'), { once: false });
    const fromString = parseWatcherConfig({ maxGasPriceGwei: "1000000000000000000000" }, { once: false });
    expect(fromNumber.maxGasPriceWei).toBe(fromString.maxGasPriceWei);
    expect(() => parseWatcherConfig({ minProfitEth: -1 }, { once: false })).toThrow(ConfigError);
  });

  it("a small JSON number for minProfitEth (0.0000001 → JS 1e-7) is accepted like its string form", () => {
    const fromNumber = parseWatcherConfig(JSON.parse('{"minProfitEth": 0.0000001}'), { once: false });
    const fromString = parseWatcherConfig({ minProfitEth: "0.0000001" }, { once: false });
    expect(fromNumber.minProfitWei).toBe(fromString.minProfitWei);
  });

  it("the example config file holds exactly the defaults, as its _comment and the README claim", () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, "../watcher.config.example.json"), "utf8"));
    const fromExample = parseWatcherConfig(raw, { once: false });
    const fromNothing = parseWatcherConfig(undefined, { once: false });
    expect(fromExample).toEqual(fromNothing);
    expect(fromNothing).toEqual({ ...DEFAULT_WATCHER_CONFIG, fromBlock: undefined, rescanFrom: undefined, confirmations: undefined });
  });
});

describe("review: watcher state file robustness", () => {
  const dir = mkdtempSync(join(tmpdir(), "dms-review-"));

  it("a state file that is valid JSON but not an object (`null`) is a ConfigError saying to move it aside, not a TypeError", () => {
    const f = join(dir, "null.json");
    writeFileSync(f, "null");
    expect(() => loadState(f, 31337, DMS)).toThrow(ConfigError);
  });

  it("a state file missing `contract` is a ConfigError, not a TypeError from .toLowerCase()", () => {
    const f = join(dir, "no-contract.json");
    writeFileSync(f, JSON.stringify({ version: 1, chainId: 31337, switches: {} }));
    expect(() => loadState(f, 31337, DMS)).toThrow(ConfigError);
  });

  it("an empty file (a torn write) is a ConfigError", () => {
    const f = join(dir, "empty.json");
    writeFileSync(f, "");
    expect(() => loadState(f, 31337, DMS)).toThrow(ConfigError);
  });
});

describe("review: --out", () => {
  it("--out - is refused: plaintext is never written raw to stdout", async () => {
    const { parseCliArgs } = await import("../src/args.js");
    expect(() => parseCliArgs(["read", DMS, "1", "--out", "-"])).toThrow(UsageError);
    expect(parseCliArgs(["read", DMS, "1", "--out", "x.bin"])).toMatchObject({ out: "x.bin" });
  });
});

describe("review: ciphertext test vector, checked with node:crypto only (not envelope.ts)", () => {
  const v = JSON.parse(readFileSync(resolve(__dirname, "../../docs/ciphertext-test-vector.json"), "utf8")) as Record<string, string | number>;
  const h = (x: string) => Buffer.from(x.slice(2), "hex");

  it("decrypts, re-encrypts byte for byte, and its commitment is keccak256(salt ‖ plaintext)", () => {
    const dek = h(v.dek as string), nonce = h(v.nonce as string), salt = h(v.salt as string), pt = h(v.plaintext as string), ct = h(v.ciphertext as string);
    expect(Buffer.from(v.plaintextUtf8 as string, "utf8").equals(pt)).toBe(true);
    expect(ct.length).toBe(pt.length + 61);
    expect(ct[0]).toBe(1);
    expect(ct.subarray(1, 13).equals(nonce)).toBe(true);
    const d = createDecipheriv("aes-256-gcm", dek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const inner = Buffer.concat([d.update(ct.subarray(13, ct.length - 16)), d.final()]);
    expect(inner.subarray(0, 32).equals(salt)).toBe(true);
    expect(inner.subarray(32).equals(pt)).toBe(true);
    expect(keccak256(Buffer.concat([salt, pt]))).toBe(v.commitment);
    const c = createCipheriv("aes-256-gcm", dek, nonce);
    const body = Buffer.concat([c.update(Buffer.concat([salt, pt])), c.final()]);
    expect(Buffer.concat([Buffer.from([1]), nonce, body, c.getAuthTag()]).equals(ct)).toBe(true);
  });
});
