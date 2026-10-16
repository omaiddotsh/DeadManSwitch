import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toHex } from "viem";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { createClients } from "../src/chain.js";
import { describeError } from "../src/errors.js";
import { classifyRelayerError, createFhevm, fheChainFor, FhevmError, normalizeDecryption, redactUrls } from "../src/fhevm.js";
import { relayerAnswers } from "./relayerErrors.js";

const DMS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const PK = `0x${"ab".repeat(32)}`;
const base = { CHAIN_ID: "31337", RPC_URL: "http://127.0.0.1:8545", DMS_ADDRESS: DMS };

describe("parseConfig", () => {
  it("parses a minimal local config", () => {
    expect(parseConfig(base)).toEqual({
      privateKey: undefined,
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      dmsAddress: DMS,
      relayerApiKey: undefined,
      relayerUrl: undefined,
      fromBlock: 0n,
    });
  });

  it("accepts the three supported chains only", () => {
    for (const id of ["1", "11155111", "31337"]) expect(parseConfig({ ...base, CHAIN_ID: id }).chainId).toBe(Number(id));
    for (const id of ["8453", "10", "42161", "0", "-1", "1.0", "abc"]) {
      expect(() => parseConfig({ ...base, CHAIN_ID: id }), id).toThrow(ConfigError);
    }
    expect(() => parseConfig({ ...base, CHAIN_ID: "8453" })).toThrow(/not supported/);
    expect(() => parseConfig({ ...base, CHAIN_ID: undefined })).toThrow(/CHAIN_ID is required/);
  });

  it("validates the private key, address, URLs and FROM_BLOCK", () => {
    expect(parseConfig({ ...base, PRIVATE_KEY: PK.slice(2) }).privateKey).toBe(PK);
    expect(() => parseConfig({ ...base, PRIVATE_KEY: "0x1234" })).toThrow(/PRIVATE_KEY/);
    expect(() => parseConfig({ ...base, DMS_ADDRESS: "0x1234" })).toThrow(/DMS_ADDRESS/);
    expect(() => parseConfig({ ...base, DMS_ADDRESS: undefined })).toThrow(/DMS_ADDRESS is required/);
    expect(() => parseConfig({ ...base, RPC_URL: undefined })).toThrow(/RPC_URL is required/);
    expect(() => parseConfig({ ...base, RPC_URL: "ftp://x" })).toThrow(/http/);
    expect(() => parseConfig({ ...base, ZAMA_RELAYER_URL: "not a url" })).toThrow(/ZAMA_RELAYER_URL/);
    expect(parseConfig({ ...base, FROM_BLOCK: "123" }).fromBlock).toBe(123n);
    expect(() => parseConfig({ ...base, FROM_BLOCK: "-5" })).toThrow(/FROM_BLOCK/);
    expect(parseConfig({ ...base, DMS_ADDRESS: DMS.toLowerCase() }).dmsAddress).toBe(DMS);
  });

  it("treats blank values as unset", () => {
    expect(parseConfig({ ...base, PRIVATE_KEY: "  ", ZAMA_RELAYER_API_KEY: "" }).privateKey).toBeUndefined();
  });

  it("treats a bare 0x PRIVATE_KEY (the old .env.example placeholder) as unset", () => {
    expect(parseConfig({ ...base, PRIVATE_KEY: "0x" }).privateKey).toBeUndefined();
    expect(parseConfig({ ...base, PRIVATE_KEY: " 0X " }).privateKey).toBeUndefined();
    expect(() => parseConfig({ ...base, PRIVATE_KEY: "0x0" })).toThrow(/PRIVATE_KEY/);
  });

  it("the shipped .env.example works for read-only commands once DMS_ADDRESS is filled in", () => {
    const env = dotenv.parse(readFileSync(resolve(__dirname, "../.env.example"), "utf8"));
    expect(env.PRIVATE_KEY).toBe("");
    expect(parseConfig({ ...env, DMS_ADDRESS: DMS }).privateKey).toBeUndefined();
  });
});

describe("fheChainFor", () => {
  it("31337 → anvil preset with network = RPC_URL, no auth needed", () => {
    const c = fheChainFor({ chainId: 31337, rpcUrl: "http://127.0.0.1:9999" });
    expect(c.id).toBe(31337);
    expect(c.network).toBe("http://127.0.0.1:9999");
    expect(c.aclContractAddress).toBe("0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D");
    expect(c.kmsContractAddress).toBe("0x901F8942346f7AB3a01F6D7613119Bca447Bb030");
    expect(c.executorAddress).toBe("0xe3a9105a3a932253A70F126eb1E3b589C643dD24");
    expect(c.auth).toBeUndefined();
  });

  it("mainnet requires ZAMA_RELAYER_API_KEY", () => {
    expect(() => fheChainFor({ chainId: 1, rpcUrl: "https://rpc" })).toThrow(ConfigError);
    expect(() => fheChainFor({ chainId: 1, rpcUrl: "https://rpc" })).toThrow(/ZAMA_RELAYER_API_KEY is required on Ethereum mainnet/);
  });

  it("Sepolia works without ZAMA_RELAYER_API_KEY (open relayer, no auth sent)", () => {
    const c = fheChainFor({ chainId: 11155111, rpcUrl: "https://rpc" });
    expect(c.id).toBe(11155111);
    expect(c.relayerUrl).toBe("https://relayer.testnet.zama.org");
    expect(c.auth).toBeUndefined();
    expect(fheChainFor({ chainId: 11155111, rpcUrl: "https://rpc", relayerApiKey: "k" }).auth).toEqual({ __type: "ApiKeyHeader", value: "k" });
  });

  it("mainnet → mainnet preset, API-key header auth, RPC_URL network", () => {
    const c = fheChainFor({ chainId: 1, rpcUrl: "https://my-rpc", relayerApiKey: "k" });
    expect(c.id).toBe(1);
    expect(c.network).toBe("https://my-rpc");
    expect(c.relayerUrl).toBe("https://relayer.mainnet.zama.org");
    expect(c.aclContractAddress).toBe("0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6");
    expect(c.kmsContractAddress).toBe("0x77627828a55156b04Ac0DC0eb30467f1a552BB03");
    expect(c.auth).toEqual({ __type: "ApiKeyHeader", value: "k" });
  });

  it("Sepolia → sepolia preset; ZAMA_RELAYER_URL overrides the relayer", () => {
    const c = fheChainFor({ chainId: 11155111, rpcUrl: "https://s", relayerApiKey: "k" });
    expect(c.relayerUrl).toBe("https://relayer.testnet.zama.org");
    expect(c.aclContractAddress).toBe("0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D");
    const o = fheChainFor({ chainId: 11155111, rpcUrl: "https://s", relayerApiKey: "k", relayerUrl: "https://proxy.example/relayer" });
    expect(o.relayerUrl).toBe("https://proxy.example/relayer");
  });
});

describe("normalizeDecryption (single-handle public decrypt result)", () => {
  const handle = `0x${"11".repeat(32)}` as const;
  const dek = 0x00ff00n;
  const dataKey = toHex(dek, { size: 32 });
  const proof = "0x01abcdef" as const;

  it("returns the DEK bytes and the 32-byte dataKey revealKey expects", () => {
    const r = normalizeDecryption(handle, { clearValues: { [handle.toUpperCase().replace("0X", "0x")]: dek }, abiEncodedClearValues: dataKey, decryptionProof: proof });
    expect(r.dataKey).toBe(dataKey);
    expect(r.dek.length).toBe(32);
    expect(r.dek[30]).toBe(0xff);
    expect(r.dek[31]).toBe(0x00);
    expect(r.decryptionProof).toBe(proof);
  });

  it("rejects multi-handle encodings, mismatches, missing handles and empty proofs", () => {
    expect(() => normalizeDecryption(handle, { clearValues: { [handle]: dek }, abiEncodedClearValues: `${dataKey}${"00".repeat(32)}`, decryptionProof: proof })).toThrow(
      /one handle/,
    );
    expect(() => normalizeDecryption(handle, { clearValues: { [handle]: dek + 1n }, abiEncodedClearValues: dataKey, decryptionProof: proof })).toThrow(FhevmError);
    expect(() => normalizeDecryption(handle, { clearValues: {}, abiEncodedClearValues: dataKey, decryptionProof: proof })).toThrow(/does not contain/);
    expect(() => normalizeDecryption(handle, { clearValues: { [handle]: dek }, abiEncodedClearValues: dataKey, decryptionProof: "0x" })).toThrow(/empty/);
    expect(() => normalizeDecryption(handle, { clearValues: { [handle]: true }, abiEncodedClearValues: dataKey, decryptionProof: proof })).toThrow(/boolean/);
  });
});

describe("classifyRelayerError (real @zama-fhe/sdk error classes)", () => {
  it("configuration errors and HTTP 401/403 are fatal; not-ready, 5xx and 429 are not; Retry-After is surfaced", async () => {
    const sdk = await import("@zama-fhe/sdk");
    const helpers = { matchZamaError: sdk.matchZamaError, retryAfterSeconds: sdk.retryAfterSeconds };
    expect(classifyRelayerError(new sdk.ConfigurationError("bad chain"), helpers)).toEqual({ fatal: true, retryAfterSec: undefined });
    expect(classifyRelayerError(new sdk.RelayerRequestFailedError("Unauthorized", 401), helpers).fatal).toBe(true);
    expect(classifyRelayerError(new sdk.RelayerRequestFailedError("Forbidden", 403), helpers).fatal).toBe(true);
    expect(classifyRelayerError(new sdk.RelayerRequestFailedError("Bad gateway", 502), helpers).fatal).toBe(false);
    expect(classifyRelayerError(new sdk.RelayerRequestFailedError("slow down", 429, { retryAfter: 7 }), helpers)).toEqual({ fatal: false, retryAfterSec: 7 });
    expect(classifyRelayerError(new sdk.DecryptionFailedError("not decryptable yet"), helpers).fatal).toBe(false);
    expect(classifyRelayerError(new Error("socket hang up"), helpers)).toEqual({ fatal: false, retryAfterSec: undefined });
  });

  it("a request the relayer has no route for (a wrong ZAMA_RELAYER_URL path) is fatal; the 400 lag after markDark and a typed 404 are not", async () => {
    const sdk = await import("@zama-fhe/sdk");
    const helpers = { matchZamaError: sdk.matchZamaError, retryAfterSeconds: sdk.retryAfterSeconds };
    for (const wrong of [relayerAnswers.wrongUrl(), relayerAnswers.wrongUrl405()]) {
      const c = classifyRelayerError(wrong, helpers);
      expect(c.fatal).toBe(true);
      expect(c.hint).toMatch(/ZAMA_RELAYER_URL.*base URL.*appends \/v2\/public-decrypt/);
    }
    // the lag stays transient: never make a 400 (NO_CIPHERTEXT) fatal
    expect(classifyRelayerError(relayerAnswers.notYet(), helpers)).toEqual({ fatal: false, retryAfterSec: undefined });
    expect(classifyRelayerError(relayerAnswers.unknownJob(), helpers).fatal).toBe(false);
    expect(classifyRelayerError(relayerAnswers.rpc404(), helpers).fatal).toBe(false);
    expect(classifyRelayerError(new sdk.RelayerRequestFailedError("Unauthorized", 401), helpers).hint).toMatch(/ZAMA_RELAYER_API_KEY/);
  });
});

describe("relayer / SDK error text", () => {
  const rpcUrl = "http://127.0.0.1:1/v2/ALCHEMY_SECRET_KEY_abc123"; // an Alchemy-style key in the path

  it("does not print (or let the watcher persist) RPC_URL's API key when the SDK's own RPC read fails", async () => {
    const fhe = await createFhevm({ chainId: 31337, rpcUrl }, createClients({ chainId: 31337, rpcUrl }));
    try {
      const err = await fhe.publicDecryptDek(`0x${"12".repeat(32)}`, { timeoutMs: 20_000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FhevmError);
      const text = describeError(err);
      expect(text).toMatch(/public decryption of 0x(12){32} refused or failed: .*HTTP request failed/);
      expect(text).not.toContain("ALCHEMY_SECRET_KEY");
      expect(text).not.toContain("/v2/");
    } finally {
      fhe.close();
    }
  }, 30_000);

  it("redactUrls replaces RPC_URL and cuts other URLs on its host down to the host; every other URL is left whole", () => {
    const rpc = "https://eth-sepolia.g.alchemy.com/v2/KEY1";
    const text =
      `URL: ${rpc} and https://eth-sepolia.g.alchemy.com/v2/KEY2?x=1 and wss://user:pw@eth-sepolia.g.alchemy.com/v2/KEY3, ` +
      "see https://docs.zama.org/protocol/relayer-errors#rate-limit and https://relayer.testnet.zama.org/v1/public-decrypt; ratio 3://4";
    expect(redactUrls(text, rpc)).toBe(
      "URL: <RPC_URL> and https://eth-sepolia.g.alchemy.com/… and wss://eth-sepolia.g.alchemy.com/…, " +
        "see https://docs.zama.org/protocol/relayer-errors#rate-limit and https://relayer.testnet.zama.org/v1/public-decrypt; ratio 3://4",
    );
    expect(redactUrls("fetch failed: connect ECONNREFUSED 127.0.0.1:8545", "http://127.0.0.1:8545")).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:8545");
  });
});
