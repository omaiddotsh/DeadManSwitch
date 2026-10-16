"use client";

import { useState } from "react";
import { formatEther, type Hex } from "viem";
import { useAccount } from "wagmi";
import { outcomeUnknown, useFundBounty, useFunderStake, useReclaimContribution } from "@/lib/hooks";
import {
  LATE_TX_RISK_SECONDS, fmtEth, isRescuableAt, type SwitchHandle, type SwitchInfo, type SwitchState,
} from "@/lib/switch";
import { hasDecimalComma, parseEthInput } from "@/components/amount";
import { ActionGate } from "@/components/ui/ActionGate";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Loading";
import { PendingTx } from "@/components/ui/PendingTx";
import { SelfRevealNote } from "@/components/ui/Note";
import { useToast } from "@/components/ui/Toast";
import { useTxToast } from "@/components/ui/useTxToast";

/**
 * The top-up field as typed: wei above zero, or why not; and what it was read
 * as when a decimal comma was taken for a point ("0,005" → 0.005).
 */
export const topUpInput = (amount: string): { value: bigint | null; error: string | null; readAs: string | null } => {
  const v = parseEthInput(amount);
  if (v === null) return { value: null, error: null, readAs: null };
  if (v === undefined || v === 0n) return { value: null, error: "Enter an amount above zero.", readAs: null };
  return { value: v, error: null, readAs: hasDecimalComma(amount) ? formatEther(v) : null };
};

/**
 * One "Add ETH": send the top-up through `tx` (toasts), and clear the amount
 * once it is done, so that a second top-up is never one click away:
 *   - on success;
 *   - when a top-up whose wallet answer was lost (recorded without a hash, the
 *     form locked meanwhile) shows up on the switch later: a success like any
 *     other, with its toast (`landed`), worded neutrally when the transaction
 *     at its nonce is not this top-up (one from another tab, device or the CLI);
 *   - on a verdict that it may still land or already did (a top-up the app's
 *     RPC lost sight of, one not confirmed in time, a Safe's request not
 *     executed yet): the message says to check the wallet first.
 * A rejection, or a refusal before the wallet (a revert in the dry run), keeps it.
 */
export const sendTopUp = async (
  d: {
    write: (h: SwitchHandle, value: bigint, opts?: { landed?: (how: { matched: boolean }) => void }) => Promise<{ hash: Hex }>;
    tx: <T extends { hash: Hex }>(send: () => Promise<T>, success: string) => Promise<T | null>;
    success: (message: string) => void;
    clear: () => void;
  },
  handle: SwitchHandle,
  value: bigint,
): Promise<void> => {
  const done = `Bounty topped up by ${fmtEth(value, 6)}`;
  const r = await d.tx(
    () => d.write(handle, value, {
      // Matched: the sender's transaction at the recorded nonce is this top-up. Otherwise the stake grew by a
      // top-up of the same account from elsewhere (another tab, device, the CLI): said as such, and the amount
      // is cleared all the same (a second top-up must not be one click away).
      landed: ({ matched }) => {
        d.clear();
        d.success(matched ? done : `A top-up of ${fmtEth(value, 6)} from your account landed on this switch.`);
      },
    }).catch((e: unknown) => {
      if (outcomeUnknown(e)) d.clear();
      throw e;
    }),
    done,
  );
  if (r) d.clear();
};

/**
 * Anyone: top up the bounty of a live switch; reclaim your own contribution
 * after the owner cancels or once the switch is rescuable.
 *
 * The write hooks are given this switch, so a top-up or reclaim sent before a
 * reload (or from another card of the same switch) shows here as pending and
 * blocks a second one until it settles (lib/pendingWrites.ts).
 */
export function FundAction({
  handle, info, state, nowSec, isOwner,
}: {
  handle: SwitchHandle;
  info: SwitchInfo;
  state: SwitchState;
  nowSec: bigint;
  isOwner: boolean;
}) {
  const { address } = useAccount();
  const { data: myStake } = useFunderStake(handle, address);
  const fund = useFundBounty(handle);
  const reclaim = useReclaimContribution(handle);
  const tx = useTxToast();
  const toast = useToast();
  const [amount, setAmount] = useState("");

  const { value, error: amountErr, readAs } = topUpInput(amount);
  const busy = fund.pending || reclaim.pending;
  const canReclaim = (state === "cancelled" || isRescuableAt(info, nowSec)) && !!myStake && myStake > 0n;
  // Warn, never disable: the funder decides. The owner's card already warns about a late ping or cancel
  // (OwnerActions), so the owner gets that one warning, not a second about top-ups.
  const late = state === "alive" && !isOwner && info.expiresAt - nowSec < LATE_TX_RISK_SECONDS;
  // The pending line, and the last verdict (dropped / replaced / not confirmed / reverted): it names the
  // transaction and says to check the wallet, so it stays in view after the toast is gone.
  const sent = (
    <>
      <PendingTx writes={[fund, reclaim]} />
      {[fund, reclaim].map((w, i) => !w.pending && w.error && (
        <p key={i} role="alert" className="field-error break-words">{w.error}</p>
      ))}
    </>
  );

  if (state === "alive") {
    return (
      <div className="space-y-3 border-t border-line pt-4">
        <div className="field">
          <label className="field-label" htmlFor={`fund-${handle.id}`}>Add to the bounty</label>
          <p className="field-hint">
            {isOwner
              ? "Top-ups are booked as a contribution: refundable only via reclaim after a cancel or a stuck release, not by cancel itself."
              : "A bigger bounty makes it likelier someone releases this secret on time. Your contribution is tracked separately from the owner's."}
          </p>
          <ActionGate what="fund this switch">
            <div className="flex flex-wrap gap-2">
              <input
                id={`fund-${handle.id}`}
                className={`input max-w-40 ${amountErr ? "input-invalid" : ""}`}
                type="text"
                inputMode="decimal"
                placeholder="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || value === null}
                onClick={() => sendTopUp({ write: fund.write, tx, success: toast.success, clear: () => setAmount("") }, handle, value!)}
              >
                {fund.pending ? <Spinner size={14} /> : <Icon name="coins" />} Add ETH
              </button>
            </div>
          </ActionGate>
          {amountErr && <p className="field-error">{amountErr}</p>}
          {!amountErr && value !== null && readAs && (
            <p className="text-xs text-fg-muted">Read as <span className="value text-fg">{readAs} ETH</span>.</p>
          )}
          {late && (
            <p className="flex max-w-none items-start gap-1.5 text-xs text-warn" role="status">
              <span className="mt-px"><Icon name="alert" size={12} /></span>
              <span>
                Under {Number(LATE_TX_RISK_SECONDS)} s to the deadline: a top-up sent now may be mined after the
                deadline. It would then revert and still cost gas.
              </span>
            </p>
          )}
          {sent}
          {!!myStake && myStake > 0n && (
            <p className="text-xs text-fg-muted">You have contributed <span className="value text-fg">{fmtEth(myStake, 6)}</span>.</p>
          )}
        </div>
        {!isOwner && <SelfRevealNote audience="funder" />}
      </div>
    );
  }

  if (canReclaim) {
    return (
      <div className="space-y-2 border-t border-line pt-4">
        <p className="text-sm text-fg-muted">
          {state === "cancelled"
            ? isOwner ? "You cancelled. Your top-ups are yours to take back." : "The owner cancelled. Your contribution is yours to take back."
            : "Nobody released the key within 30 days of the deadline. You may take back your contribution; a late release would collect whatever is left."}
        </p>
        <ActionGate what="reclaim your contribution">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => tx(() => reclaim.write(handle), "Contribution reclaimed")}
          >
            {reclaim.pending ? <Spinner size={14} /> : <Icon name="coins" />} Reclaim {fmtEth(myStake!, 6)}
          </button>
        </ActionGate>
        {sent}
      </div>
    );
  }

  // A top-up still pending when the deadline passed (or its verdict): keep it in view.
  if (fund.pending || reclaim.pending || fund.error || reclaim.error) return <div className="border-t border-line pt-4">{sent}</div>;

  return null;
}
