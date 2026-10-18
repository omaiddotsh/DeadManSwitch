// Regression tests from the 2026-10 review: relayer proxy policy (client address
// behind the edge, which relayer gets the mainnet key) and a byte-level
// cross-check of lib/envelope.ts against client/src/envelope.ts.

import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { FixedWindowRateLimiter, RATE_LIMITS, clientIp, handleRelayerRequest } from "@/app/api/relayer/proxy";
import * as fe from "@/lib/envelope";

/**
 * client/src/envelope.ts, loaded at run time only: a static import would pull the client's sources into
 * this project's TypeScript program (another @types/node, so its WebCrypto BufferSource typing fails
 * `next build`). The specifier is not a literal, so tsc does not resolve it; vitest does.
 */
interface CliEnvelope {
  seal(plaintext: Uint8Array, opts?: { dek?: Uint8Array }): Promise<{ ciphertext: Uint8Array; commitment: `0x${string}`; salt: Uint8Array }>;
  open(ciphertext: Uint8Array, dek: Uint8Array): Promise<{ salt: Uint8Array; plaintext: Uint8Array; commitment: `0x${string}` }>;
  verifyCommitment(salt: Uint8Array, plaintext: Uint8Array, commitment: `0x${string}`): boolean;
}
const cliEnvelopePath = new URL("../../client/src/envelope.ts", import.meta.url).pathname;
const cliEnvelope = (): Promise<CliEnvelope> => import(/* @vite-ignore */ cliEnvelopePath) as Promise<CliEnvelope>;

// ---------- helpers ----------

interface Seen { url: string; method: string; headers: Record<string, string>; body: string }

/** A fake upstream relayer that records what the proxy sends it and answers like a queued job. */
const fakeUpstream = () => {
  const seen: Seen[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body instanceof Blob ? await init.body.text() : String(init?.body ?? "");
    seen.push({ url: String(url), method: init?.method ?? "GET", headers, body });
    return new Response(JSON.stringify({ status: "queued", requestId: "job-1" }), {
      status: 202, headers: { "content-type": "application/json" },
    });
  };
  return { seen, fetch: fetch as unknown as typeof globalThis.fetch };
};

const req = (method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}) =>
  new Request(`http://app.local/api/relayer/${path}`, {
    method, headers: opts.headers, body: opts.body,
  });

const ENV = {
  ZAMA_RELAYER_API_KEY: "MAINNET-KEY-abc123",
  ZAMA_RELAYER_URL_1: "https://relayer.mainnet.zama.org",
  ZAMA_RELAYER_URL_11155111: "https://relayer.testnet.zama.org",
  NEXT_PUBLIC_CONTRACT_1: "0x2222222222222222222222222222222222222222",
  NEXT_PUBLIC_CONTRACT_11155111: "0x1111111111111111111111111111111111111111",
};

// ---------- relayer proxy ----------

describe("relayer proxy policy (app/api/relayer/proxy.ts)", () => {
  it("the per-IP rate limit is keyed on the entry the edge appended, so a fake first X-Forwarded-For entry does not escape it", async () => {
    const limiter = new FixedWindowRateLimiter();
    const up = fakeUpstream();
    const now = 1_000_000;
    const limit = RATE_LIMITS.keyurl;
    let allowed = 0;
    for (let i = 1; i <= limit * 3; i++) {
      const r = await handleRelayerRequest(
        req("GET", "11155111/v2/keyurl", { headers: { "x-forwarded-for": `10.0.0.${i}, 203.0.113.9` } }),
        { chainId: "11155111", path: ["v2", "keyurl"] },
        { fetch: up.fetch, env: ENV, limiter, now: () => now },
      );
      if (r.status !== 429) allowed++;
    }
    expect(allowed).toBe(limit);
    expect(up.seen).toHaveLength(limit);
    expect(clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "spoofed, 203.0.113.9" } }))).toBe("203.0.113.9");
  });

  it("the global ZAMA_RELAYER_API_KEY (the mainnet key) is not sent to the open Sepolia relayer", async () => {
    const up = fakeUpstream();
    const res = await handleRelayerRequest(
      req("GET", "11155111/v2/keyurl"),
      { chainId: "11155111", path: ["v2", "keyurl"] },
      { fetch: up.fetch, env: ENV, limiter: new FixedWindowRateLimiter() },
    );
    expect(res.status).toBe(202);
    expect(up.seen[0]!.url).toBe("https://relayer.testnet.zama.org/v2/keyurl");
    expect(up.seen[0]!.headers["x-api-key"]).toBeUndefined();
    const mainnet = await handleRelayerRequest(
      req("GET", "1/v2/keyurl"),
      { chainId: "1", path: ["v2", "keyurl"] },
      { fetch: up.fetch, env: ENV, limiter: new FixedWindowRateLimiter() },
    );
    expect(mainnet.status).toBe(202);
    expect(up.seen[1]!.headers["x-api-key"]).toBe("MAINNET-KEY-abc123");
  });
});

// ---------- envelope cross-implementation ----------

describe("review: lib/envelope.ts is byte-compatible with client/src/envelope.ts", () => {
  const dek = webcrypto.getRandomValues(new Uint8Array(32));
  const plaintext = new TextEncoder().encode("cross-impl ✓ " + "x".repeat(2048 - 20)); // near the cap

  it("frontend seal → client open (tag, salt, commitment)", async () => {
    const cli = await cliEnvelope();
    const sealed = await fe.seal(plaintext, { dek });
    expect(sealed.ciphertext.length).toBe(plaintext.length + 61);
    const opened = await cli.open(sealed.ciphertext, dek);
    expect(Buffer.from(opened.plaintext)).toEqual(Buffer.from(plaintext));
    expect(Buffer.from(opened.salt)).toEqual(Buffer.from(sealed.salt));
    expect(opened.commitment.toLowerCase()).toBe(sealed.commitment.toLowerCase());
    expect(cli.verifyCommitment(opened.salt, opened.plaintext, sealed.commitment)).toBe(true);
  });

  it("client seal → frontend open / checkKey", async () => {
    const cli = await cliEnvelope();
    const sealed = await cli.seal(plaintext, { dek });
    const check = await fe.checkKey(dek, sealed.ciphertext, sealed.commitment);
    expect(check.status).toBe("ok");
    if (check.status === "ok") {
      expect(Buffer.from(check.plaintext)).toEqual(Buffer.from(plaintext));
      expect(check.saltHex.toLowerCase()).toBe(fe.bytesToHex(sealed.salt).toLowerCase());
    }
  });

  it("both refuse 2,049 bytes and both accept the 61-byte minimum", async () => {
    const cli = await cliEnvelope();
    const big = new Uint8Array(2049);
    await expect(fe.seal(big)).rejects.toMatchObject({ code: "PLAINTEXT_TOO_LARGE" });
    await expect(cli.seal(big)).rejects.toMatchObject({ code: "payload-too-large" });
    // The contract accepts an empty plaintext (61 bytes). The CLI seals it; the frontend refuses to SEAL it
    // (a UI choice) but must still OPEN one the CLI made.
    const empty = await cli.seal(new Uint8Array(0), { dek });
    expect(empty.ciphertext.length).toBe(61);
    const opened = await fe.open(dek, empty.ciphertext);
    expect(opened.plaintext.length).toBe(0);
  });
});
