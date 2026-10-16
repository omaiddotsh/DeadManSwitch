// A JSON-RPC node over HTTP for tests that drive real viem clients: `answer`
// returns each method's result, or throws an error carrying a JSON-RPC `code`
// (as geth answers, e.g. -32000 "insufficient funds ...") and optionally revert `data`.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export type Answer = (method: string, params: unknown[]) => unknown;

/** A JSON-RPC error as a node returns it. */
export const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

/** Start a node answering with `answer`; returns its URL. Closed after the test. */
export const fakeNode = async (answer: Answer): Promise<string> => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const one = (m: { id: number; method: string; params?: unknown[] }) => {
        try {
          return { jsonrpc: "2.0", id: m.id, result: answer(m.method, m.params ?? []) };
        } catch (err) {
          const { code, data } = err as { code?: number; data?: unknown };
          return { jsonrpc: "2.0", id: m.id, error: { code: code ?? -32601, message: (err as Error).message, ...(data !== undefined ? { data } : {}) } };
        }
      };
      const msg = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
