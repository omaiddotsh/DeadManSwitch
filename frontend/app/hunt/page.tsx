"use client";

import { useMemo, useState } from "react";
import { useChainTime, useSwitchInfos, useSwitches } from "@/lib/hooks";
import { switchStateFor, type SwitchHandle, type SwitchInfo, type SwitchState } from "@/lib/switch";
import { SwitchCard } from "@/components/switch/SwitchCard";
import { byDeadline } from "@/components/switch/order";
import { NetworkGuard } from "@/components/ui/NetworkGuard";
import { EmptyState, ErrorBox, StaleNote, UnreadRowsError } from "@/components/ui/EmptyState";
import { ScanProgress, SkeletonGrid } from "@/components/ui/Loading";
import { Note } from "@/components/ui/Note";
import { Pagination } from "@/components/ui/Pagination";

type SortKey = "expiring" | "bounty" | "newest";
type FilterKey = "claimable" | "alive" | "revealed" | "all";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "expiring", label: "Deadline" },
  { key: "bounty", label: "Biggest bounty" },
  { key: "newest", label: "Newest" },
];
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "claimable", label: "Claimable" },
  { key: "alive", label: "Still alive" },
  { key: "revealed", label: "Revealed" },
  { key: "all", label: "All" },
];
const MATCH: Record<FilterKey, (s: SwitchState) => boolean> = {
  claimable: (s) => s === "dark" || s === "darkMarked",
  alive: (s) => s === "alive",
  revealed: (s) => s === "revealed",
  all: () => true,
};

const PAGE_SIZE = 10;

export default function HuntPage() {
  return <NetworkGuard><HuntInner /></NetworkGuard>;
}

function HuntInner() {
  const { switches, loading, progress, error } = useSwitches();
  // Shares cache entries with each card's own useSwitchInfo.
  const rows = useSwitchInfos(switches);

  const [sortBy, setSortBy] = useState<SortKey>("expiring");
  const [filter, setFilter] = useState<FilterKey>("claimable");
  const [page, setPage] = useState(1);

  // The order does not depend on the clock, so it is computed only when the
  // data or the sort changes. The 1 Hz chain clock lives in HuntResults: here
  // it re-ran useSwitchInfos (one query observer per switch on the contract)
  // and this sort every second.
  const sorted = useMemo(() => {
    const list: Row[] = rows.filter((r) => r.info?.exists).map((r) => ({ handle: r.handle, info: r.info! }));
    if (sortBy === "expiring") {
      // Alive: soonest deadline first. Claimable: longest-dark first (most overdue). Under "All", revealed and
      // cancelled switches come last: their frozen deadlines mixed them in between the dark and the alive ones.
      list.sort((a, b) => byDeadline(a.info, b.info));
    } else if (sortBy === "bounty") {
      list.sort((a, b) => (a.info.bounty < b.info.bounty ? 1 : a.info.bounty > b.info.bounty ? -1 : 0));
    } else {
      list.sort((a, b) => (a.info.createdAt < b.info.createdAt ? 1 : a.info.createdAt > b.info.createdAt ? -1 : 0));
    }
    return list;
  }, [rows, sortBy]);
  const infosLoading = rows.length > 0 && rows.some((r) => r.isLoading);
  // Never read (a failed read keeps any earlier data): unknown, not "nothing to claim".
  const unread = useMemo(() => rows.filter((r) => !r.info && r.error), [rows]);
  /** The scan failed with no earlier result: nothing is known. */
  const scanFailed = !!error && rows.length === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Hunt</h1>
        <p className="page-lede">
          Every switch on the contract. When an owner misses their deadline, anyone can release the key and collect
          the bounty.
        </p>
      </header>

      <Note tone="info" title="How a release works">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li><strong className="text-fg">Mark dark</strong>: the contract checks the deadline and asks Zama&apos;s KMS to make the key decryptable.</li>
          <li><strong className="text-fg">Fetch the key</strong>: Zama&apos;s threshold KMS decrypts it and signs the result. No wallet needed.</li>
          <li><strong className="text-fg">Verify, then reveal</strong>: the key is checked against the ciphertext, then submitted with its proof. The contract pays you the whole bounty.</li>
        </ol>
        <p className="text-xs">Two transactions. The first lands the release for everyone; the second is a race, by design.</p>
      </Note>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented label="Show" options={FILTERS} value={filter} onChange={(v) => { setFilter(v); setPage(1); }} />
        <Segmented label="Sort by" options={SORTS} value={sortBy} onChange={(v) => { setSortBy(v); setPage(1); }} />
      </div>

      {scanFailed && <ErrorBox title="Could not scan for switches" message={error} />}
      {error && !scanFailed && <StaleNote>Could not refresh the switch list ({error}). Showing the last scan.</StaleNote>}
      <UnreadRowsError rows={unread} />
      {loading && !scanFailed && <ScanProgress progress={progress} />}

      <HuntResults
        sorted={sorted}
        total={rows.length}
        unread={unread.length}
        loading={loading || infosLoading}
        error={scanFailed}
        filter={filter}
        page={page}
        onPage={setPage}
      />
    </div>
  );
}

interface Row { handle: SwitchHandle; info: SwitchInfo }

/** Filters by the chain-time state, which changes as deadlines pass, and paginates. */
function HuntResults({
  sorted, total, unread, loading, error, filter, page, onPage,
}: {
  sorted: Row[];
  /** Switches discovered on the contract, whatever their state. */
  total: number;
  /** Of those, how many could not be read: nothing can be said about them. */
  unread: number;
  loading: boolean;
  error: boolean;
  filter: FilterKey;
  page: number;
  onPage: (p: number) => void;
}) {
  const { nowSec } = useChainTime();
  const visible = useMemo(
    () => (nowSec === null ? [] : sorted.filter((r) => MATCH[filter](switchStateFor(r.info, nowSec)))),
    [sorted, filter, nowSec],
  );

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const pageRows = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const stillLoading = nowSec === null || (loading && visible.length === 0);

  return (
    <>
      {stillLoading && !error && <SkeletonGrid count={4} />}

      {!stillLoading && !error && total === 0 && (
        <EmptyState icon="target" title="No switches on this contract yet" body="Nothing to hunt. Check back later." />
      )}
      {!stillLoading && total > 0 && unread === 0 && visible.length === 0 && (
        <EmptyState
          icon="target"
          title={filter === "claimable" ? "Nothing to claim right now" : "Nothing matches this filter"}
          body={filter === "claimable" ? "Every switch is either alive or already settled." : "Try another filter."}
        />
      )}

      <div className="grid-2">
        {pageRows.map(({ handle }) => (
          <SwitchCard key={`${handle.contractAddr}:${handle.owner}:${handle.id}`} handle={handle} variant="hunter" />
        ))}
      </div>

      <Pagination current={current} totalPages={totalPages} count={visible.length} onPage={onPage} />
    </>
  );
}

function Segmented<T extends string>({
  label, options, value, onChange,
}: {
  label: string;
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="text-xs uppercase tracking-wide text-fg-subtle">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.key}
            className={`btn btn-sm ${value === o.key ? "btn-selected" : "btn-ghost"}`}
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
