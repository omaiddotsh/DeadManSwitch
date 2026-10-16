// The ~50 MB FHE key download is shared by every create in the tab. A
// transfer that stalls (connection kept open, no bytes) must end with a
// retryable error and leave nothing cached, so the next create starts a fresh
// download instead of joining the stalled one forever. SDK modules are
// mocked; nothing leaves the test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handleFor = (chainId: number) => `0x${"ab".repeat(21)}00${chainId.toString(16).padStart(16, "0")}0800` as const;

vi.mock("@zama-fhe/sdk", () => ({
  cleartext: () => ({}),
  createConfig: (c: unknown) => c,
  memoryStorage: {},
  ZamaSDK: class {
    async encrypt() { return { encryptedValues: [handleFor(11155111)], inputProof: "0x01" }; }
    terminate() {}
  },
}));
vi.mock("@zama-fhe/sdk/chains", () => ({ anvil: {}, mainnet: {}, sepolia: {} }));
vi.mock("@zama-fhe/sdk/viem", () => ({ ViemProvider: class {} }));
vi.mock("@zama-fhe/sdk/web", () => ({ web: () => ({}) }));

const base = {
  chainId: 11155111,
  contractAddress: "0x00000000000000000000000000000000000d3ad5",
  userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  dek: new Uint8Array(32).fill(7),
} as const;

const keyurl = () => new Response(JSON.stringify({ response: {
  fheKeyInfo: [{ fhePublicKey: { dataId: "pk-1", urls: ["https://bucket.example/pk"] } }],
  crs: { 2048: { dataId: "crs-1", urls: ["https://bucket.example/crs"] } },
} }), { headers: { "content-type": "application/json" } });

/** A body that sends `first` bytes, then nothing, keeping the connection open. */
const stalledBody = (first: number) => new Response(new ReadableStream<Uint8Array>({
  start(c) { c.enqueue(new Uint8Array(first)); },
}), { headers: { "content-length": "1000000" } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { location: { origin: "https://dms.example" } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("a stalled FHE key download", () => {
  it("ends with a retryable KEY_DOWNLOAD_FAILED, and the next create downloads afresh", async () => {
    const { encryptDek, getFheKeyStatus, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    let stall = true;
    const bucket: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v2/keyurl")) return keyurl();
      bucket.push(url);
      return stall ? stalledBody(1_000) : new Response(new Uint8Array(1_000), { headers: { "content-length": "1000" } });
    }));

    const first: { error?: { code?: string; message?: string } } = {};
    encryptDek(base).catch((e: { code?: string; message?: string }) => { first.error = e; });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(first.error?.code).toBe("KEY_DOWNLOAD_FAILED");
    expect(first.error?.message).toMatch(/stalled/);
    expect(getFheKeyStatus(11155111).state).toBe("error");

    // The connection recovers: the next create does not join the dead download.
    stall = false;
    const before = bucket.length;
    const second = encryptDek(base);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toMatchObject({ handle: handleFor(11155111).toLowerCase() });
    expect(bucket.length).toBe(before + 2);
    expect(getFheKeyStatus(11155111).state).toBe("ready");
  });

  it("a slow but moving download is not cut off", async () => {
    const { encryptDek, disposeFhevm, KEY_IDLE_TIMEOUT_MS } = await import("./fhevm");
    await disposeFhevm();
    // A chunk every KEY_IDLE_TIMEOUT_MS / 2 for longer than several idle windows.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v2/keyurl")) return keyurl();
      let n = 0;
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          const iv = setInterval(() => {
            c.enqueue(new Uint8Array(100));
            if (++n === 8) { clearInterval(iv); c.close(); }
          }, KEY_IDLE_TIMEOUT_MS / 2);
        },
      }), { headers: { "content-length": "800" } });
    }));
    const out: { value?: unknown; error?: unknown } = {};
    encryptDek(base).then((v) => { out.value = v; }, (e: unknown) => { out.error = e; });
    await vi.advanceTimersByTimeAsync(5 * KEY_IDLE_TIMEOUT_MS);
    expect(out.error).toBeUndefined();
    expect(out.value).toMatchObject({ handle: handleFor(11155111).toLowerCase() });
  });
});

describe("G19: a compressed key response, whose Content-Encoding a cross-origin fetch cannot read", () => {
  it("the progress total is dropped once the bytes outrun Content-Length: the bar never shows more loaded than its total", async () => {
    const { prefetchFheKey, getFheKeyStatus, subscribeFheKeyStatus, disposeFhevm } = await import("./fhevm");
    await disposeFhevm();
    const CRS = 4 * 1024 * 1024;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/v2/keyurl")) return keyurl();
      if (url.endsWith("/pk")) return new Response(new Uint8Array(1_000), { headers: { "content-length": "1000" } });
      // What a browser shows for a gzip response from another origin: the encoded length, and no Content-Encoding
      // (not CORS-safelisted). The body is the decoded bytes, far more than that length.
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(CRS / 4));
          c.close();
        },
      }), { headers: { "content-length": "16613" } });
    }));
    const progress: { loadedBytes?: number; totalBytes?: number | null }[] = [];
    const statuses: { loadedBytes: number; totalBytes: number | null }[] = [];
    const unsubscribe = subscribeFheKeyStatus(() => { statuses.push(getFheKeyStatus(11155111)); });
    const done = prefetchFheKey(11155111, (p) => { if (p.stage === "downloading-key") progress.push(p); });
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    unsubscribe();
    expect(progress.length).toBeGreaterThan(2);
    for (const p of progress) if (p.totalBytes != null) expect(p.loadedBytes).toBeLessThanOrEqual(p.totalBytes);
    for (const s of statuses) if (s.totalBytes !== null) expect(s.loadedBytes).toBeLessThanOrEqual(s.totalBytes);
    expect(getFheKeyStatus(11155111)).toMatchObject({ state: "ready", loadedBytes: 1_000 + CRS, totalBytes: 1_000 + CRS });
  });
});
