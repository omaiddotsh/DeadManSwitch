// Relayer failures as @zama-fhe/sdk 3.6.0 reports them from public decryption, built from stand-ins for the
// @fhevm/sdk 0.13.2 errors it wraps (those are not exported). Like the real ones, they are named
// "RelayerErrorBase", and their HTTP status, method and typed relayer error are getters over private fields.
// The SDK maps every relayer 400 to NoCiphertextError (no status code) and any other status to
// RelayerRequestFailedError(status), keeping the @fhevm/sdk error as the cause.

import { matchZamaError, NoCiphertextError, RelayerRequestFailedError, retryAfterSeconds } from "@zama-fhe/sdk";
import { classifyRelayerError, FhevmError } from "../src/fhevm.js";

/** An answer outside the relayer's API contract (RelayerResponseStatusError), such as the edge's "no Route matched" 404. */
export class RelayerStatusAnswer extends Error {
  readonly #status: number;
  readonly #fetchMethod: "POST" | "GET";

  constructor(status: number, fetchMethod: "POST" | "GET") {
    super(`Public decryption: Relayer returned unexpected response status: ${status}`);
    this.name = "RelayerErrorBase";
    this.#status = status;
    this.#fetchMethod = fetchMethod;
  }

  get status(): number {
    return this.#status;
  }

  get fetchMethod(): "POST" | "GET" {
    return this.#fetchMethod;
  }
}

/** A typed relayer error (RelayerResponseApiError): a label and a message in the relayer's JSON body. */
export class RelayerApiAnswer extends RelayerStatusAnswer {
  readonly #relayerApiError: { label: string; message: string };

  constructor(status: number, fetchMethod: "POST" | "GET", relayerApiError: { label: string; message: string }) {
    super(status, fetchMethod);
    this.message = `Public decryption: Relayer API error [${relayerApiError.label}]: ${relayerApiError.message}`;
    this.#relayerApiError = relayerApiError;
  }

  get relayerApiError(): { label: string; message: string } {
    return this.#relayerApiError;
  }
}

const HANDLE = `0x${"66".repeat(32)}`;

/** SDK errors from public decryption, by what the relayer answered. */
export const relayerAnswers = {
  /** ZAMA_RELAYER_URL with a path (…/v2): POST …/v2/v2/public-decrypt, answered 404 by the edge (recorded on the testnet relayer). */
  wrongUrl: () => {
    const cause = new RelayerStatusAnswer(404, "POST");
    return new RelayerRequestFailedError(cause.message, 404, { cause });
  },
  /** The same mistake answered 405 (method not allowed on that path). */
  wrongUrl405: () => {
    const cause = new RelayerStatusAnswer(405, "POST");
    return new RelayerRequestFailedError(cause.message, 405, { cause });
  },
  /** The normal lag right after markDark: the poll's 400 not_allowed_on_host_acl (recorded on the testnet relayer). */
  notYet: () => {
    const cause = new RelayerApiAnswer(400, "GET", { label: "not_allowed_on_host_acl", message: `ACL check failed for 1 handle(s): handle=${HANDLE}` });
    return new NoCiphertextError(cause.message, { cause });
  },
  /** A poll for a job the relayer no longer knows: a typed 404, which a fresh request can fix. */
  unknownJob: () => {
    const cause = new RelayerApiAnswer(404, "GET", { label: "not_found", message: "Wrong jobId or unknown value" });
    return new RelayerRequestFailedError(cause.message, 404, { cause });
  },
  /** An RPC endpoint (not the relayer) answering 404 while the SDK checks the ACL: viem's HttpRequestError has no request method. */
  rpc404: () => {
    const cause = Object.assign(new Error("HTTP request failed. Status: 404"), { status: 404 });
    return new RelayerRequestFailedError(cause.message, 404, { cause });
  },
};

/** What publicDecryptDek throws for one of them: the SDK error, classified. */
export const decryptFailure = (err: Error): FhevmError =>
  new FhevmError(`public decryption of ${HANDLE} refused or failed: ${err.message}`, { cause: err, ...classifyRelayerError(err, { matchZamaError, retryAfterSeconds }) });
