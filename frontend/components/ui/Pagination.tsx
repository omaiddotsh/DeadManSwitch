import { Icon } from "./Icon";

/** Previous / next for a paged list of switches. Renders nothing for a single page. */
export function Pagination({
  current, totalPages, count, onPage,
}: {
  current: number;
  totalPages: number;
  /** Items across all pages. */
  count: number;
  onPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-3 pt-2" aria-label="Pagination">
      <button type="button" className="btn btn-sm" onClick={() => onPage(Math.max(1, current - 1))} disabled={current === 1}>
        <Icon name="chevronLeft" size={14} /> Previous
      </button>
      <span className="text-sm text-fg-muted">
        Page <span className="value">{current}</span> of <span className="value">{totalPages}</span>
        <span className="text-fg-subtle"> · {count} switches</span>
      </span>
      <button type="button" className="btn btn-sm" onClick={() => onPage(Math.min(totalPages, current + 1))} disabled={current === totalPages}>
        Next <Icon name="chevronRight" size={14} />
      </button>
    </nav>
  );
}
