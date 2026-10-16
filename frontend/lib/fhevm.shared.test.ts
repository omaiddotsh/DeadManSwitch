// The SDK build and the FHE key download are shared by every caller: a create
// whose form unmounted (its run aborted) must not cancel the next create that
// joins the same load, and progress must reach the caller still waiting.
// SDK modules are mocked; nothing leaves the test.

import { afterEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN = "1";
  let open!: () => void;
  const sdkGate = new Promise<void>((r) => { open = r; });
  return { sdkGate, openSdk: () => open(), handleChain: 31337 };
});

/** hash21 ‖ index ‖ chainId(8) ‖ type 8 (euint256) ‖ version. */
const handleFor = (chainId: number) =>
  `0x${"ab".repeat(21)}00${chainId.toString(16).padStart(16, "0")}0800` as const;

vi.mock("@zama-fhe/sdk", async () => {
  await st.sdkGate; // the SDK / WASM import takes a while on a first visit
  return {
    cleartext: () => ({}),
    createConfig: (c: unknown) => c,
    memoryStorage: {},
    ZamaSDK: class {
      async encrypt() { return { encryptedValues: [handleFor(st.handleChain)], inputProof: "0x01" }; }
      terminate() {}
    },
  };
});
vi.mock("@zama-fhe/sdk/chains", () => ({ anvil: {}, mainnet: {}, sepolia: {} }));
vi.mock("@zama-fhe/sdk/viem", () => ({ ViemProvider: class {} }));
vi.mock("@zama-fhe/sdk/web", () => ({ web: () => ({}) }));

const base = {
  contractAddress: "0x00000000000000000000000000000000000d3ad5",
  userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  dek: new Uint8Array(32).fill(7),
} as const;

afterEach(() => { vi.unstubAllGlobals(); });

describe("shared FHE loads are not tied to the first caller", () => {
  it("SDK still loading: the first create is aborted (form unmounted); the next one joins the load and succeeds, with progress", async () => {
    const { encryptDek } = await import("./fhevm");
    st.handleChain = 31337;
    const seen1: string[] = [];
    const seen2: string[] = [];
    const c1 = new AbortController();
    const run1 = encryptDek({ ...base, chainId: 31337, signal: c1.signal, onProgress: (p) => seen1.push(p.stage) }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    c1.abort();
    const c2 = new AbortController();
    const run2 = encryptDek({ ...base, chainId: 31337, signal: c2.signal, onProgress: (p) => seen2.push(p.stage) }).catch((e: unknown) => e);
    st.openSdk();
    const [r1, r2] = await Promise.all([run1, run2]);
    expect((r1 as { code?: string }).code).toBe("ABORTED");
    expect(r2).toMatchObject({ handle: handleFor(31337).toLowerCase(), inputProof: "0x01" });
    // The shared load's progress reaches the caller still waiting, not the one that left.
    expect(seen2).toContain("initializing");
    expect(seen2).toContain("done");
    expect(seen1).not.toContain("initializing");
  });

  it("the 50 MB key download keeps going when the first create is aborted: the next create uses it, nothing is fetched twice", async () => {
    const { encryptDek, getFheKeyStatus } = await import("./fhevm");
    st.handleChain = 11155111;
    vi.stubGlobal("window", { location: { origin: "https://dms.example" } });
    let releaseKey!: () => void;
    const keyGate = new Promise<void>((r) => { releaseKey = r; });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      fetched.push(url);
      if (url.endsWith("/v2/keyurl")) {
        return new Response(JSON.stringify({ response: {
          fheKeyInfo: [{ fhePublicKey: { dataId: "pk-1", urls: ["https://bucket.example/pk"] } }],
          crs: { 2048: { dataId: "crs-1", urls: ["https://bucket.example/crs"] } },
        } }), { headers: { "content-type": "application/json" } });
      }
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        void keyGate.then(resolve);
      });
      return new Response(new Uint8Array(1_000), { headers: { "content-length": "1000" } });
    }));

    const c1 = new AbortController();
    const run1 = encryptDek({ ...base, chainId: 11155111, signal: c1.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(fetched).toContain("https://bucket.example/pk"));
    c1.abort(); // navigated away mid-download
    const seen2: string[] = [];
    const run2 = encryptDek({ ...base, chainId: 11155111, onProgress: (p) => seen2.push(p.stage) }).catch((e: unknown) => e);
    releaseKey();
    const [r1, r2] = await Promise.all([run1, run2]);
    expect((r1 as { code?: string }).code).toBe("ABORTED");
    expect(r2).toMatchObject({ handle: handleFor(11155111).toLowerCase() });
    expect(fetched.filter((u) => u.includes("bucket.example")).sort()).toEqual(["https://bucket.example/crs", "https://bucket.example/pk"]);
    expect(fetched.filter((u) => u.endsWith("/v2/keyurl"))).toHaveLength(1);
    expect(getFheKeyStatus(11155111).state).toBe("ready");
    // The second caller joined mid-download and was told at once where the shared loads stood.
    expect(seen2.slice(0, 2)).toEqual(["loading-sdk", "downloading-key"]);
    expect(seen2.at(-1)).toBe("done");
  });
});
