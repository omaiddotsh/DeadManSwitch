"use client";

import type { Hex } from "viem";
import { explorerTx } from "@/lib/contracts";
import { useChainTime, useEffectiveChain } from "@/lib/hooks";
import { fmtBytes32, fmtDuration } from "@/lib/switch";
import { CopyButton } from "./Copy";
import { Icon } from "./Icon";
import { Spinner } from "./Loading";

/** What PendingTx reads from a lib write hook (usePing(), useFundBounty(handle), …). */
export interface PendingWriteView {
  pending: boolean;
  hash: Hex | string | null;
  /** The wallet answered with an error after it may have broadcast (no hash): lib/pendingWrites.ts. */
  unconfirmed?: boolean;
  /** The user checked the wallet and nothing was sent. */
  dismissUnconfirmed?: () => void;
  /** A ping or cancel: the switch's deadline it must be mined before (usePing / useCancelSwitch). */
  deadline?: bigint | null;
  /**
   * Sent from a contract account (a Safe): `hash` may be its wallet's id for the request (a safeTxHash),
   * which no explorer knows, and the request may wait for the other owners' signatures.
   */
  contractAccount?: boolean;
}

/**
 * A sent write that has not been mined yet. lib's waitForWrite keeps waiting
 * (up to 30 minutes) through receipt timeouts and RPC errors, and a write sent
 * before a reload is resumed by the hook that shows its switch, so the action
 * can stay pending for a long time: show its hash and an explorer link so the
 * user can follow it instead of sending it again. A write whose wallet
 * answered with an error instead of a hash is shown as "may have been sent".
 * A ping or cancel only counts if mined before the deadline: while one is
 * pending, it says to speed it up in the wallet if it is stuck (the buttons
 * are off meanwhile, and a second one from the page would only queue behind
 * it), with the time left.
 * From a contract account (a Safe) the hash may be the wallet's id for the
 * request rather than a transaction: it is not linked to the explorer, and the
 * line says it may wait for the other owners (lib/hooks.ts follows it through
 * the wallet).
 * Renders nothing before the wallet returns, or once the write settles.
 */
export function PendingTx({ writes }: { writes: readonly PendingWriteView[] }) {
  const { chainId } = useEffectiveChain();
  const { nowSec } = useChainTime();
  const sent = writes.filter((w) => w.pending && w.hash);
  const unconfirmed = writes.filter((w) => w.pending && !w.hash && w.unconfirmed);
  if (sent.length === 0 && unconfirmed.length === 0) return null;
  return (
    <div role="status" className="space-y-1">
      {sent.map((w) => {
        const hash = w.hash as Hex;
        const href = w.contractAccount ? null : explorerTx(chainId, hash);
        const deadline = w.deadline ?? null;
        return (
          <div key={hash} className="space-y-1">
          <p className="flex max-w-none flex-wrap items-center gap-1 text-xs text-fg-muted">
            <span className="text-info"><Spinner size={10} /></span>
            {w.contractAccount ? "Submitted to your account" : "Sent"}{" "}
            <span className="value text-fg" title={hash}>{fmtBytes32(hash)}</span>
            <CopyButton value={hash} title={w.contractAccount ? "Copy request id" : "Copy transaction hash"} />
            {href && (
              <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-fg hover:underline">
                View on Etherscan <Icon name="external" size={12} />
              </a>
            )}
            {w.contractAccount ? (
              <span>
                · Your account is a contract account: if it is a Safe, this may be its request id rather than a
                transaction, and it may wait for your other owners to sign. This page asks your wallet when it has
                been executed. Don&apos;t send it again.
              </span>
            ) : (
              <span>· Waiting for it to be mined, which can take a while. Don&apos;t send it again.</span>
            )}
          </p>
          {deadline !== null && nowSec !== null && (
            <p className="flex max-w-none items-start gap-1.5 text-xs text-warn">
              <span className="mt-px"><Icon name="alert" size={12} /></span>
              {deadline > nowSec ? (
                <span>
                  It only counts if mined before the deadline, <span className="value">{fmtDuration(deadline - nowSec)}</span> from
                  now. If it is stuck (fee too low), speed it up in your wallet: the same transaction with a higher fee.
                  Sending another one from this page would not help: it would wait behind this one.
                </span>
              ) : (
                <span>The deadline has passed: if it is mined now, it reverts and still costs gas.</span>
              )}
            </p>
          )}
          </div>
        );
      })}
      {unconfirmed.map((w, i) => (
        <div key={`unconfirmed-${i}`} className="space-y-1 text-xs text-warn">
          <p className="flex max-w-none items-start gap-1.5">
            <span className="mt-px"><Icon name="alert" size={12} /></span>
            <span>
              Your wallet answered with an error instead of a transaction hash, so this transaction may have been sent.
              Check your wallet&apos;s activity. This page keeps watching the switch and does not offer it again until it
              shows up there (or for 30 minutes).
            </span>
          </p>
          {w.dismissUnconfirmed && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={w.dismissUnconfirmed}>
              Nothing was sent: allow it again
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
