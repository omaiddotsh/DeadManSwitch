"use client";

import { ANVIL_ID } from "@/lib/contracts";
import { FhevmError, prefetchFheKey } from "@/lib/fhevm";
import { useFheKeyStatus } from "@/lib/hooks";
import { Icon } from "@/components/ui/Icon";

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

/** One-time download of Zama's FHE public key, as a line plus a progress bar. */
export function FheKeyStatus({ chainId, allowPrefetch = true }: { chainId: number; allowPrefetch?: boolean }) {
  const s = useFheKeyStatus(chainId);

  if (chainId === ANVIL_ID) {
    return (
      <p className="text-xs text-fg-muted">
        Local chain: the FHE key is encrypted with forge-fhevm&apos;s cleartext mock. No key download.
      </p>
    );
  }

  if (s.state === "downloading") {
    const pct = s.totalBytes ? Math.min(100, Math.round((s.loadedBytes / s.totalBytes) * 100)) : null;
    return (
      <div className="space-y-1.5" role="status" aria-live="polite">
        <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
          <span>Downloading Zama&apos;s FHE public key (once per browser)</span>
          <span className="value">
            {mb(s.loadedBytes)}{s.totalBytes ? ` / ${mb(s.totalBytes)}` : ""}{pct !== null ? ` · ${pct}%` : ""}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-raised">
          <div
            className={`h-full bg-info transition-[width] duration-300 ${pct === null ? "w-1/3 animate-pulse" : ""}`}
            style={pct !== null ? { width: `${pct}%` } : undefined}
          />
        </div>
      </div>
    );
  }

  if (s.state === "ready") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-fg-muted">
        <span className="text-alive"><Icon name="check" size={12} /></span>
        FHE public key ready{s.fromCache ? " (cached in this browser)" : ""} · {mb(s.totalBytes ?? s.loadedBytes)}
      </p>
    );
  }

  if (s.state === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gone">FHE key download failed: {s.error ?? "unknown error"}</span>
        {allowPrefetch && (
          <button type="button" className="btn btn-sm" onClick={() => void prefetchFheKey(chainId)}>
            <Icon name="refresh" size={12} /> Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      <span>
        The first encryption in this browser downloads Zama&apos;s FHE public key (about 4.6 MB, then cached).
      </span>
      {allowPrefetch && (
        <button type="button" className="btn btn-sm" onClick={() => void prefetchFheKey(chainId)}>
          <Icon name="download" size={12} /> Download now
        </button>
      )}
    </div>
  );
}

/** Extra guidance for FHE failures, keyed by FhevmError code. */
export const fhevmHint = (e: unknown): string | null => {
  if (!(e instanceof FhevmError)) return null;
  switch (e.code) {
    case "RELAYER_NOT_CONFIGURED":
      return "This server's Zama relayer proxy is not set up for this network, so it cannot reach Zama's network: no NEXT_PUBLIC_CONTRACT_<chainId>, no ZAMA_RELAYER_API_KEY on mainnet, or a bad ZAMA_RELAYER_URL_<chainId>. The operator must fix the server settings. Nothing was sent on-chain.";
    case "STALE_PAGE":
      return "The site was updated after this page loaded. Reload the page, then try again.";
    case "KEY_DOWNLOAD_FAILED":
      return "Zama's FHE public key could not be downloaded. Check your connection (and any content blocker) and try again.";
    case "SDK_LOAD_FAILED":
      return "The FHE library failed to load. Reload the page and try again.";
    case "RELAYER_ERROR":
      return "Zama's relayer returned an error. It may be busy or rate-limiting; wait a minute and retry.";
    case "NOT_DECRYPTABLE_YET":
      return "Zama's KMS has not released this key yet. It only does so after markDark is mined and observed; retry in a little while.";
    case "UNSUPPORTED_CHAIN":
      return "Switch your wallet to Ethereum mainnet or Sepolia.";
    case "ABORTED":
      return null;
    default:
      return null;
  }
};
