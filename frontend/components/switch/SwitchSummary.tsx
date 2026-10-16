"use client";

import { formatEther } from "viem";
import { useContractConfig, useEffectiveChain } from "@/lib/hooks";
import {
  RESCUE_DELAY, STATE_DESCRIPTION, STATE_LABEL, fmtDateTime, fmtDuration, fmtEth,
  type SwitchHandle, type SwitchInfo, type SwitchState,
} from "@/lib/switch";
import { Address } from "@/components/ui/Address";
import { Icon, type IconName } from "@/components/ui/Icon";

const PILL: Record<SwitchState, { cls: string; icon: IconName }> = {
  none:       { cls: "pill-neutral",   icon: "ban" },
  alive:      { cls: "pill-alive",     icon: "heart" },
  dark:       { cls: "pill-dark",      icon: "clock" },
  darkMarked: { cls: "pill-dark",      icon: "key" },
  revealed:   { cls: "pill-revealed",  icon: "unlock" },
  cancelled:  { cls: "pill-cancelled", icon: "ban" },
};

export function StatePill({ state }: { state: SwitchState }) {
  const p = PILL[state];
  return (
    <span className={`pill ${p.cls}`} title={STATE_DESCRIPTION[state]}>
      <Icon name={p.icon} size={12} />
      {STATE_LABEL[state]}
    </span>
  );
}

/** ETH amount plus a USD hint when the oracle is up. */
export function EthAmount({ wei, precision = 4 }: { wei: bigint; precision?: number }) {
  const { data: config } = useContractConfig();
  const usd = config?.ethUsd ? Number(formatEther(wei)) * config.ethUsd : null;
  return (
    <span>
      <span className="value">{fmtEth(wei, precision)}</span>
      {usd !== null && wei > 0n && (
        <span className="ml-1 text-xs text-fg-subtle">≈ ${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
      )}
    </span>
  );
}

/**
 * Identity, state and countdown for one switch. Presentational: it issues no
 * per-switch chain reads, so list views can render many cheaply. `state` is
 * the chain-time-refined state (switchStateFor); `nowSec` is chain time.
 */
export function SwitchSummary({
  handle, info, state, nowSec, isOwner, older = false,
}: {
  handle: SwitchHandle;
  info: SwitchInfo;
  state: SwitchState;
  nowSec: bigint;
  isOwner: boolean;
  /** On a previous deployment of this app (lib/contracts.ts isPreviousDeployment). */
  older?: boolean;
}) {
  const { chainId } = useEffectiveChain();
  const remaining = info.expiresAt - nowSec;
  const rescueAt = info.expiresAt + BigInt(RESCUE_DELAY);
  const rescueOpen = info.rescuable || ((state === "dark" || state === "darkMarked") && nowSec >= rescueAt);
  // Under 10 % of the interval (or a day) left: say so.
  const urgent = state === "alive" && (remaining * 10n < info.pingInterval || remaining < 86400n);

  return (
    <div className="space-y-3">
      {/* Below sm the state block has its own row, left-aligned like the rest of the card. From sm it is a
          right-hand column of at most 11rem (long labels wrap inside it), and the identity takes the rest:
          a full owner address still fits beside it in a half-width list card. */}
      <div className="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatePill state={state} />
            {isOwner && <span className="pill pill-neutral">You</span>}
            {older && (
              <span className="pill pill-neutral" title={`On an earlier contract of this app: ${handle.contractAddr}`}>
                Older deployment
              </span>
            )}
            {rescueOpen && (
              <span className="pill border-warn/40 bg-warn/10 text-warn" title="RESCUE_DELAY has passed without a reveal: depositors may reclaim their own deposits.">
                Rescue open
              </span>
            )}
            {info.published && <span className="pill pill-revealed" title="publishPlaintext was called">Plaintext published</span>}
          </div>
          {/* The owner in full: a shortened address can be matched by a vanity lookalike. */}
          <div className="flex flex-wrap items-center gap-x-2 text-sm">
            <Address address={handle.owner} chainId={chainId} copyTitle="Copy owner address" className="text-xs text-fg-muted" />
            <span className="value truncate text-xs text-fg-subtle" title={handle.id.toString()}>
              #{handle.id.toString()}
            </span>
          </div>
        </div>

        <div className="w-full sm:w-auto sm:max-w-[11rem] sm:shrink-0 sm:text-right" aria-live="off">
          {state === "alive" ? (
            <>
              <div className="text-xs text-fg-muted">Goes dark in</div>
              <div className={`value text-lg ${urgent ? "text-warn" : "text-alive"}`}>{fmtDuration(remaining)}</div>
            </>
          ) : state === "dark" ? (
            <>
              <div className="text-xs text-fg-muted">Dark for <span className="whitespace-nowrap">{fmtDuration(nowSec - info.expiresAt)}</span></div>
              <div className="text-lg font-semibold text-gone">Ready to release</div>
            </>
          ) : state === "darkMarked" ? (
            <>
              <div className="text-xs text-fg-muted">Release requested <span className="whitespace-nowrap">{fmtDateTime(info.darkMarkedAt)}</span></div>
              <div className="text-lg font-semibold text-gone">Key claimable</div>
            </>
          ) : state === "revealed" ? (
            <>
              <div className="text-xs text-fg-muted">Revealed <span className="whitespace-nowrap">{fmtDateTime(info.revealedAt)}</span></div>
              <div className="text-lg font-semibold text-info">Public</div>
            </>
          ) : state === "cancelled" ? (
            <>
              <div className="text-xs text-fg-muted">Cancelled</div>
              <div className="text-lg font-semibold text-fg-muted">Sealed</div>
            </>
          ) : (
            <>
              <div className="text-xs text-fg-muted">Status</div>
              <div className="text-lg font-semibold text-fg-muted">{STATE_LABEL[state]}</div>
            </>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-xs sm:grid-cols-4">
        {state === "cancelled" ? (
          // What is left after a cancel is the funders' own money, which they reclaim: no bounty can be paid from it.
          <div>
            <dt className="text-fg-subtle">Unreclaimed contributions</dt>
            <dd className="mt-0.5 text-sm text-fg">
              {info.bounty > 0n
                ? <span className="value">{fmtEth(info.bounty)}</span>
                : <span className="text-fg-muted">None</span>}
            </dd>
          </div>
        ) : (
          <div>
            <dt className="text-fg-subtle">Bounty</dt>
            <dd className="mt-0.5 text-sm text-fg">
              {state === "revealed" ? <span className="text-fg-muted">Paid to the revealer</span> : <EthAmount wei={info.bounty} />}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-fg-subtle">Ping interval</dt>
          <dd className="mt-0.5 text-sm text-fg">{fmtDuration(info.pingInterval)}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Last ping</dt>
          <dd className="mt-0.5 text-sm text-fg">{fmtDateTime(info.lastPing)}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">{state === "alive" ? "Deadline" : "Went dark"}</dt>
          <dd className="mt-0.5 text-sm text-fg">
            {state === "cancelled" ? <span className="text-fg-muted">Never</span> : fmtDateTime(info.expiresAt)}
          </dd>
        </div>
        {(state === "dark" || state === "darkMarked") && !rescueOpen && info.bounty > 0n && (
          <div className="col-span-2 sm:col-span-4">
            <dt className="sr-only">Rescue</dt>
            <dd className="text-fg-muted">
              If nobody releases the key by {fmtDateTime(rescueAt)}, depositors{isOwner ? ", you included," : ""} may
              reclaim their own deposits.
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
