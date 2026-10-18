// FHE operations for the browser: encrypt the 32-byte data key (DEK) for
// createSwitch, and public-decrypt it after markDark for revealKey.
//
// - Nothing from @zama-fhe/sdk is imported at module scope (type imports are
//   erased): the SDK and its WASM load on first use via dynamic import(), so
//   pages that never encrypt or decrypt never download it, and SSR never
//   evaluates it. next.config.js additionally aliases the SDK away on the server.
// - Chains 1 / 11155111 use the `web()` relayer with
//   relayerUrl = `${window.location.origin}/api/relayer/<chainId>` — our own
//   proxy (app/api/relayer) injects the API key server-side. No key is ever
//   configured or sent from the browser.
// - Chain 31337 (local Anvil, NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1) uses the
//   `anvil` preset with `cleartext()` against the wagmi chain's RPC (the
//   forge-fhevm host stack at its canonical addresses). That path also works
//   in Node, which the opt-in integration test uses.
// - The first encryption in a browser needs Zama's FHE public key + CRS
//   (~4.6 MB). We fetch it ourselves (keyurl via the proxy, then the public
//   bucket URLs it names) so the UI can show byte progress, cache it in
//   IndexedDB across visits, and hand it to the SDK as `fheEncryptionKey`.
//   Public decryption does not need it.
// - Public decryption is ONE handle per call: revealKey checks a single-handle
//   proof, so a proof over several handles can never be used on-chain.

import { createPublicClient, http, type Hex } from "viem";
import type { ZamaSDK } from "@zama-fhe/sdk";
import type { WebRelayerOptions } from "@zama-fhe/sdk/web";
import { ANVIL_ID, LOCAL_CHAIN_ENABLED, MAINNET_ID, SEPOLIA_ID, chainById, rpcUrlFor, type Address } from "./contracts";
import { bytesToHex, hexToBytes } from "./envelope";
import { DEK_BYTES } from "./switch";

// ---------- public types ----------

export type FhevmChainId = typeof MAINNET_ID | typeof SEPOLIA_ID | typeof ANVIL_ID;

export const isFhevmChain = (chainId: number | undefined | null): chainId is FhevmChainId =>
  chainId === MAINNET_ID || chainId === SEPOLIA_ID || (chainId === ANVIL_ID && LOCAL_CHAIN_ENABLED);

export type FhevmStage =
  | "loading-sdk"        // downloading/evaluating the SDK + WASM bundle
  | "fetching-key-info"  // GET keyurl via our relayer proxy
  | "downloading-key"    // the ~4.6 MB FHE public key + CRS (byte progress available)
  | "key-cached"         // key loaded from this browser's IndexedDB cache
  | "initializing"       // SDK / WASM / worker init, on-chain protocol reads
  | "encrypting"         // ZK proof generation + relayer input-proof round trip
  | "decrypting"         // relayer public-decrypt round trip (KMS threshold decryption)
  | "done";

export interface FhevmProgress {
  stage: FhevmStage;
  message: string;
  /** downloading-key only. */
  loadedBytes?: number;
  /** downloading-key only; null when the server sent no content-length. */
  totalBytes?: number | null;
}
export type FhevmProgressFn = (p: FhevmProgress) => void;

export type FhevmErrorCode =
  | "UNSUPPORTED_CHAIN"
  | "NOT_BROWSER"
  | "NO_RPC"
  | "RELAYER_NOT_CONFIGURED"
  /** Zama's relayer failed or is down for now (a gateway 5xx, an outage the proxy reported): retry later. */
  | "RELAYER_ERROR"
  /** This page was loaded for another DeadManSwitch contract than the site now uses (it was redeployed): reload. */
  | "STALE_PAGE"
  | "KEY_DOWNLOAD_FAILED"
  | "SDK_LOAD_FAILED"
  | "ENCRYPT_FAILED"
  | "DECRYPT_FAILED"
  /** The handle is not (yet) publicly decryptable: markDark not mined, or the KMS has not caught up. Retry later. */
  | "NOT_DECRYPTABLE_YET"
  | "BAD_RESULT"
  | "ABORTED";

export class FhevmError extends Error {
  readonly code: FhevmErrorCode;
  constructor(code: FhevmErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FhevmError";
    this.code = code;
  }
}

/** Global, per-chain status of the one-time FHE key download, for a UI badge. */
export interface FheKeyStatus {
  state: "idle" | "downloading" | "ready" | "error";
  loadedBytes: number;
  totalBytes: number | null;
  fromCache: boolean;
  error?: string;
}

export interface EncryptDekParams {
  chainId: number;
  /** The DeadManSwitch deployment; bound into the input proof. */
  contractAddress: Address;
  /** The switch owner (msg.sender of createSwitch); bound into the input proof. */
  userAddress: Address;
  /** The 32-byte AES key from envelope.seal(). */
  dek: Uint8Array | Hex;
  onProgress?: FhevmProgressFn;
  signal?: AbortSignal;
  /** Relayer round-trip ceiling, ms. Default 10 min. */
  timeoutMs?: number;
}

export interface EncryptedDek {
  /** externalEuint256 for createSwitch(…, encKey, …). */
  handle: Hex;
  /** inputProof for createSwitch(…, inputProof). */
  inputProof: Hex;
}

export interface PublicDecryptDekParams {
  chainId: number;
  /** The switch's encKeyHandle (getSwitchInfo().encKeyHandle / getEncKeyHandle). */
  handle: Hex;
  onProgress?: FhevmProgressFn;
  signal?: AbortSignal;
  /** Relayer round-trip ceiling, ms. Default 10 min. */
  timeoutMs?: number;
}

export interface DecryptedDek {
  /** bytes32 for revealKey(owner, id, dataKey, …) — the ABI-encoded clear value, exactly as the proof signs it. */
  dataKey: Hex;
  /** Same 32 bytes, for envelope.open / checkKey. */
  dekBytes: Uint8Array;
  /** decryptionProof for revealKey(…, decryptionProof). */
  decryptionProof: Hex;
}

// ---------- key-status store (useSyncExternalStore-compatible) ----------

const IDLE_STATUS: FheKeyStatus = Object.freeze({ state: "idle", loadedBytes: 0, totalBytes: null, fromCache: false });
const keyStatus = new Map<number, FheKeyStatus>();
const keyListeners = new Set<() => void>();

export const getFheKeyStatus = (chainId: number): FheKeyStatus => keyStatus.get(chainId) ?? IDLE_STATUS;

export const subscribeFheKeyStatus = (listener: () => void): (() => void) => {
  keyListeners.add(listener);
  return () => { keyListeners.delete(listener); };
};

const setKeyStatus = (chainId: number, s: FheKeyStatus) => {
  keyStatus.set(chainId, Object.freeze(s));
  for (const l of keyListeners) {
    try { l(); } catch { /* listener errors must not break the download */ }
  }
};

// ---------- shared loads: never tied to one caller ----------
//
// The FHE key download and the SDK build are shared by every caller (the
// prefetch, a create, the create of a form that was remounted). They run to
// completion whoever started them: a caller's AbortSignal ends only its own
// wait (forCaller), and progress goes to every caller still waiting, a new
// one first getting the latest state (followProgress).

const progressSubs = new Map<string, Set<FhevmProgressFn>>();
const lastProgress = new Map<string, FhevmProgress>();

const broadcast = (channel: string): FhevmProgressFn => (p) => {
  lastProgress.set(channel, p);
  for (const f of [...(progressSubs.get(channel) ?? [])]) {
    try { f(p); } catch { /* a caller's callback must not break the shared load */ }
  }
};

/** Receive a shared load's progress until the returned function is called. */
const followProgress = (channel: string, f: FhevmProgressFn | undefined): (() => void) => {
  if (!f) return () => {};
  let subs = progressSubs.get(channel);
  if (!subs) progressSubs.set(channel, (subs = new Set()));
  subs.add(f);
  const last = lastProgress.get(channel);
  if (last) { try { f(last); } catch { /* ignore */ } }
  return () => { subs.delete(f); };
};

/** Wait for a shared load on behalf of one caller: its abort rejects only this wait. */
const forCaller = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new FhevmError("ABORTED", "cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new FhevmError("ABORTED", "cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
};

const keyChannel = (chainId: number) => `key|${chainId}`;
const sdkChannel = (chainId: number, purpose: Purpose) => `sdk|${chainId}|${chainId === ANVIL_ID ? "any" : purpose}`;

// ---------- internals ----------

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const EUINT256_TYPE_ID = 8;

const isBrowser = (): boolean => typeof window !== "undefined" && typeof window.location !== "undefined";

const relayerUrlFor = (chainId: FhevmChainId): string => {
  if (!isBrowser()) throw new FhevmError("NOT_BROWSER", "the FHE relayer path is browser-only");
  return `${window.location.origin}/api/relayer/${chainId}`;
};

const assertChain = (chainId: number): FhevmChainId => {
  if (!isFhevmChain(chainId)) {
    throw new FhevmError(
      "UNSUPPORTED_CHAIN",
      chainId === ANVIL_ID
        ? "local chain 31337 is disabled (set NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1)"
        : `chain ${chainId} is not supported; use Ethereum mainnet or Sepolia`,
    );
  }
  return chainId;
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new FhevmError("ABORTED", "cancelled");
};

const errText = (e: unknown): string => {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const m = (cur as { shortMessage?: string; message?: string }).shortMessage ?? (cur as { message?: string }).message;
    if (m && !parts.includes(m)) parts.push(m);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" — ") || String(e);
};

/** Validate a bytes32 FHE handle and its embedded chain id / type. */
const checkHandle = (handle: string, chainId: number): Hex => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(handle)) throw new FhevmError("BAD_RESULT", `malformed FHE handle ${handle}`);
  const hex = handle.slice(2);
  // hash21 ‖ index(1) ‖ chainId(8, big-endian) ‖ fheTypeId(1) ‖ version(1)
  if (BigInt("0x" + hex.slice(44, 60)) !== BigInt(chainId)) {
    throw new FhevmError("BAD_RESULT", `handle ${handle} belongs to another chain`);
  }
  if (parseInt(hex.slice(60, 62), 16) !== EUINT256_TYPE_ID) {
    throw new FhevmError("BAD_RESULT", `handle ${handle} is not an euint256`);
  }
  return handle.toLowerCase() as Hex;
};

// ---------- relayer JSON errors (our proxy's 503 etc.) ----------

/**
 * Labels of the relayer proxy's server-configuration errors
 * (app/api/relayer/proxy.ts CONFIG_ERROR_LABELS): on keyurl the `error` of a
 * 503; on the SDK's paths the start of a 403's message, which the SDK copies
 * into its error ("Details: …").
 */
export const RELAYER_CONFIG_LABELS = ["relayer_not_configured", "relayer_misconfigured", "contract_not_configured", "contract_mismatch"] as const;
const CONFIG_LABEL_RE = new RegExp(`\\b(${RELAYER_CONFIG_LABELS.join("|")})\\b`);

/** The proxy's configuration-error label inside an error from the SDK (message or `details`, causes included). */
const relayerConfigLabel = (e: unknown): string | undefined => {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const x = cur as { message?: unknown; details?: unknown; cause?: unknown };
    for (const s of [x.message, x.details]) {
      const m = typeof s === "string" ? CONFIG_LABEL_RE.exec(s) : null;
      if (m) return m[1];
    }
    cur = x.cause;
  }
  return undefined;
};

const relayerHttpError = async (res: Response, what: string): Promise<FhevmError> => {
  let detail = "";
  try {
    const j = (await res.json()) as { error?: string | { label?: string; message?: string }; message?: string };
    const label = typeof j.error === "string" ? j.error : j.error?.label;
    detail = (typeof j.error === "object" ? j.error?.message : undefined) ?? j.message ?? label ?? "";
    if (label && (RELAYER_CONFIG_LABELS as readonly string[]).includes(label)) {
      return new FhevmError("RELAYER_NOT_CONFIGURED", detail || "the relayer proxy is not configured on this server");
    }
  } catch { /* non-JSON */ }
  return new FhevmError("RELAYER_ERROR", `${what} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
};

/**
 * The HTTP status an SDK request loop ended on (RelayerResponseStatusError and the like; @zama-fhe/sdk's
 * RelayerRequestFailedError calls it statusCode), causes included.
 */
const relayerStatus = (e: unknown): number | undefined => {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const st = (cur as { status?: unknown }).status;
    if (typeof st === "number") return st;
    const code = (cur as { statusCode?: unknown }).statusCode;
    if (typeof code === "number") return code;
    const m = /unexpected response status: (\d{3})/.exec(String((cur as { message?: unknown }).message ?? ""));
    if (m) return Number(m[1]);
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
};

/**
 * An SDK failure that is really the proxy's answer: its configuration error,
 * or the 502/504 it gives once Zama's relayer failed several times in a row
 * (app/api/relayer/proxy.ts UpstreamFailures).
 */
const proxyAnswer = (e: unknown): FhevmError | null => {
  const label = relayerConfigLabel(e);
  // The bundle names its contract at build time and the proxy reads the server's at run time: they differ for
  // a tab loaded before the site was rebuilt for a new contract. Reloading fixes it; the server is fine.
  if (label === "contract_mismatch") {
    return new FhevmError(
      "STALE_PAGE",
      "This page is out of date: the site now uses another DeadManSwitch contract than the one this page was loaded with. Reload the page and try again. Nothing was sent on-chain.",
      { cause: e },
    );
  }
  if (label) return new FhevmError("RELAYER_NOT_CONFIGURED", `the relayer proxy refused the request (${label}): ${errText(e)}`, { cause: e });
  const status = relayerStatus(e);
  if (status === 502 || status === 504) {
    return new FhevmError(
      "RELAYER_ERROR",
      status === 504
        ? `Zama's relayer did not answer in time (HTTP 504), several times in a row. Try again in a few minutes. (${errText(e)})`
        : `Zama's relayer could not be reached (HTTP 502), several times in a row. Try again in a few minutes. (${errText(e)})`,
      { cause: e },
    );
  }
  return null;
};

/** Statuses with which Zama's relayer, or the gateway in front of it, says it is down or overloaded for now. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * What the gateway said in a body the SDK could not parse (RelayerResponseInvalidBodyError keeps it as
 * `bodyJson`): Kong answers an outage with {"message":"failure to get a peer from the ring-balancer"}.
 * One short line, printable characters only.
 */
const upstreamReason = (e: unknown): string | undefined => {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const body = (cur as { bodyJson?: unknown }).bodyJson;
    if (typeof body === "string") {
      let said: unknown;
      try {
        const j = JSON.parse(body) as { message?: unknown; error?: unknown };
        said = typeof j.message === "string" ? j.message
          : typeof j.error === "string" ? j.error
          : typeof (j.error as { message?: unknown } | null)?.message === "string" ? (j.error as { message: string }).message
          : undefined;
      } catch { /* not JSON (an HTML error page): nothing worth showing */ }
      const line = typeof said === "string" ? said.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 200) : "";
      return line || undefined;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
};

/**
 * An SDK failure that is Zama's relayer being down or overloaded (an HTTP 429 or 5xx the SDK does not
 * retry, such as the gateway's 503 during an outage): RELAYER_ERROR with the status and the gateway's
 * reason, which the hunt retries, rather than a failed encryption or decryption with the cause hidden.
 */
const relayerUnavailable = (e: unknown): FhevmError | null => {
  const status = relayerStatus(e);
  if (status === undefined || !UNAVAILABLE_STATUSES.has(status)) return null;
  const reason = upstreamReason(e);
  return new FhevmError(
    "RELAYER_ERROR",
    `Zama's relayer is unavailable right now (HTTP ${status}${reason ? `: ${reason}` : ""}). Nothing was sent on-chain; try again in a few minutes.`,
    { cause: e },
  );
};

/** The relayer refused the input proof: built with an FHE public key or CRS its coprocessors no longer accept. */
const inputProofRejected = (e: unknown): boolean => {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const x = cur as { name?: unknown; message?: unknown; cause?: unknown };
    if (x.name === "RelayerResponseInputProofRejectedError" || (typeof x.message === "string" && /rejected the input proof/i.test(x.message))) return true;
    cur = x.cause;
  }
  return false;
};

// ---------- FHE public key: keyurl → download with progress → IndexedDB ----------

type FheKeyBytes = NonNullable<WebRelayerOptions["fheEncryptionKey"]>;

interface KeySource { pkId: string; pkUrl: string; crsId: string; crsUrl: string }

const parseKeyUrl = (j: unknown): KeySource => {
  const r = (j as { response?: Record<string, unknown> })?.response as
    | { fheKeyInfo?: { fhePublicKey?: { dataId?: unknown; urls?: unknown } }[]; crs?: Record<string, { dataId?: unknown; urls?: unknown }> }
    | undefined;
  const pk = r?.fheKeyInfo?.[0]?.fhePublicKey;
  const crs = r?.crs?.["2048"];
  const ok = (x: { dataId?: unknown; urls?: unknown } | undefined): x is { dataId: string; urls: string[] } =>
    !!x && typeof x.dataId === "string" && Array.isArray(x.urls) && typeof x.urls[0] === "string";
  if (!ok(pk) || !ok(crs)) throw new FhevmError("RELAYER_ERROR", "unexpected keyurl response from the relayer");
  for (const u of [pk.urls[0], crs.urls[0]]) {
    let parsed: URL;
    try { parsed = new URL(u); } catch { throw new FhevmError("RELAYER_ERROR", `keyurl returned an invalid URL`); }
    if (parsed.protocol !== "https:") throw new FhevmError("RELAYER_ERROR", "keyurl returned a non-https key URL");
  }
  return { pkId: pk.dataId, pkUrl: pk.urls[0], crsId: crs.dataId, crsUrl: crs.urls[0] };
};

const IDB_NAME = "dms-fhe-key";
const IDB_STORE = "keys";

const idb = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

const idbGet = async (key: string): Promise<{ pk: Uint8Array; crs: Uint8Array } | null> => {
  const db = await idb();
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result as { pk?: unknown; crs?: unknown } | undefined;
        resolve(v && v.pk instanceof Uint8Array && v.crs instanceof Uint8Array ? { pk: v.pk, crs: v.crs } : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
};

/** Store the key for `chainId`, replacing any older key for that chain (keys rotate rarely; ~4.6 MB each). */
const idbPut = async (chainId: number, key: string, value: { pk: Uint8Array; crs: Uint8Array }): Promise<void> => {
  const db = await idb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        for (const k of keysReq.result) {
          if (typeof k === "string" && k.startsWith(`${chainId}|`) && k !== key) store.delete(k);
        }
        store.put({ ...value, storedAt: Date.now() }, key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* quota, private mode: the next visit downloads again */
  } finally {
    db.close();
  }
};

/**
 * A key or keyurl transfer that receives nothing for this long has stalled:
 * it is aborted and retried, and after the last attempt the shared download
 * fails (and is evicted), so the next caller starts a fresh one instead of
 * joining a download that never ends.
 */
export const KEY_IDLE_TIMEOUT_MS = 60_000;

/** Rejects once `ms` pass without a call to `touch()`; `stop()` disarms it. */
const idleWatch = (ms: number, onStall: (e: Error) => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail!: (e: Error) => void;
  const stalled = new Promise<never>((_, reject) => { fail = reject; });
  stalled.catch(() => {}); // observed through races only
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const e = new Error(`the transfer stalled (no data for ${Math.round(ms / 1000)} s)`);
      onStall(e);
      fail(e);
    }, ms);
  };
  touch();
  return { stalled, touch, stop: () => clearTimeout(timer) };
};

/**
 * Download `url`, reporting each chunk: `onChunk(delta, total)` with the expected size (null when unknown;
 * left out on the rollback before a retry, which keeps the last one).
 */
const downloadBytes = async (
  url: string,
  onChunk: (delta: number, total?: number | null) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    throwIfAborted(signal);
    let received = 0;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const idle = idleWatch(KEY_IDLE_TIMEOUT_MS, (e) => ac.abort(e));
    try {
      const res = await Promise.race([
        fetch(url, { signal: ac.signal, credentials: "omit", referrerPolicy: "no-referrer" }), idle.stalled,
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lenHeader = Number(res.headers.get("content-length"));
      // A compressed response's Content-Length is its encoded size. The bucket is another origin and
      // Content-Encoding is not a CORS-safelisted header, so a browser hides it unless the bucket exposes it:
      // the check below is not enough, and a total the bytes outrun is dropped as unknown (in the loop).
      let total = Number.isFinite(lenHeader) && lenHeader > 0 && !res.headers.get("content-encoding") ? lenHeader : null;
      if (!res.body) {
        const b = new Uint8Array(await Promise.race([res.arrayBuffer(), idle.stalled]));
        onChunk(b.length, b.length === total ? total : null);
        return b;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          idle.touch();
          const { done, value } = await Promise.race([reader.read(), idle.stalled]);
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total !== null && received > total) total = null;
          onChunk(value.length, total);
        }
      } catch (e) {
        reader.cancel().catch(() => {});
        throw e;
      }
      const out = new Uint8Array(received);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    } catch (e) {
      if (signal?.aborted) throw new FhevmError("ABORTED", "cancelled");
      onChunk(-received); // roll back progress for the retry
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    } finally {
      idle.stop();
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new FhevmError(
    "KEY_DOWNLOAD_FAILED",
    `could not download the FHE public key: ${errText(lastErr)}. Try again: a new attempt starts a fresh download.`,
    { cause: lastErr },
  );
};

/** Remove every cached key of `chainId` (a copy Zama's network no longer accepts). */
const idbDeleteChain = async (chainId: number): Promise<void> => {
  const db = await idb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        for (const k of keysReq.result) if (typeof k === "string" && k.startsWith(`${chainId}|`)) store.delete(k);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* the next visit may load it again, and is told again */
  } finally {
    db.close();
  }
};

/** A key URL without its query: what names the key's bytes (a presigned query may change between answers). */
const keyObject = (u: string): string => {
  const x = new URL(u);
  return `${x.origin}${x.pathname}`;
};

const keyPromises = new Map<number, Promise<FheKeyBytes>>();

/**
 * Fetch (or load from IndexedDB) the FHE public key + CRS for a relayer chain.
 * Memoised per chain and shared (see "shared loads"); a failure clears the
 * memo so the next call retries.
 */
const loadFheKey = (chainId: typeof MAINNET_ID | typeof SEPOLIA_ID): Promise<FheKeyBytes> => {
  const existing = keyPromises.get(chainId);
  if (existing) return existing;
  const report = broadcast(keyChannel(chainId));
  const p = (async (): Promise<FheKeyBytes> => {
    const relayerUrl = relayerUrlFor(chainId);
    report({ stage: "fetching-key-info", message: "Locating Zama's FHE public key…" });
    // Bounded like the key transfer: a stalled keyurl must not hold every later caller.
    // (An AbortController and a timer: AbortSignal's static timeout() needs Safari 16.)
    let res: Response;
    let body: unknown;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), KEY_IDLE_TIMEOUT_MS);
    try {
      res = await fetch(`${relayerUrl}/v2/keyurl`, { headers: { accept: "application/json" }, signal: ac.signal });
      if (!res.ok) throw await relayerHttpError(res, "keyurl");
      body = await res.json();
    } catch (e) {
      if (e instanceof FhevmError) throw e;
      throw new FhevmError("RELAYER_ERROR", `keyurl failed: ${errText(e)}`, { cause: e });
    } finally {
      clearTimeout(timer);
    }
    const src = parseKeyUrl(body);
    // Keyed on the URLs, not only the dataIds: Sepolia's relayer answers with constant placeholder dataIds
    // ("fhe-public-key-data-id", "crs-data-id"), so a key or CRS rotation shows only as new URLs. The chain
    // prefix is what idbPut replaces older entries by.
    const cacheKey = `${chainId}|${src.pkId}|${keyObject(src.pkUrl)}|${src.crsId}|${keyObject(src.crsUrl)}`;
    const metadata = { relayerUrl, chainId };
    const build = (pk: Uint8Array, crs: Uint8Array): FheKeyBytes =>
      ({ publicKeyBytes: { id: src.pkId, bytes: pk }, crsBytes: { id: src.crsId, capacity: 2048, bytes: crs }, metadata }) as FheKeyBytes;

    const cached = await idbGet(cacheKey);
    if (cached) {
      const n = cached.pk.length + cached.crs.length;
      setKeyStatus(chainId, { state: "ready", loadedBytes: n, totalBytes: n, fromCache: true });
      report({ stage: "key-cached", message: "FHE public key loaded from this browser's cache" });
      return build(cached.pk, cached.crs);
    }

    let loaded = 0;
    const totals: [number | null, number | null] = [null, null];
    const emit = () => {
      const total = totals[0] !== null && totals[1] !== null ? totals[0] + totals[1] : null;
      setKeyStatus(chainId, { state: "downloading", loadedBytes: loaded, totalBytes: total, fromCache: false });
      report({
        stage: "downloading-key",
        message: "Downloading Zama's FHE public key (one time, about 4.6 MB)…",
        loadedBytes: loaded,
        totalBytes: total,
      });
    };
    emit();
    const track = (i: 0 | 1) => (delta: number, total?: number | null) => {
      loaded += delta;
      if (total !== undefined) totals[i] = total;
      emit();
    };
    const [pk, crs] = await Promise.all([
      downloadBytes(src.pkUrl, track(0)),
      downloadBytes(src.crsUrl, track(1)),
    ]);
    setKeyStatus(chainId, { state: "ready", loadedBytes: loaded, totalBytes: loaded, fromCache: false });
    void idbPut(chainId, cacheKey, { pk, crs });
    return build(pk, crs);
  })();
  keyPromises.set(chainId, p);
  p.then(() => { lastProgress.delete(keyChannel(chainId)); }, (e) => {
    lastProgress.delete(keyChannel(chainId));
    if (keyPromises.get(chainId) === p) keyPromises.delete(chainId);
    setKeyStatus(chainId, { ...getFheKeyStatus(chainId), state: "error", error: errText(e) });
  });
  return p;
};

/**
 * Warm the one-time FHE key download before the user submits (e.g. when the
 * create form mounts). No-op on Anvil and outside the browser. Never throws.
 */
export const prefetchFheKey = async (chainId: number, onProgress?: FhevmProgressFn): Promise<void> => {
  if (!isBrowser() || (chainId !== MAINNET_ID && chainId !== SEPOLIA_ID)) return;
  const stop = followProgress(keyChannel(chainId), onProgress);
  try {
    await loadFheKey(chainId);
  } catch {
    /* surfaced through getFheKeyStatus and again on encryptDek */
  } finally {
    stop();
  }
};

// ---------- SDK instances ----------

type Purpose = "encrypt" | "decrypt";
const sdkPromises = new Map<string, Promise<ZamaSDK>>();

const logger = {
  error: (...a: unknown[]) => console.error("[fhevm]", ...a),
  warn: (...a: unknown[]) => console.warn("[fhevm]", ...a),
  info: () => {},
  debug: () => {},
};

/**
 * One ZamaSDK per (chain, purpose). The decrypt instance never needs the 4.6 MB
 * key; the encrypt instance on relayer chains is built with the prefetched key.
 * Shared (see "shared loads"). A failed build is evicted so the next call
 * starts clean (the SDK's own init does not self-recover).
 */
const getSdk = (chainId: FhevmChainId, purpose: Purpose): Promise<ZamaSDK> => {
  const k = sdkChannel(chainId, purpose);
  const existing = sdkPromises.get(k);
  if (existing) return existing;
  const report = broadcast(k);
  const p = (async () => {
    const rpc = rpcUrlFor(chainId);
    const viemChain = chainById(chainId);
    if (!rpc || !viemChain) throw new FhevmError("NO_RPC", `no RPC URL configured for chain ${chainId}`);

    // Key download (relayer chains, encrypt only) runs in parallel with the SDK import.
    const keyP = chainId !== ANVIL_ID && purpose === "encrypt" ? loadFheKey(chainId) : null;

    report({ stage: "loading-sdk", message: "Loading the FHE library…" });
    let mods;
    try {
      mods = await Promise.all([
        import("@zama-fhe/sdk"),
        import("@zama-fhe/sdk/chains"),
        import("@zama-fhe/sdk/viem"),
        chainId === ANVIL_ID ? null : import("@zama-fhe/sdk/web"),
      ]);
    } catch (e) {
      throw new FhevmError("SDK_LOAD_FAILED", `could not load the FHE SDK: ${errText(e)}`, { cause: e });
    }
    const [sdkMod, chainsMod, viemMod, webMod] = mods;
    const fheKey = keyP ? await keyP : undefined;

    report({ stage: "initializing", message: "Initialising FHE…" });
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const provider = new viemMod.ViemProvider({ publicClient: publicClient as never });

    let fheChain;
    let relayer;
    if (chainId === ANVIL_ID) {
      fheChain = { ...chainsMod.anvil, network: rpc };
      relayer = sdkMod.cleartext();
    } else {
      const preset = chainId === MAINNET_ID ? chainsMod.mainnet : chainsMod.sepolia;
      // No `auth`: the same-origin proxy adds x-api-key server-side.
      fheChain = { ...preset, network: rpc, relayerUrl: relayerUrlFor(chainId) };
      relayer = webMod!.web({ ...(fheKey ? { fheEncryptionKey: fheKey } : {}) });
    }
    const config = sdkMod.createConfig({
      chains: [fheChain],
      relayers: { [chainId]: relayer } as never,
      provider,
      storage: sdkMod.memoryStorage,
      logger,
    });
    return new sdkMod.ZamaSDK(config);
  })();
  sdkPromises.set(k, p);
  p.then(() => { lastProgress.delete(k); }, () => {
    lastProgress.delete(k);
    if (sdkPromises.get(k) === p) sdkPromises.delete(k);
  });
  return p;
};

/** The shared SDK for one caller: its progress while waiting, its own abort. */
const sdkFor = async (chainId: FhevmChainId, purpose: Purpose, report: FhevmProgressFn, signal?: AbortSignal): Promise<ZamaSDK> => {
  const stops = [followProgress(sdkChannel(chainId, purpose), report)];
  if (chainId !== ANVIL_ID && purpose === "encrypt") stops.push(followProgress(keyChannel(chainId), report));
  try {
    return await forCaller(getSdk(chainId, purpose), signal);
  } finally {
    for (const stop of stops) stop();
  }
};

/**
 * Forget `chainId`'s FHE key: this browser's cached copy, the page's loaded one and the encrypt SDK built
 * with it. The next encryption downloads it afresh.
 */
const evictFheKey = async (chainId: typeof MAINNET_ID | typeof SEPOLIA_ID): Promise<void> => {
  keyPromises.delete(chainId);
  const k = sdkChannel(chainId, "encrypt");
  const sdk = sdkPromises.get(k);
  sdkPromises.delete(k);
  lastProgress.delete(k);
  lastProgress.delete(keyChannel(chainId));
  setKeyStatus(chainId, IDLE_STATUS);
  await idbDeleteChain(chainId);
  try { (await sdk)?.terminate(); } catch { /* already failed */ }
};

/** Dispose every SDK instance (e.g. on sign-out). The key cache in IndexedDB is kept. */
export const disposeFhevm = async (): Promise<void> => {
  const all = [...sdkPromises.values()];
  sdkPromises.clear();
  keyPromises.clear();
  lastProgress.clear();
  for (const p of all) {
    try { (await p).terminate(); } catch { /* already failed */ }
  }
};

// ---------- operations ----------

const toDekBigInt = (dek: Uint8Array | Hex): bigint => {
  const bytes = typeof dek === "string" ? hexToBytes(dek) : dek;
  if (bytes.length !== DEK_BYTES) throw new FhevmError("BAD_RESULT", `data key must be ${DEK_BYTES} bytes, got ${bytes.length}`);
  return BigInt(bytesToHex(bytes));
};

/**
 * Encrypt the DEK as an euint256 bound to (contractAddress, userAddress).
 * Returns the handle + input proof for createSwitch. The first call on a
 * relayer chain downloads the FHE key (see onProgress / getFheKeyStatus).
 */
export const encryptDek = async (params: EncryptDekParams): Promise<EncryptedDek> => {
  const chainId = assertChain(params.chainId);
  if (chainId !== ANVIL_ID && !isBrowser()) throw new FhevmError("NOT_BROWSER", "encryptDek is browser-only");
  const report = params.onProgress ?? (() => {});
  const value = toDekBigInt(params.dek);
  throwIfAborted(params.signal);

  const sdk = await sdkFor(chainId, "encrypt", report, params.signal);
  throwIfAborted(params.signal);
  report({ stage: "encrypting", message: "Encrypting the key and requesting the input proof…" });
  let res;
  try {
    res = await sdk.encrypt(
      { values: [{ type: "euint256", value }], contractAddress: params.contractAddress, userAddress: params.userAddress },
      { signal: params.signal, timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  } catch (e) {
    if (params.signal?.aborted) throw new FhevmError("ABORTED", "cancelled", { cause: e });
    const proxy = proxyAnswer(e);
    if (proxy) throw proxy;
    // Proofs made with a stale key or CRS are rejected. A key rotated without a new URL can only show this
    // way, so a cached copy is dropped (once: the next one is a fresh download, never blamed on the cache).
    if (chainId !== ANVIL_ID && inputProofRejected(e) && getFheKeyStatus(chainId).fromCache) {
      await evictFheKey(chainId);
      throw new FhevmError(
        "ENCRYPT_FAILED",
        `Zama's network rejected the input proof made with this browser's cached FHE key, which may be out of date. The cached key was cleared: try again, and it is downloaded afresh (about 4.6 MB). Nothing was sent on-chain. (${errText(e)})`,
        { cause: e },
      );
    }
    throw relayerUnavailable(e) ?? new FhevmError("ENCRYPT_FAILED", `FHE encryption failed: ${errText(e)}`, { cause: e });
  }
  // The SDK honours the signal only during the relayer round trip; the coprocessor-signature check after it
  // (a host-chain read) does not, so a cancel then ends here, before the create opens its wallet prompt.
  throwIfAborted(params.signal);
  const handle = res.encryptedValues[0];
  if (res.encryptedValues.length !== 1 || !handle) throw new FhevmError("BAD_RESULT", "expected exactly one encrypted value");
  if (!/^0x[0-9a-fA-F]+$/.test(res.inputProof) || res.inputProof.length <= 2) {
    throw new FhevmError("BAD_RESULT", "empty input proof");
  }
  report({ stage: "done", message: "Key encrypted" });
  return { handle: checkHandle(handle, chainId), inputProof: res.inputProof };
};

// Includes the relayer's typed answers for a handle the gateway has not seen as decryptable yet
// (400 not_ready_for_decryption, 503 readiness_check_timed_out on the poll).
const NOT_YET_RE = /not.{0,40}(allowed|decryptable)|publicly.?decrypt|acl|not.?found|unauthori[sz]ed|isAllowedForDecryption|not_ready_for_decryption|readiness_check_timed_?out/i;

/**
 * Ask Zama's KMS (through the relayer, or the cleartext mock on Anvil) to
 * publicly decrypt ONE handle. Succeeds only after markDark is mined and the
 * KMS has observed it; otherwise throws FhevmError("NOT_DECRYPTABLE_YET") —
 * retry with backoff.
 *
 * The returned key is what the KMS signed, not yet what opens the ciphertext:
 * always run envelope.checkKey(dekBytes, ciphertext, commitment) and show
 * INVALID_KEY_WARNING if it fails.
 */
export const publicDecryptDek = async (params: PublicDecryptDekParams): Promise<DecryptedDek> => {
  const chainId = assertChain(params.chainId);
  if (chainId !== ANVIL_ID && !isBrowser()) throw new FhevmError("NOT_BROWSER", "publicDecryptDek is browser-only");
  const report = params.onProgress ?? (() => {});
  const handle = checkHandle(params.handle, chainId);
  throwIfAborted(params.signal);

  const sdk = await sdkFor(chainId, "decrypt", report, params.signal);
  throwIfAborted(params.signal);
  report({ stage: "decrypting", message: "Waiting for Zama's KMS to decrypt the key…" });
  let res;
  try {
    res = await sdk.decryption.decryptPublicValues([handle], {
      signal: params.signal,
      timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (e) {
    if (params.signal?.aborted) throw new FhevmError("ABORTED", "cancelled", { cause: e });
    const config = proxyAnswer(e);
    if (config) throw config;
    const msg = errText(e);
    // Matched without the URLs the SDK's messages carry: a site at "…oracle…" contains "acl".
    if (NOT_YET_RE.test(msg.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " "))) {
      throw new FhevmError("NOT_DECRYPTABLE_YET", `the key is not publicly decryptable yet (has markDark been mined?): ${msg}`, { cause: e });
    }
    throw relayerUnavailable(e) ?? new FhevmError("DECRYPT_FAILED", `public decryption failed: ${msg}`, { cause: e });
  }
  throwIfAborted(params.signal);

  const dataKey = res.abiEncodedClearValues;
  if (!/^0x[0-9a-fA-F]{64}$/.test(dataKey)) {
    throw new FhevmError("BAD_RESULT", "the KMS returned an unexpected clear-value encoding (expected one uint256)");
  }
  const clear = Object.entries(res.clearValues).find(([h]) => h.toLowerCase() === handle)?.[1];
  if (clear !== undefined && BigInt(clear as bigint) !== BigInt(dataKey)) {
    throw new FhevmError("BAD_RESULT", "clear value and its ABI encoding disagree");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(res.decryptionProof) || res.decryptionProof.length <= 2) {
    throw new FhevmError("BAD_RESULT", "empty decryption proof");
  }
  report({ stage: "done", message: "Key decrypted by the KMS" });
  return {
    dataKey: dataKey.toLowerCase() as Hex,
    dekBytes: hexToBytes(dataKey),
    decryptionProof: res.decryptionProof,
  };
};
