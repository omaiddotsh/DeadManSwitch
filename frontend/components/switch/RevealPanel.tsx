"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { parseEventLogs, type TransactionReceipt } from "viem";
import { dmsAbi } from "@/lib/abi";
import { useEffectiveChain, useKmsKey, useMarkDark, useRevealKey } from "@/lib/hooks";
import {
  fmtDateTime, fmtDuration, fmtEth, isRescuableAt, type SwitchHandle, type SwitchInfo, type SwitchState,
} from "@/lib/switch";
import { fhevmHint } from "@/components/FheKeyStatus";
import { estimateMarkDarkGas, estimateRevealGas, gasCost, useCallGas, useGasPrice } from "@/components/gas";
import { ActionGate } from "@/components/ui/ActionGate";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Loading";
import { PendingTx } from "@/components/ui/PendingTx";
import { FrontrunNote } from "@/components/ui/Note";
import { useTxToast } from "@/components/ui/useTxToast";
import { EthAmount } from "./SwitchSummary";

type StepStatus = "done" | "active" | "pending" | "warn" | "failed";

/**
 * What the reveal paid: KeyRevealed.bountyPaid in its receipt (null if the
 * receipt has none from this contract). The bounty read before sending can be
 * stale: once rescue is open, depositors may reclaim in an earlier block.
 */
const bountyPaidFrom = (receipt: TransactionReceipt, contract: string): bigint | null => {
  const ev = parseEventLogs({ abi: dmsAbi, eventName: "KeyRevealed", logs: receipt.logs })
    .find((l) => l.address.toLowerCase() === contract.toLowerCase());
  return ev ? ev.args.bountyPaid : null;
};

const revealedMessage = (paid: bigint | null): string =>
  paid === null ? "Key revealed"
  : paid > 0n ? `Key revealed: ${fmtEth(paid, 6)} paid to you`
  : "Key revealed. The bounty was empty by then, so nothing was paid.";

function Step({ n, title, status, optional, children }: {
  n: number; title: string; status: StepStatus; optional?: boolean; children?: ReactNode;
}) {
  const dot: Record<StepStatus, string> = {
    done: "border-alive/50 bg-alive/15 text-alive",
    active: "border-info/60 bg-info/10 text-info",
    pending: "border-line-strong text-fg-subtle",
    warn: "border-warn/50 bg-warn/10 text-warn",
    failed: "border-gone/50 bg-gone/10 text-gone",
  };
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      <span
        className={`z-10 mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-surface text-xs ${dot[status]}`}
        aria-hidden
      >
        {status === "done" ? <Icon name="check" size={12} />
          : status === "warn" || status === "failed" ? <Icon name="alert" size={12} />
          : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className={`flex flex-wrap items-center gap-2 text-sm font-medium ${status === "pending" ? "text-fg-muted" : "text-fg"}`}>
          {title}
          {optional && <span className="pill pill-neutral">Optional</span>}
          <span className="sr-only">({status})</span>
        </div>
        {children && <div className="space-y-2 text-xs text-fg-muted [&_p]:max-w-none">{children}</div>}
      </div>
    </li>
  );
}

/**
 * The hunter flow for one switch, from the deadline to the bounty:
 *
 *   1. markDark      — anyone, once dark: the contract asks Zama's KMS to make
 *                      the key publicly decryptable. Irreversible.
 *   2. fetch key     — no wallet: the KMS threshold-decrypts the one handle and
 *                      signs it (retried while it catches up with markDark).
 *   3. verify        — the key must open the on-chain ciphertext (AES-GCM tag).
 *                      A KMS-signed key that does not is shown as a warning.
 *   4. revealKey     — submit key + proof; the contract checks the signatures
 *                      and pays the whole bounty.
 *   5. decrypt / 6. publish — on the revealed view, from chain state.
 */
export function RevealPanel({
  handle, info, state, nowSec,
}: {
  handle: SwitchHandle;
  info: SwitchInfo;
  state: SwitchState;
  nowSec: bigint;
}) {
  const { chainId } = useEffectiveChain();
  // Given this switch: a markDark or reveal sent before a reload shows as pending, and a second is refused.
  const markDark = useMarkDark(handle);
  const kms = useKmsKey();
  const reveal = useRevealKey(handle);
  const tx = useTxToast();
  const gasPrice = useGasPrice();
  const [fetchHint, setFetchHint] = useState<string | null>(null);
  const [ackBadKey, setAckBadKey] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Stop polling the KMS when the panel goes away.
  useEffect(() => {
    const ref = abortRef;
    return () => ref.current?.abort();
  }, []);

  const marked = state === "darkMarked" || state === "revealed";
  const result = kms.result;
  const check = result?.check ?? null;

  const markGas = useCallGas(state === "dark" ? { contract: handle.contractAddr, functionName: "markDark", args: [handle.owner, handle.id] } : null)
    ?? estimateMarkDarkGas(chainId);
  const revealGas = useCallGas(
    result && state === "darkMarked"
      ? { contract: handle.contractAddr, functionName: "revealKey", args: [handle.owner, handle.id, result.dataKey, result.decryptionProof] }
      : null,
  ) ?? estimateRevealGas(chainId);
  const markFee = gasCost(markGas, gasPrice);
  const revealFee = gasCost(revealGas, gasPrice);
  const releaseFee = gasCost(state === "dark" || state === "alive" ? markGas + revealGas : revealGas, gasPrice);

  const onFetch = async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setFetchHint(null);
    setAckBadKey(false);
    try {
      await kms.fetchKey(handle, info, { signal: ac.signal });
    } catch (e) {
      setFetchHint(fhevmHint(e));
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  };

  const step1: StepStatus = marked ? "done" : state === "dark" ? "active" : "pending";
  const step2: StepStatus = result ? "done" : state === "darkMarked" ? (kms.stage === "error" ? "failed" : "active") : "pending";
  const step3: StepStatus = !check ? "pending"
    : check.status === "ok" ? "done"
    : check.status === "commitment-mismatch" ? "warn"
    : "failed";
  const step4: StepStatus = state === "revealed" ? "done" : result && state === "darkMarked" ? "active" : "pending";
  const keyIsBad = !!check && check.status !== "ok" && check.status !== "commitment-mismatch";
  // Rescue open: the owner and funders may take their deposits back before this reveal lands.
  const rescueOpen = isRescuableAt(info, nowSec);
  // "Up to" only while something is left to claim: with nothing left the reveal pays exactly 0.
  const upTo = rescueOpen && info.bounty > 0n;

  return (
    <div className="space-y-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Release the key</h3>
        <span className="text-xs text-fg-muted">
          Bounty <EthAmount wei={info.bounty} />
          {releaseFee !== null && <> · gas to release ≈ <span className="value">{fmtEth(releaseFee, 6)}</span></>}
        </span>
      </div>
      <PendingTx writes={[markDark, reveal]} />
      {/* The last verdict stays in view: a write resumed after a reload has no toast. */}
      {[markDark, reveal].map((w, i) => !w.pending && w.error && (
        <p key={i} role="alert" className="field-error break-words">{w.error}</p>
      ))}

      <ol className="relative before:absolute before:bottom-3 before:left-3 before:top-3 before:w-px before:bg-line">
        <Step n={1} title="Mark dark" status={step1}>
          {state === "alive" && (
            <p>
              Opens in <span className="value text-fg">{fmtDuration(info.expiresAt - nowSec)}</span> (
              {fmtDateTime(info.expiresAt)}) unless the owner pings first.
            </p>
          )}
          {state === "dark" && (
            <>
              <p>
                The owner missed the deadline. Marking the switch dark asks the contract to make its key decryptable
                by Zama&apos;s KMS. The contract checks the deadline itself; this is <strong className="text-fg">irreversible</strong>,
                anyone may call it, and it pays nothing by itself. ≈ {Number(markGas).toLocaleString()} gas
                {markFee !== null && <> ({fmtEth(markFee, 6)})</>}.
              </p>
              <ActionGate what="mark this switch dark" compact>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={markDark.pending}
                  onClick={() => tx(() => markDark.write(handle), "Marked dark: Zama's KMS may now decrypt the key")}
                >
                  {markDark.pending ? <Spinner size={12} /> : <Icon name="clock" size={12} />} Mark dark
                </button>
              </ActionGate>
            </>
          )}
          {marked && info.darkMarkedAt > 0n && <p>Requested {fmtDateTime(info.darkMarkedAt)}.</p>}
        </Step>

        <Step n={2} title="Fetch the key from Zama's KMS" status={step2}>
          {state === "darkMarked" && !result && (
            <>
              <p>
                Zama&apos;s threshold KMS decrypts this switch&apos;s key and signs the result. It only does so because the
                contract marked it publicly decryptable. No wallet needed; usually seconds to a few minutes after
                markDark is mined.
              </p>
              {kms.pending ? (
                <div className="space-y-2" role="status" aria-live="polite">
                  <p className="flex items-center gap-2 text-info">
                    <Spinner size={12} />
                    {kms.stage === "waiting-retry"
                      ? kms.retryReason === "relayer-unavailable"
                        ? `Zama's relayer is down or busy. Retrying (attempt ${kms.attempt} of 20)…`
                        : `The KMS has not released it yet. Retrying (attempt ${kms.attempt} of 20)…`
                      : kms.stage === "verifying"
                        ? "Checking the key against the on-chain ciphertext…"
                        : kms.progress?.message ?? "Asking Zama's KMS…"}
                  </p>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => abortRef.current?.abort()}>
                    Stop
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={onFetch}>
                  <Icon name={kms.stage === "error" ? "refresh" : "key"} size={12} />
                  {kms.stage === "error" ? "Try again" : "Fetch key"}
                </button>
              )}
              {kms.stage === "error" && kms.error && (
                <div role="alert" className="space-y-1">
                  <p className="break-words text-gone">{kms.error}</p>
                  {fetchHint && <p className="text-fg">{fetchHint}</p>}
                </div>
              )}
            </>
          )}
          {(state === "alive" || state === "dark") && (
            <p>Zama&apos;s KMS decrypts the key once the switch is marked dark. No wallet needed.</p>
          )}
          {result && <p>Key received with a KMS threshold proof.</p>}
        </Step>

        <Step n={3} title="Verify the key opens the ciphertext" status={step3}>
          {!check && <p>Before paying gas, the key is checked against the stored ciphertext&apos;s AES-GCM tag.</p>}
          {check?.status === "ok" && (
            <p className="text-fg">
              The key opens the ciphertext (AES-GCM tag verified) and the plaintext matches the owner&apos;s commitment.
            </p>
          )}
          {check?.status === "commitment-mismatch" && (
            <p className="text-warn">
              The key opens the ciphertext, but the plaintext does not match the owner&apos;s commitment. You can still
              reveal and claim; publishing the decrypted plaintext on-chain will be impossible.
            </p>
          )}
          {check?.status === "invalid-key" && (
            <div className="note note-danger" role="alert">
              <p className="text-sm text-fg">{check.warning}</p>
              <p className="mt-1">
                The contract will still accept the proof and pay the bounty, but nobody will be able to read the secret.
              </p>
            </div>
          )}
          {check?.status === "malformed" && (
            <div className="note note-danger" role="alert">
              <p className="text-sm text-fg">The stored ciphertext is malformed: {check.reason}</p>
            </div>
          )}
        </Step>

        <Step n={4} title="Reveal the key and claim the bounty" status={step4}>
          {step4 === "active" && result && (
            <>
              <p>
                Submits the key and the KMS proof. The contract verifies the threshold signatures, records the key
                on-chain for good and pays you{" "}
                {info.bounty === 0n
                  ? <>nothing: the bounty is empty{rescueOpen ? ", reclaimed by its depositors" : ""}.</>
                  : upTo
                    ? <>whatever is left of the bounty when it lands: up to <EthAmount wei={info.bounty} />. Rescue is
                      open, so depositors may reclaim their deposits first.</>
                    : <>the whole bounty of <EthAmount wei={info.bounty} />.</>}
                {" "}≈ {Number(revealGas).toLocaleString()} gas{revealFee !== null && <> ({fmtEth(revealFee, 6)})</>}
                {revealFee !== null && info.bounty > revealFee && (
                  <>, net {upTo ? "at most" : "≈"} <span className="value text-fg">{fmtEth(info.bounty - revealFee, 6)}</span></>
                )}.
              </p>
              {keyIsBad && (
                <label className="flex items-start gap-2 text-fg">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-gone"
                    checked={ackBadKey}
                    onChange={(e) => setAckBadKey(e.target.checked)}
                  />
                  <span>Reveal anyway: I understand the secret will not be readable.</span>
                </label>
              )}
              <ActionGate what="reveal the key" compact>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={reveal.pending || (keyIsBad && !ackBadKey)}
                  onClick={() => tx(
                    () => reveal.write(handle, result.dataKey, result.decryptionProof),
                    (r) => revealedMessage(bountyPaidFrom(r.receipt, handle.contractAddr)),
                  )}
                >
                  {reveal.pending ? <Spinner size={14} /> : <Icon name="unlock" />} Reveal and claim{" "}
                  {upTo && "up to "}{fmtEth(info.bounty)}
                </button>
              </ActionGate>
              <FrontrunNote />
            </>
          )}
          {step4 === "pending" && <p>Pays the whole bounty to whoever lands it first.</p>}
        </Step>

        <Step n={5} title="Decrypt locally" status="pending">
          <p>Once revealed, the key is on-chain and this page decrypts the secret in your browser.</p>
        </Step>

        <Step n={6} title="Publish the plaintext" status="pending" optional>
          <p>Posts the plaintext on-chain for indexers. Costs gas and pays nothing.</p>
        </Step>
      </ol>
    </div>
  );
}
