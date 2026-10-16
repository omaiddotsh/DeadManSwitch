"use client";

import { useState } from "react";
import { useCancelSwitch, useFunderStake, usePing, useRescueOwnerStake } from "@/lib/hooks";
import {
  LATE_TX_RISK_SECONDS, fmtDateTime, fmtDuration, fmtEth, isRescuableAt,
  type SwitchHandle, type SwitchInfo, type SwitchState,
} from "@/lib/switch";
import { ActionGate } from "@/components/ui/ActionGate";
import { ConfirmPanel } from "@/components/ui/ConfirmPanel";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Loading";
import { PendingTx } from "@/components/ui/PendingTx";
import { useTxToast } from "@/components/ui/useTxToast";

/**
 * Owner controls: ping and cancel while alive; rescue of the owner's own
 * escrow once a dark switch has gone RESCUE_DELAY without a reveal.
 *
 * The owner's own top-ups are booked as a funder contribution, not as escrow:
 * cancel and rescue do not return them, reclaimContribution does (FundAction,
 * rendered below this on both the dashboard and the switch page).
 *
 * Ping takes no input and needs no secret: `ping(id)` carries no payload.
 *
 * Under LATE_TX_RISK_SECONDS before the deadline a ping or cancel may be mined
 * after it and revert (Expired), still costing gas. The wallet's estimate runs
 * against the latest block, still before the deadline, so it does not warn.
 *
 * The write hooks are given this switch, so a ping, cancel or rescue sent
 * before a reload shows here as pending and blocks a second one until it
 * settles (lib/pendingWrites.ts).
 */
export function OwnerActions({
  handle, info, state, nowSec,
}: {
  handle: SwitchHandle;
  info: SwitchInfo;
  state: SwitchState;
  nowSec: bigint;
}) {
  const ping = usePing(handle);
  const cancel = useCancelSwitch(handle);
  const rescue = useRescueOwnerStake(handle);
  const tx = useTxToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { data: ownTopUps } = useFunderStake(handle, info.owner);
  const own = ownTopUps ?? 0n;

  const busy = ping.pending || cancel.pending || rescue.pending;
  // In both the alive and the dark view: a ping still pending when the deadline passes stays visible.
  // So does the last verdict (dropped / replaced / reverted): a write resumed after a reload has no toast.
  const sent = (
    <>
      <PendingTx writes={[ping, cancel, rescue]} />
      {[ping, cancel, rescue].map((w, i) => !w.pending && w.error && (
        <p key={i} role="alert" className="field-error break-words">{w.error}</p>
      ))}
    </>
  );
  // Warn, never disable: a late ping is still the owner's only chance to stay alive.
  const pingAtRisk = state === "alive" && info.expiresAt - nowSec < LATE_TX_RISK_SECONDS;

  if (state === "alive") {
    return (
      <div className="space-y-4 border-t border-line pt-4">
        <ActionGate what="ping or cancel">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => tx(() => ping.write(handle), "Pinged: the deadline moved out by one interval")}
              >
                {ping.pending ? <><Spinner size={14} /> Pinging…</> : <><Icon name="heart" /> Ping: I&apos;m alive</>}
              </button>
              <span className="text-xs text-fg-muted">
                Moves the deadline to {fmtDuration(info.pingInterval)} from the moment it is mined. No secret needed.
              </span>
            </div>
            {pingAtRisk && (
              <p className="flex max-w-none items-start gap-1.5 text-xs text-warn" role="status">
                <span className="mt-px"><Icon name="alert" size={12} /></span>
                <span>
                  Under {Number(LATE_TX_RISK_SECONDS)} s to the deadline: a ping or cancel sent now may be mined after the
                  deadline. It would then revert and still cost gas, and the switch would be dark.
                </span>
              </p>
            )}

            {!confirmCancel ? (
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => setConfirmCancel(true)}>
                <Icon name="ban" /> Cancel switch…
              </button>
            ) : (
              <CancelConfirm
                info={info}
                ownTopUps={ownTopUps}
                nowSec={nowSec}
                busy={cancel.pending}
                onCancel={() => setConfirmCancel(false)}
                onConfirm={async () => {
                  const r = await tx(() => cancel.write(handle), "Switch cancelled: your escrow was refunded");
                  if (r) setConfirmCancel(false);
                }}
              />
            )}
          </div>
        </ActionGate>
        {sent}
      </div>
    );
  }

  if (state === "dark" || state === "darkMarked") {
    // Until rescue opens, its date is in the summary above (SwitchSummary), once per card.
    const rescuable = isRescuableAt(info, nowSec);
    return (
      <div className="space-y-3 border-t border-line pt-4">
        <p className="text-sm text-fg-muted">
          Your deadline passed on {fmtDateTime(info.expiresAt)}. Pinging, funding and cancelling are closed for good;
          anyone can now release the key and collect the bounty.
        </p>
        {info.ownerStake > 0n && rescuable && (
          <div className="note note-warn space-y-2">
            <div className="note-title"><span className="text-warn"><Icon name="coins" /></span> Rescue your escrow</div>
            <p className="text-sm">
              Nobody released the key within 30 days of the deadline (Zama&apos;s KMS or relayer never served it, or
              the contract was paused). You may take back your own{" "}
              <span className="value text-fg">{fmtEth(info.ownerStake)}</span>. The switch stays active: a late
              release still lands and collects whatever is left.
              {own > 0n && (
                <> Your top-ups (<span className="value text-fg">{fmtEth(own, 6)}</span>) are reclaimed separately, below.</>
              )}
            </p>
            <ActionGate what="rescue your escrow">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => tx(() => rescue.write(handle), "Escrow rescued")}
              >
                {rescue.pending ? <Spinner size={14} /> : <Icon name="coins" />} Reclaim {fmtEth(info.ownerStake)}
              </button>
            </ActionGate>
          </div>
        )}
        {sent}
      </div>
    );
  }

  if (state === "cancelled") {
    return (
      <p className="max-w-none border-t border-line pt-3 text-xs text-fg-muted">
        You cancelled this switch. Your escrow was refunded and the key will never be released.
        {own > 0n && (
          <> Your own top-ups of <span className="value text-fg">{fmtEth(own, 6)}</span> were not part of the escrow:
            reclaim them below.</>
        )}
      </p>
    );
  }

  return null;
}

const SEALED_ACK = "I understand the secret stays sealed forever and this cannot be undone.";
const LATE_ACK = "I understand that if it lands after the deadline, it reverts and the switch goes dark instead.";

/**
 * The cancel confirmation: what a cancel refunds and what it does not, and,
 * in the last slots before the deadline, that it may land too late.
 */
export function CancelConfirm({
  info, ownTopUps, nowSec, busy, onConfirm, onCancel,
}: {
  info: SwitchInfo;
  /** The owner's own funderStake (top-ups); undefined while unknown. */
  ownTopUps: bigint | undefined;
  nowSec: bigint;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Every contribution, the owner's own top-ups included (cancel refunds only ownerStake).
  const contributions = info.bounty > info.ownerStake ? info.bounty - info.ownerStake : 0n;
  const own = ownTopUps === undefined ? null : ownTopUps < contributions ? ownTopUps : contributions;
  const others = own === null ? null : contributions - own;
  const late = info.expiresAt - nowSec < LATE_TX_RISK_SECONDS;
  return (
    <ConfirmPanel
      title="Cancel this switch for good?"
      acknowledge={late ? [SEALED_ACK, LATE_ACK] : SEALED_ACK}
      confirmLabel="Cancel switch and refund my escrow"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {late && (
        <p className="text-warn" role="alert">
          Under {Number(LATE_TX_RISK_SECONDS)} s to the deadline: this cancel may be mined after the deadline. It would
          then revert, cost gas and refund nothing, and the switch would be dark, so anyone could release the secret.
        </p>
      )}
      <p>
        Cancelling disables the switch permanently. The contract never asks Zama&apos;s KMS to decrypt the
        key, so <strong className="text-fg">the secret stays sealed forever</strong>: nobody, including you,
        can ever release it through this contract, and a cancelled switch cannot be restarted.
      </p>
      <p>
        Your escrow of <span className="value text-fg">{fmtEth(info.ownerStake)}</span> is refunded.
        {own !== null && own > 0n && (
          <> Your own top-ups (<span className="value text-fg">{fmtEth(own, 6)}</span>) are not part of the escrow:
            cancelling does not refund them, but you can reclaim them once the switch is cancelled.</>
        )}
        {others !== null && others > 0n && (
          <> Contributions from other funders (<span className="value text-fg">{fmtEth(others, 6)}</span>)
            are not yours: each funder reclaims their own.</>
        )}
        {own === null && contributions > 0n && (
          <> Contributions to the bounty (<span className="value text-fg">{fmtEth(contributions, 6)}</span>) are not
            refunded by cancelling: each funder, you included if you topped up, reclaims their own afterwards.</>
        )}
      </p>
    </ConfirmPanel>
  );
}
