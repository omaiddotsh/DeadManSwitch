// Per-test browser diagnostics: console errors and warnings, failed requests,
// HTTP errors and uncaught page errors, from every page of the test's context.
// The fixture attaches them to the test (diagnostics.json) and fails the test
// on an uncaught page error.

import type { BrowserContext, ConsoleMessage, Request, Response } from "@playwright/test";

export interface ConsoleEntry {
  type: string;
  text: string;
  url: string;
  location?: string;
  /** Logged about a non-local resource (WalletConnect, RainbowKit telemetry): noise from the external block. */
  external: boolean;
}

export interface PageErrorEntry {
  message: string;
  stack?: string;
  url: string;
}

export interface FailedRequestEntry {
  method: string;
  url: string;
  resourceType: string;
  failure: string;
  /** net::ERR_ABORTED: cancelled by a navigation or reload (Next.js prefetches), not a failure of the server. */
  aborted: boolean;
}

export interface HttpErrorEntry {
  method: string;
  url: string;
  status: number;
}

/** One JSON-RPC call the page made to Anvil (app reads and the test wallet's forwarding). */
export interface RpcEntry {
  at: string;
  method: string;
  params: string;
  result: string;
}

export interface Diagnostics {
  console: ConsoleEntry[];
  pageErrors: PageErrorEntry[];
  failedRequests: FailedRequestEntry[];
  httpErrors: HttpErrorEntry[];
  /** Requests to non-local hosts, which do not resolve in the test browser (not counted as failures). */
  blockedExternal: string[];
  /** JSON-RPC traffic to Anvil, for failure analysis (attached when a test fails, or always with E2E_LOG_RPC=1). */
  rpc: RpcEntry[];
}

export const emptyDiagnostics = (): Diagnostics => ({
  console: [],
  pageErrors: [],
  failedRequests: [],
  httpErrors: [],
  blockedExternal: [],
  rpc: [],
});

/** Hosts the page may reach: the app and Anvil. Nothing else resolves unless E2E_ALLOW_EXTERNAL=1 (playwright.config.ts). */
export const isLocalUrl = (url: string): boolean => {
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return true;
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
};

const short = (url: string) => (url.length > 300 ? `${url.slice(0, 300)}…` : url);

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Record the JSON-RPC calls of one finished request to `rpcUrl` (batches are split). */
const recordRpc = async (req: Request, diag: Diagnostics) => {
  let body: unknown;
  try {
    body = req.postDataJSON();
  } catch {
    return;
  }
  const calls = (Array.isArray(body) ? body : [body]) as { id?: unknown; method?: string; params?: unknown }[];
  let results: { id?: unknown; result?: unknown; error?: unknown }[] = [];
  try {
    const res = await req.response();
    const json = (await res?.json()) as unknown;
    results = (Array.isArray(json) ? json : [json]) as typeof results;
  } catch {
    /* no body (aborted, page closed) */
  }
  const at = new Date().toISOString().slice(11, 23);
  for (const c of calls) {
    if (typeof c?.method !== "string") continue;
    const r = results.find((x) => x?.id === c.id);
    const out = r ? (r.error !== undefined ? `ERROR ${JSON.stringify(r.error)}` : JSON.stringify(r.result)) : "(no response)";
    diag.rpc.push({ at, method: c.method, params: clip(JSON.stringify(c.params ?? [])), result: clip(out ?? "undefined") });
    if (diag.rpc.length > 5000) diag.rpc.shift();
  }
};

export const watchContext = async (
  context: BrowserContext,
  diag: Diagnostics,
  opts: { rpcUrl: string },
): Promise<void> => {
  const rpcOrigin = new URL(opts.rpcUrl).origin;
  const isRpc = (url: string) => {
    try {
      return new URL(url).origin === rpcOrigin;
    } catch {
      return false;
    }
  };
  context.on("requestfinished", (req: Request) => {
    if (req.method() === "POST" && isRpc(req.url())) void recordRpc(req, diag);
  });
  context.on("console", (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    const loc = msg.location();
    diag.console.push({
      type,
      text: msg.text().slice(0, 4000),
      url: short(msg.page()?.url() ?? ""),
      location: loc.url ? `${short(loc.url)}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
      external: !!loc.url && !isLocalUrl(loc.url),
    });
  });

  context.on("weberror", (err) => {
    const e = err.error();
    diag.pageErrors.push({ message: e.message, stack: e.stack, url: short(err.page()?.url() ?? "") });
  });

  context.on("requestfailed", (req: Request) => {
    const failure = req.failure()?.errorText ?? "unknown";
    // Other hosts do not resolve in the test browser (playwright.config.ts EXTERNAL_BLOCK).
    if (!isLocalUrl(req.url())) {
      diag.blockedExternal.push(`${short(req.url())} (${failure})`);
      return;
    }
    diag.failedRequests.push({
      method: req.method(), url: short(req.url()), resourceType: req.resourceType(), failure,
      aborted: failure.includes("ERR_ABORTED"),
    });
  });

  context.on("response", (res: Response) => {
    if (res.status() < 400) return;
    diag.httpErrors.push({ method: res.request().method(), url: short(res.url()), status: res.status() });
  });
};

/** One-line counts, for the test's stdout. Noise from blocked external hosts and aborted prefetches is counted apart. */
export const summarize = (d: Diagnostics): string => {
  const own = d.console.filter((c) => !c.external);
  const errors = own.filter((c) => c.type === "error").length;
  const warnings = own.length - errors;
  const failed = d.failedRequests.filter((f) => !f.aborted).length;
  return (
    `console errors ${errors}, warnings ${warnings}, page errors ${d.pageErrors.length}, ` +
    `failed requests ${failed} (+${d.failedRequests.length - failed} aborted), HTTP errors ${d.httpErrors.length}, ` +
    `blocked external ${d.blockedExternal.length} (+${d.console.length - own.length} console lines about them)`
  );
};
