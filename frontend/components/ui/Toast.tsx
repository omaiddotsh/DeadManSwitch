"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";

type ToastKind = "info" | "success" | "error";
interface ToastItem { id: number; kind: ToastKind; message: string; href?: string }

interface Ctx {
  push: (kind: ToastKind, message: string, opts?: { href?: string; ttlMs?: number }) => void;
  success: (msg: string, opts?: { href?: string }) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

const ToastCtx = createContext<Ctx | null>(null);

export const useToast = (): Ctx => {
  const c = useContext(ToastCtx);
  if (!c) throw new Error("useToast used outside ToastProvider");
  return c;
};

const TONE: Record<ToastKind, { border: string; text: string; icon: "check" | "alert" | "info" }> = {
  success: { border: "border-alive/45", text: "text-alive", icon: "check" },
  error:   { border: "border-gone/45",  text: "text-gone",  icon: "alert" },
  info:    { border: "border-line-strong", text: "text-fg", icon: "info" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setItems(prev => prev.filter(x => x.id !== id));
  }, []);

  const push = useCallback<Ctx["push"]>((kind, message, opts) => {
    // Monotonic counter rather than Date.now() + Math.random(): two toasts
    // raised in the same tick previously risked colliding keys.
    const id = nextId.current++;
    setItems(prev => [...prev, { id, kind, message, href: opts?.href }]);
    const ttl = opts?.ttlMs ?? (kind === "error" ? 9000 : 4500);
    timers.current.set(id, setTimeout(() => dismiss(id), ttl));
  }, [dismiss]);

  // Timers outlive the component on navigation without this.
  useEffect(() => {
    const map = timers.current;
    return () => { map.forEach(clearTimeout); map.clear(); };
  }, []);

  const ctx = useMemo<Ctx>(() => ({
    push,
    success: (m, o) => push("success", m, o),
    error:   (m)    => push("error", m),
    info:    (m)    => push("info", m),
  }), [push]);

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      {/*
        Announced to assistive tech. Errors are assertive because they usually
        mean a transaction the user just authorised did not go through;
        successes are polite so they don't interrupt.

        At the bottom: at the top the stack covered the sticky header's wallet
        button (an error toast for 9 s, right where one checks the wallet).
      */}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-4 sm:w-96">
        {items.map(t => {
          const tone = TONE[t.kind];
          return (
            <div
              key={t.id}
              role={t.kind === "error" ? "alert" : "status"}
              aria-live={t.kind === "error" ? "assertive" : "polite"}
              className={`pointer-events-auto w-full animate-rise-in rounded-lg border ${tone.border} bg-overlay p-3 shadow-lift`}
            >
              <div className="flex items-start gap-2">
                <span className={`mt-0.5 ${tone.text}`}><Icon name={tone.icon} /></span>
                <p className="min-w-0 flex-1 max-w-none break-words text-sm text-fg">{t.message}</p>
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  className="rounded p-0.5 text-fg-subtle transition-colors hover:bg-raised hover:text-fg"
                  aria-label="Dismiss notification"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              {t.href && (
                <a
                  href={t.href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 inline-flex items-center gap-1 pl-6 text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  View transaction <Icon name="external" size={12} />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
