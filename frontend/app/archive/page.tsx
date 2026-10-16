"use client";

import { useMemo, useState } from "react";
import { useSwitchInfos, useSwitches } from "@/lib/hooks";
import { SwitchCard } from "@/components/switch/SwitchCard";
import { NetworkGuard } from "@/components/ui/NetworkGuard";
import { EmptyState, ErrorBox, StaleNote, UnreadRowsError } from "@/components/ui/EmptyState";
import { ScanProgress, SkeletonGrid } from "@/components/ui/Loading";
import { Pagination } from "@/components/ui/Pagination";

/**
 * Every card on a page reads the ciphertext, decrypts it and, if it was
 * published, scans for the PlaintextPublished event. Paged like /hunt so a
 * long archive does not issue all of that at once.
 */
const PAGE_SIZE = 10;

export default function ArchivePage() {
  return <NetworkGuard><ArchiveInner /></NetworkGuard>;
}

function ArchiveInner() {
  const { switches, loading, progress, error } = useSwitches();
  const rows = useSwitchInfos(switches);

  const released = useMemo(
    () => rows
      .filter((r) => r.info?.exists && r.info.state === "revealed")
      // Most recently revealed first.
      .sort((a, b) => (a.info!.revealedAt < b.info!.revealedAt ? 1 : a.info!.revealedAt > b.info!.revealedAt ? -1 : 0)),
    [rows],
  );

  // Never read (a failed read keeps any earlier data): unknown, not "not released".
  const unread = useMemo(() => rows.filter((r) => !r.info && r.error), [rows]);

  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(released.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const pageRows = released.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const stillLoading = loading || (rows.length > 0 && rows.some((r) => r.isLoading) && released.length === 0);
  /** The scan failed with no earlier result: nothing is known. */
  const scanFailed = !!error && rows.length === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Archive</h1>
        <p className="page-lede">
          Secrets whose owners went dark and whose keys were released. Each one is decrypted in your browser from
          chain state alone: the stored ciphertext and the revealed key. No wallet needed.
        </p>
      </header>

      {scanFailed && <ErrorBox title="Could not scan for switches" message={error} />}
      {error && !scanFailed && <StaleNote>Could not refresh the switch list ({error}). Showing the last scan.</StaleNote>}
      <UnreadRowsError rows={unread} />
      {loading && !scanFailed && <ScanProgress progress={progress} />}
      {/* Secrets the scan already found are listed as they arrive; skeletons only while there are none. */}
      {stillLoading && !scanFailed && released.length === 0 && <SkeletonGrid count={4} />}

      {!stillLoading && !scanFailed && unread.length === 0 && released.length === 0 && (
        <EmptyState
          icon="archive"
          title="Nothing has been released yet"
          body="Every switch on this contract is still alive, waiting for someone to release it, or cancelled."
        />
      )}

      <div className="grid-2">
        {pageRows.map(({ handle }) => (
          <SwitchCard key={`${handle.contractAddr}:${handle.owner}:${handle.id}`} handle={handle} variant="archive" />
        ))}
      </div>

      <Pagination current={current} totalPages={totalPages} count={released.length} onPage={setPage} />
    </div>
  );
}
