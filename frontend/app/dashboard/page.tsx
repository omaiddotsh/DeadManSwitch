"use client";

import { useMemo } from "react";
import { useAccount } from "wagmi";
import { chainLabel } from "@/lib/contracts";
import { useOwnerSwitches, useSwitchInfos } from "@/lib/hooks";
import { SwitchCard } from "@/components/switch/SwitchCard";
import { ownerOrder } from "@/components/switch/order";
import { CreateSwitchForm } from "@/components/CreateSwitchForm";
import { NetworkGuard } from "@/components/ui/NetworkGuard";
import { EmptyState, ErrorBox } from "@/components/ui/EmptyState";
import { ScanProgress, SkeletonGrid } from "@/components/ui/Loading";

export default function DashboardPage() {
  return (
    <NetworkGuard requireWallet walletReason="Create switches and ping the ones you own. Your wallet's address is the owner.">
      <DashboardInner />
    </NetworkGuard>
  );
}

function DashboardInner() {
  const { address } = useAccount();
  const { switches, loading, progress, error, contractAddress, chainId } = useOwnerSwitches(address ?? null);
  // The same reads as each card's (shared cache entries): ordered so that the next ping due is on top.
  const rows = useSwitchInfos(switches);
  const ordered = useMemo(() => ownerOrder(rows), [rows]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="page-title">My switches</h1>
        <p className="page-lede">Ping each one before its deadline.</p>
        <p className="mt-1 max-w-none text-xs text-fg-subtle">
          {chainLabel(chainId)} · {contractAddress
            ? <>contract <span className="value break-words">{contractAddress}</span></>
            : "no current deployment (older ones only)"}
        </p>
      </header>

      <CreateSwitchForm />

      <section className="space-y-4" aria-labelledby="mine">
        {/* The space keeps the count a separate word in the heading's accessible name ("Your switches 3"). */}
        <h2 id="mine" className="section-title">
          Your switches{" "}
          {switches.length > 0 && (
            <span className="value ml-1 inline-block rounded-full bg-raised px-2 py-0.5 align-middle text-xs font-medium text-fg-muted">
              {switches.length}
            </span>
          )}
        </h2>

        {error && <ErrorBox title="Could not scan for your switches" message={error} />}
        {loading && <ScanProgress progress={progress} />}
        {/* Switches the scan already found are listed as they arrive; skeletons only while there are none. */}
        {loading && switches.length === 0 && <SkeletonGrid count={2} />}
        {!loading && !error && switches.length === 0 && (
          <EmptyState
            icon="shield"
            title="No switches yet"
            body="Create one above. Nothing is stored anywhere until you confirm the transaction."
          />
        )}

        <div className="grid-2">
          {ordered.map(({ handle }) => (
            <SwitchCard key={`${handle.contractAddr}:${handle.owner}:${handle.id}`} handle={handle} variant="owner" />
          ))}
        </div>
      </section>
    </div>
  );
}
