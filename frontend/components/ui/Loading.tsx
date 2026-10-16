export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span
      className="inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent align-middle"
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function SkeletonCard() {
  return (
    <div className="card animate-pulse space-y-3" aria-hidden>
      <div className="flex items-center gap-2">
        <div className="h-5 w-16 rounded-full bg-raised" />
        <div className="h-4 w-24 rounded bg-raised" />
      </div>
      <div className="h-3 w-40 rounded bg-raised" />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-3 rounded bg-raised" />
        <div className="h-3 rounded bg-raised" />
      </div>
    </div>
  );
}

export function SkeletonGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid-2" role="status" aria-label="Loading switches">
      {Array.from({ length: count }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}

/**
 * The first scan of a list (minutes on a public RPC): how far it got. Switches
 * it already found are listed below it, not hidden behind it.
 */
export function ScanProgress({ progress }: { progress: { done: bigint; total: bigint } | null }) {
  const pct = progress && progress.total > 0n ? Number((progress.done * 100n) / progress.total) : null;
  return (
    <p className="flex max-w-none items-center gap-2 text-xs text-fg-muted" role="status">
      <Spinner size={12} />
      <span>
        Scanning the chain…{pct !== null && <> <span className="value">{pct}%</span></>}
      </span>
    </p>
  );
}
