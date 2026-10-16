"use client";

import { useState } from "react";
import { getAddress, isAddress } from "viem";
import { useAccount } from "wagmi";
import { chainLabel, explorerAddress } from "@/lib/contracts";
import { errMsg } from "@/lib/errors";
import { useAdminActions, useContractConfig, useEffectiveChain, useIsAdmin, useIsPendingAdmin, type ContractConfig } from "@/lib/hooks";
import { MAX_MIN_BOUNTY_USD, ZERO_ADDRESS, fmtDuration, fmtEth, fmtUsd8 } from "@/lib/switch";
import { hasDecimalComma, parseUsdInput } from "@/components/amount";
import { ActionGate } from "@/components/ui/ActionGate";
import { ConfirmPanel } from "@/components/ui/ConfirmPanel";
import { CopyButton } from "@/components/ui/Copy";
import { EmptyState, ErrorBox } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Loading";
import { NetworkGuard } from "@/components/ui/NetworkGuard";
import { PendingTx } from "@/components/ui/PendingTx";
import { Note } from "@/components/ui/Note";
import { useTxToast } from "@/components/ui/useTxToast";

export default function AdminPage() {
  return <NetworkGuard><AdminInner /></NetworkGuard>;
}

const isZero = (a: string) => a.toLowerCase() === ZERO_ADDRESS;

function AdminInner() {
  const { chainId, address: contract } = useEffectiveChain();
  const { data: config, error } = useContractConfig();
  const isAdmin = useIsAdmin();
  const isPending = useIsPendingAdmin();

  // Only previous deployments left on this chain (their settings are not managed here).
  if (!contract) {
    return (
      <EmptyState
        icon="alert"
        title={`No current deployment on ${chainLabel(chainId)}`}
        body="This app keeps only older deployments on this network, for the switches on them. Their settings are not managed here."
      />
    );
  }

  // The settings refetch every 30 s. A failed refetch keeps the last data:
  // replacing the page with an error would unmount an open confirmation and
  // its typed phrase or address. Only an error with nothing read yet is fatal.
  if (!config) {
    if (error) return <ErrorBox title="Could not read the contract settings" message={errMsg(error)} />;
    return <p className="flex items-center gap-2 text-sm text-fg-muted"><Spinner size={14} /> Reading contract settings…</p>;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Admin</h1>
        <p className="page-lede">
          {chainLabel(chainId)} · contract <span className="value">{contract}</span>
        </p>
      </header>

      {error && (
        <p className="max-w-none break-words text-xs text-warn" role="status">
          Could not refresh the settings ({errMsg(error)}). Showing the last values read.
        </p>
      )}

      <p className="text-sm text-fg-muted">
        The admin can change one thing: the minimum bounty, in USD, for new switches. It cannot touch any existing
        switch, its funds or its key. The role transfers in two steps and can be renounced, which freezes the
        minimum forever.
      </p>

      <div className="grid-2">
        <Status config={config} chainId={chainId} />
        {isPending && <AcceptAdmin />}
        {isAdmin && <SetMinBounty config={config} />}
        {isAdmin && <TransferAdmin config={config} />}
        {isAdmin && <RenounceAdmin config={config} />}
        {!isAdmin && !isPending && (
          <section className="card space-y-2">
            <h2 className="section-title">Read-only</h2>
            <p className="text-sm text-fg-muted">
              {config.adminRenounced
                ? "The admin role has been renounced: these settings are permanent."
                : "Connect the admin wallet (or the pending admin) to make changes."}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-0.5">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-right text-fg">{children}</dd>
    </div>
  );
}

function Addr({ a, chainId }: { a: string; chainId: number }) {
  const href = explorerAddress(chainId, a);
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      {href
        ? <a className="value break-all text-xs underline-offset-2 hover:underline" href={href} target="_blank" rel="noreferrer">{a}</a>
        : <span className="value break-all text-xs">{a}</span>}
      <CopyButton value={a} />
    </span>
  );
}

function Status({ config, chainId }: { config: ContractConfig; chainId: number }) {
  const noFeed = isZero(config.ethUsdPriceFeed);
  return (
    <section className="card space-y-3">
      <h2 className="section-title">Current settings</h2>
      <dl className="space-y-2 text-sm">
        <Row label="Admin">
          {config.adminRenounced ? <span className="text-fg-muted">Renounced</span> : <Addr a={config.admin} chainId={chainId} />}
        </Row>
        <Row label="Pending admin">
          {isZero(config.pendingAdmin) ? <span className="text-fg-muted">None</span> : <Addr a={config.pendingAdmin} chainId={chainId} />}
        </Row>
        <Row label="Minimum bounty">
          {config.minBountyUsd === 0n ? <span className="text-fg-muted">Disabled</span> : fmtUsd8(config.minBountyUsd)}
        </Row>
        <Row label="Minimum right now">
          <span className="value">{fmtEth(config.minBounty, 6, "up")}</span>
        </Row>
        <Row label="ETH/USD feed">
          {noFeed ? <span className="text-fg-muted">None (floor can never be enabled)</span> : <Addr a={config.ethUsdPriceFeed} chainId={chainId} />}
        </Row>
        {!noFeed && (
          <>
            <Row label="Oracle">
              {config.oracleOk
                ? <span className="text-alive">OK · ${config.ethUsd?.toFixed(2) ?? "?"}</span>
                : <span className="text-warn">Unavailable (stale, invalid or reverting)</span>}
            </Row>
            <Row label="Max price age">{fmtDuration(config.maxPriceAge)}</Row>
          </>
        )}
      </dl>
      {config.oracleDown && (
        <Note tone="warn" title="Floor not enforced">
          <p className="text-sm">
            A {fmtUsd8(config.minBountyUsd)} minimum is configured, but the price feed is unusable, so minBounty() returns
            zero and any bounty is accepted. This is deliberate: a dead oracle must never block new switches.
          </p>
        </Note>
      )}
    </section>
  );
}

function SetMinBounty({ config }: { config: ContractConfig }) {
  const admin = useAdminActions();
  const tx = useTxToast();
  const [input, setInput] = useState("");
  const [confirming, setConfirming] = useState(false);

  let usd8: bigint | null = null;
  let err: string | null = null;
  if (input.trim() !== "") {
    try {
      usd8 = parseUsdInput(input);
      if (usd8 > MAX_MIN_BOUNTY_USD) err = `At most ${fmtUsd8(MAX_MIN_BOUNTY_USD)}.`;
      else if (usd8 > 0n && isZero(config.ethUsdPriceFeed)) err = "This deployment has no price feed: only $0 (disabled) is allowed.";
    } catch (e) {
      err = (e as Error).message;
    }
  }
  const ok = usd8 !== null && !err && usd8 !== config.minBountyUsd;

  return (
    <section className="card space-y-3">
      <h2 className="section-title">Minimum bounty</h2>
      <p className="text-sm text-fg-muted">
        In USD; the contract converts to wei with the Chainlink feed when a switch is created. $0 disables the floor.
        Applies to new switches only.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-muted">$</span>
        <input
          className={`input max-w-40 ${err ? "input-invalid" : ""}`}
          type="text"
          inputMode="decimal"
          placeholder={(Number(config.minBountyUsd) / 1e8).toString()}
          value={input}
          onChange={(e) => { setInput(e.target.value); setConfirming(false); }}
          aria-label="New minimum bounty in USD"
        />
        <button type="button" className="btn btn-primary" disabled={!ok || admin.pending} onClick={() => setConfirming(true)}>
          Review
        </button>
      </div>
      {err && <p className="field-error">{err}</p>}
      {!err && usd8 !== null && hasDecimalComma(input) && (
        <p className="text-xs text-fg-muted">Read as <span className="value text-fg">${Number(usd8) / 1e8}</span>.</p>
      )}
      {confirming && usd8 !== null && (
        <ActionGate what="update the minimum">
          <ConfirmPanel
            tone="warn"
            title={`Change the minimum from ${fmtUsd8(config.minBountyUsd)} to ${fmtUsd8(usd8)}?`}
            acknowledge="I understand this applies to every switch created from now on."
            confirmLabel="Update minimum"
            busy={admin.pending}
            onCancel={() => setConfirming(false)}
            onConfirm={async () => {
              const r = await tx(() => admin.setMinBountyUsd(usd8!), `Minimum bounty set to ${fmtUsd8(usd8!)}`);
              if (r) { setInput(""); setConfirming(false); }
            }}
          >
            <p>{usd8 === 0n ? "The floor will be disabled: any bounty, including zero, will be accepted." : "Owners will need at least this much (in ETH at the oracle price) to create a switch."}</p>
          </ConfirmPanel>
        </ActionGate>
      )}
      <PendingTx writes={[admin]} />
    </section>
  );
}

function TransferAdmin({ config }: { config: ContractConfig }) {
  const admin = useAdminActions();
  const tx = useTxToast();
  const { address } = useAccount();
  const [input, setInput] = useState("");
  const [confirming, setConfirming] = useState(false);
  const valid = isAddress(input.trim(), { strict: false });
  const target = valid ? getAddress(input.trim()) : null;
  const err = input.trim() && !valid ? "Not a valid address." : target && isZero(target) ? "Use “Cancel pending transfer” instead." : target && address && target.toLowerCase() === address.toLowerCase() ? "That is you." : null;

  return (
    <section className="card space-y-3">
      <h2 className="section-title">Transfer admin</h2>
      <p className="text-sm text-fg-muted">
        Two steps: you nominate an address, and it becomes admin only when it calls acceptAdmin. Until then you stay
        admin and can cancel.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          className={`input ${err ? "input-invalid" : ""}`}
          type="text"
          placeholder="0x…"
          spellCheck={false}
          value={input}
          onChange={(e) => { setInput(e.target.value); setConfirming(false); }}
          aria-label="New admin address"
        />
        <button type="button" className="btn btn-primary" disabled={!target || !!err || admin.pending} onClick={() => setConfirming(true)}>
          Review
        </button>
      </div>
      {err && <p className="field-error">{err}</p>}
      {confirming && target && !err && (
        <ActionGate what="transfer admin">
          <ConfirmPanel
            title="Nominate a new admin?"
            acknowledge="I have checked the address character by character and it can sign transactions on this network."
            phrase="TRANSFER"
            confirmLabel="Nominate"
            busy={admin.pending}
            onCancel={() => setConfirming(false)}
            onConfirm={async () => {
              const r = await tx(() => admin.transferAdmin(target), "Admin nominated: it must now call acceptAdmin");
              if (r) { setInput(""); setConfirming(false); }
            }}
          >
            <p className="break-all"><span className="value text-fg">{target}</span></p>
            <p>Once it accepts, you lose the role immediately and only the new admin can give it back.</p>
          </ConfirmPanel>
        </ActionGate>
      )}
      {!isZero(config.pendingAdmin) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
          <span className="text-fg-muted">Pending: <span className="value text-xs">{config.pendingAdmin}</span></span>
          <ActionGate what="cancel the transfer" compact>
            <button
              type="button"
              className="btn btn-sm"
              disabled={admin.pending}
              onClick={() => tx(() => admin.transferAdmin(ZERO_ADDRESS), "Pending transfer cancelled")}
            >
              Cancel pending transfer
            </button>
          </ActionGate>
        </div>
      )}
      <PendingTx writes={[admin]} />
    </section>
  );
}

function AcceptAdmin() {
  const admin = useAdminActions();
  const tx = useTxToast();
  return (
    <section className="card space-y-3">
      <h2 className="section-title">You have been nominated as admin</h2>
      <p className="text-sm text-fg-muted">Accepting makes this wallet the admin and removes the current one.</p>
      <ActionGate what="accept the admin role">
        <button
          type="button"
          className="btn btn-primary"
          disabled={admin.pending}
          onClick={() => tx(() => admin.acceptAdmin(), "You are now the admin")}
        >
          {admin.pending ? <Spinner size={14} /> : <Icon name="check" />} Accept admin role
        </button>
      </ActionGate>
      <PendingTx writes={[admin]} />
    </section>
  );
}

/**
 * What renouncing risks. The floor fails open only for an unusable feed; a
 * live feed with an absurd answer (or new decimals) makes it huge, and after
 * renouncing nobody can set it to $0 (TODO §4: keep a multisig admin).
 */
function RenounceRisk({ config }: { config: ContractConfig }) {
  return (
    <>
      <p>
        A dead, stale or reverting price feed turns the minimum off (it fails open). But a live feed that reports an
        absurd price, or changes its decimals, would make the minimum huge and block every new switch, and nobody
        could set it back to $0. Existing switches are not affected. Keeping a multisig admin is recommended instead.
      </p>
      {config.minBountyUsd > 0n && (
        <p>
          The minimum is {fmtUsd8(config.minBountyUsd)} now. At $0 the feed is never read: set it to $0 first if you
          want no minimum after renouncing.
        </p>
      )}
    </>
  );
}

function RenounceAdmin({ config }: { config: ContractConfig }) {
  const admin = useAdminActions();
  const tx = useTxToast();
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="card space-y-3">
      <h2 className="section-title text-gone">Renounce admin</h2>
      <p className="text-sm text-fg-muted">
        Removes the admin and any pending admin. The minimum bounty is then fixed forever.
      </p>
      {!confirming ? (
        <>
          <Note tone="warn" title="Not recommended">
            <div className="space-y-2 text-sm"><RenounceRisk config={config} /></div>
          </Note>
          <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>Renounce admin…</button>
        </>
      ) : (
        <ActionGate what="renounce admin">
          <ConfirmPanel
            title="Renounce the admin role permanently?"
            acknowledge="I understand nobody, including me, can ever change the minimum bounty again."
            phrase="RENOUNCE"
            confirmLabel="Renounce forever"
            busy={admin.pending}
            onCancel={() => setConfirming(false)}
            onConfirm={async () => {
              const r = await tx(() => admin.renounceAdmin(), "Admin renounced: the settings are now permanent");
              if (r) setConfirming(false);
            }}
          >
            <p>There is no undo.</p>
            <RenounceRisk config={config} />
          </ConfirmPanel>
        </ActionGate>
      )}
      <PendingTx writes={[admin]} />
    </section>
  );
}
