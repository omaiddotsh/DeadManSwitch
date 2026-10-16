"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export function CopyButton({ value, title = "Copy" }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear on unmount: the card this sits in can be removed by a list refetch
  // between the click and the reset.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is unavailable over plain HTTP and in some embedded webviews.
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded p-1 text-fg-subtle transition-colors hover:bg-raised hover:text-fg"
      aria-label={copied ? "Copied" : title}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

export function Mono({ children, copy }: { children: string; copy?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="value">{children}</span>
      {copy && <CopyButton value={children} />}
    </span>
  );
}
