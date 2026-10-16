// Same-origin proxy to Zama's relayer: /api/relayer/<chainId>/<relayer path>.
// The browser SDK (lib/fhevm.ts) uses `${origin}/api/relayer/<chainId>` as its
// relayerUrl, so the relayer API key stays on the server. All policy lives in
// ../../proxy.ts (unit-tested in proxy.test.ts).

import { handleRelayerRequest } from "../../proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Next 15+ passes the dynamic segments as a Promise (Next 16 removed sync access).
type Ctx = { params: Promise<{ chainId: string; path: string[] }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  return handleRelayerRequest(req, await ctx.params);
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  return handleRelayerRequest(req, await ctx.params);
}
