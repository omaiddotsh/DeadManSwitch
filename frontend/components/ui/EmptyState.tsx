import type { ReactNode } from "react";
import { Icon, IconBadge, type IconName } from "./Icon";

interface Props {
  title: string;
  body?: string;
  icon?: IconName;
  cta?: ReactNode;
}

export function EmptyState({ title, body, icon = "archive", cta }: Props) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
      <IconBadge name={icon} tone="neutral" size={48} />
      <h3 className="text-base font-semibold">{title}</h3>
      {body && <p className="text-sm text-fg-muted">{body}</p>}
      {cta && <div className="flex flex-wrap justify-center gap-2 pt-1">{cta}</div>}
    </div>
  );
}

export function ErrorBox({ title = "Something went wrong", message, children }: {
  title?: string;
  message: string;
  /** Explanation or a retry, below the raw error. */
  children?: ReactNode;
}) {
  return (
    <div className="note note-danger" role="alert">
      <div className="note-title">
        <Icon name="alert" /> {title}
      </div>
      {/* Chain errors are long and lack break opportunities; wrap rather than
          let them push the layout sideways. */}
      <p className="max-w-none whitespace-pre-wrap break-words font-mono text-xs text-fg-muted">
        {message}
      </p>
      {children && <div className="mt-2 space-y-2 text-sm [&_p]:max-w-none">{children}</div>}
    </div>
  );
}

/** A list read that failed while an earlier result is still on screen: a note, not an alert. */
export function StaleNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex max-w-none items-start gap-1.5 text-xs text-warn" role="status">
      <span className="mt-px"><Icon name="alert" size={12} /></span>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/**
 * Some rows of a list could not be read (and had never been read): say how
 * many, and offer a retry, so the list's empty state is not taken as a fact.
 */
export function UnreadRowsError({ rows }: { rows: { error: string | null; refetch?: () => unknown }[] }) {
  const n = rows.length;
  if (n === 0) return null;
  return (
    <ErrorBox title={`Could not read ${n} ${n === 1 ? "switch" : "switches"}`} message={rows[0].error ?? ""}>
      <p className="text-fg-muted">
        {n === 1 ? "It is" : "They are"} left out of this list until a read succeeds. The page retries every 15 s.
      </p>
      <button type="button" className="btn btn-sm" onClick={() => { for (const r of rows) void r.refetch?.(); }}>
        <Icon name="refresh" size={12} /> Retry
      </button>
    </ErrorBox>
  );
}
