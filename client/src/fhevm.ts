// Zama SDK (@zama-fhe/sdk 3.6.0) factory, one per chain:
//
//   1         → `mainnet` preset + node() relayer   (needs ZAMA_RELAYER_API_KEY)
//   11155111  → `sepolia` preset + node() relayer   (Zama's Sepolia relayer is open; key optional)
//   31337     → `anvil` preset   + cleartext()      (forge-fhevm host on local Anvil)
//
// The chain's `network` is always RPC_URL; ZAMA_RELAYER_URL overrides the
// preset relayer. Only the 32-byte DEK ever goes through FHE.
//
// Public decryption is ONE handle per call: revealKey checks a KMS proof over a
// single-handle list, so a proof that covers several handles can never verify.

import { anvil as fheAnvil, mainnet as fheMainnet, sepolia as fheSepolia, type FheChain } from "@zama-fhe/sdk/chains";
import { hexToBytes, isHex, toHex, type Address, type Hex, type WalletClient } from "viem";
import { createWalletClient, http } from "viem";
import type { Clients } from "./chain.js";
import { CHAIN_NAMES, ConfigError, type Config } from "./config.js";
import { DEK_BYTES, dekToBigInt } from "./envelope.js";

export type FhevmConfig = Pick<Config, "chainId" | "rpcUrl" | "relayerApiKey" | "relayerUrl">;

/** Build the SDK chain definition for this config. Pure; throws ConfigError when mainnet has no API key. */
export const fheChainFor = (cfg: FhevmConfig): FheChain => {
  if (cfg.chainId === 31337) {
    return { ...fheAnvil, network: cfg.rpcUrl, ...(cfg.relayerUrl ? { relayerUrl: cfg.relayerUrl } : {}) };
  }
  const preset = cfg.chainId === 1 ? fheMainnet : fheSepolia;
  if (!cfg.relayerApiKey && cfg.chainId === 1) {
    throw new ConfigError(
      `ZAMA_RELAYER_API_KEY is required on ${CHAIN_NAMES[cfg.chainId]} (chain ${cfg.chainId}) to encrypt the key ` +
        `or fetch a public-decryption proof from ${cfg.relayerUrl ?? preset.relayerUrl}. Request one from Zama and set it in .env.`,
    );
  }
  return {
    ...preset,
    network: cfg.rpcUrl,
    relayerUrl: cfg.relayerUrl ?? preset.relayerUrl,
    ...(cfg.relayerApiKey ? { auth: { __type: "ApiKeyHeader", value: cfg.relayerApiKey } } : {}),
  };
};

export interface EncryptedDek {
  /** externalEuint256 handle for createSwitch. */
  handle: Hex;
  inputProof: Hex;
}

export interface DecryptedDek {
  /** The 32-byte data key. */
  dek: Uint8Array;
  /** abi.encode(uint256 dek) — exactly the bytes32 `revealKey` expects as `dataKey`. */
  dataKey: Hex;
  /** KMS public-decryption proof for this one handle. */
  decryptionProof: Hex;
}

export interface Fhevm {
  readonly chain: FheChain;
  encryptDek(dek: Uint8Array, contractAddress: Address, userAddress: Address): Promise<EncryptedDek>;
  publicDecryptDek(handle: Hex, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DecryptedDek>;
  close(): void;
}

/**
 * How long to wait before asking the relayer again after a "no route" answer (FhevmError.noRoute): an edge
 * reloading its routes can answer that for a second or two; only a second answer after this wait counts.
 */
export const NO_ROUTE_RECHECK_MS = 3_000;

export class FhevmError extends Error {
  /**
   * The relayer refused us for a reason a retry cannot fix: SDK configuration,
   * HTTP 401/403 (missing, wrong or revoked ZAMA_RELAYER_API_KEY), or no route
   * for the request that starts a job (a wrong ZAMA_RELAYER_URL path). Anything
   * else (key not decryptable yet, timeouts, 5xx, 429) is treated as transient.
   */
  readonly fatal: boolean;
  /** Server-suggested delay before retrying (Retry-After on HTTP 429), seconds. */
  readonly retryAfterSec?: number;
  /** For a fatal error: what the operator should check. */
  readonly hint?: string;
  /**
   * Fatal because the relayer has no route for the request (404/405, a wrong ZAMA_RELAYER_URL path). An edge
   * reloading its routes can answer that for a second or two: callers conclude only when a request
   * NO_ROUTE_RECHECK_MS later gets it too.
   */
  readonly noRoute: boolean;

  constructor(message: string, options?: { cause?: unknown; fatal?: boolean; retryAfterSec?: number; hint?: string; noRoute?: boolean }) {
    super(message, options);
    this.name = "FhevmError";
    this.fatal = options?.fatal ?? false;
    this.retryAfterSec = options?.retryAfterSec;
    this.hint = options?.hint;
    this.noRoute = options?.noRoute ?? false;
  }
}

/** The @zama-fhe/sdk error helpers classifyRelayerError needs (passed in so the SDK stays lazily imported). */
export interface SdkErrorHelpers {
  matchZamaError: typeof import("@zama-fhe/sdk").matchZamaError;
  retryAfterSeconds: typeof import("@zama-fhe/sdk").retryAfterSeconds;
}

/**
 * The relayer's HTTP answer in an SDK error's cause chain: the first error carrying a status and the request
 * method (@fhevm/sdk's response errors; their name is always "RelayerErrorBase", so it is not matched), and
 * whether the relayer answered with a typed error (`relayerApiError`, a getter over a private field).
 */
const relayerAnswer = (err: unknown): { status: number; method: string; typed: boolean } | undefined => {
  let e: unknown = err;
  for (let i = 0; i < 8 && typeof e === "object" && e !== null; i++, e = (e as { cause?: unknown }).cause) {
    try {
      const { status, fetchMethod, relayerApiError } = e as { status?: unknown; fetchMethod?: unknown; relayerApiError?: unknown };
      if (typeof status === "number" && typeof fetchMethod === "string") return { status, method: fetchMethod, typed: relayerApiError !== undefined };
    } catch {
      /* a getter of another error class: not the relayer's answer */
    }
  }
  return undefined;
};

/**
 * Classify an SDK error from the relayer: fatal or transient, plus Retry-After. Fatal: configuration, HTTP
 * 401/403, and a 404/405 to the POST that starts a job without a typed relayer error (the edge has no route
 * there: a wrong ZAMA_RELAYER_URL path such as …/v2, live answer `{"message":"no Route matched with those
 * values"}`). Never a 400: the SDK reports every relayer 400 as NO_CIPHERTEXT, including the normal lag right
 * after markDark (`not_allowed_on_host_acl` from the poll). A typed 404 from the poll (a job the relayer no
 * longer knows) is transient too: a fresh request can work. A no-route answer is marked `noRoute`: one alone can
 * be an edge reloading its routes, so callers ask again NO_ROUTE_RECHECK_MS later before concluding.
 */
export const classifyRelayerError = (err: unknown, sdk: SdkErrorHelpers): { fatal: boolean; retryAfterSec?: number; hint?: string; noRoute?: boolean } => {
  /** Fatal: what to check, if anything more specific than the error itself. */
  const fatal = sdk.matchZamaError<{ hint?: string; noRoute?: boolean } | undefined>(err, {
    CONFIGURATION: () => ({}),
    RELAYER_REQUEST_FAILED: (e) => {
      if (e.statusCode === 401 || e.statusCode === 403) return { hint: "check ZAMA_RELAYER_API_KEY (and ZAMA_RELAYER_URL)" };
      const answer = relayerAnswer(err);
      if ((e.statusCode === 404 || e.statusCode === 405) && answer?.method === "POST" && !answer.typed) {
        return {
          hint:
            "the relayer has no public-decrypt route there: check ZAMA_RELAYER_URL " +
            "(give the relayer's base URL, such as https://relayer.testnet.zama.org; the SDK appends /v2/public-decrypt)",
          noRoute: true,
        };
      }
      return undefined;
    },
    _: () => undefined,
  });
  return { fatal: fatal !== undefined, retryAfterSec: sdk.retryAfterSeconds(err), ...fatal };
};

/**
 * A viem error's `shortMessage` (plus `details`, the innermost cause). Its full `message` names the request
 * URL, and an RPC URL can carry an API key in its path (Alchemy's /v2/<key>, Infura's /v3/<key>).
 */
const viemText = (err: unknown): string | undefined => {
  const { shortMessage, details } = err as { shortMessage?: unknown; details?: unknown };
  if (typeof shortMessage !== "string" || !shortMessage) return undefined;
  return typeof details === "string" && details && !shortMessage.includes(details) ? `${shortMessage} (${details})` : shortMessage;
};

/**
 * `text` with RPC_URL replaced, and every other URL on RPC_URL's host cut down to that host (`https://host/…`):
 * an RPC URL can carry an API key in its path (Alchemy's /v2/<key>, Infura's /v3/<key>) or in credentials.
 * Other URLs (documentation links, the relayer) stay whole. Errors from the SDK are printed by the CLI and kept
 * in the watcher's log and state file.
 */
export const redactUrls = (text: string, rpcUrl?: string): string => {
  if (!rpcUrl) return text;
  const out = text.split(rpcUrl).join("<RPC_URL>");
  let host: string;
  try {
    host = new URL(rpcUrl).host.toLowerCase();
  } catch {
    return out;
  }
  return out.replace(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/?#@]*@)?([^\s/?#"'<>]+)([^\s"'<>]*)/gi, (m: string, scheme: string, at: string, rest: string) => {
    if (at.toLowerCase() !== host) return m;
    const trailing = /[.,;:!?)\]]+$/.exec(rest)?.[0] ?? ""; // punctuation after the URL is the sentence's
    const path = rest.slice(0, rest.length - trailing.length);
    return `${scheme}://${at}${path && path !== "/" ? "/…" : ""}${trailing}`;
  });
};

const describeCause = (err: unknown, rpcUrl?: string): string => {
  let msg: string;
  if (err instanceof Error) {
    const own = viemText(err) ?? err.message;
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? (viemText(cause) ?? cause.message) : undefined;
    msg = causeText && !own.includes(causeText) ? `${own}: ${causeText}` : own;
  } else {
    msg = String(err);
  }
  return redactUrls(msg.replace(/\s+/g, " ").trim(), rpcUrl);
};

/** Validate and normalise a decryptPublicValues result for one euint256 handle. Exported for tests. */
export const normalizeDecryption = (
  handle: Hex,
  res: { clearValues: Record<string, unknown>; abiEncodedClearValues: Hex; decryptionProof: Hex },
): DecryptedDek => {
  const entry = Object.entries(res.clearValues).find(([h]) => h.toLowerCase() === handle.toLowerCase());
  if (!entry) throw new FhevmError(`KMS response does not contain handle ${handle}`);
  const clear = entry[1];
  if (typeof clear !== "bigint") throw new FhevmError(`KMS returned a ${typeof clear} for an euint256 handle`);
  const dataKey = toHex(clear, { size: DEK_BYTES });
  if (!isHex(res.abiEncodedClearValues) || res.abiEncodedClearValues.length !== 2 + DEK_BYTES * 2) {
    throw new FhevmError(
      `expected a 32-byte abi-encoded cleartext for one handle, got ${(res.abiEncodedClearValues.length - 2) / 2} bytes ` +
        `(was more than one handle decrypted?)`,
    );
  }
  if (res.abiEncodedClearValues.toLowerCase() !== dataKey.toLowerCase()) {
    throw new FhevmError("KMS abi-encoded cleartext disagrees with the decoded clear value");
  }
  if (!isHex(res.decryptionProof) || res.decryptionProof.length <= 2) throw new FhevmError("KMS returned an empty decryption proof");
  return { dek: hexToBytes(dataKey), dataKey: res.abiEncodedClearValues, decryptionProof: res.decryptionProof };
};

/**
 * Create the SDK for this chain. The SDK modules are imported lazily so that
 * commands which never touch FHE (ping, info, read, ...) start fast.
 */
export const createFhevm = async (cfg: FhevmConfig, clients: Clients): Promise<Fhevm> => {
  const chain = fheChainFor(cfg);
  const [{ ZamaSDK, cleartext, matchZamaError, retryAfterSeconds }, { createConfig }, { node }] = await Promise.all([
    import("@zama-fhe/sdk"),
    import("@zama-fhe/sdk/viem"),
    import("@zama-fhe/sdk/node"),
  ]);
  const relayer = cfg.chainId === 31337 ? cleartext() : node();
  // The SDK wants a wallet client even for public decryption; a read-only
  // caller gets one with no account (it is never asked to sign).
  const walletClient: WalletClient =
    clients.walletClient ?? createWalletClient({ chain: clients.chain, transport: http(cfg.rpcUrl) });
  const sdk = new ZamaSDK(
    createConfig({
      chains: [chain],
      publicClient: clients.publicClient,
      walletClient,
      relayers: { [chain.id]: relayer },
    }),
  );

  return {
    chain,

    async encryptDek(dek, contractAddress, userAddress) {
      let res;
      try {
        res = await sdk.encrypt({
          values: [{ type: "euint256", value: dekToBigInt(dek) }],
          contractAddress,
          userAddress,
        });
      } catch (err) {
        throw new FhevmError(`FHE encryption of the data key failed: ${describeCause(err, cfg.rpcUrl)}`, { cause: err });
      }
      const handle = res.encryptedValues[0];
      if (res.encryptedValues.length !== 1 || !handle) throw new FhevmError("SDK returned an unexpected number of handles");
      return { handle, inputProof: res.inputProof };
    },

    async publicDecryptDek(handle, opts = {}) {
      let res;
      try {
        res = await sdk.decryption.decryptPublicValues([handle], {
          ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (err) {
        const how = classifyRelayerError(err, { matchZamaError, retryAfterSeconds });
        throw new FhevmError(`public decryption of ${handle} refused or failed: ${describeCause(err, cfg.rpcUrl)}`, { cause: err, ...how });
      }
      return normalizeDecryption(handle, res as never);
    },

    close() {
      try {
        sdk.terminate();
      } catch {
        /* best effort */
      }
    },
  };
};
