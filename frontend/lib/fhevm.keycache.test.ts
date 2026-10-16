// The browser's IndexedDB copy of Zama's FHE public key + CRS (~50 MB) must
// follow a key or CRS rotation. Sepolia's relayer answers keyurl with constant
// placeholder dataIds ("fhe-public-key-data-id", "crs-data-id", seen live on
// 2026-10-13); only the bucket URLs name the actual key. And a key that is
// rotated in place (same URL) shows up only as a rejected input proof: the
// cached copy is then dropped, so the next try downloads afresh.
// SDK modules are mocked; IndexedDB is an in-memory stand-in that outlives a
// "visit" (disposeFhevm drops the page's memoised key and SDK, not the cache).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({
  /** The fheEncryptionKey each web() relayer was built with: pk / crs bytes. */
  webKeys: [] as { pk: Uint8Array; crs: Uint8Array }[],
  encrypt: null as null | (() => Promise<unknown>),
}));

const handleFor = (chainId: number) => `0x${"ab".repeat(21)}00${chainId.toString(16).padStart(16, "0")}0800` as const;

vi.mock("@zama-fhe/sdk", () => ({
  cleartext: () => ({}),
  createConfig: (c: unknown) => c,
  memoryStorage: {},
  ZamaSDK: class {
    async encrypt() {
      if (st.encrypt) return st.encrypt();
      return { encryptedValues: [handleFor(11155111)], inputProof: "0x01" };
    }
    terminate() {}
  },
}));
vi.mock("@zama-fhe/sdk/chains", () => ({ anvil: {}, mainnet: {}, sepolia: {} }));
vi.mock("@zama-fhe/sdk/viem", () => ({ ViemProvider: class {} }));
vi.mock("@zama-fhe/sdk/web", () => ({
  web: (o: { fheEncryptionKey?: { publicKeyBytes: { bytes: Uint8Array }; crsBytes: { bytes: Uint8Array } } }) => {
    if (o.fheEncryptionKey) st.webKeys.push({ pk: o.fheEncryptionKey.publicKeyBytes.bytes, crs: o.fheEncryptionKey.crsBytes.bytes });
    return {};
  },
}));

/** Just enough of IndexedDB for lib/fhevm.ts: one database, one object store, async callbacks. */
const memoryIndexedDB = () => {
  const data = new Map<string, unknown>();
  const later = (f: () => void) => setTimeout(f, 0);
  const db = {
    close: () => {},
    transaction: () => {
      let open = 0;
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown } = {
        objectStore: () => store,
      };
      const settle = () => later(() => { if (open === 0) tx.oncomplete?.(); });
      const request = <T>(f: () => T) => {
        const r: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
        open++;
        later(() => { r.result = f(); r.onsuccess?.(); open--; settle(); });
        return r;
      };
      const store = {
        get: (k: string) => request(() => data.get(k)),
        getAllKeys: () => request(() => [...data.keys()]),
        put: (v: unknown, k: string) => request(() => { data.set(k, v); return k; }),
        delete: (k: string) => request(() => { data.delete(k); }),
      };
      return tx;
    },
  };
  const factory = {
    open: () => {
      const r: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = {};
      later(() => { r.result = db; r.onsuccess?.(); });
      return r;
    },
  };
  return { factory, data };
};

const base = {
  chainId: 11155111,
  contractAddress: "0x00000000000000000000000000000000000d3ad5",
  userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  dek: new Uint8Array(32).fill(7),
} as const;

/** The live Sepolia keyurl answer: placeholder dataIds, the key's identity only in the URLs. */
const liveKeyurl = (pkUrl: string, crsUrl: string) => new Response(JSON.stringify({
  status: "succeeded",
  response: {
    fheKeyInfo: [{ fhePublicKey: { dataId: "fhe-public-key-data-id", urls: [pkUrl] } }],
    crs: { 2048: { dataId: "crs-data-id", urls: [crsUrl] } },
  },
}), { headers: { "content-type": "application/json" } });

const BUCKET = "https://zama-mpc-testnet-public.example/PUB-p1";
const KEY_A = { pk: `${BUCKET}/PublicKey/0400000003`, crs: `${BUCKET}/CRS/0500000004` };
const KEY_B = { pk: `${BUCKET}/PublicKey/0400000005`, crs: `${BUCKET}/CRS/0500000006` };

let idb: ReturnType<typeof memoryIndexedDB>;
let served: { pk: string; crs: string };
let bucket: string[];

beforeEach(() => {
  st.webKeys = [];
  st.encrypt = null;
  idb = memoryIndexedDB();
  served = KEY_A;
  bucket = [];
  vi.stubGlobal("window", { location: { origin: "https://dms.example" } });
  vi.stubGlobal("indexedDB", idb.factory);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/v2/keyurl")) return liveKeyurl(served.pk, served.crs);
    bucket.push(url);
    // The bytes name the object: 0xaa for key A's files, 0xbb for key B's.
    const fill = url === KEY_A.pk || url === KEY_A.crs ? 0xaa : 0xbb;
    return new Response(new Uint8Array(1_000).fill(fill), { headers: { "content-length": "1000" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A new page load: the page's memoised key and SDK are gone, the IndexedDB copy is not. */
const newVisit = async () => {
  const { disposeFhevm } = await import("./fhevm");
  await disposeFhevm();
};

const chainEntries = () => [...idb.data.keys()].filter((k) => k.startsWith("11155111|"));

describe("G0: the FHE key cache follows a key or CRS rotation", () => {
  it("live keyurl shape: a rotation (new URLs, same placeholder dataIds) is downloaded, not served from the old cache", async () => {
    const { encryptDek, getFheKeyStatus } = await import("./fhevm");
    await newVisit();
    await encryptDek(base);
    expect(bucket.sort()).toEqual([KEY_A.crs, KEY_A.pk].sort());
    await vi.waitFor(() => expect(chainEntries()).toHaveLength(1));

    // Zama rotates the key and the CRS: keyurl names new URLs, with the same placeholder dataIds.
    served = KEY_B;
    bucket = [];
    await newVisit();
    await encryptDek(base);
    expect(bucket.sort()).toEqual([KEY_B.crs, KEY_B.pk].sort());
    expect(getFheKeyStatus(11155111).fromCache).toBe(false);
    expect(st.webKeys.at(-1)?.pk[0]).toBe(0xbb);
    expect(st.webKeys.at(-1)?.crs[0]).toBe(0xbb);
    // One copy per chain: key A's is replaced.
    await vi.waitFor(() => {
      expect(chainEntries()).toHaveLength(1);
      expect(chainEntries()[0]).toContain("0400000005");
    });

    // Unchanged on the next visit: served from the cache, nothing downloaded.
    bucket = [];
    await newVisit();
    await encryptDek(base);
    expect(bucket).toEqual([]);
    expect(getFheKeyStatus(11155111).fromCache).toBe(true);
    expect(st.webKeys.at(-1)?.pk[0]).toBe(0xbb);
  });

  it("a key replaced in place (same URL): a rejected input proof drops the cached copy once, and the next try downloads afresh", async () => {
    const { encryptDek, getFheKeyStatus } = await import("./fhevm");
    await newVisit();
    await encryptDek(base);
    await vi.waitFor(() => expect(chainEntries()).toHaveLength(1));

    // Next visit: the cached copy is used, and Zama's coprocessors reject the proof made with it.
    bucket = [];
    await newVisit();
    st.encrypt = async () => {
      const rejected = Object.assign(new Error("Relayer rejected the input proof"), { name: "RelayerResponseInputProofRejectedError" });
      throw new Error("Encryption failed", { cause: rejected });
    };
    const e = await encryptDek(base).catch((x: unknown) => x);
    expect(bucket).toEqual([]);
    expect(e).toMatchObject({ name: "FhevmError", code: "ENCRYPT_FAILED" });
    expect((e as Error).message).toMatch(/cached FHE key/i);
    expect((e as Error).message).toMatch(/try again/i);
    await vi.waitFor(() => expect(chainEntries()).toHaveLength(0));
    expect(getFheKeyStatus(11155111).fromCache).toBe(false);

    // The retry, in the same page: a fresh download, then the proof is accepted.
    st.encrypt = null;
    await expect(encryptDek(base)).resolves.toMatchObject({ handle: handleFor(11155111).toLowerCase() });
    expect(bucket.sort()).toEqual([KEY_A.crs, KEY_A.pk].sort());

    // A rejection with a freshly downloaded key is not blamed on the cache (no download loop).
    bucket = [];
    st.encrypt = async () => { throw Object.assign(new Error("Relayer rejected the input proof"), { name: "RelayerResponseInputProofRejectedError" }); };
    const again = await encryptDek(base).catch((x: unknown) => x);
    expect(again).toMatchObject({ code: "ENCRYPT_FAILED" });
    expect((again as Error).message).not.toMatch(/cached FHE key/i);
    await new Promise((r) => setTimeout(r, 20));
    expect(chainEntries()).toHaveLength(1);
  });
});
