import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BODY_LIMITS, FixedWindowRateLimiter, MAX_UPSTREAM_RETRIES, RATE_LIMITS, UpstreamFailures, allowedContractFor, handleRelayerRequest,
  matchRelayerPath, type Env, type ProxyDeps,
} from "./proxy";
import { deploymentFor } from "@/lib/deployments";
import * as route from "./[chainId]/[...path]/route";

const KEY = "sk_test_relayer_SECRET_123";
const CONTRACT_SEPOLIA = "0x00000000000000000000000000000000000d3ad5";
const CONTRACT_MAINNET = "0x000000000000000000000000000000000000beef";

const baseEnv = (): Env => ({
  ZAMA_RELAYER_API_KEY: KEY,
  NEXT_PUBLIC_CONTRACT_11155111: CONTRACT_SEPOLIA,
  NEXT_PUBLIC_CONTRACT_1: CONTRACT_MAINNET,
});

/** A handle as the host builds it: hash21 ‖ index ‖ chainId(8) ‖ type ‖ version. */
const handleFor = (chainId: number, typeId = 8): string =>
  "0x" + "ab".repeat(21) + "00" + chainId.toString(16).padStart(16, "0") + typeId.toString(16).padStart(2, "0") + "00";

/** Realistic input-proof body: one euint256 measured at 19,178 proof bytes → 38,564-byte JSON. */
const inputProofBody = (over: Record<string, unknown> = {}, proofBytes = 19_178) => JSON.stringify({
  ciphertextWithInputVerification: "ab".repeat(proofBytes),
  contractAddress: CONTRACT_SEPOLIA,
  contractChainId: "0xaa36a7",
  extraData: "0x00",
  userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  ...over,
});

const publicDecryptBody = (handles = [handleFor(11155111)], extraData = "0x00") =>
  JSON.stringify({ ciphertextHandles: handles, extraData });

const req = (method: string, path = "/api/relayer/x", init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`https://dms.example${path}`, { method, ...init, headers: { ...(init.headers ?? {}) } });

const okUpstream = (body = '{"status":"succeeded","response":{}}', headers: Record<string, string> = {}) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } }));

const deps = (over: Partial<ProxyDeps> = {}): ProxyDeps & { fetch: ReturnType<typeof okUpstream> } => ({
  env: baseEnv(),
  fetch: okUpstream(),
  limiter: new FixedWindowRateLimiter(),
  upstreamFailures: new UpstreamFailures(),
  now: () => 1_000_000,
  ...over,
}) as ProxyDeps & { fetch: ReturnType<typeof okUpstream> };

const call = (r: Request, chainId: string, path: string[], d: ProxyDeps) =>
  handleRelayerRequest(r, { chainId, path }, d);

describe("path table", () => {
  it("allows exactly the SDK's encrypt + public-decrypt surface", () => {
    expect(matchRelayerPath(["v2", "keyurl"])?.method).toBe("GET");
    expect(matchRelayerPath(["v2", "input-proof"])?.method).toBe("POST");
    expect(matchRelayerPath(["v2", "public-decrypt"])?.method).toBe("POST");
    expect(matchRelayerPath(["v2", "input-proof", "0b3e4c2a-1d7f-4a8e-9b1c-2f3d4e5f6a7b"])?.kind).toBe("poll");
    expect(matchRelayerPath(["v2", "public-decrypt", "job_123"])?.kind).toBe("poll");
    expect(matchRelayerPath(["v2", "public-decrypt", "job.v1:abc=+~"])?.kind).toBe("poll");
  });

  it.each([
    [["v2", "user-decrypt"]], [["v3", "user-decrypt"]], [["v2", "delegated-user-decrypt"]], [["v1", "keyurl"]],
    [["v2", "keyurl", "x"]], [["v2"]], [["v2", "input-proof", "a", "b"]], [["v2", "..", "keyurl"]],
    [["..", "v2", "keyurl"]], [["v2", "input-proof", ".."]], [["v2", "input-proof", "../../admin"]],
    [["v2/keyurl"]], [["v2", "keyurl%2F.."]], [["https:", "", "evil.example", "v2", "keyurl"]],
    [["v2", "input-proof", "a\\b"]], [["v2", "input-proof", ""]], [["v2", "input-proof", "x".repeat(257)]],
    [["v2", "input-proof", "."]], [["v2", "public-decrypt", "a/b"]], [["v2", "public-decrypt", "a%2Fb"]],
    [["V2", "keyurl"]], [["v2", "input-proof", "id?x=1"]], [["v2", "input-proof", "id#f"]],
  ])("refuses %j", (segs) => {
    expect(matchRelayerPath(segs as string[])).toBeNull();
  });
});

describe("handleRelayerRequest — method / chain / path", () => {
  it.each(["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])("405 for %s", async (m) => {
    const d = deps();
    const res = await call(req(m), "11155111", ["v2", "keyurl"], d);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("405 for the wrong method on an allowed path", async () => {
    const d = deps();
    expect((await call(req("POST", "/", { body: "{}", headers: { "content-type": "application/json" } }), "1", ["v2", "keyurl"], d)).status).toBe(405);
    expect((await call(req("GET"), "1", ["v2", "input-proof"], d)).status).toBe(405);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it.each(["137", "31337", "8453", "01", "1 ", "11155111x", "", "0x1"])("404 for chain %j", async (c) => {
    const d = deps();
    expect((await call(req("GET"), c, ["v2", "keyurl"], d)).status).toBe(404);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("404 for traversal and absolute-URL attempts; never reaches upstream", async () => {
    const d = deps();
    for (const p of [["v2", "..", "keyurl"], ["..", ".."], ["https:", "", "evil.example"], ["v2", "keyurl", ".."], ["%2e%2e", "v2"]]) {
      expect((await call(req("GET"), "1", p, d)).status).toBe(404);
    }
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("400 for query strings", async () => {
    const d = deps();
    const res = await call(req("GET", "/api/relayer/1/v2/keyurl?redirect=https://evil"), "1", ["v2", "keyurl"], d);
    expect(res.status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("403 for cross-site browser requests", async () => {
    const d = deps();
    const res = await call(req("GET", "/", { headers: { "sec-fetch-site": "cross-site" } }), "1", ["v2", "keyurl"], d);
    expect(res.status).toBe(403);
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe("handleRelayerRequest — API key", () => {
  it("mainnet: 503 with a clear JSON error when no key is configured, without calling upstream", async () => {
    const d = deps({ env: { NEXT_PUBLIC_CONTRACT_1: CONTRACT_MAINNET } });
    const res = await call(req("GET"), "1", ["v2", "keyurl"], d);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    const j = await res.json();
    expect(j.error).toBe("relayer_not_configured");
    expect(j.message).toMatch(/ZAMA_RELAYER_API_KEY/);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("mainnet without a key on the SDK's paths (create, fetch a key): a 403 whose label and message the SDK surfaces", async () => {
    const d = deps({ env: { NEXT_PUBLIC_CONTRACT_1: CONTRACT_MAINNET } });
    const decrypt = req("POST", "/", { body: publicDecryptBody([handleFor(1)]), headers: { "content-type": "application/json" } });
    for (const [r, path] of [[decrypt, ["v2", "public-decrypt"]], [req("GET"), ["v2", "public-decrypt", "job-1"]]] as const) {
      const res = await call(r, "1", [...path], d);
      expect(res.status).toBe(403);
      const j = await res.json();
      expect(j.error.label).toBe("relayer_not_configured");
      expect(j.error.message).toMatch(/^relayer_not_configured: .*ZAMA_RELAYER_API_KEY/);
    }
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("Sepolia: the relayer is open, so with no key it forwards without x-api-key", async () => {
    const d = deps({ env: { NEXT_PUBLIC_CONTRACT_11155111: CONTRACT_SEPOLIA } });
    const res = await call(req("GET"), "11155111", ["v2", "keyurl"], d);
    expect(res.status).toBe(200);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("https://relayer.testnet.zama.org/v2/keyurl");
    expect(Object.keys(init?.headers as Record<string, string>)).not.toContain("x-api-key");
  });

  it("Sepolia: a client-supplied x-api-key is still never forwarded when no key is configured", async () => {
    const d = deps({ env: { NEXT_PUBLIC_CONTRACT_11155111: CONTRACT_SEPOLIA } });
    const r = req("GET", "/api/relayer/11155111/v2/keyurl", { headers: { "x-api-key": "client-supplied" } });
    await call(r, "11155111", ["v2", "keyurl"], d);
    expect(JSON.stringify(d.fetch.mock.calls[0]![1]?.headers)).not.toMatch(/client-supplied/);
  });

  it("blank key counts as missing", async () => {
    const d = deps({ env: { ...baseEnv(), ZAMA_RELAYER_API_KEY: "   " } });
    expect((await call(req("GET"), "1", ["v2", "keyurl"], d)).status).toBe(503);
  });

  it("injects x-api-key upstream, to the default relayer, with only allowlisted headers", async () => {
    const d = deps();
    const r = req("GET", "/api/relayer/11155111/v2/keyurl", {
      headers: {
        cookie: "session=abc", authorization: "Bearer user", "x-api-key": "client-supplied",
        "x-forwarded-for": "203.0.113.9", accept: "application/json",
        "zama-sdk-name": "@fhevm/sdk", "zama-sdk-version": "0.13.2", origin: "https://dms.example",
      },
    });
    const res = await call(r, "11155111", ["v2", "keyurl"], d);
    expect(res.status).toBe(200);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("https://relayer.testnet.zama.org/v2/keyurl");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.cache).toBe("no-store");
    const h = init?.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe(KEY);
    expect(Object.keys(h).sort()).toEqual(["accept", "x-api-key", "zama-sdk-name", "zama-sdk-version"]);
    expect(JSON.stringify(h)).not.toMatch(/session=abc|Bearer user|client-supplied|203\.0\.113\.9/);
  });

  it("per-chain key and URL override the global ones", async () => {
    const d = deps({
      env: {
        ...baseEnv(), ZAMA_RELAYER_API_KEY_1: "mainnet-key",
        ZAMA_RELAYER_URL_1: "https://relayer.internal.example/base/",
      },
    });
    await call(req("GET"), "1", ["v2", "keyurl"], d);
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("https://relayer.internal.example/base/v2/keyurl");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("mainnet-key");
  });

  it("an empty or blank per-chain key falls back to ZAMA_RELAYER_API_KEY (dotenv loads `KEY_1=` as \"\")", async () => {
    for (const blank of ["", "   "]) {
      const d = deps({
        env: { ...baseEnv(), ZAMA_RELAYER_API_KEY_1: blank, ZAMA_RELAYER_API_KEY_11155111: blank },
      });
      for (const chainId of ["1", "11155111"]) {
        const res = await call(req("GET"), chainId, ["v2", "keyurl"], d);
        expect(res.status).toBe(200);
      }
      expect(d.fetch).toHaveBeenCalledTimes(2);
      for (const [, init] of d.fetch.mock.calls) {
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
      }
    }
  });

  it("per-chain key is trimmed; blank per-chain key with no global key is still 503", async () => {
    const d = deps({ env: { ...baseEnv(), ZAMA_RELAYER_API_KEY_1: "  mainnet-key \n" } });
    await call(req("GET"), "1", ["v2", "keyurl"], d);
    expect((d.fetch.mock.calls[0]![1]?.headers as Record<string, string>)["x-api-key"]).toBe("mainnet-key");
    const d2 = deps({ env: { NEXT_PUBLIC_CONTRACT_1: CONTRACT_MAINNET, ZAMA_RELAYER_API_KEY_1: "" } });
    expect((await call(req("GET"), "1", ["v2", "keyurl"], d2)).status).toBe(503);
    expect(d2.fetch).not.toHaveBeenCalled();
  });

  it("refuses a non-https relayer URL override (except localhost)", async () => {
    const d = deps({ env: { ...baseEnv(), ZAMA_RELAYER_URL_1: "http://relayer.example" } });
    expect((await call(req("GET"), "1", ["v2", "keyurl"], d)).status).toBe(503);
    const d2 = deps({ env: { ...baseEnv(), ZAMA_RELAYER_URL_1: "http://127.0.0.1:3999" } });
    expect((await call(req("GET"), "1", ["v2", "keyurl"], d2)).status).toBe(200);
    expect(d2.fetch.mock.calls[0]![0]).toBe("http://127.0.0.1:3999/v2/keyurl");
  });

  it("never returns the key, even if upstream echoes it; drops upstream cookies; forces safe content-type", async () => {
    const d = deps({
      fetch: okUpstream(`{"echo":"${KEY}","nested":{"k":"${KEY}"}}`, {
        "set-cookie": "relayer=1", "x-api-key": KEY, "content-type": "text/html", "retry-after": "3",
      }),
    });
    const res = await call(req("GET"), "1", ["v2", "input-proof", "job-1"], d);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).toContain("[redacted]");
    const hdrs = [...res.headers.entries()];
    expect(JSON.stringify(hdrs)).not.toContain(KEY);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("3");
  });

  it("passes the relayer status through (e.g. 202 queued for a job)", async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response('{"status":"queued","result":{"jobId":"j1"}}', {
        status: 202, headers: { "content-type": "application/json", "retry-after": "2" },
      })),
    });
    const res = await call(req("POST", "/", { body: publicDecryptBody(), headers: { "content-type": "application/json" } }), "11155111", ["v2", "public-decrypt"], d);
    expect(res.status).toBe(202);
    expect(res.headers.get("retry-after")).toBe("2");
    expect((await res.json()).result.jobId).toBe("j1");
  });
});

describe("handleRelayerRequest — POST bodies", () => {
  const post = (body: BodyInit, headers: Record<string, string> = { "content-type": "application/json" }) =>
    req("POST", "/", { body, headers, ...(body instanceof ReadableStream ? ({ duplex: "half" } as { duplex: string }) : {}) });

  it("forwards a realistic input proof (~38.5 KB) unchanged", async () => {
    const d = deps();
    const body = inputProofBody();
    expect(body.length).toBeGreaterThan(38_000);
    const res = await call(post(body), "11155111", ["v2", "input-proof"], d);
    expect(res.status).toBe(200);
    const [url, init] = d.fetch.mock.calls[0]!;
    expect(url).toBe("https://relayer.testnet.zama.org/v2/input-proof");
    expect(init?.method).toBe("POST");
    expect(await new Response(init?.body as BodyInit).text()).toBe(body);
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("413 above the input-proof cap (declared content-length)", async () => {
    const d = deps();
    const body = inputProofBody({}, BODY_LIMITS["input-proof"]); // hex doubles it
    const res = await call(post(body, { "content-type": "application/json", "content-length": String(body.length) }), "11155111", ["v2", "input-proof"], d);
    expect(res.status).toBe(413);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("413 above the cap when streamed without a content-length", async () => {
    const d = deps();
    const big = new TextEncoder().encode(inputProofBody({}, BODY_LIMITS["input-proof"]));
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < big.length; i += 16_384) c.enqueue(big.slice(i, i + 16_384)); c.close(); },
    });
    const res = await call(post(stream), "11155111", ["v2", "input-proof"], d);
    expect(res.status).toBe(413);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("413 above the (small) public-decrypt cap", async () => {
    const d = deps();
    const res = await call(post(publicDecryptBody([handleFor(11155111)], "0x" + "00".repeat(BODY_LIMITS["public-decrypt"]))), "11155111", ["v2", "public-decrypt"], d);
    expect(res.status).toBe(413);
  });

  it("415 for non-JSON content types, 400 for invalid JSON", async () => {
    const d = deps();
    expect((await call(post(inputProofBody(), { "content-type": "text/plain" }), "11155111", ["v2", "input-proof"], d)).status).toBe(415);
    expect((await call(post("{not json"), "11155111", ["v2", "input-proof"], d)).status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("input proofs only for this app's contract and this chain", async () => {
    const d = deps();
    const other = await call(post(inputProofBody({ contractAddress: "0x1111111111111111111111111111111111111111" })), "11155111", ["v2", "input-proof"], d);
    expect(other.status).toBe(403);
    const wrongChain = await call(post(inputProofBody({ contractChainId: "0x1" })), "11155111", ["v2", "input-proof"], d);
    expect(wrongChain.status).toBe(400);
    const extraKey = await call(post(inputProofBody({ evil: 1 })), "11155111", ["v2", "input-proof"], d);
    expect(extraKey.status).toBe(400);
    const notHex = await call(post(inputProofBody({ ciphertextWithInputVerification: "zz" })), "11155111", ["v2", "input-proof"], d);
    expect(notHex.status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("duplicate JSON keys: what is forwarded is exactly what was validated (no parser differential upstream)", async () => {
    // JSON.parse keeps the LAST duplicate; a first-wins parser upstream would read the foreign contract / handle.
    const FOREIGN = "0x1111111111111111111111111111111111111111";
    const dupProof = inputProofBody().replace('"contractAddress":', `"contractAddress":"${FOREIGN}","contractAddress":`);
    expect(JSON.parse(dupProof).contractAddress).toBe(CONTRACT_SEPOLIA);
    const dupDecrypt = publicDecryptBody().replace('"ciphertextHandles":', `"ciphertextHandles":["${handleFor(1, 5)}","${handleFor(1, 5)}"],"ciphertextHandles":`);
    const d = deps();
    for (const [body, path] of [[dupProof, "input-proof"], [dupDecrypt, "public-decrypt"]] as const) {
      const res = await call(post(body), "11155111", ["v2", path], d);
      expect(res.status).toBe(200);
      const sent = await new Response(d.fetch.mock.calls.at(-1)![1]?.body as BodyInit).text();
      expect(sent).toBe(JSON.stringify(JSON.parse(body)));
      expect(sent).not.toContain(FOREIGN);
      expect(sent).not.toContain(handleFor(1, 5));
    }
  });

  it("input proofs when the contract address is not configured: a 403 whose label and message the SDK surfaces", async () => {
    const d = deps({ env: { ZAMA_RELAYER_API_KEY: KEY } });
    const res = await call(post(inputProofBody()), "11155111", ["v2", "input-proof"], d);
    // The SDK reads `error.message` of a 403 into its error (a 503 must match the relayer's schema, and this one cannot).
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error.label).toBe("contract_not_configured");
    expect(j.error.message).toMatch(/^contract_not_configured: .*NEXT_PUBLIC_CONTRACT_11155111/);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("an address compiled into the app (lib/deployments.ts, no env variable) is the proxy's allowed contract too", async () => {
    const hardcoded = { 11155111: CONTRACT_SEPOLIA } as const;
    expect(allowedContractFor(11155111, {}, hardcoded)).toBe(CONTRACT_SEPOLIA.toLowerCase());
    // The env variable still wins, as in the browser bundle (contractFor).
    expect(allowedContractFor(11155111, { NEXT_PUBLIC_CONTRACT_11155111: CONTRACT_MAINNET }, hardcoded)).toBe(CONTRACT_MAINNET.toLowerCase());
    expect(allowedContractFor(1, {}, hardcoded)).toBeUndefined();
    const d = deps({ env: {}, deployments: hardcoded });
    const res = await call(post(inputProofBody()), "11155111", ["v2", "input-proof"], d);
    expect(res.status).toBe(200);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("the proxy and the browser bundle resolve the contract with one rule (lib/deployments.ts deploymentFor)", () => {
    for (const [envValue, hard] of [[undefined, CONTRACT_SEPOLIA], [CONTRACT_MAINNET, CONTRACT_SEPOLIA], [" bad ", CONTRACT_SEPOLIA], [undefined, undefined]] as const) {
      const map = { 11155111: hard };
      const env: Env = envValue === undefined ? {} : { NEXT_PUBLIC_CONTRACT_11155111: envValue };
      expect(allowedContractFor(11155111, env, map)).toBe(deploymentFor(11155111, envValue, map)?.toLowerCase());
    }
  });

  it("a foreign contract: 403 labelled contract_mismatch (the browser bundle and the server disagree)", async () => {
    const d = deps();
    const res = await call(post(inputProofBody({ contractAddress: "0x1111111111111111111111111111111111111111" })), "11155111", ["v2", "input-proof"], d);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({ label: "contract_mismatch", message: expect.stringMatching(/^contract_mismatch: /) });
  });

  it("G16: the contract_mismatch refusal says the page is out of date and to reload it (the usual cause: a tab from before a redeploy)", async () => {
    const res = await call(post(inputProofBody({ contractAddress: "0x1111111111111111111111111111111111111111" })), "11155111", ["v2", "input-proof"], deps());
    const { message } = (await res.json()).error as { message: string };
    expect(message).toMatch(/out of date/i);
    expect(message).toMatch(/reload the page/i);
    expect(message.toLowerCase()).toContain(CONTRACT_SEPOLIA.toLowerCase());
  });

  it("public decrypt: exactly one euint256 handle of this chain", async () => {
    const d = deps();
    const two = await call(post(publicDecryptBody([handleFor(11155111), handleFor(11155111)])), "11155111", ["v2", "public-decrypt"], d);
    expect(two.status).toBe(400);
    const none = await call(post(publicDecryptBody([])), "11155111", ["v2", "public-decrypt"], d);
    expect(none.status).toBe(400);
    const mainnetHandle = await call(post(publicDecryptBody([handleFor(1)])), "11155111", ["v2", "public-decrypt"], d);
    expect(mainnetHandle.status).toBe(400);
    const euint64 = await call(post(publicDecryptBody([handleFor(11155111, 5)])), "11155111", ["v2", "public-decrypt"], d);
    expect(euint64.status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
    const ok = await call(post(publicDecryptBody()), "11155111", ["v2", "public-decrypt"], d);
    expect(ok.status).toBe(200);
  });
});

describe("handleRelayerRequest — upstream failures", () => {
  it("does not follow redirects (they would carry the key)", async () => {
    const d = deps({ fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) });
    const res = await call(req("GET"), "1", ["v2", "keyurl"], d);
    expect(res.status).toBe(502);
  });

  it("504 on upstream timeout, 502 when unreachable; no key in the error", async () => {
    const t = deps({ fetch: vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }) });
    const r1 = await call(req("GET"), "1", ["v2", "keyurl"], t);
    expect(r1.status).toBe(504);
    const u = deps({ fetch: vi.fn(async () => { throw new TypeError(`fetch failed for key ${KEY}`); }) });
    const r2 = await call(req("GET"), "1", ["v2", "keyurl"], u);
    expect(r2.status).toBe(502);
    expect(await r2.text()).not.toContain(KEY);
  });

  it("an upstream that times out or drops the connection mid-body is a 504 / 502, not an unhandled error", async () => {
    const failingBody = (err: Error) => vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"status":"succ')); c.error(err); },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const t = await call(req("GET"), "1", ["v2", "keyurl"], deps({ fetch: failingBody(new DOMException("timed out", "TimeoutError")) }));
    expect(t.status).toBe(504);
    const r = await call(req("GET"), "1", ["v2", "keyurl"], deps({ fetch: failingBody(new TypeError(`terminated: other side closed, key ${KEY}`)) }));
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(KEY);
  });

  it.each([204, 205])("an upstream %i is passed through with an empty body, not a 500", async (status) => {
    const d = deps({ fetch: vi.fn(async () => new Response(null, { status, headers: { "content-type": "text/html" } })) });
    const res = await call(req("GET"), "1", ["v2", "input-proof", "job-1"], d);
    expect(res.status).toBe(status);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("passes upstream timeout signal", async () => {
    const d = deps();
    await call(req("GET"), "1", ["v2", "keyurl"], d);
    expect(d.fetch.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  // The SDK's request loop (proxy.sdk.test.ts) retries only a relayer-shaped 429 on a POST and a 202 "queued"
  // on a poll; a 502/504 ends the job. keyurl is fetched by lib/fhevm.ts itself and keeps its plain statuses.
  it("an upstream failure on a poll: 202 queued with a short Retry-After (the SDK polls again)", async () => {
    for (const err of [new DOMException("timed out", "TimeoutError"), new TypeError(`fetch failed for key ${KEY}`)]) {
      const res = await call(req("GET"), "1", ["v2", "public-decrypt", "job-1"], deps({ fetch: vi.fn(async () => { throw err; }) }));
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "queued", requestId: "proxy-upstream-retry" });
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    }
  });

  it("an outage: after MAX_UPSTREAM_RETRIES failures in a row the poll gets the 502/504 the SDK ends on; an answer resets the count", async () => {
    const failures = new UpstreamFailures();
    let down = true;
    const fetch = vi.fn(async () => {
      if (down) throw new TypeError(`fetch failed for key ${KEY}`);
      return new Response('{"status":"queued","requestId":"r"}', { status: 202, headers: { "content-type": "application/json" } });
    });
    // The SDK polls again after Retry-After (3 s); simultaneous failures of one request count as one round.
    let clock = 1_000_000;
    const d = deps({ fetch, upstreamFailures: failures, now: () => clock });
    const poll = () => { clock += 3_000; return call(req("GET"), "1", ["v2", "public-decrypt", "job-1"], d); };
    for (let i = 0; i < MAX_UPSTREAM_RETRIES; i++) expect((await poll()).status).toBe(202);
    const failed = await poll();
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(KEY);
    // The relayer is back: its answer passes, and the next failure is retried again.
    down = false;
    expect((await poll()).status).toBe(202);
    down = true;
    expect(await (await poll()).json()).toEqual({ status: "queued", requestId: "proxy-upstream-retry" });
    // Another job of the same client has its own count.
    expect((await call(req("GET"), "1", ["v2", "public-decrypt", "job-2"], d)).status).toBe(202);
    // Failures of the same job at the same moment (several users behind one IP) are one round.
    const burst = new UpstreamFailures();
    const same = deps({ fetch, upstreamFailures: burst, now: () => clock });
    for (let i = 0; i < 2 * MAX_UPSTREAM_RETRIES + 1; i++) {
      expect((await call(req("GET"), "1", ["v2", "public-decrypt", "job-3"], same)).status).toBe(202);
    }
  });

  it("an upstream failure on a POST: 429 protocol_overload in the relayer's shape (the SDK posts again)", async () => {
    const d = deps({ fetch: vi.fn(async () => { throw new TypeError(`fetch failed for key ${KEY}`); }) });
    const post = req("POST", "/", { body: publicDecryptBody(), headers: { "content-type": "application/json" } });
    const res = await call(post, "11155111", ["v2", "public-decrypt"], d);
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ status: "failed", error: { label: "protocol_overload", message: expect.any(String) } });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});

describe("rate limiting", () => {
  it("429 with Retry-After once a client exceeds its per-minute budget; other clients unaffected", async () => {
    const d = deps();
    const from = (ip: string) => req("GET", "/", { headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });
    for (let i = 0; i < RATE_LIMITS.keyurl; i++) {
      expect((await call(from("198.51.100.7"), "1", ["v2", "keyurl"], d)).status).toBe(200);
    }
    const limited = await call(from("198.51.100.7"), "1", ["v2", "keyurl"], d);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call(from("198.51.100.8"), "1", ["v2", "keyurl"], d)).status).toBe(200);
    // Polling has its own, larger bucket.
    expect((await call(from("198.51.100.7"), "1", ["v2", "input-proof", "job"], d)).status).toBe(200);
    // Window resets.
    const later = { ...d, now: () => 1_000_000 + 60_000 };
    expect((await call(from("198.51.100.7"), "1", ["v2", "keyurl"], later)).status).toBe(200);
  });

  it("on the SDK's paths a throttle is answered in the relayer's shape, and nothing reaches upstream", async () => {
    const d = deps();
    const from = () => req("GET", "/", { headers: { "x-forwarded-for": "198.51.100.9" } });
    const postFrom = () => req("POST", "/", { body: publicDecryptBody(), headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" } });
    for (let i = 0; i < RATE_LIMITS.poll; i++) await call(from(), "11155111", ["v2", "public-decrypt", "job"], d);
    for (let i = 0; i < RATE_LIMITS["public-decrypt"]; i++) await call(postFrom(), "11155111", ["v2", "public-decrypt"], d);
    const calls = d.fetch.mock.calls.length;
    const poll = await call(from(), "11155111", ["v2", "public-decrypt", "job"], d);
    expect(poll.status).toBe(202);
    expect(await poll.json()).toEqual({ status: "queued", requestId: "proxy-throttled" });
    expect(Number(poll.headers.get("retry-after"))).toBeGreaterThan(0);
    const posted = await call(postFrom(), "11155111", ["v2", "public-decrypt"], d);
    expect(posted.status).toBe(429);
    expect(await posted.json()).toMatchObject({ status: "failed", error: { label: "rate_limited", message: expect.any(String) } });
    expect(Number(posted.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(d.fetch.mock.calls.length).toBe(calls);
  });

  it("the limiter stays bounded", () => {
    const l = new FixedWindowRateLimiter(100);
    for (let i = 0; i < 1000; i++) l.take(`ip${i}`, 5, 0);
    expect(l.take("fresh", 5, 0)).toBe(0);
  });
});

describe("route.ts wiring", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ZAMA_RELAYER_API_KEY = KEY;
    process.env.NEXT_PUBLIC_CONTRACT_11155111 = CONTRACT_SEPOLIA;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it("exports GET/POST on the Node runtime, uncached", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    expect(typeof route.GET).toBe("function");
    expect(typeof route.POST).toBe("function");
    expect((route as Record<string, unknown>).PUT).toBeUndefined();
  });

  it("GET proxies through global fetch with the key from process.env", async () => {
    const f = okUpstream();
    vi.stubGlobal("fetch", f);
    const res = await route.GET(req("GET", "/api/relayer/11155111/v2/keyurl", { headers: { "x-forwarded-for": "192.0.2.50" } }), {
      params: Promise.resolve({ chainId: "11155111", path: ["v2", "keyurl"] }),
    });
    expect(res.status).toBe(200);
    expect((f.mock.calls[0]![1]?.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
  });

  it("no key on mainnet: refused without calling upstream", async () => {
    delete process.env.ZAMA_RELAYER_API_KEY;
    const f = okUpstream();
    vi.stubGlobal("fetch", f);
    const res = await route.POST(req("POST", "/", { body: publicDecryptBody([handleFor(1)]), headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.51" } }), {
      params: Promise.resolve({ chainId: "1", path: ["v2", "public-decrypt"] }),
    });
    // An SDK path: a 403 the SDK surfaces (keyurl keeps its 503, see "mainnet: 503 …").
    expect(res.status).toBe(403);
    expect((await res.json()).error.label).toBe("relayer_not_configured");
    expect(f).not.toHaveBeenCalled();
  });

  it("Sepolia without a key proxies without x-api-key", async () => {
    delete process.env.ZAMA_RELAYER_API_KEY;
    const f = okUpstream();
    vi.stubGlobal("fetch", f);
    const res = await route.POST(req("POST", "/", { body: publicDecryptBody(), headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.52" } }), {
      params: Promise.resolve({ chainId: "11155111", path: ["v2", "public-decrypt"] }),
    });
    expect(res.status).toBe(200);
    expect(Object.keys(f.mock.calls[0]![1]?.headers as Record<string, string>)).not.toContain("x-api-key");
  });
});
