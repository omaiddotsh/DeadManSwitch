"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toDisplayText } from "@/lib/envelope";
import { CopyButton } from "@/components/ui/Copy";
import { Icon } from "@/components/ui/Icon";

// Measured before paint in the browser; useEffect on the server (no layout there, and no warning).
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Lines the box shows before it is clipped: max-h-48 / max-h-[32rem] of text-sm (20 px lines) with p-3. */
const VISIBLE_LINES = { compact: 8, full: 24 } as const;
/** Characters per line assumed before the box is measured: a phone's width in monospace. */
const ASSUMED_LINE_CHARS = 40;

/**
 * Whether `text` likely overflows the box, before it can be measured (first
 * render, and the static render in tests). The measurement replaces it.
 */
export const likelyOverflows = (text: string, compact: boolean): boolean => {
  let lines = 0;
  for (const l of text.split("\n")) lines += Math.max(1, Math.ceil(l.length / ASSUMED_LINE_CHARS));
  return lines > VISIBLE_LINES[compact ? "compact" : "full"];
};

/**
 * Renders revealed plaintext, which is attacker-controlled bytes.
 *
 * Text only: the decoded string is a single React text child of a <pre>, so
 * markup in it is never parsed, URLs are never linkified, and nothing in it is
 * fetched. Control and bidi-override characters are neutralised, and
 * invisible ones shown as \u{…} escapes, by toDisplayText (and flagged).
 * The download button saves the exact bytes as application/octet-stream,
 * behind an explicit click.
 */
export function PlaintextView({
  plaintext, filenameBase, compact = false, source,
}: {
  plaintext: Uint8Array;
  /** Download name without extension: .txt for valid UTF-8, .bin otherwise. */
  filenameBase: string;
  compact?: boolean;
  /** Where these bytes came from, e.g. "decrypted from chain state". */
  source?: string;
}) {
  const display = useMemo(() => toDisplayText(plaintext), [plaintext]);
  const [mono, setMono] = useState(true);
  // A long secret is clipped with a fade and a "Show all" toggle: an inner scrollbar alone is hidden on
  // touch screens, and the cut can fall where the text looks complete.
  const preRef = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(() => likelyOverflows(display.text, compact));
  useIsoLayoutEffect(() => {
    const el = preRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [display.text, mono, expanded]);
  const clipped = overflows && !expanded;

  const download = () => {
    const blob = new Blob([new Uint8Array(plaintext)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filenameBase}.${display.validUtf8 ? "txt" : "bin"}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-fg-subtle">
          <span className="value">{plaintext.length.toLocaleString()}</span> bytes
          {source && <> · {source}</>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`btn btn-sm ${mono ? "btn-selected" : "btn-ghost"}`}
            aria-pressed={mono}
            onClick={() => setMono((m) => !m)}
            title="Toggle monospace"
          >
            <Icon name="text" size={12} /> Monospace
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={download} title="Download the exact bytes">
            <Icon name="download" size={12} /> Download
          </button>
          <CopyButton value={display.text} title="Copy text" />
        </div>
      </div>

      <div className="relative">
        <pre
          ref={preRef}
          className={
            `${expanded ? "" : compact ? "max-h-48" : "max-h-[32rem]"} ${clipped ? "overflow-hidden" : "overflow-auto"} ` +
            `whitespace-pre-wrap break-words rounded border border-info/30 bg-canvas p-3 text-sm text-fg ` +
            `${mono ? "font-mono" : "font-sans"}`
          }
          // Not a live region: untrusted text must not be announced on its own.
          translate="no"
        >
          {display.text}
        </pre>
        {clipped && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-px bottom-px h-16 rounded-b bg-gradient-to-t from-canvas to-transparent"
          />
        )}
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          <Icon name="chevronRight" size={12} className={`transition-transform ${expanded ? "-rotate-90" : "rotate-90"}`} />
          {expanded ? "Show less" : "Show all"}
        </button>
      )}

      <p className="flex items-start gap-1.5 text-xs text-fg-subtle">
        <span className="mt-px"><Icon name="info" size={12} /></span>
        <span className="max-w-none">
          Written by the switch owner and shown as plain text: links are not clickable and nothing in it is loaded.
          Treat instructions inside it with suspicion.
        </span>
      </p>
      {(!display.validUtf8 || display.hadControlChars || display.hadBidiControls || display.hadInvisibleChars ||
        display.hadVariationSequences) && (
        <ul className="space-y-0.5 text-xs text-warn">
          {!display.validUtf8 && <li>Not valid UTF-8: undecodable bytes are shown as �. Download for the exact bytes.</li>}
          {display.hadControlChars && <li>Control characters were replaced with �.</li>}
          {display.hadBidiControls && (
            <li>Bidirectional-override characters were removed: they can make text display in a misleading order.</li>
          )}
          {display.hadInvisibleChars && (
            <li>Invisible or format characters were made visible as {"\\u{…}"}: they can hide text.</li>
          )}
          {display.hadVariationSequences && (
            <li>
              Ideographic or Mongolian variation selectors are shown as written. They are invisible and can carry
              hidden data, one byte per character.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
