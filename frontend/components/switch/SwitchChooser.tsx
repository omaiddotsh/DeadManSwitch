"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import type { Deployment } from "@/lib/contracts";
import { useChainTime } from "@/lib/hooks";
import { switchPath, switchStateFor, type SwitchInfo } from "@/lib/switch";
import { Address } from "@/components/ui/Address";
import { ErrorBox } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { Note } from "@/components/ui/Note";
import { SwitchSummary } from "./SwitchSummary";

/**
 * A switch link that names no contract, whose (owner, id) exists on more than
 * one deployment of this app (the CLI lets owners choose ids, so #1 on both is
 * realistic). They are different switches: a ping sent from a page showing one
 * leaves the other to go dark and release its secret. So each is only
 * summarised here, with no action; acting takes its own link, which names its
 * contract.
 */
export function SwitchChooser({ chainId, owner, id, choices }: {
  chainId: number;
  owner: `0x${string}`;
  id: bigint;
  /** The deployments where (owner, id) exists, current first, and what each holds. */
  choices: { deployment: Deployment; info: SwitchInfo }[];
}) {
  const { nowSec } = useChainTime();
  const { address } = useAccount();
  const isOwner = !!address && address.toLowerCase() === owner.toLowerCase();
  return (
    <section className="space-y-4" aria-label="Choose a switch">
      <Note tone="warn" title={`${choices.length === 2 ? "Two" : choices.length} switches match this link`}>
        <p className="text-sm">
          This link names no contract, and switch #{id.toString()} of this owner exists on {choices.length} deployments
          of this app. They are different switches, each with its own deadline, bounty and secret. Open the one you
          mean; nothing can be sent from this page.
        </p>
      </Note>
      <div className="grid-2">
        {choices.map(({ deployment, info }) => {
          const handle = { contractAddr: deployment.address, owner, id };
          return (
            <article
              key={deployment.address}
              className="card flex flex-col gap-4"
              aria-label={`Switch ${id.toString()} on the ${deployment.current ? "current" : "older"} deployment`}
            >
              <p className="flex max-w-none flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
                {deployment.current ? "Current deployment" : "Older deployment"}
                <Address address={deployment.address} chainId={chainId} copyTitle="Copy contract address" className="text-xs" />
              </p>
              {nowSec !== null && (
                <SwitchSummary
                  handle={handle} info={info} state={switchStateFor(info, nowSec)} nowSec={nowSec}
                  isOwner={isOwner} older={!deployment.current}
                />
              )}
              <Link href={switchPath(chainId, handle)} className="btn btn-sm self-start">
                <Icon name="link" size={12} /> Open this switch
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * A switch link that names no contract, where reading (owner, id) failed on
 * some deployment. That deployment may hold another switch with the same id,
 * so none is shown with its actions (a ping on the wrong one leaves the other
 * to go dark): Retry, or open it, by its own link, on a deployment that was
 * read. The reads are retried every 15 s; once they all succeed the page
 * resolves the link as usual.
 */
export function SwitchLookupFailed({ chainId, owner, id, rows }: {
  chainId: number;
  owner: `0x${string}`;
  id: bigint;
  /** (owner, id) on each deployment of the chain, current first. */
  rows: { deployment: Deployment; info: SwitchInfo | null; error: string | null; refetch?: () => unknown }[];
}) {
  const unread = rows.filter((r) => !r.info);
  const read = rows.filter((r): r is typeof r & { info: SwitchInfo } => !!r.info);
  return (
    <ErrorBox title="Could not check every deployment" message={unread[0]?.error ?? ""}>
      <p className="text-fg-muted">
        This link names no contract, and reading switch #{id.toString()} failed on{" "}
        {unread.map((r) => r.deployment.address).join(", ")}. A switch with this id there would be a different one, so
        none is shown with its actions until every deployment has been read. The page retries every 15 s.
      </p>
      {read.length > 0 && (
        <ul className="space-y-1 text-sm">
          {read.map(({ deployment, info }) => (
            <li key={deployment.address}>
              <Link
                href={switchPath(chainId, { contractAddr: deployment.address, owner, id })}
                className="underline-offset-2 hover:underline"
              >
                Open it on the {deployment.current ? "current" : "older"} deployment{" "}
                <span className="value break-all">{deployment.address}</span>
              </Link>
              {!info.exists && <span className="text-fg-muted"> (no switch with this id there)</span>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-sm" onClick={() => { for (const r of unread) void r.refetch?.(); }}>
        <Icon name="refresh" size={12} /> Retry
      </button>
    </ErrorBox>
  );
}
