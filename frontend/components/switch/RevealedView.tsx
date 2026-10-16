"use client";

import Link from "next/link";
import { useMemo } from "react";
import { explorerTx } from "@/lib/contracts";
import { hexToBytes } from "@/lib/envelope";
import { errMsg } from "@/lib/errors";
import { useEffectiveChain, usePublishPlaintext, usePublishedPlaintext, useRevealedSecret } from "@/lib/hooks";
import { fmtBytes32, fmtEth, switchPath, type SwitchHandle, type SwitchInfo } from "@/lib/switch";
import { estimatePublishGas, gasCost, useCallGas, useGasPrice } from "@/components/gas";
import { ActionGate } from "@/components/ui/ActionGate";
import { Address } from "@/components/ui/Address";
import { CopyButton } from "@/components/ui/Copy";
import { ErrorBox } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Loading";
import { Note } from "@/components/ui/Note";
import { PendingTx } from "@/components/ui/PendingTx";
import { useTxToast } from "@/components/ui/useTxToast";
import { PlaintextView } from "./PlaintextView";

function Badge({ ok, children, title }: { ok: boolean; children: React.ReactNode; title: string }) {
  return (
    <span className={`pill ${ok ? "pill-alive" : "border-warn/40 bg-warn/10 text-warn"}`} title={title}>
      <Icon name={ok ? "check" : "alert"} size={12} /> {children}
    </span>
  );
}

/**
 * A REVEALED switch, decrypted in the browser from chain state alone:
 * getCiphertext + getRevealedKey → AES-256-GCM. Works whether or not anyone
 * called publishPlaintext. `compact` is the archive-list variant.
 */
export function RevealedView({
  handle, info, compact = false,
}: {
  handle: SwitchHandle;
  info: SwitchInfo;
  compact?: boolean;
}) {
  const { chainId } = useEffectiveChain();
  const secret = useRevealedSecret(handle, info);
  const published = usePublishedPlaintext(handle, info);
  const check = secret.data;
  const filenameBase = `switch-${chainId}-${handle.owner.slice(2, 10).toLowerCase()}-${handle.id.toString()}`;

  const opened = check && (check.status === "ok" || check.status === "commitment-mismatch") ? check : null;
  const payload = published.data?.payload;
  const pubBytes = useMemo(() => (payload ? hexToBytes(payload) : null), [payload]);
  const publishedMatches = !!opened && !!published.data
    && published.data.payload.toLowerCase() === opened.plaintextHex.toLowerCase();
  // The key opens the ciphertext, but the commitment-checked published payload is something else: show both.
  const publishedDiffers = !!opened && !!pubBytes && !publishedMatches;

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-info">
          <Icon name="unlock" size={12} /> Released secret
        </span>
        {opened && (
          <>
            <Badge ok title="The revealed key opened the on-chain ciphertext: AES-GCM authenticated it, so it is exactly what the owner encrypted.">
              Tag verified
            </Badge>
            <Badge
              ok={opened.status === "ok"}
              title="keccak256(salt ‖ plaintext) compared with the commitment the owner made at creation."
            >
              {opened.status === "ok" ? "Commitment verified" : "Commitment mismatch"}
            </Badge>
          </>
        )}
      </div>

      {secret.isLoading && (
        <p className="flex items-center gap-2 text-sm text-fg-muted"><Spinner size={14} /> Decrypting from chain state…</p>
      )}
      {secret.error && <ErrorBox title="Could not read the ciphertext" message={errMsg(secret.error)} />}

      {check?.status === "invalid-key" && (
        <Note tone="danger" title="The revealed key does not open the ciphertext">
          <p className="text-sm">{check.warning}</p>
        </Note>
      )}
      {check?.status === "malformed" && (
        <Note tone="danger" title="The stored ciphertext is malformed">
          <p className="text-sm">{check.reason}</p>
        </Note>
      )}
      {opened?.status === "commitment-mismatch" && (
        <Note tone="warn" title="Not what the owner committed to">
          <p className="text-sm">
            The key opens the ciphertext, so this is exactly what was encrypted, but it does not match the commitment
            made at creation: the owner committed to something else
            {publishedDiffers
              ? ". These decrypted bytes can never be published on-chain. The committed plaintext was published separately and is shown below; it is the copy explorers and indexers display."
              : info.published ? "." : ", so these decrypted bytes can never be published on-chain."}
          </p>
        </Note>
      )}

      {opened && (
        <PlaintextView
          plaintext={opened.plaintext}
          filenameBase={filenameBase}
          compact={compact}
          source={opened.status === "ok" ? "decrypted in this browser" : "decrypted in this browser (does not match the commitment)"}
        />
      )}

      {/* The key does not open the ciphertext, or opens it but the commitment
          matches something else: someone published the committed plaintext. */}
      {pubBytes && (!opened || publishedDiffers) && (
        <PlaintextView
          plaintext={pubBytes}
          filenameBase={opened ? `${filenameBase}-published` : filenameBase}
          compact={compact}
          source="from the PlaintextPublished event (commitment-checked by the contract)"
        />
      )}

      {info.published && published.data && (
        <p className="text-xs text-fg-muted">
          Also published on-chain by{" "}
          <Address address={published.data.publisher} chainId={chainId} copyTitle="Copy publisher address" />
          {explorerTx(chainId, published.data.txHash) && (
            <> in <a className="underline-offset-2 hover:underline" href={explorerTx(chainId, published.data.txHash)} target="_blank" rel="noreferrer">this transaction</a></>
          )}
          {opened && (publishedMatches ? " · identical to the decrypted bytes." : " · differs from the decrypted bytes (both shown).")}
        </p>
      )}
      {info.published && published.isLoading && (
        <p className="text-xs text-fg-subtle">Looking up the PlaintextPublished event…</p>
      )}
      {/* The lookup throws on persistent RPC failure. Without the key opening
          the ciphertext, that event is the only readable copy: never a silent blank. */}
      {info.published && published.isError && (
        <Note tone={opened ? "info" : "warn"} title="Couldn't look up the published plaintext">
          <p className="break-words text-sm">
            The PlaintextPublished event could not be read ({errMsg(published.error)}).
            {!opened && " It is the only readable copy of this secret, because the revealed key does not open the ciphertext."}
          </p>
          <button
            type="button"
            className="btn btn-sm"
            disabled={published.isFetching}
            onClick={() => void published.refetch()}
          >
            {published.isFetching ? <Spinner size={12} /> : <Icon name="refresh" size={12} />} Retry
          </button>
        </Note>
      )}

      {/* The reveal time is in the summary above. */}
      {!compact && (
        <dl className="text-xs">
          <dt className="text-fg-subtle">Revealed key (on-chain)</dt>
          <dd className="flex items-center gap-1">
            <span className="value text-fg">{fmtBytes32(info.revealedKey)}</span>
            <CopyButton value={info.revealedKey} title="Copy key" />
          </dd>
        </dl>
      )}

      {!compact && opened?.status === "ok" && !info.published && (
        <PublishAction handle={handle} saltHex={opened.saltHex} plaintextHex={opened.plaintextHex} size={opened.plaintext.length} />
      )}
      {compact && (
        <Link
          href={switchPath(chainId, handle)}
          className="inline-flex items-center gap-1 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
        >
          Details{opened?.status === "ok" && !info.published ? " and optional on-chain publication" : ""} <Icon name="chevronRight" size={12} />
        </Link>
      )}
    </div>
  );
}

/** Optional: post the plaintext in a PlaintextPublished event. Pays nothing. */
function PublishAction({
  handle, saltHex, plaintextHex, size,
}: {
  handle: SwitchHandle;
  saltHex: `0x${string}`;
  plaintextHex: `0x${string}`;
  size: number;
}) {
  // Given this switch: a publish sent before a reload shows as pending, and a second is refused.
  const publish = usePublishPlaintext(handle);
  const tx = useTxToast();
  const gasPrice = useGasPrice();
  const exact = useCallGas({ contract: handle.contractAddr, functionName: "publishPlaintext", args: [handle.owner, handle.id, saltHex, plaintextHex] });
  const gas = exact ?? estimatePublishGas(size);
  const fee = gasCost(gas, gasPrice);

  return (
    <div className="space-y-2 rounded border border-line p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon name="archive" size={14} /> Publish the plaintext on-chain <span className="pill pill-neutral">Optional</span>
      </div>
      <p className="text-xs text-fg-muted">
        Not needed: anyone can already decrypt this from chain state, as this page just did. Publishing writes the
        plaintext into an event the contract checks against the owner&apos;s commitment, so explorers and indexers can
        show it without decrypting. It costs about{" "}
        <span className="value text-fg">{Number(gas).toLocaleString()}</span> gas
        {fee !== null && <> (≈ <span className="value text-fg">{fmtEth(fee, 6)}</span>)</>} and pays nothing.
      </p>
      <ActionGate what="publish the plaintext" compact>
        <button
          type="button"
          className="btn btn-sm"
          disabled={publish.pending}
          onClick={() => tx(() => publish.write(handle, saltHex, plaintextHex), "Plaintext published on-chain")}
        >
          {publish.pending ? <Spinner size={12} /> : <Icon name="archive" size={12} />} Publish plaintext
        </button>
      </ActionGate>
      <PendingTx writes={[publish]} />
      {/* The last verdict stays in view: a write resumed after a reload has no toast. */}
      {!publish.pending && publish.error && <p role="alert" className="field-error break-words">{publish.error}</p>}
    </div>
  );
}
