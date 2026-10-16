// How lib/fhevm.ts reads the relayer proxy's answers: a server
// configuration error must come out as RELAYER_NOT_CONFIGURED (with the
// operator hint), whether it arrives on the keyurl fetch or inside an SDK
// error from the input-proof / public-decrypt request loop; and the relayer's
// typed "not ready yet" answers must be retried, not reported as a failure.
// SDK modules are mocked; the SDK errors are the real @fhevm/sdk classes.

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_ERROR_LABELS } from "@/app/api/relayer/proxy";

const st = vi.hoisted(() => ({ fail: null as unknown }));

const handleFor = (chainId: number) => `0x${"ab".repeat(21)}00${chainId.toString(16).padStart(16, "0")}0800` as const;

vi.mock("@zama-fhe/sdk", () => ({
  cleartext: () => ({}),
  createConfig: (c: unknown) => c,
  memoryStorage: {},
  ZamaSDK: class {
    async encrypt() { throw st.fail; }
    decryption = { decryptPublicValues: async () => { throw st.fail; } };
    terminate() {}
  },
}));
vi.mock("@zama-fhe/sdk/chains", () => ({ anvil: {}, mainnet: {}, sepolia: {} }));
vi.mock("@zama-fhe/sdk/viem", () => ({ ViemProvider: class {} }));
vi.mock("@zama-fhe/sdk/web", () => ({ web: () => ({}) }));

const SDK_ERRORS = fileURLToPath(new URL("../node_modules/@fhevm/sdk/_esm/core/errors/", import.meta.url));
type StatusErrorCtor = new (p: Record<string, unknown>) => Error;
/** What the SDK's request loop throws for a 403, carrying the body's error.message (proxy.ts sdkAnswers). */
const statusError = async (status: number, responseMessage?: string, operation = "INPUT_PROOF") => {
  const { RelayerResponseStatusError } = (await import(/* @vite-ignore */ `${SDK_ERRORS}RelayerResponseStatusError.js`)) as { RelayerResponseStatusError: StatusErrorCtor };
  const e = new RelayerResponseStatusError({
    fetchMethod: "POST", status, url: "https://dms.example/api/relayer/11155111/v2/input-proof", operation,
    elapsed: 0, retryCount: 0, state: {}, ...(responseMessage ? { responseMessage } : {}),
  });
  // @zama-fhe/sdk wraps relayer errors (EncryptionFailedError / DecryptionFailedError) with the original as cause.
  return new Error("Encryption failed", { cause: e });
};

const base = {
  contractAddress: "0x00000000000000000000000000000000000d3ad5",
  userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  dek: new Uint8Array(32).fill(7),
} as const;

/** A browser on Sepolia whose keyurl fetch gets `keyurl`; the key download itself succeeds. */
const browser = (keyurl: () => Response) => {
  vi.stubGlobal("window", { location: { origin: "https://dms.example" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/v2/keyurl")) return keyurl();
    return new Response(new Uint8Array(10));
  }));
};
const keyurlOk = () => new Response(JSON.stringify({ response: {
  fheKeyInfo: [{ fhePublicKey: { dataId: "pk-1", urls: ["https://bucket.example/pk"] } }],
  crs: { 2048: { dataId: "crs-1", urls: ["https://bucket.example/crs"] } },
} }), { headers: { "content-type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); st.fail = null; });

describe("proxy configuration errors on the SDK's paths: RELAYER_NOT_CONFIGURED, not ENCRYPT_FAILED / DECRYPT_FAILED", () => {
  it("lib/fhevm.ts knows every label the proxy sends", async () => {
    const { RELAYER_CONFIG_LABELS } = await import("./fhevm");
    expect([...RELAYER_CONFIG_LABELS].sort()).toEqual([...CONFIG_ERROR_LABELS].sort());
  });

  // contract_mismatch is this page being out of date, not a server setting (G16 below).
  it.each(CONFIG_ERROR_LABELS.filter((l) => l !== "contract_mismatch").map((l) => [l]))("create: %s", async (label) => {
    const { encryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await statusError(403, `${label}: set it on the server`);
    const e = await encryptDek({ ...base, chainId: 11155111 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: "FhevmError", code: "RELAYER_NOT_CONFIGURED" });
    expect((e as Error).message).toContain(label);
  });

  it("fetching a key on mainnet without a relayer key (the hunt page never fetches keyurl)", async () => {
    const { publicDecryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await statusError(403, "relayer_not_configured: This server has no Zama relayer API key for chain 1.", "PUBLIC_DECRYPT");
    const e = await publicDecryptDek({ chainId: 1, handle: handleFor(1) }).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: "FhevmError", code: "RELAYER_NOT_CONFIGURED" });
  });

  it("another 403 (an edge proxy's block) is still a plain failure", async () => {
    const { encryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await statusError(403, "Forbidden by policy");
    const e = await encryptDek({ ...base, chainId: 11155111 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "ENCRYPT_FAILED" });
  });
});

describe("keyurl: a misconfigured relayer URL is a server setting too", () => {
  it.each(["relayer_misconfigured", "relayer_not_configured", "contract_not_configured"])("503 %s → RELAYER_NOT_CONFIGURED", async (label) => {
    const { encryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(() => new Response(JSON.stringify({ error: label, message: "ZAMA_RELAYER_URL_11155111 must be https" }), { status: 503 }));
    const e = await encryptDek({ ...base, chainId: 11155111 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "RELAYER_NOT_CONFIGURED" });
  });
});

describe("the relayer's typed 'not ready yet' answers are retried (NOT_DECRYPTABLE_YET)", () => {
  it.each([
    // RelayerResponseApiError's wording; the relayer's own message text is not relied on.
    "Public decryption: Relayer API error [not_ready_for_decryption]: try again later",
    "Public decryption: Relayer API error [readiness_check_timed_out]: gateway timed out",
  ])("%s", async (msg) => {
    const { publicDecryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = new Error(msg);
    const e = await publicDecryptDek({ chainId: 11155111, handle: handleFor(11155111) }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "NOT_DECRYPTABLE_YET" });
  });
});

describe("a relayer outage reported by the proxy (502/504) is a relayer error with a reason, not a failed encryption", () => {
  it.each([502, 504])("create: %i → RELAYER_ERROR", async (status) => {
    const { encryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await statusError(status);
    const e = await encryptDek({ ...base, chainId: 11155111 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "RELAYER_ERROR" });
    expect((e as Error).message).toMatch(status === 504 ? /did not answer in time/ : /could not be reached/);
  });

  it("fetching a key: 502 → RELAYER_ERROR", async () => {
    const { publicDecryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await statusError(502, undefined, "PUBLIC_DECRYPT");
    const e = await publicDecryptDek({ chainId: 11155111, handle: handleFor(11155111) }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "RELAYER_ERROR" });
  });
});

describe("G16: a tab loaded before the site moved to a new contract is told to reload, not that the server is broken", () => {
  it("the proxy's contract_mismatch refusal of an input proof: STALE_PAGE, with reload advice", async () => {
    const { encryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await statusError(403, "contract_mismatch: input proofs are only relayed for this app's contract");
    const e = await encryptDek({ ...base, chainId: 11155111 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: "FhevmError", code: "STALE_PAGE" });
    expect((e as Error).message).toMatch(/reload the page/i);
    expect((e as Error).message).toMatch(/nothing was sent/i);
    expect((e as Error).message).not.toMatch(/operator|server configuration/i);
  });
});

/**
 * What the SDK throws when Zama's gateway answers a relayer call with its own error body (Kong's 503
 * "failure to get a peer from the ring-balancer", seen live on Sepolia on 2026-10-13): the request
 * loop cannot parse it (RelayerResponseInvalidBodyError, which keeps the body), and @zama-fhe/sdk
 * wraps that in a RelayerRequestFailedError carrying the HTTP status.
 */
const gatewayError = async (status: number, body: string, operation = "PUBLIC_DECRYPT", url = "https://dms.example/api/relayer/11155111/v2/public-decrypt") => {
  const { RelayerResponseInvalidBodyError } = (await import(/* @vite-ignore */ `${SDK_ERRORS}RelayerResponseInvalidBodyError.js`)) as { RelayerResponseInvalidBodyError: StatusErrorCtor };
  const inner = new RelayerResponseInvalidBodyError({
    fetchMethod: "POST", status, url, operation, elapsed: 0, retryCount: 0, state: {},
    cause: new Error("missing body.status, expected failed"), bodyJson: body,
  });
  return Object.assign(new Error(inner.message, { cause: inner }), { name: "RelayerRequestFailedError", statusCode: status, retryable: false });
};
const KONG_503 = JSON.stringify({ message: "failure to get a peer from the ring-balancer", request_id: "0b6c" });

describe("G1: Zama's relayer down (a gateway 5xx) is a relayer error with its cause, retried by the hunt, not a failed decryption", () => {
  it("fetching a key: Kong's 503 is RELAYER_ERROR naming the status and the gateway's reason", async () => {
    const { publicDecryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await gatewayError(503, KONG_503);
    const e = await publicDecryptDek({ chainId: 11155111, handle: handleFor(11155111) }).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: "FhevmError", code: "RELAYER_ERROR" });
    expect((e as Error).message).toContain("503");
    expect((e as Error).message).toContain("failure to get a peer from the ring-balancer");
    expect((e as Error).message).toMatch(/nothing was sent/i);
  });

  it.each([429, 500, 502, 503, 504])("create (key already loaded, the input-proof call fails): %i is RELAYER_ERROR", async (status) => {
    const { encryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await gatewayError(status, "<html>bad gateway</html>", "INPUT_PROOF", "https://dms.example/api/relayer/11155111/v2/input-proof");
    const e = await encryptDek({ ...base, chainId: 11155111 }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "RELAYER_ERROR" });
    expect((e as Error).message).toContain(String(status));
  });

  it("the hunt retries it like a key the KMS has not released yet; a failure that will not change is not retried", async () => {
    const { FhevmError } = await import("./fhevm");
    const { isRetryableKmsError } = await import("./hooks");
    expect(isRetryableKmsError(new FhevmError("RELAYER_ERROR", "x"))).toBe(true);
    expect(isRetryableKmsError(new FhevmError("NOT_DECRYPTABLE_YET", "x"))).toBe(true);
    for (const code of ["DECRYPT_FAILED", "RELAYER_NOT_CONFIGURED", "BAD_RESULT", "ABORTED"] as const) {
      expect(isRetryableKmsError(new FhevmError(code, "x"))).toBe(false);
    }
    expect(isRetryableKmsError(new Error("x"))).toBe(false);
  });

  it("a 400 whose body breaks the schema is still DECRYPT_FAILED (not an outage)", async () => {
    const { publicDecryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await gatewayError(400, JSON.stringify({ message: "bad request" }));
    const e = await publicDecryptDek({ chainId: 11155111, handle: handleFor(11155111) }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "DECRYPT_FAILED" });
  });

  it("a site whose address contains 'acl' (oracle…) does not turn every failure into 'not decryptable yet'", async () => {
    const { publicDecryptDek, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    browser(keyurlOk);
    st.fail = await gatewayError(400, JSON.stringify({ message: "bad request" }), "PUBLIC_DECRYPT", "https://dms-oracle.example/api/relayer/11155111/v2/public-decrypt");
    const e = await publicDecryptDek({ chainId: 11155111, handle: handleFor(11155111) }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "DECRYPT_FAILED" });
  });
});
