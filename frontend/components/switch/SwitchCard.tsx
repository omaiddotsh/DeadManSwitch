"use client";

import Link from "next/link";
import { encodePacked, keccak256 } from "viem";
import { useAccount } from "wagmi";
import { explorerAddress, isPreviousDeployment } from "@/lib/contracts";
import { useChainTime, useEffectiveChain, useFunderStake, useSwitchInfo } from "@/lib/hooks";
import {
  fmtBytes32, fmtDateTime, fmtDuration, switchPath, switchStateFor,
  type SwitchHandle, type SwitchInfo,
} from "@/lib/switch";
import { CopyButton } from "@/components/ui/Copy";
import { ErrorBox } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { SkeletonCard } from "@/components/ui/Loading";
import { FundAction } from "./FundAction";
import { OwnerActions } from "./OwnerActions";
import { RevealPanel } from "./RevealPanel";
import { RevealedView } from "./RevealedView";
import { SwitchSummary } from "./SwitchSummary";

/**
 * owner   — dashboard list: summary + ping / cancel / rescue inline
 * hunter  — hunt list: summary + the one next action (or a link to it)
 * archive — archive list: summary + the decrypted secret, compact
 * detail  — switch page: everything this viewer may do
 */
export type SwitchCardVariant = "owner" | "hunter" | "archive" | "detail";

export function SwitchCard({ handle, variant }: { handle: SwitchHandle; variant: SwitchCardVariant }) {
  const { info, error, isLoading } = useSwitchInfo(handle);
  const { nowSec } = useChainTime();
  const { address } = useAccount();
  const { chainId } = useEffectiveChain();

  // A failed background refetch keeps the last data (react-query sets both):
  // only an error with nothing read yet replaces the card. Swapping a loaded
  // card for an error box would unmount the actions under it and lose their
  // state (a fetched KMS key and proof, an open confirmation, a typed amount).
  if (!info) return error ? <ErrorBox title="Could not load switch" message={error} /> : <SkeletonCard />;
  if (isLoading || nowSec === null) return <SkeletonCard />;
  if (!info.exists) {
    return (
      <div className="card text-sm text-fg-muted">
        No switch #{handle.id.toString()} for owner <span className="value break-all">{handle.owner}</span> on this
        network. It may not be mined yet, or a reorg dropped it.
      </div>
    );
  }

  const state = switchStateFor(info, nowSec);
  const isOwner = !!address && address.toLowerCase() === info.owner.toLowerCase();
  const path = switchPath(chainId, handle);
  const props = { handle, info, state, nowSec };
  const older = isPreviousDeployment(chainId, handle.contractAddr);

  return (
    // A column, so that in a list grid the "Switch page" row sits at the bottom of a card stretched to its row.
    <article className="card flex flex-col gap-4" aria-label={`Switch ${handle.id.toString()}`}>
      {/* An older deployment is a pill in the summary on every card; the switch page also says what it means. */}
      <SwitchSummary {...props} isOwner={isOwner} older={older} />

      {older && variant === "detail" && (
        <p className="flex max-w-none items-start gap-1.5 text-xs text-fg-muted" role="note">
          <span className="mt-px text-info"><Icon name="info" size={12} /></span>
          <span className="min-w-0">
            On an earlier contract of this app, <span className="value break-all">{handle.contractAddr}</span>.
            Pings, top-ups, cancel and release go to it as before; new switches are created on the current one.
          </span>
        </p>
      )}

      {error && (
        <p className="flex max-w-none items-start gap-1.5 text-xs text-warn" role="status">
          <span className="mt-px"><Icon name="alert" size={12} /></span>
          <span className="min-w-0 break-words">Could not refresh this switch ({error}). Showing the last state read.</span>
        </p>
      )}

      {variant === "owner" && (
        <>
          {isOwner && <OwnerActions {...props} />}
          {/* The owner's own top-ups, after a cancel or once rescuable (renders nothing otherwise). */}
          {isOwner && state !== "alive" && state !== "revealed" && <FundAction {...props} isOwner />}
          {state === "revealed" && (
            <p className="max-w-none border-t border-line pt-3 text-xs text-fg-muted">The key was released and the secret is public.</p>
          )}
        </>
      )}

      {variant === "hunter" && <HunterCta {...props} path={path} />}

      {variant === "archive" && state === "revealed" && <RevealedView handle={handle} info={info} compact />}

      {variant === "detail" && (
        <>
          {isOwner && <OwnerActions {...props} />}
          {/* Top-up while alive; reclaim after a cancel or once rescuable (renders nothing otherwise). */}
          {state !== "revealed" && <FundAction {...props} isOwner={isOwner} />}
          {(state === "alive" || state === "dark" || state === "darkMarked") && !(state === "alive" && isOwner) && (
            <RevealPanel {...props} />
          )}
          {state === "revealed" && <RevealedView handle={handle} info={info} />}
          {state === "cancelled" && !isOwner && <CancelledNote handle={handle} viewer={address} />}
          <TechnicalDetails handle={handle} info={info} />
        </>
      )}

      {variant !== "detail" && (
        <div className="mt-auto flex items-center gap-2 border-t border-line pt-3 text-xs text-fg-subtle">
          <Link href={path} className="inline-flex items-center gap-1 underline-offset-2 hover:text-fg hover:underline">
            <Icon name="link" size={12} /> Switch page
          </Link>
          <CopyButton
            value={typeof window !== "undefined" ? `${window.location.origin}${path}` : path}
            title="Copy link to this switch"
          />
        </div>
      )}
    </article>
  );
}

/**
 * Why a cancelled switch offers nothing. Not to a funder who can still reclaim:
 * FundAction already tells them the owner cancelled (the same stake read, so no
 * extra RPC call), and the two lines said it twice.
 */
function CancelledNote({ handle, viewer }: { handle: SwitchHandle; viewer: `0x${string}` | undefined }) {
  const { data: stake } = useFunderStake(handle, viewer);
  if (stake !== undefined && stake > 0n) return null;
  return (
    <p className="max-w-none border-t border-line pt-3 text-xs text-fg-muted">
      The owner cancelled this switch while alive. Its key will never be made decryptable: the secret stays sealed
      forever.
    </p>
  );
}

/** Hunt-list call to action: the next step for this switch, inline where cheap. */
function HunterCta({ info, state, nowSec, path }: {
  handle: SwitchHandle; info: SwitchInfo; state: ReturnType<typeof switchStateFor>; nowSec: bigint; path: string;
}) {
  if (state === "alive") {
    return (
      <p className="max-w-none border-t border-line pt-3 text-xs text-fg-muted">
        Still alive. Claimable in {fmtDuration(info.expiresAt - nowSec)} if the owner stops pinging.
      </p>
    );
  }
  if (state === "dark" || state === "darkMarked") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <span className="text-xs text-fg-muted">
          {state === "dark" ? "Deadline passed: mark it dark, fetch the key, claim the bounty." : "Release requested: fetch the key and claim the bounty."}
        </span>
        <Link href={path} className="btn btn-primary btn-sm">
          <Icon name="target" size={12} /> {state === "dark" ? "Start release" : "Fetch key and claim"}
        </Link>
      </div>
    );
  }
  if (state === "revealed") {
    return (
      <div className="flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-fg-muted">
        <span>Revealed {fmtDateTime(info.revealedAt)}.</span>
        <Link href={path} className="btn btn-sm"><Icon name="eye" size={12} /> Read</Link>
      </div>
    );
  }
  return null;
}

function TechnicalDetails({ handle, info }: { handle: SwitchHandle; info: SwitchInfo }) {
  const { chainId } = useEffectiveChain();
  const key = keccak256(encodePacked(["address", "uint256"], [handle.owner, handle.id]));
  const contractHref = explorerAddress(chainId, handle.contractAddr);
  // `full`: wrap instead of clipping with an ellipsis (an address that identifies a party).
  const rows: { label: string; value: string; copy?: string; href?: string; full?: boolean }[] = [
    { label: "Owner", value: handle.owner, copy: handle.owner, href: explorerAddress(chainId, handle.owner), full: true },
    { label: "Contract", value: handle.contractAddr, copy: handle.contractAddr, href: contractHref },
    { label: "Switch id", value: handle.id.toString(), copy: handle.id.toString() },
    { label: "Switch key", value: fmtBytes32(key), copy: key },
    { label: "Encrypted key handle (euint256)", value: fmtBytes32(info.encKeyHandle), copy: info.encKeyHandle },
    { label: "Plaintext commitment", value: fmtBytes32(info.plaintextCommitment), copy: info.plaintextCommitment },
    { label: "Ciphertext", value: `${info.ciphertextLength.toString()} bytes (secret ${Math.max(0, Number(info.ciphertextLength) - 61)} bytes)` },
    { label: "Created", value: fmtDateTime(info.createdAt) },
    { label: "Owner escrow", value: `${info.ownerStake.toString()} wei` },
  ];
  return (
    <details className="group border-t border-line pt-3">
      <summary className="cursor-pointer list-none text-xs text-fg-subtle hover:text-fg">
        <span className="inline-flex items-center gap-1">
          <Icon name="chevronRight" size={12} className="transition-transform group-open:rotate-90" /> Technical details
        </span>
      </summary>
      <dl className="mt-3 space-y-1.5 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-fg-subtle">{r.label}</dt>
            <dd className="flex min-w-0 items-center gap-1">
              {r.href
                ? <a className={`value ${r.full ? "break-all" : "truncate"} text-fg underline-offset-2 hover:underline`} href={r.href} target="_blank" rel="noreferrer">{r.value}</a>
                : <span className={`value ${r.full ? "break-all" : "truncate"} text-fg`}>{r.value}</span>}
              {r.copy && <CopyButton value={r.copy} title={`Copy ${r.label.toLowerCase()}`} />}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
