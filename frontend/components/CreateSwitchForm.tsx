"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
import { MAINNET_ID, SEPOLIA_ID, chainLabel, explorerTx } from "@/lib/contracts";
import { prefetchFheKey, type FhevmProgress } from "@/lib/fhevm";
import {
  useChainTime, useContractConfig, useCreateSwitch, useEffectiveChain, useSwitchInfo,
  type AttemptOutcome, type CreateAttempt, type CreateStage, type CreatedSwitch,
} from "@/lib/hooks";
import {
  INTERVAL_PRESETS, MAX_PAYLOAD_SIZE, ciphertextSizeFor, fmtAddress, fmtDuration, fmtEth, fmtUsd8,
  MIN_PING_INTERVAL, isValidInterval, switchPath, switchStateFor, utf8Len, type SwitchState,
} from "@/lib/switch";
import { hasDecimalComma, parseEthInput } from "@/components/amount";
import { FheKeyStatus, fhevmHint } from "@/components/FheKeyStatus";
import { estimateCreateGas, estimateMarkDarkGas, estimateRevealGas, gasCost, useGasPrice } from "@/components/gas";
import { ActionGate } from "@/components/ui/ActionGate";
import { CopyButton } from "@/components/ui/Copy";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Loading";
import { Note, SelfRevealNote } from "@/components/ui/Note";

const UNITS = [
  { label: "minutes", seconds: 60 },
  { label: "hours", seconds: 3600 },
  { label: "days", seconds: 86400 },
] as const;

/** Bounty this close to the floor may revert BountyTooLow if ETH/USD moves before it lands. */
const FLOOR_MARGIN_BPS = 300n; // 3 %

// ---------- progress steps ----------

const STEPS = [
  { title: "Check and seal", body: "AES-256-GCM in this browser, under a fresh random 32-byte key" },
  { title: "Prepare FHE", body: "Load the FHE library and, the first time, Zama's public key (about 4.6 MB)" },
  { title: "Encrypt the key to Zama", body: "Proof of knowledge in your browser, then an input proof from Zama's relayer" },
  { title: "Confirm in your wallet", body: "Ciphertext, encrypted key and bounty go on-chain in one transaction" },
  { title: "Wait for the block", body: "The switch is live once the transaction is mined" },
] as const;

/**
 * Index of the step in progress (or that failed); STEPS.length when done; -1
 * when idle. `failedAt` is the stage a failed run stopped in (null: the sent
 * transaction itself failed).
 */
const stepIndex = (stage: CreateStage, fhe: FhevmProgress | null, failedAt: CreateStage | null): number => {
  const encrypting = fhe?.stage === "encrypting" || fhe?.stage === "done" ? 2 : 1;
  switch (stage) {
    case "idle": return -1;
    case "sealing": return 0;
    case "encrypting-key": return encrypting;
    case "confirm-in-wallet": return 3;
    case "mining": return 4;
    case "unconfirmed": return 4;
    case "done": return STEPS.length;
    case "error":
      switch (failedAt) {
        case "sealing": return 0;
        case "encrypting-key": return encrypting;
        case "confirm-in-wallet": return 3;
        default: return 4;
      }
  }
};

function Steps({ current, failed, fhe, chainId }: {
  current: number; failed: boolean; fhe: FhevmProgress | null; chainId: number;
}) {
  return (
    <ol className="space-y-2.5" aria-label="Progress">
      {STEPS.map((s, i) => {
        const state = i < current ? "done" : i === current ? (failed ? "failed" : "active") : "pending";
        return (
          <li key={s.title} className="flex gap-3">
            <span
              className={
                "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] " +
                (state === "done" ? "border-alive/50 bg-alive/15 text-alive"
                  : state === "active" ? "border-info/50 bg-info/10 text-info"
                  : state === "failed" ? "border-gone/50 bg-gone/10 text-gone"
                  : "border-line-strong text-fg-subtle")
              }
              aria-hidden
            >
              {state === "done" ? <Icon name="check" size={11} />
                : state === "active" ? <Spinner size={10} />
                : state === "failed" ? <Icon name="x" size={11} />
                : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-sm ${state === "pending" ? "text-fg-muted" : "text-fg"}`}>
                {s.title}
                <span className="sr-only"> ({state})</span>
              </div>
              <div className="text-xs text-fg-subtle">{s.body}</div>
              {state === "active" && (i === 1 || i === 2) && fhe && (
                <div className="mt-1.5 space-y-1.5">
                  <p className="text-xs text-info">{fhe.message}</p>
                  {i === 1 && <FheKeyStatus chainId={chainId} allowPrefetch={false} />}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- outcome cards ----------

type CreateFlow = ReturnType<typeof useCreateSwitch>;

function TxHash({ chainId, hash }: { chainId: number; hash: string }) {
  const href = explorerTx(chainId, hash);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="value break-all text-fg">{hash}</span>
      <CopyButton value={hash} title="Copy transaction hash" />
      {href && (
        <a href={href} target="_blank" rel="noreferrer" className="text-fg-subtle hover:text-fg" aria-label="View on Etherscan">
          <Icon name="external" size={14} />
        </a>
      )}
    </span>
  );
}

function AttemptFacts({ attempt }: { attempt: CreateAttempt }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded border border-line bg-canvas p-3 text-xs sm:grid-cols-[auto_1fr]">
      <dt className="text-fg-subtle">Switch id</dt>
      <dd className="inline-flex items-center gap-1">
        <span className="value text-fg">#{attempt.id.toString()}</span>
        <CopyButton value={attempt.id.toString()} title="Copy switch id" />
      </dd>
      <dt className="text-fg-subtle">Network</dt>
      <dd className="text-fg">{chainLabel(attempt.chainId)}</dd>
      <dt className="text-fg-subtle">Owner</dt>
      <dd className="value text-fg">{fmtAddress(attempt.owner)}</dd>
      {attempt.hash && (
        <>
          <dt className="text-fg-subtle">Transaction</dt>
          <dd><TxHash chainId={attempt.chainId} hash={attempt.hash} /></dd>
        </>
      )}
    </dl>
  );
}

const OUTCOME_LINE: Partial<Record<AttemptOutcome, string>> = {
  pending: "Not mined yet.",
  unknown: "Could not reach the network's RPC; retrying.",
};

/**
 * A reverted attempt's switch is re-checked for a few minutes, then only on
 * request: an earlier send of the same id may have created it.
 */
export function RecheckLine({ flow, attempt }: { flow: CreateFlow; attempt: CreateAttempt }) {
  return (
    <p className="mt-1 flex max-w-none flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
      <span>
        If an earlier send of switch <span className="value">#{attempt.id.toString()}</span> went through, it shows
        here.
        {flow.lastCheckedAt !== null && <> Last checked {new Date(flow.lastCheckedAt).toLocaleTimeString()}.</>}
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={flow.checkNow}>
        <Icon name="refresh" size={12} /> Check again
      </button>
    </p>
  );
}

/** A tx was sent and its outcome is not known yet. Never offers a new create. */
export function UnconfirmedCard({ flow, attempt }: { flow: CreateFlow; attempt: CreateAttempt }) {
  const path = switchPath(attempt.chainId, { contractAddr: attempt.contract, owner: attempt.owner, id: attempt.id });
  return (
    <section className="card space-y-4" aria-live="polite">
      <div className="flex items-center gap-2 text-info">
        <Spinner size={16} />
        <h2 className="section-title text-fg">Waiting for confirmation</h2>
      </div>
      <p className="text-sm text-fg-muted">
        Your wallet sent the transaction, but it is not confirmed yet. This can take a while when the network is busy.
        This page keeps checking switch <span className="value text-fg">#{attempt.id.toString()}</span> and shows the
        result here, also after a reload. If you close this tab, check that the switch appears under Your switches
        before you rely on it. <strong className="text-fg">Do not create the switch again.</strong>
      </p>
      <AttemptFacts attempt={attempt} />
      <p className="text-xs text-fg-muted">
        {(flow.outcome && OUTCOME_LINE[flow.outcome]) ?? "Checking…"}
        {flow.lastCheckedAt !== null && (
          <span className="text-fg-subtle"> Last checked {new Date(flow.lastCheckedAt).toLocaleTimeString()}.</span>
        )}
      </p>
      <Note tone="info" title="Stuck?">
        <p className="text-sm">
          Speed it up in your wallet: a replacement keeps the same switch id. If the transaction is dropped or reverts,
          this page offers to send it again with the same id, which can never create a second switch.
        </p>
      </Note>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={flow.checkNow}>
          <Icon name="refresh" size={14} /> Check now
        </button>
        <Link href={path} className="btn btn-ghost">
          Switch page <Icon name="chevronRight" size={14} />
        </Link>
      </div>
    </section>
  );
}

/**
 * The attempt reached the wallet from another account or network. With no
 * hash, or a hash the network has not seen for a while, it may still land
 * there: finish it first. Even a reverted hash does not prove there is no
 * switch (an earlier send of the same id may have landed first, or the read
 * lagged), so starting afresh from here is always behind a warning, and
 * forgetAttempt re-reads the switch before it drops the attempt.
 */
export function OtherAccountCard({ flow, attempt }: { flow: CreateFlow; attempt: CreateAttempt }) {
  const [confirming, setConfirming] = useState(false);
  const from = (
    <>
      <span className="value text-fg">{fmtAddress(attempt.owner)}</span> on {chainLabel(attempt.chainId)}
    </>
  );
  const id = <span className="value text-fg">#{attempt.id.toString()}</span>;
  const reverted = !!attempt.hash && flow.outcome === "reverted";
  const unseen = !!attempt.hash && flow.outcome === "vanished";
  return (
    <section className="card space-y-4" aria-live="polite">
      <h2 className="section-title">{reverted ? "Your earlier attempt reverted" : "Finish your earlier attempt first"}</h2>
      <p className="text-sm text-fg-muted">
        {reverted ? (
          <>
            The transaction for switch {id}, sent from {from}, reverted, and switch {id} has not been found. This
            page re-checks it for a few minutes: if an earlier send of the same id went through, it shows that
            switch here. To try again, switch back to that account and network: a retry there reuses the same id, so
            it can never create a second switch.
          </>
        ) : (
          <>
            Switch {id} was sent to your wallet from {from}, and{" "}
            {unseen
              ? <>its transaction has not been seen on the network for several minutes. It may have been dropped, or
                sent privately and still land.</>
              : <>this page cannot tell whether it went through.</>}{" "}
            Switch back to that account and network to finish it: a retry there reuses the same id, so it can never
            create a second switch. This page keeps checking meanwhile.
          </>
        )}
      </p>
      <AttemptFacts attempt={attempt} />
      {reverted && <RecheckLine flow={flow} attempt={attempt} />}
      {confirming ? (
        <ForgetAttemptNote flow={flow} attempt={attempt} onKeep={() => setConfirming(false)} />
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
          {reverted ? "Start a new switch…" : unseen ? "It will not land…" : "It was never sent…"}
        </button>
      )}
    </section>
  );
}

/** OtherAccountCard's confirmation before the attempt is dropped. The drop itself re-checks the chain first. */
export function ForgetAttemptNote({ flow, attempt, onKeep }: { flow: CreateFlow; attempt: CreateAttempt; onKeep: () => void }) {
  const reverted = !!attempt.hash && flow.outcome === "reverted";
  const unseen = !!attempt.hash && flow.outcome === "vanished";
  return (
    <Note tone="warn" title={reverted ? "Start a new switch instead?" : "Forget that attempt?"}>
      <p className="text-sm">
        {reverted
          ? <>Only if no other send of switch #{attempt.id.toString()} from that account can land, for example one your
            wallet sent before reporting an error: check that account&apos;s activity in your wallet.</>
          : unseen
            ? <>Only if you are sure it will never land: check that account&apos;s activity in your wallet.</>
            : <>Only if you are sure the wallet never sent it.</>}{" "}
        If it lands after all, creating a new switch would leave two switches holding the same secret, and the one you
        do not ping would release it. This page first checks the chain again, and shows the switch if it exists.
      </p>
      {flow.recheckError && <p className="text-sm text-gone">{flow.recheckError}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="button" className="btn btn-sm" disabled={flow.rechecking} onClick={() => void flow.forgetAttempt()}>
          {flow.rechecking
            ? <><Spinner size={12} /> Checking the chain…</>
            : reverted ? "Check, then start a new switch" : "Check, then forget it"}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={flow.rechecking} onClick={onKeep}>Keep it</button>
      </div>
    </Note>
  );
}

/** What became of a created switch since, when it is no longer alive (CreatedCard). */
const SINCE: Partial<Record<SwitchState, string>> = {
  dark: "It has since gone dark: anyone can release the key.",
  darkMarked: "It has since gone dark, and its key release was requested.",
  revealed: "Its key has since been released: the secret is public.",
  cancelled: "It has since been cancelled.",
};

/**
 * The last create that finished in this tab. `live` is the switch's state
 * now (null while it is read): the card can stay for days (until "Create
 * another"), so it never repeats the state the switch had at creation.
 */
export function CreatedCard({ created, live = null, onStartOver, startingOver = false, startOverError = null }: {
  created: CreatedSwitch;
  live?: SwitchState | null;
  onStartOver: () => void;
  /** "Create another" is re-reading the switch first (a reorg can hide a fresh create for a while). */
  startingOver?: boolean;
  /** Why that re-read failed: the card stays. */
  startOverError?: string | null;
}) {
  const path = switchPath(created.chainId, { contractAddr: created.contract, owner: created.owner, id: created.id });
  const since = live ? SINCE[live] : undefined;
  return (
    <section className="card space-y-4" aria-live="polite">
      <div className="flex items-center gap-2 text-alive">
        <Icon name="check" size={18} />
        <h2 className="section-title text-fg">Switch created</h2>
      </div>
      <p className="text-sm text-fg-muted">
        Switch <span className="value text-fg">#{created.id.toString()}</span>{" "}
        {live === "alive"
          ? <>is live on {chainLabel(created.chainId)}.</>
          : <>was created on {chainLabel(created.chainId)}.</>}{" "}
        {since ?? (
          <>
            Ping at least every <strong className="text-fg">{fmtDuration(created.pingInterval)}</strong>. Miss one
            deadline and anyone can release the key.
          </>
        )}
      </p>
      {created.adopted && (
        <Note tone="info" title="Found on-chain">
          <p className="text-sm">
            This switch was created by a transaction you had already sent from this form
            {created.hash ? <> (<span className="value">{created.hash.slice(0, 10)}…</span>)</> : null}, so nothing new
            was sent. It holds what you submitted in that transaction.
          </p>
        </Note>
      )}
      {live !== "revealed" && live !== "cancelled" && (
        <Note tone="info" title="Keep your own copy">
          <p className="text-sm">
            The plaintext and its key have been wiped from this page. Nobody, you included, can read the secret
            back from the chain until the switch is released.
          </p>
        </Note>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Link href={path} className="btn btn-primary">
          Open the switch page <Icon name="chevronRight" size={14} />
        </Link>
        <CopyButton value={typeof window !== "undefined" ? `${window.location.origin}${path}` : path} title="Copy link" />
        <button type="button" className="btn btn-ghost" onClick={onStartOver} disabled={startingOver}>
          {startingOver ? <Spinner size={14} /> : <Icon name="plus" size={14} />} Create another
        </button>
      </div>
      {startOverError && <p role="alert" className="field-error break-words">{startOverError}</p>}
    </section>
  );
}

/** CreatedCard with the switch's state now (the same read as its card in the list below). */
function LiveCreatedCard({ flow, created }: { flow: CreateFlow; created: CreatedSwitch }) {
  const { info } = useSwitchInfo({ contractAddr: created.contract, owner: created.owner, id: created.id });
  const { nowSec } = useChainTime();
  const live = info?.exists && nowSec !== null ? switchStateFor(info, nowSec) : null;
  return (
    <CreatedCard
      created={created}
      live={live}
      onStartOver={() => void flow.startOver()}
      startingOver={flow.startingOver}
      startOverError={flow.startOverError}
    />
  );
}

// ---------- form ----------

/**
 * The create flow. The form (and the secret it holds) is unmounted as soon as
 * a transaction is unconfirmed or the switch exists, so the secret is not kept
 * around and no second create can start from it.
 */
export function CreateSwitchForm() {
  const flow = useCreateSwitch();
  const { chainId, address: current } = useEffectiveChain();
  if (flow.created) return <LiveCreatedCard flow={flow} created={flow.created} />;
  if (flow.attempt && (flow.stage === "unconfirmed" || flow.block === "pending")) {
    return <UnconfirmedCard flow={flow} attempt={flow.attempt} />;
  }
  if (flow.attempt && flow.block === "other-account") return <OtherAccountCard flow={flow} attempt={flow.attempt} />;
  if (!current) return <CreatesClosed chainId={chainId} />;
  return <CreateForm flow={flow} />;
}

/** A chain whose current deployment was removed: only its previous ones are left, for the switches on them. */
function CreatesClosed({ chainId }: { chainId: number }) {
  return (
    <Note tone="info" title={`New switches cannot be created on ${chainLabel(chainId)}`}>
      <p className="text-sm">
        This app has no current deployment there, only older ones. Your switches on them are listed below and work as
        before: keep pinging them, or cancel them.
      </p>
    </Note>
  );
}

function CreateForm({ flow }: { flow: CreateFlow }) {
  const { chainId } = useEffectiveChain();
  const { data: config, isLoading: configLoading } = useContractConfig();
  const gasPrice = useGasPrice();
  const { create, stage, fhe, error, errorTitle, failedAt, pending, attempt } = flow;

  const [secret, setSecret] = useState("");
  const [presetSec, setPresetSec] = useState<number | null>(86400 * 30);
  const [customValue, setCustomValue] = useState("14");
  const [customUnit, setCustomUnit] = useState<number>(86400);
  const [bountyEth, setBountyEth] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const prefetched = useRef(false);

  // Leaving the page (or the wallet disconnecting) unmounts the form while
  // the secret is still being sealed and encrypted. Without this the run went
  // on in the background, opened a wallet prompt on whatever page the owner
  // was on, and a second submit after coming back raced it with the same id.
  // A run already past the wallet prompt is unaffected (nothing to abort).
  useEffect(() => {
    const ref = abortRef;
    return () => ref.current?.abort();
  }, []);

  const relayerChain = chainId === MAINNET_ID || chainId === SEPOLIA_ID;
  /** A send of this form session may exist on-chain: retries reuse its id. */
  const sentBefore = !!attempt?.submitted;

  // --- secret ---
  const secretBytes = utf8Len(secret);
  const secretErr = secretBytes > MAX_PAYLOAD_SIZE
    ? `${secretBytes.toLocaleString()} of ${MAX_PAYLOAD_SIZE.toLocaleString()} bytes: ${(secretBytes - MAX_PAYLOAD_SIZE).toLocaleString()} over the limit`
    : null;
  const ctBytes = ciphertextSizeFor(Math.max(secretBytes, 1));

  // --- interval ---
  const customSec = (() => {
    const v = Number(customValue);
    return Number.isFinite(v) && v > 0 ? Math.round(v * customUnit) : NaN;
  })();
  const intervalSec = presetSec ?? customSec;
  const intervalErr = !isValidInterval(Number.isFinite(intervalSec) ? intervalSec : 0)
    ? "Between 1 minute and 365 days."
    : null;

  // --- bounty ---
  const minBounty = config?.minBounty ?? 0n;
  const bountyWei = parseEthInput(bountyEth);
  const bountyErr =
    bountyWei === undefined ? "Not a valid ETH amount."
    : bountyWei !== null && bountyWei < minBounty ? `Below the current minimum of ${fmtEth(minBounty, 6, "up")}.`
    : null;
  const nearFloor = !bountyErr && bountyWei != null && minBounty > 0n
    && bountyWei < minBounty + (minBounty * FLOOR_MARGIN_BPS) / 10_000n;
  const suggestedFloor = minBounty > 0n ? minBounty + (minBounty * FLOOR_MARGIN_BPS) / 10_000n : 0n;
  const hunterCost = gasCost(estimateMarkDarkGas(chainId) + estimateRevealGas(chainId), gasPrice);
  const bountyUsd = bountyWei != null && config?.ethUsd ? (Number(formatEther(bountyWei)) * config.ethUsd) : null;

  // --- fee ---
  const createGas = estimateCreateGas(ctBytes, chainId);
  const createFee = gasCost(createGas, gasPrice);

  const busy = pending;
  const canSubmit = !busy && secretBytes > 0 && !secretErr && !intervalErr && bountyWei != null && !bountyErr
    && !configLoading;

  const current = stepIndex(stage, fhe, failedAt);

  const onSecretChange = (v: string) => {
    setSecret(v);
    // Warm the one-time key download once the user shows intent to create.
    if (!prefetched.current && relayerChain && v.length > 0) {
      prefetched.current = true;
      void prefetchFheKey(chainId);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || bountyWei == null) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setHint(null);
    try {
      // On success or an unconfirmed send this form unmounts (see
      // CreateSwitchForm), dropping the secret with it.
      await create({ secret, pingInterval: intervalSec, bountyWei, signal: ac.signal });
    } catch (err) {
      setHint(fhevmHint(err));
    } finally {
      abortRef.current = null;
    }
  };

  return (
    // noValidate: the checks above mirror the contract's limits and are shown inline. Native
    // constraint validation (e.g. min on the custom interval) silently blocked valid submits.
    <form onSubmit={onSubmit} noValidate className="card space-y-6" aria-busy={busy}>
      <div>
        <h2 className="section-title">Create a switch</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Your secret is encrypted in this browser. Only its 32-byte key is encrypted to Zama&apos;s threshold
          network, and the contract alone decides when you have gone dark. Until then the key stays sealed.
        </p>
      </div>

      {/* Secret */}
      <div className="field">
        <label className="field-label" htmlFor="secret">The secret</label>
        <textarea
          id="secret"
          className={`input min-h-36 font-mono text-sm ${secretErr ? "input-invalid" : ""}`}
          placeholder="A key, a seed phrase, a letter, a location…"
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
          disabled={busy}
          // Browser spellcheck / grammar extensions can ship text to remote services.
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-gramm="false"
          data-1p-ignore
          data-lpignore="true"
          aria-describedby={secretErr ? "secret-count secret-error" : "secret-count"}
          aria-invalid={!!secretErr}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="secret-count" className={`text-xs ${secretErr ? "text-gone" : "text-fg-muted"}`}>
            <span className="value">{secretBytes.toLocaleString()}</span> / {MAX_PAYLOAD_SIZE.toLocaleString()} bytes
            {secretBytes > 0 && (
              <span className="text-fg-subtle"> · {ctBytes.toLocaleString()} bytes on-chain after encryption</span>
            )}
          </p>
          <p className="text-xs text-fg-subtle">UTF-8 bytes: accented letters and emoji count 2 to 4.</p>
        </div>
        {secretErr && <p id="secret-error" className="field-error">{secretErr}</p>}
        <p className="field-hint">
          Stored on-chain as ciphertext forever. Once released, it is public forever: anyone can decrypt it from
          chain state alone.
        </p>
      </div>

      {/* Ping interval */}
      <fieldset className="field" disabled={busy}>
        <legend className="field-label">Ping interval</legend>
        <p className="field-hint">How long you may go without pinging. Miss one interval and the switch goes dark.</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {INTERVAL_PRESETS.map((p) => (
            <button
              key={p.seconds}
              type="button"
              className={`btn btn-sm ${presetSec === p.seconds ? "btn-selected" : ""}`}
              aria-pressed={presetSec === p.seconds}
              onClick={() => setPresetSec(p.seconds)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className={`btn btn-sm ${presetSec === null ? "btn-selected" : ""}`}
            aria-pressed={presetSec === null}
            onClick={() => setPresetSec(null)}
          >
            Custom
          </button>
        </div>
        {presetSec === null && (
          <div className="flex items-center gap-2 pt-1">
            <input
              className={`input max-w-32 ${intervalErr ? "input-invalid" : ""}`}
              type="number"
              min={MIN_PING_INTERVAL / customUnit}
              step="any"
              inputMode="decimal"
              value={customValue}
              onChange={(e) => setCustomValue(e.target.value)}
              aria-label="Custom interval"
              aria-invalid={!!intervalErr}
              aria-describedby={intervalErr ? "interval-error" : undefined}
            />
            <select
              className="input max-w-32"
              value={customUnit}
              onChange={(e) => setCustomUnit(Number(e.target.value))}
              aria-label="Interval unit"
            >
              {UNITS.map((u) => <option key={u.seconds} value={u.seconds}>{u.label}</option>)}
            </select>
          </div>
        )}
        {intervalErr
          ? <p id="interval-error" className="field-error">{intervalErr}</p>
          : <p className="text-xs text-fg-muted">Goes dark after <span className="value text-fg">{fmtDuration(intervalSec)}</span> without a ping.</p>}
      </fieldset>

      {/* Bounty */}
      <div className="field">
        <label className="field-label" htmlFor="bounty">Bounty</label>
        <p className="field-hint">
          Paid in full to whoever releases the key after you go dark. It is what makes anyone bother: releasing
          costs two transactions.
        </p>
        <div className="flex items-center gap-2 pt-1">
          <input
            id="bounty"
            className={`input max-w-48 ${bountyErr ? "input-invalid" : ""}`}
            type="text"
            inputMode="decimal"
            placeholder={suggestedFloor > 0n ? formatEther(suggestedFloor) : "0.01"}
            value={bountyEth}
            onChange={(e) => setBountyEth(e.target.value)}
            disabled={busy}
            aria-invalid={!!bountyErr}
            aria-describedby={bountyErr ? "bounty-error" : undefined}
          />
          <span className="text-sm text-fg-muted">ETH</span>
          {bountyUsd !== null && (
            <span className="text-xs text-fg-subtle">≈ ${bountyUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
          )}
        </div>
        {bountyErr && <p id="bounty-error" className="field-error">{bountyErr}</p>}
        {!bountyErr && bountyWei != null && hasDecimalComma(bountyEth) && (
          <p className="text-xs text-fg-muted">Read as <span className="value text-fg">{formatEther(bountyWei)} ETH</span>.</p>
        )}
        {nearFloor && (
          <p className="text-xs text-warn">
            Within 3% of the floor. If ETH/USD moves before the transaction lands, it reverts. Consider{" "}
            <button type="button" className="value underline underline-offset-2" onClick={() => setBountyEth(formatEther(suggestedFloor))}>
              {formatEther(suggestedFloor)} ETH
            </button>.
          </p>
        )}
        <ul className="space-y-0.5 text-xs text-fg-muted">
          {configLoading && <li>Reading the minimum bounty…</li>}
          {config && config.minBountyUsd === 0n && (
            <li>No minimum: the bounty floor is disabled on this deployment. Zero is accepted, but nobody is paid to release it.</li>
          )}
          {config && config.minBountyUsd > 0n && !config.oracleDown && (
            <li>
              {/* Rounded up: typing the shown minimum must clear it (fmtEth truncates by default). */}
              Minimum <span className="value text-fg">{fmtEth(minBounty, 6, "up")}</span> ({fmtUsd8(config.minBountyUsd)} at the
              Chainlink ETH/USD price{config.ethUsd ? ` of $${config.ethUsd.toFixed(2)}` : ""}).
            </li>
          )}
          {config?.oracleDown && (
            <li className="text-warn">
              Price oracle unavailable: the {fmtUsd8(config.minBountyUsd)} floor is not enforced right now (the contract
              fails open). Any amount is accepted, but size the bounty as if it were.
            </li>
          )}
          {hunterCost !== null && (
            <li>
              Releasing costs a hunter about <span className="value text-fg">{fmtEth(hunterCost, 6)}</span> in gas at
              today&apos;s price. Leave a wide margin: gas may be far higher on the day it matters.
            </li>
          )}
        </ul>
      </div>

      {/* FHE key */}
      {relayerChain && !busy && (
        <div className="card-inset">
          <FheKeyStatus chainId={chainId} />
        </div>
      )}

      <SelfRevealNote audience="owner" />

      {/* Cost summary */}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 rounded border border-line bg-canvas p-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-fg-subtle">Estimated gas</dt>
          <dd className="value text-sm text-fg">≈ {Number(createGas).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Network fee</dt>
          <dd className="value text-sm text-fg">{createFee !== null ? `≈ ${fmtEth(createFee, 6)}` : "—"}</dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Total incl. bounty</dt>
          <dd className="value text-sm text-fg">
            {createFee !== null && bountyWei != null && !bountyErr ? `≈ ${fmtEth(createFee + bountyWei, 6)}` : "—"}
          </dd>
        </div>
        <p className="text-fg-subtle sm:col-span-3">
          Storage dominates: about 22,100 gas per 32 bytes of ciphertext. Your wallet shows the exact figure.
        </p>
      </dl>

      {/* Progress */}
      {current >= 0 && (
        <div className="space-y-3 rounded border border-line p-3">
          <Steps current={current} failed={stage === "error"} fhe={fhe} chainId={chainId} />
          {busy && (
            <p className="text-xs text-fg-subtle">
              {current <= 2
                ? "Keep this tab open. Nothing is sent on-chain until you confirm in your wallet."
                : "Keep this tab open (or reload it) until it shows “Switch created”: a sent transaction can still revert."}
            </p>
          )}
        </div>
      )}

      {stage === "error" && error && (
        <div className="note note-danger" role="alert">
          <div className="note-title">
            <span className="text-gone"><Icon name="alert" /></span>{" "}
            {errorTitle}
          </div>
          <p className="max-w-none break-words text-xs text-fg-muted">{error}</p>
          {sentBefore && !attempt?.hash && (
            <p className="mt-1 max-w-none text-xs text-fg">
              The wallet may have sent the transaction anyway. This page keeps checking switch{" "}
              <span className="value">#{attempt?.id.toString()}</span> and shows it here if it lands. Trying again
              reuses the same id, so it can never create a second switch.
            </p>
          )}
          {attempt?.hash && flow.outcome === "reverted" && <RecheckLine flow={flow} attempt={attempt} />}
          {hint && <p className="mt-1 max-w-none text-xs text-fg">{hint}</p>}
        </div>
      )}

      {stage === "idle" && sentBefore && !attempt?.hash && (
        <Note tone="info" title={`Resuming switch #${attempt?.id.toString()}`}>
          <p className="text-sm">
            An earlier submission from this tab reached your wallet but was never confirmed here. This page keeps
            checking it. Submitting again reuses its id, so it can never create a second switch.
          </p>
        </Note>
      )}

      <ActionGate what="create a switch">
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary btn-lg flex-1" type="submit" disabled={!canSubmit}>
            {busy
              ? <><Spinner size={16} /> {current >= 0 ? STEPS[Math.min(current, STEPS.length - 1)].title : "Working"}…</>
              : <><Icon name="lock" /> {stage === "error" ? "Try again" : "Encrypt and create"}</>}
          </button>
          {busy && current <= 2 && (
            <button type="button" className="btn btn-lg" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          )}
        </div>
      </ActionGate>
    </form>
  );
}
