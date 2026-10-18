// Server-side proxy to Zama's relayer. Injects the relayer API key so it never
// reaches the browser. Only the mainnet relayer needs a key; Zama's Sepolia
// relayer is open, so the global ZAMA_RELAYER_API_KEY (a mainnet secret) is
// never sent to it: a Sepolia key is sent only when given explicitly as
// ZAMA_RELAYER_API_KEY_11155111. Framework-free (Fetch API Request/Response) so it can be
// unit-tested; app/api/relayer/[chainId]/[...path]/route.ts is a thin wrapper.
//
// Surface — exactly what @zama-fhe/sdk 3.6.0 (→ @fhevm/sdk 0.13.2) calls for
// encrypt + public decrypt (read from node_modules/@fhevm/sdk/core/modules/relayer/module):
//
//   GET  v2/keyurl                       fetchFheEncryptionKeySource — returns absolute
//                                        URLs of the FHE public key + CRS; the browser
//                                        downloads those directly (public bucket, no key).
//   POST v2/input-proof                  fetchCoprocessorSignatures (RelayerAsyncRequest)
//   GET  v2/input-proof/<jobId>          …its polling loop (`${url}/${jobId}`)
//   POST v2/public-decrypt               fetchPublicDecrypt (RelayerAsyncRequest)
//   GET  v2/public-decrypt/<jobId>       …its polling loop
//
// Everything else (user-decrypt, delegated-user-decrypt, v1/v3 paths, other
// methods) is refused: the app never needs it and our API key should not
// fund it.
//
// Hardening:
//   - chains 1 and 11155111 only; GET/POST only; strict path table (fixed
//     segments compared literally, job ids limited to path-safe characters and
//     never "."/".."): no traversal, no absolute URLs, no encoded separators;
//     no query strings;
//   - POST bodies: JSON only, capped per endpoint, schema-checked: input proofs
//     only for THIS chain and THIS app's DeadManSwitch contract, public decrypts
//     for exactly one euint256 handle of THIS chain; the validated object is
//     what is forwarded (re-serialised, so duplicate keys cannot differ);
//   - forwards only content-type / accept / zama-sdk-{name,version}; never the
//     client's cookies, authorization or IP; sets x-api-key upstream when a
//     key is configured;
//   - upstream: https only (http allowed for localhost), timeout, no redirects
//     followed (a redirect would carry the key), response size cap, only
//     content-type / retry-after copied back, the key redacted from the body;
//   - a JSON error when mainnet has no key (503 on keyurl; on the SDK's paths
//     a labelled 403, see sdkAnswers); best-effort per-IP rate limit (per
//     server instance, the client IP taken from the X-Forwarded-For entry the
//     trusted edge appended: TRUSTED_PROXY_HOPS from the right, default 1);
//     `cache-control: no-store` everywhere;
//   - on the SDK's paths the proxy's own throttles and upstream network
//     failures are answered so the SDK waits and retries (a relayer-shaped
//     429 on a POST, a 202 "queued" on a poll), not with a 429/502/504 that
//     ends its job; a third upstream failure in a row is reported (502/504);
//   - cross-site browser requests (Sec-Fetch-Site: cross-site) are refused.

import { HARDCODED_CONTRACTS, deploymentFor, type Address } from "@/lib/deployments";

export const RELAYER_CHAIN_IDS = [1, 11155111] as const;
export type RelayerChainId = (typeof RELAYER_CHAIN_IDS)[number];

export const DEFAULT_RELAYER_URLS: Record<RelayerChainId, string> = {
  1: "https://relayer.mainnet.zama.org",
  11155111: "https://relayer.testnet.zama.org",
};

/**
 * Whether the chain's relayer needs an API key. Zama: "Only the Zama-hosted
 * mainnet relayer needs an API key" (docs.zama.org/protocol/sdk/guides/relayer-api-keys);
 * the Sepolia relayer answers without one.
 */
export const API_KEY_REQUIRED: Record<RelayerChainId, boolean> = {
  1: true,
  11155111: false,
};

/**
 * POST body caps. A real input-proof body for ONE euint256 measured 38,564 bytes
 * (tfhe 1.6.2 WASM, PARAM_MESSAGE_2_CARRY_2_KS_PBS_TUNIFORM_2M128 + dedicated PKE
 * params, CRS for 2048 bits: 19,178-byte proven list, hex-encoded in JSON).
 * 256 KiB leaves ~6.8x margin for parameter changes. A public-decrypt body is
 * one handle + extraData, well under 1 KiB.
 */
export const BODY_LIMITS = {
  "input-proof": 256 * 1024,
  "public-decrypt": 16 * 1024,
} as const;

/** Upstream response cap (keyurl / job results are a few KiB). */
export const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Per-IP fixed-window limits, requests per minute. The SDK polls job status at
 * the relayer's Retry-After (≥ 1 s, default 2.5 s), so polling gets the
 * largest budget.
 */
export const RATE_LIMITS = {
  keyurl: 30,
  "input-proof": 10,
  "public-decrypt": 20,
  poll: 120,
} as const;
export type RateBucket = keyof typeof RATE_LIMITS;
const RATE_WINDOW_MS = 60_000;

type Operation =
  | { kind: "keyurl"; method: "GET"; bucket: "keyurl" }
  | { kind: "input-proof" | "public-decrypt"; method: "POST"; bucket: "input-proof" | "public-decrypt" }
  | { kind: "poll"; method: "GET"; bucket: "poll"; jobId: string };

/**
 * Relayer job ids are opaque strings (the SDK polls `${url}/${jobId}` verbatim).
 * Allow RFC 3986 path-safe characters only: no "/", "\\", "%", "?", "#", and never
 * "." / ".." — so a job id can neither leave its path segment nor traverse.
 */
const JOB_ID_RE = /^(?!\.{1,2}$)[A-Za-z0-9._~:=+-]{1,256}$/;

/** Map a path (already split into segments) to an allowed operation, ignoring method. */
export const matchRelayerPath = (segments: readonly string[]): Operation | null => {
  if (segments.length < 2 || segments.length > 3) return null;
  const [version, endpoint, jobId] = segments;
  if (jobId !== undefined && !JOB_ID_RE.test(jobId)) return null;
  if (version !== "v2") return null;
  if (endpoint === "keyurl" && segments.length === 2) return { kind: "keyurl", method: "GET", bucket: "keyurl" };
  if (endpoint === "input-proof" || endpoint === "public-decrypt") {
    return segments.length === 2
      ? { kind: endpoint, method: "POST", bucket: endpoint }
      : { kind: "poll", method: "GET", bucket: "poll", jobId: jobId! };
  }
  return null;
};

// ---------- env ----------

export type Env = Record<string, string | undefined>;

/**
 * The relayer API key for a chain. An empty or whitespace-only per-chain
 * variable counts as unset (dotenv loads `ZAMA_RELAYER_API_KEY_1=` as ""), so
 * it falls back to ZAMA_RELAYER_API_KEY instead of hiding it. The fallback
 * applies only to chains whose relayer needs a key: the global variable is the
 * mainnet secret, and the open Sepolia relayer (whose URL an operator can
 * override) must never receive it.
 */
export const apiKeyFor = (chainId: RelayerChainId, env: Env): string | undefined =>
  env[`ZAMA_RELAYER_API_KEY_${chainId}`]?.trim() ||
  (API_KEY_REQUIRED[chainId] ? env.ZAMA_RELAYER_API_KEY?.trim() : undefined) ||
  undefined;

export const relayerBaseFor = (chainId: RelayerChainId, env: Env): string => {
  const raw = env[`ZAMA_RELAYER_URL_${chainId}`]?.trim() || DEFAULT_RELAYER_URLS[chainId];
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`ZAMA_RELAYER_URL_${chainId} is not a valid URL`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error(`ZAMA_RELAYER_URL_${chainId} must be https`);
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new Error(`ZAMA_RELAYER_URL_${chainId} must not carry credentials, a query or a fragment`);
  }
  return u.toString().replace(/\/+$/, "");
};

/**
 * The DeadManSwitch deployment input proofs may target: resolved like the
 * browser bundle's contractFor (lib/deployments.ts deploymentFor), from
 * NEXT_PUBLIC_CONTRACT_<chainId>, else the address compiled into the app.
 */
export const allowedContractFor = (
  chainId: RelayerChainId,
  env: Env,
  hardcoded: Readonly<Record<number, Address | undefined>> = HARDCODED_CONTRACTS,
): string | undefined =>
  deploymentFor(chainId, chainId === 1 ? env.NEXT_PUBLIC_CONTRACT_1 : env.NEXT_PUBLIC_CONTRACT_11155111, hardcoded)?.toLowerCase();

// ---------- rate limiting ----------

export class FixedWindowRateLimiter {
  #hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private readonly maxEntries = 10_000) {}

  /** Returns 0 when allowed, else seconds until the window resets. */
  take(key: string, limit: number, now: number): number {
    let e = this.#hits.get(key);
    if (!e || now - e.windowStart >= RATE_WINDOW_MS) {
      if (!e && this.#hits.size >= this.maxEntries) this.#prune(now);
      e = { windowStart: now, count: 0 };
      this.#hits.set(key, e);
    }
    if (e.count >= limit) return Math.max(1, Math.ceil((e.windowStart + RATE_WINDOW_MS - now) / 1000));
    e.count++;
    return 0;
  }

  #prune(now: number) {
    for (const [k, v] of this.#hits) if (now - v.windowStart >= RATE_WINDOW_MS) this.#hits.delete(k);
    // Still full of live windows: drop the oldest half rather than grow without bound.
    if (this.#hits.size >= this.maxEntries) {
      let n = Math.floor(this.maxEntries / 2);
      for (const k of this.#hits.keys()) { if (n-- <= 0) break; this.#hits.delete(k); }
    }
  }
}

const sharedLimiter = new FixedWindowRateLimiter();

/**
 * Upstream network failures (no answer: DNS, refused, TLS, timeout) on the
 * SDK's paths are answered with a retry (sdkAnswers), but only this many in a
 * row for the same job (a poll) or the same request (a POST: the client, the
 * endpoint and the body, which the SDK re-posts unchanged).
 * The next one is answered with the 502/504 the SDK ends the job on, so a
 * relayer outage shows as an error within seconds instead of a hang until the
 * SDK's 10-minute timeout (and 100+ upstream calls). The proxy's own throttle
 * (rate_limited) is not counted: that one is always worth waiting out.
 */
export const MAX_UPSTREAM_RETRIES = 2;
/** A failure older than this no longer counts towards MAX_UPSTREAM_RETRIES. */
const UPSTREAM_FAILURE_WINDOW_MS = 2 * 60_000;
/**
 * Failures of one key closer together than this are one round: the SDK
 * re-sends only after Retry-After (UPSTREAM_RETRY_AFTER_S), so they are
 * different users sending the same request at once (two hunters behind one
 * NAT fetching the same key), not a retry that failed again.
 */
const UPSTREAM_SAME_ROUND_MS = 2_000;

/** Consecutive upstream failures per key (bounded, per server instance, like the limiter). */
export class UpstreamFailures {
  #fails = new Map<string, { n: number; at: number }>();
  constructor(private readonly maxEntries = 10_000) {}

  /** Count a failure; returns how many rounds of failures there have been in a row (within the window). */
  fail(key: string, now: number): number {
    const e = this.#fails.get(key);
    if (e && now - e.at < UPSTREAM_SAME_ROUND_MS) return e.n;
    const n = e && now - e.at < UPSTREAM_FAILURE_WINDOW_MS ? e.n + 1 : 1;
    if (!e && this.#fails.size >= this.maxEntries) {
      for (const [k, v] of this.#fails) if (now - v.at >= UPSTREAM_FAILURE_WINDOW_MS) this.#fails.delete(k);
      if (this.#fails.size >= this.maxEntries) this.#fails.clear();
    }
    this.#fails.set(key, { n, at: now });
    return n;
  }

  /** Upstream answered: the run of failures for this key is over. */
  ok(key: string): void {
    this.#fails.delete(key);
  }
}

const sharedUpstreamFailures = new UpstreamFailures();

/**
 * How many trusted proxies append to X-Forwarded-For in front of this server
 * (TRUSTED_PROXY_HOPS, default 1: Railway's edge, or any single reverse proxy).
 * 0 means no trusted proxy: the header is ignored.
 */
export const trustedProxyHops = (env: Env): number => {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 16 ? n : 1;
};

/**
 * The client's address for the rate limiter and the upstream-failure budget.
 * A proxy appends the address it saw to X-Forwarded-For, so the entry the
 * outermost trusted proxy wrote is the n-th from the RIGHT; everything left of
 * it came from the client and can be set freely (a rotating fake first entry
 * would otherwise defeat the per-IP limit). Falls back to X-Real-IP.
 */
export const clientIp = (req: Request, env: Env = {}): string => {
  const hops = trustedProxyHops(env);
  const xff = req.headers.get("x-forwarded-for");
  if (xff && hops > 0) {
    const entries = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const trusted = entries[entries.length - hops];
    if (trusted) return trusted.slice(0, 64);
  }
  return (req.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64) || "unknown";
};

// ---------- body validation ----------

const HEX_RE = /^(0x)?[0-9a-fA-F]*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const EXTRA_DATA_RE = /^0x[0-9a-fA-F]{0,1024}$/;
const EUINT256_TYPE_ID = 8;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).every((k) => keys.includes(k));

export interface BodyProblem { status: 400 | 403; error: string }
const bad = (error: string): BodyProblem => ({ status: 400, error });

/** Returns the problem, or null when the input-proof body is acceptable. */
export const validateInputProofBody = (
  body: unknown,
  chainId: RelayerChainId,
  allowedContract: string,
): BodyProblem | null => {
  const KEYS = ["ciphertextWithInputVerification", "contractAddress", "contractChainId", "extraData", "userAddress"] as const;
  if (!isPlainObject(body) || !onlyKeys(body, KEYS)) return bad("unexpected input-proof payload shape");
  const { ciphertextWithInputVerification: ct, contractAddress, contractChainId, extraData, userAddress } = body;
  if (typeof ct !== "string" || ct.length === 0 || ct.length % 2 !== 0 || !HEX_RE.test(ct)) {
    return bad("ciphertextWithInputVerification must be hex");
  }
  if (typeof contractAddress !== "string" || !ADDRESS_RE.test(contractAddress)) return bad("bad contractAddress");
  if (contractAddress.toLowerCase() !== allowedContract) {
    return { status: 403, error: "input proofs are only relayed for this app's contract" };
  }
  if (typeof userAddress !== "string" || !ADDRESS_RE.test(userAddress)) return bad("bad userAddress");
  if (typeof extraData !== "string" || !EXTRA_DATA_RE.test(extraData)) return bad("bad extraData");
  if (typeof contractChainId !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(contractChainId)) {
    return bad("bad contractChainId");
  }
  if (BigInt(contractChainId) !== BigInt(chainId)) return bad("contractChainId does not match this endpoint's chain");
  return null;
};

/** Returns the problem, or null when the public-decrypt body is acceptable. */
export const validatePublicDecryptBody = (body: unknown, chainId: RelayerChainId): BodyProblem | null => {
  if (!isPlainObject(body) || !onlyKeys(body, ["ciphertextHandles", "extraData"])) {
    return bad("unexpected public-decrypt payload shape");
  }
  const { ciphertextHandles: handles, extraData } = body;
  // One handle per request: revealKey verifies a single-handle proof, and a
  // multi-handle proof can never be submitted on-chain.
  if (!Array.isArray(handles) || handles.length !== 1) return bad("exactly one ciphertext handle per request");
  const h = handles[0];
  if (typeof h !== "string" || !BYTES32_RE.test(h)) return bad("bad ciphertext handle");
  // Handle layout: hash21 ‖ index(1) ‖ chainId(8, BE) ‖ fheTypeId(1) ‖ version(1).
  const hex = h.slice(2);
  if (BigInt("0x" + hex.slice(44, 60)) !== BigInt(chainId)) return bad("handle belongs to another chain");
  if (parseInt(hex.slice(60, 62), 16) !== EUINT256_TYPE_ID) return bad("only euint256 handles are relayed");
  if (typeof extraData !== "string" || !EXTRA_DATA_RE.test(extraData)) return bad("bad extraData");
  return null;
};

// ---------- helpers ----------

const json = (status: number, body: Record<string, unknown>, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });

/**
 * Server settings that stop the proxy relaying anything. lib/fhevm.ts maps
 * each label to RELAYER_NOT_CONFIGURED ("the operator must fix the server").
 */
export const CONFIG_ERROR_LABELS = ["relayer_not_configured", "relayer_misconfigured", "contract_not_configured", "contract_mismatch"] as const;
export type ConfigErrorLabel = (typeof CONFIG_ERROR_LABELS)[number];

/** Retry-After, seconds, after an upstream network error or timeout on an SDK path. */
export const UPSTREAM_RETRY_AFTER_S = 3;

/**
 * The proxy's own answers on the SDK's paths (POST input-proof /
 * public-decrypt and their GET polls), in the relayer's wire format, because
 * the SDK (@fhevm/sdk 0.13.2 RelayerAsyncRequest) acts only on that:
 *   - it waits and re-posts only on a 429 {status:"failed", error:{label:
 *     "rate_limited"|"protocol_overload", message}}, and polls again only on a
 *     202 {status:"queued", requestId}; any other 429, and every 502/504,
 *     ends the job (a create then reseals and regenerates its ZK proof);
 *   - of a 403 it keeps `error.message` (a 503 must match the relayer's own
 *     schema), so configuration errors are 403s whose message starts with
 *     their label, which lib/fhevm.ts reads back.
 * A throttled or failed poll costs nothing upstream: polling it again is safe,
 * and the SDK's timeout (10 min from lib/fhevm.ts) still bounds the wait. A
 * re-posted job only costs relayer quota. An upstream failure is retried only
 * MAX_UPSTREAM_RETRIES times in a row (UpstreamFailures): an outage is then
 * reported with the 502/504 the SDK ends the job on.
 */
const sdkAnswers = (method: "GET" | "POST") => ({
  retry: (label: "rate_limited" | "protocol_overload", message: string, retryAfterS: number): Response =>
    method === "GET"
      ? json(202, { status: "queued", requestId: label === "rate_limited" ? "proxy-throttled" : "proxy-upstream-retry" }, { "retry-after": String(retryAfterS) })
      : json(429, { status: "failed", error: { label, message } }, { "retry-after": String(retryAfterS) }),
  configError: (label: ConfigErrorLabel, message: string): Response =>
    json(403, { status: "failed", error: { label, message: `${label}: ${message}` } }),
});

/** SHA-256 of a (validated, re-serialised) request body, hex: identifies a re-post of the same request. */
const bodyDigest = async (body: Uint8Array | undefined): Promise<string> => {
  if (!body) return "";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Read a request body, refusing more than `limit` bytes without buffering past it. */
const readCapped = async (body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | "too-large"> => {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

const SDK_HEADER_RE = /^[A-Za-z0-9@/._+-]{1,64}$/;
const ACCEPT_RE = /^[A-Za-z0-9*/,;=. +-]{1,128}$/;

// ---------- handler ----------

export interface ProxyDeps {
  fetch?: typeof fetch;
  env?: Env;
  now?: () => number;
  limiter?: FixedWindowRateLimiter;
  /** Compiled-in deployments (default lib/deployments.ts HARDCODED_CONTRACTS). */
  deployments?: Readonly<Record<number, Address | undefined>>;
  upstreamFailures?: UpstreamFailures;
}

export const handleRelayerRequest = async (
  req: Request,
  params: { chainId: string; path: string[] | string },
  deps: ProxyDeps = {},
): Promise<Response> => {
  const env = deps.env ?? (process.env as Env);
  const doFetch = deps.fetch ?? fetch;
  const now = (deps.now ?? Date.now)();
  const limiter = deps.limiter ?? sharedLimiter;

  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return json(405, { error: "method not allowed" }, { allow: "GET, POST" });
  }

  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return json(403, { error: "cross-site requests are not allowed" });
  }

  if (!/^(1|11155111)$/.test(params.chainId)) {
    return json(404, { error: "unsupported chain; the relayer proxy serves chains 1 and 11155111" });
  }
  const chainId = Number(params.chainId) as RelayerChainId;

  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const op = matchRelayerPath(segments);
  if (!op) return json(404, { error: "relayer path not allowed" });
  if (op.method !== method) return json(405, { error: "method not allowed for this path" }, { allow: op.method });

  let search = "";
  try { search = new URL(req.url).search; } catch { /* relative URL in tests */ }
  if (search) return json(400, { error: "query strings are not allowed" });

  // The SDK's request loop (everything but keyurl, which lib/fhevm.ts fetches
  // itself) understands only the relayer's own answers: see sdkAnswers.
  const sdk = op.kind === "keyurl" ? null : sdkAnswers(op.kind === "poll" ? "GET" : "POST");
  const configError = (label: ConfigErrorLabel, message: string) =>
    sdk ? sdk.configError(label, message) : json(503, { error: label, message });

  const apiKey = apiKeyFor(chainId, env);
  if (!apiKey && API_KEY_REQUIRED[chainId]) {
    return configError(
      "relayer_not_configured",
      `This server has no Zama relayer API key for chain ${chainId}. Set ZAMA_RELAYER_API_KEY (or ZAMA_RELAYER_API_KEY_${chainId}).`,
    );
  }

  let base: string;
  try {
    base = relayerBaseFor(chainId, env);
  } catch (e) {
    return configError("relayer_misconfigured", (e as Error).message);
  }

  const retryAfter = limiter.take(`${clientIp(req, env)}|${chainId}|${op.bucket}`, RATE_LIMITS[op.bucket], now);
  if (retryAfter > 0) {
    return sdk ? sdk.retry("rate_limited", "rate limited by this server", retryAfter)
      : json(429, { error: "rate limited" }, { "retry-after": String(retryAfter) });
  }

  // ---- request body ----
  let upstreamBody: Uint8Array | undefined;
  if (op.method === "POST") {
    const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!ctype.startsWith("application/json")) return json(415, { error: "content-type must be application/json" });
    const limit = BODY_LIMITS[op.kind as "input-proof" | "public-decrypt"];
    const declared = Number(req.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > limit) {
      return json(413, { error: `request body exceeds ${limit} bytes` });
    }
    const raw = await readCapped(req.body, limit);
    if (raw === "too-large") return json(413, { error: `request body exceeds ${limit} bytes` });
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return json(400, { error: "request body must be JSON" });
    }
    let problem: BodyProblem | null;
    if (op.kind === "input-proof") {
      const allowed = allowedContractFor(chainId, env, deps.deployments);
      if (!allowed) {
        return configError(
          "contract_not_configured",
          `NEXT_PUBLIC_CONTRACT_${chainId} is not set on this server; input proofs are only relayed for the configured contract.`,
        );
      }
      problem = validateInputProofBody(parsed, chainId, allowed);
      // The browser bundle's contract is not the server's: a deployment setting, not a bad request. The bundle
      // names its contract at build time, so this is almost always a tab loaded before the site was rebuilt
      // for a new contract (lib/fhevm.ts tells that page to reload).
      if (problem?.status === 403) {
        return configError(
          "contract_mismatch",
          `${problem.error}: this page is out of date, it was loaded for another DeadManSwitch contract than this site now uses (${allowed}, NEXT_PUBLIC_CONTRACT_${chainId}). Reload the page and try again. Nothing was sent on-chain.`,
        );
      }
    } else {
      problem = validatePublicDecryptBody(parsed, chainId);
    }
    if (problem) return json(problem.status, { error: problem.error });
    // Forward what was validated, re-serialised: JSON.parse keeps the last of
    // duplicate keys, and a relayer whose parser keeps the first would
    // otherwise see another contract or handle than the one checked here.
    upstreamBody = new TextEncoder().encode(JSON.stringify(parsed));
  }

  // ---- headers: allowlist only ----
  const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};
  const accept = req.headers.get("accept");
  headers.accept = accept && ACCEPT_RE.test(accept) ? accept : "application/json";
  if (upstreamBody) headers["content-type"] = "application/json";
  for (const h of ["zama-sdk-name", "zama-sdk-version"]) {
    const v = req.headers.get(h);
    if (v && SDK_HEADER_RE.test(v)) headers[h] = v;
  }

  const target = `${base}/${segments.join("/")}`;

  // ---- upstream ----
  // An SDK path retries an upstream network failure a few times (sdkAnswers), then reports it (UpstreamFailures).
  const failures = deps.upstreamFailures ?? sharedUpstreamFailures;
  // Polls: per job. POSTs: per request body (the SDK re-posts the same one), not per client: users behind one
  // IP (an office, a carrier NAT) must not use up each other's retries.
  const failKey = `${clientIp(req, env)}|${chainId}|${op.kind}|${op.kind === "poll" ? op.jobId : await bodyDigest(upstreamBody)}`;
  const upstreamFailed = (timedOut: boolean, what: string): Response =>
    sdk && failures.fail(failKey, now) <= MAX_UPSTREAM_RETRIES
      ? sdk.retry("protocol_overload", timedOut ? "relayer timed out" : what, UPSTREAM_RETRY_AFTER_S)
      : json(timedOut ? 504 : 502, { error: timedOut ? "relayer timed out" : what });
  let upstream: Response;
  try {
    upstream = await doFetch(target, {
      method: op.method,
      headers,
      body: upstreamBody ? new Blob([upstreamBody as Uint8Array<ArrayBuffer>]) : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError";
    return upstreamFailed(timedOut, "relayer unreachable");
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => {});
    return json(502, { error: "relayer answered with a redirect; refusing to follow it with the API key" });
  }

  // The timeout also covers the body; a stall or reset mid-body must not escape as a 500.
  let raw: Uint8Array | "too-large";
  try {
    raw = await readCapped(upstream.body, MAX_UPSTREAM_RESPONSE_BYTES);
  } catch (e) {
    const timedOut = (e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError";
    return upstreamFailed(timedOut, "relayer response failed");
  }
  failures.ok(failKey);
  if (raw === "too-large") return json(502, { error: "relayer response too large" });

  // Defence in depth: never let the key leave, even if upstream echoes it.
  let out: BodyInit = raw as Uint8Array<ArrayBuffer>;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  if (apiKey && text.includes(apiKey)) out = text.split(apiKey).join("[redacted]");

  // Never let upstream choose an active content type on our origin.
  const upstreamType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const resHeaders: Record<string, string> = {
    "content-type": upstreamType.startsWith("application/json") ? "application/json" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  };
  const ra = upstream.headers.get("retry-after");
  if (ra && /^\d{1,6}$/.test(ra.trim())) resHeaders["retry-after"] = ra.trim();

  // A null-body status cannot carry even an empty body (the Response constructor throws).
  const nullBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
  return new Response(nullBody ? null : out, { status: upstream.status, headers: resHeaders });
};
