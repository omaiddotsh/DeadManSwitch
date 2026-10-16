"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

/**
 * Route-level error boundary: a throw inside any client component (a
 * malformed RPC response, an FHE library failure) shows this instead of
 * replacing the whole app with Next's default screen.
 */
export default function RouteError({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="card mx-auto max-w-lg space-y-4 text-center">
      <div className="flex justify-center text-gone"><Icon name="alert" size={32} /></div>
      <h1 className="text-lg font-semibold">This page hit an error</h1>
      <p className="mx-auto text-sm text-fg-muted">
        Nothing on-chain was affected: no transaction is sent without your signature.
      </p>
      <pre className="max-h-40 overflow-auto rounded border border-line bg-canvas p-3 text-left text-xs text-fg-muted whitespace-pre-wrap break-words">
        {error.message}
      </pre>
      <div className="flex justify-center gap-2">
        <button className="btn btn-primary" onClick={reset}>Try again</button>
        <Link className="btn" href="/">Go home</Link>
      </div>
    </div>
  );
}
