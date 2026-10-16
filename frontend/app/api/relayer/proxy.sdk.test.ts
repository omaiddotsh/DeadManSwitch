// The browser SDK talks to Zama's relayer only through this proxy, so the
// proxy's own answers must be ones the SDK's request loop understands. These
// tests run the SDK's real state machine (@fhevm/sdk 0.13.2
// RelayerAsyncRequest: POST, then GET polls at Retry-After) against
// handleRelayerRequest and a fake upstream relayer. RelayerAsyncRequest is not
// in the package's exports, so it is imported by file path; the expectations
// are pinned to that SDK version (see the @fhevm/sdk version check below).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedWindowRateLimiter, RATE_LIMITS, UpstreamFailures, handleRelayerRequest, type Env } from "./proxy";

const SDK_DIR = fileURLToPath(new URL("../../../node_modules/@fhevm/sdk/", import.meta.url));
const SDK_REQUEST = `${SDK_DIR}_esm/core/modules/relayer/module/RelayerAsyncRequest.js`;

type Operation = "INPUT_PROOF" | "PUBLIC_DECRYPT";
interface SdkRequest { run(): Promise<unknown> }
type SdkRequestCtor = new (p: { relayerOperation: Operation; url: string; payload: unknown; options?: { timeout?: number } }) => SdkRequest;
const loadSdk = async (): Promise<SdkRequestCtor> =>
  ((await import(/* @vite-ignore */ SDK_REQUEST)) as { RelayerAsyncRequest: SdkRequestCtor }).RelayerAsyncRequest;

const ORIGIN = "https://dms.example";
const CONTRACT = "0x00000000000000000000000000000000000d3ad5";
const HANDLE = `0x${"ab".repeat(21)}00${(11155111).toString(16).padStart(16, "0")}0800`;
const IP = "203.0.113.9";

const payloads: Record<Operation, unknown> = {
  PUBLIC_DECRYPT: { ciphertextHandles: [HANDLE], extraData: "0x00" },
  INPUT_PROOF: {
    ciphertextWithInputVerification: "ab".repeat(64), contractAddress: CONTRACT, contractChainId: "0xaa36a7",
    extraData: "0x00", userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  },
};
const results: Record<Operation, unknown> = {
  PUBLIC_DECRYPT: { signatures: ["ab".repeat(65)], decryptedValue: "11".repeat(32), extraData: "0x00" },
  INPUT_PROOF: { accepted: true, extraData: "0x00", handles: [HANDLE], signatures: [`0x${"cd".repeat(65)}`] },
};

/**
 * A relayer: every POST queues a job that answers "queued" to `pendingPolls`
 * GETs, then succeeds. `fail(n)` makes the next n upstream calls (of `method`) throw `error`.
 */
const fakeRelayer = (o: { pendingPolls: number; retryAfter?: number }) => {
  const jobs = new Map<string, number>();
  const failures: { method: "GET" | "POST"; error: () => Error }[] = [];
  let n = 0;
  const headers = { "content-type": "application/json", "retry-after": String(o.retryAfter ?? 1) };
  const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET") as "GET" | "POST";
    const i = failures.findIndex((f) => f.method === method);
    if (i >= 0) throw failures.splice(i, 1)[0]!.error();
    const path = new URL(String(url)).pathname;
    if (method === "POST") {
      const jobId = `job-${++n}`;
      jobs.set(jobId, o.pendingPolls);
      return new Response(JSON.stringify({ status: "queued", requestId: `req-${n}`, result: { jobId } }), { status: 202, headers });
    }
    const jobId = path.split("/").at(-1)!;
    const left = jobs.get(jobId) ?? 0;
    if (left > 0) {
      jobs.set(jobId, left - 1);
      return new Response(JSON.stringify({ status: "queued", requestId: `req-${jobId}` }), { status: 202, headers });
    }
    const op: Operation = path.includes("input-proof") ? "INPUT_PROOF" : "PUBLIC_DECRYPT";
    return new Response(JSON.stringify({ status: "succeeded", requestId: `req-${jobId}`, result: results[op] }), { status: 200, headers });
  });
  return { upstream, fail: (method: "GET" | "POST", error: () => Error) => failures.push({ method, error }) };
};

const env = (over: Env = {}): Env => ({ NEXT_PUBLIC_CONTRACT_11155111: CONTRACT, ...over });

/** Route the SDK's fetches (`${ORIGIN}/api/relayer/<chain>/…`) into the proxy, as Next's route does. */
const routeToProxy = (d: { upstream: typeof fetch; limiter: FixedWindowRateLimiter; env?: Env }) => {
  const failures = new UpstreamFailures();
  const statuses: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const [, , , chainId, ...path] = url.pathname.split("/");
    const res = await handleRelayerRequest(
      new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-forwarded-for": IP } }),
      { chainId: chainId!, path },
      { env: d.env ?? env(), fetch: d.upstream, limiter: d.limiter, now: () => Date.now(), upstreamFailures: failures },
    );
    statuses.push(`${init?.method ?? "GET"} ${res.status}`);
    return res;
  }));
  return statuses;
};

const run = async (Req: SdkRequestCtor, op: Operation) => {
  const endpoint = op === "INPUT_PROOF" ? "input-proof" : "public-decrypt";
  const r = new Req({ relayerOperation: op, url: `${ORIGIN}/api/relayer/11155111/v2/${endpoint}`, payload: payloads[op], options: { timeout: 10 * 60_000 } });
  return r.run();
};

/** Settle `p` while advancing fake time; returns its value or error. */
const settle = async <T,>(p: Promise<T>, ms: number) => {
  const out: { value?: T; error?: Error } = {};
  p.then((v) => { out.value = v; }, (e: Error) => { out.error = e; });
  for (let t = 0; t < ms && !out.value && !out.error; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
  return out;
};

const fill = (limiter: FixedWindowRateLimiter, bucket: keyof typeof RATE_LIMITS, n: number) => {
  for (let i = 0; i < n; i++) limiter.take(`${IP}|11155111|${bucket}`, RATE_LIMITS[bucket], Date.now());
};

beforeEach(() => { vi.useFakeTimers({ now: 1_700_000_000_000 }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the SDK these tests drive", () => {
  it("is @fhevm/sdk 0.13.2 (the request loop whose retry rules the proxy answers to)", () => {
    expect(JSON.parse(readFileSync(`${SDK_DIR}package.json`, "utf8")).version).toBe("0.13.2");
  });
});

describe("the proxy's own throttles and upstream failures make the SDK wait and retry, not give up", () => {
  it.each(["PUBLIC_DECRYPT", "INPUT_PROOF"] as const)("%s: the POST bucket is full: the SDK waits Retry-After and posts again", async (op) => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 1 });
    const limiter = new FixedWindowRateLimiter();
    fill(limiter, op === "INPUT_PROOF" ? "input-proof" : "public-decrypt", RATE_LIMITS[op === "INPUT_PROOF" ? "input-proof" : "public-decrypt"]);
    const statuses = routeToProxy({ upstream: relayer.upstream, limiter });
    const out = await settle(run(Req, op), 3 * 60_000);
    expect(out.error).toBeUndefined();
    expect(out.value).toBeDefined();
    expect(statuses[0]).toBe("POST 429");
  });

  it("the poll bucket runs out mid-job: the SDK keeps polling after Retry-After", async () => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 3 });
    const limiter = new FixedWindowRateLimiter();
    fill(limiter, "poll", RATE_LIMITS.poll - 1);
    const statuses = routeToProxy({ upstream: relayer.upstream, limiter });
    const out = await settle(run(Req, "PUBLIC_DECRYPT"), 3 * 60_000);
    expect(out.error).toBeUndefined();
    expect(out.value).toBeDefined();
    // The throttled polls never reached the relayer (the limiter still guards the key's quota).
    expect(relayer.upstream.mock.calls.filter(([, i]) => (i?.method ?? "GET") === "GET")).toHaveLength(4);
    expect(statuses.filter((s) => s === "GET 202").length).toBeGreaterThan(3);
  });

  it.each([
    ["a dropped connection (TypeError)", () => new TypeError("fetch failed")],
    ["an upstream timeout", () => new DOMException("The operation timed out.", "TimeoutError")],
  ])("%s on a poll: the SDK polls again", async (_name, error) => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 1 });
    relayer.fail("GET", error);
    routeToProxy({ upstream: relayer.upstream, limiter: new FixedWindowRateLimiter() });
    for (const op of ["PUBLIC_DECRYPT", "INPUT_PROOF"] as const) {
      relayer.fail("GET", error);
      const out = await settle(run(Req, op), 3 * 60_000);
      expect(out.error).toBeUndefined();
      expect(out.value).toBeDefined();
    }
  });

  it("an upstream failure on the POST: the SDK posts again", async () => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 1 });
    relayer.fail("POST", () => new TypeError("fetch failed"));
    routeToProxy({ upstream: relayer.upstream, limiter: new FixedWindowRateLimiter() });
    const out = await settle(run(Req, "INPUT_PROOF"), 3 * 60_000);
    expect(out.error).toBeUndefined();
    expect(out.value).toBeDefined();
  });

  it("three key fetches at once from one IP, each pending 60 polls at Retry-After 1: all finish", async () => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 60, retryAfter: 1 });
    routeToProxy({ upstream: relayer.upstream, limiter: new FixedWindowRateLimiter() });
    const outs = await Promise.all([0, 1, 2].map(() => settle(run(Req, "PUBLIC_DECRYPT"), 10 * 60_000)));
    for (const out of outs) {
      expect(out.error).toBeUndefined();
      expect(out.value).toBeDefined();
    }
  });
});

describe("the proxy's configuration errors reach the SDK's error message with their label", () => {
  const message = async (e: Env, op: Operation) => {
    const Req = await loadSdk();
    routeToProxy({ upstream: fakeRelayer({ pendingPolls: 0 }).upstream, limiter: new FixedWindowRateLimiter(), env: e });
    const out = await settle(run(Req, op), 60_000);
    expect(out.error).toBeDefined();
    return out.error!.message;
  };

  it("no contract address on the server: contract_not_configured, with the variable to set", async () => {
    const m = await message({}, "INPUT_PROOF");
    expect(m).toContain("contract_not_configured");
    expect(m).toContain("NEXT_PUBLIC_CONTRACT_11155111");
  });

  it("the browser's contract is not the server's: contract_mismatch", async () => {
    const m = await message(env({ NEXT_PUBLIC_CONTRACT_11155111: "0x1111111111111111111111111111111111111111" }), "INPUT_PROOF");
    expect(m).toContain("contract_mismatch");
  });

  it("a bad ZAMA_RELAYER_URL_<chainId>: relayer_misconfigured, on both SDK paths", async () => {
    for (const op of ["INPUT_PROOF", "PUBLIC_DECRYPT"] as const) {
      expect(await message(env({ ZAMA_RELAYER_URL_11155111: "http://relayer.example" }), op)).toContain("relayer_misconfigured");
    }
  });
});

describe("a relayer outage ends the job within seconds, with the status the SDK reports", () => {
  it.each(["INPUT_PROOF", "PUBLIC_DECRYPT"] as const)("%s: every upstream fetch fails (DNS / refused / TLS)", async (op) => {
    const Req = await loadSdk();
    const upstream = vi.fn(async () => { throw new TypeError("fetch failed (getaddrinfo ENOTFOUND relayer.testnet.zama.org)"); });
    const statuses = routeToProxy({ upstream: upstream as unknown as typeof fetch, limiter: new FixedWindowRateLimiter() });
    const t0 = Date.now();
    const out = await settle(run(Req, op), 12 * 60_000);
    expect(out.error?.message).toMatch(/unexpected response status: 50[24]/);
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(upstream.mock.calls.length).toBeLessThanOrEqual(4);
    expect(statuses.at(-1)).toMatch(/ 50[24]$/);
  });

  it("two failures in a row on a poll, then the relayer answers again: the job still finishes", async () => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 2 });
    relayer.fail("GET", () => new TypeError("fetch failed"));
    relayer.fail("GET", () => new TypeError("fetch failed"));
    routeToProxy({ upstream: relayer.upstream, limiter: new FixedWindowRateLimiter() });
    const out = await settle(run(Req, "PUBLIC_DECRYPT"), 3 * 60_000);
    expect(out.error).toBeUndefined();
    expect(out.value).toBeDefined();
  });

  it("the proxy's own throttle is still answered with a retry, however long it lasts", async () => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 1 });
    const limiter = new FixedWindowRateLimiter();
    fill(limiter, "public-decrypt", RATE_LIMITS["public-decrypt"]);
    routeToProxy({ upstream: relayer.upstream, limiter });
    const out = await settle(run(Req, "PUBLIC_DECRYPT"), 3 * 60_000);
    expect(out.error).toBeUndefined();
  });
});

describe("upstream failures on POSTs are counted per request, not per shared IP", () => {
  it("three users behind one IP, one transient upstream failure each: every job finishes", async () => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 1 });
    for (let i = 0; i < 3; i++) relayer.fail("POST", () => new TypeError("fetch failed (ECONNRESET)"));
    routeToProxy({ upstream: relayer.upstream, limiter: new FixedWindowRateLimiter() });
    const bodies = [0, 1, 2].map((i) => ({ ...(payloads.INPUT_PROOF as Record<string, unknown>), ciphertextWithInputVerification: `${i}${i}`.repeat(64) }));
    const outs = await Promise.all(bodies.map((payload) => settle(new Req({
      relayerOperation: "INPUT_PROOF", url: `${ORIGIN}/api/relayer/11155111/v2/input-proof`, payload, options: { timeout: 10 * 60_000 },
    }).run(), 3 * 60_000)));
    for (const o of outs) {
      expect(o.error).toBeUndefined();
      expect(o.value).toBeDefined();
    }
  });
});

describe("the same request from several users behind one IP (two hunters fetching one key)", () => {
  it.each(["INPUT_PROOF", "PUBLIC_DECRYPT"] as const)("%s: one transient failure each, at the same moment: every job finishes", async (op) => {
    const Req = await loadSdk();
    const relayer = fakeRelayer({ pendingPolls: 1 });
    for (let i = 0; i < 3; i++) relayer.fail("POST", () => new TypeError("fetch failed (ECONNRESET)"));
    routeToProxy({ upstream: relayer.upstream, limiter: new FixedWindowRateLimiter() });
    const outs = await Promise.all([0, 1, 2].map(() => settle(run(Req, op), 3 * 60_000)));
    for (const o of outs) {
      expect(o.error).toBeUndefined();
      expect(o.value).toBeDefined();
    }
  });
});
