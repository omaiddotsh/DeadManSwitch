"use client";

import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Spinner } from "./Loading";

/**
 * Inline confirmation for irreversible actions (cancel a switch, renounce or
 * transfer admin). Replaces window.confirm, which is easy to click through
 * and impossible to style: the consequences are spelled out, the user ticks
 * an acknowledgement, and for the most destructive actions types a phrase.
 */
export function ConfirmPanel({
  title, children, acknowledge, phrase, confirmLabel, busy = false, onConfirm, onCancel, tone = "danger",
}: {
  title: string;
  children: ReactNode;
  /** Checkbox text the user must tick (one checkbox per entry, all required). */
  acknowledge: string | readonly string[];
  /** When set, the user must also type this exactly. */
  phrase?: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  tone?: "danger" | "warn";
}) {
  const id = useId();
  const acks = typeof acknowledge === "string" ? [acknowledge] : acknowledge;
  // Keyed by text: an acknowledgement added while the panel is open starts unticked.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [typed, setTyped] = useState("");
  const phraseOk = !phrase || typed.trim() === phrase;
  const ready = acks.every((a) => ticked.has(a)) && phraseOk && !busy;
  const tick = (a: string, on: boolean) => setTicked((t) => {
    const next = new Set(t);
    if (on) next.add(a); else next.delete(a);
    return next;
  });

  return (
    <div
      role="group"
      aria-labelledby={`${id}-title`}
      className={`note ${tone === "danger" ? "note-danger" : "note-warn"} space-y-3`}
    >
      <div id={`${id}-title`} className="note-title">
        <span className={tone === "danger" ? "text-gone" : "text-warn"}><Icon name="alert" /></span>
        {title}
      </div>
      <div className="space-y-2 text-sm [&_p]:max-w-none">{children}</div>

      {acks.map((a) => (
        <label key={a} className="flex items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-gone"
            checked={ticked.has(a)}
            onChange={(e) => tick(a, e.target.checked)}
            disabled={busy}
          />
          <span>{a}</span>
        </label>
      ))}

      {phrase && (
        <div className="field">
          <label className="field-hint" htmlFor={`${id}-phrase`}>
            Type <span className="value text-fg">{phrase}</span> to confirm
          </label>
          <input
            id={`${id}-phrase`}
            className="input"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={tone === "danger" ? "btn btn-danger" : "btn btn-primary"}
          disabled={!ready}
          onClick={onConfirm}
        >
          {busy ? <Spinner size={14} /> : <Icon name="check" size={14} />}
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Back
        </button>
      </div>
    </div>
  );
}
