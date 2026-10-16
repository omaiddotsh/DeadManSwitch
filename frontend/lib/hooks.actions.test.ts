// Nothing slow may stand between the owner's click on "Ping"
// (or "Cancel") and the wallet prompt. A ping near the deadline that waits on
// a hanging read RPC misses it, and on a phone the WalletConnect deep link
// should open in the same user gesture. So ping and cancel are not dry-run;
// the other writes are, capped at DRY_RUN_TIMEOUT_MS.
// The real write hooks run under react-dom/server (render once, keep what
// they return); wagmi is mocked, and the read RPC never answers.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Hex } from "viem";

const m = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CONTRACT_11155111 = "0x00000000000000000000000000000000000d3ad5";
  return {
  OWNER: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  /** When the wallet was asked, ms after the click, by function. */
  asked: [] as [string, number][],
  t0: 0,
  simulated: [] as string[],
  };
});
afterAll(() => { delete process.env.NEXT_PUBLIC_CONTRACT_11155111; });

/** A read RPC that accepts every request and answers none. */
const hanging = () => new Promise<never>(() => {});
const deadClient = {
  chain: { id: 11155111 },
  simulateContract: (req: { functionName: string }) => { m.simulated.push(req.functionName); return hanging(); },
  getBlockNumber: hanging,
  getTransactionCount: hanging,
  readContract: hanging,
  getCode: hanging,
  waitForTransactionReceipt: hanging,
  getTransactionReceipt: hanging,
  getTransaction: hanging,
};

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: m.OWNER, isConnected: true, chainId: 11155111 }),
  useChainId: () => 11155111,
  usePublicClient: () => deadClient,
  useWriteContract: () => ({
    writeContractAsync: async (req: { functionName: string }) => {
      m.asked.push([req.functionName, Date.now() - m.t0]);
      return `0x${"11".repeat(32)}` as Hex;
    },
  }),
}));

const { DRY_RUN_TIMEOUT_MS, useCancelSwitch, useFundBounty, useMarkDark, usePing } = await import("./hooks");
const { contractFor } = await import("./contracts");

type Hooks = {
  ping: ReturnType<typeof usePing>; cancel: ReturnType<typeof useCancelSwitch>;
  fund: ReturnType<typeof useFundBounty>; mark: ReturnType<typeof useMarkDark>;
};
const hooks = (): Hooks => {
  let out: Hooks | null = null;
  const Probe = () => {
    out = { ping: usePing(), cancel: useCancelSwitch(), fund: useFundBounty(), mark: useMarkDark() };
    return null;
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Probe)));
  return out!;
};

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
  m.asked = [];
  m.simulated = [];
  m.t0 = Date.now();
});
afterEach(() => { vi.useRealTimers(); });

describe("the wallet prompt is not held back by a dead read RPC", () => {
  it("ping and cancel go to the wallet at once, with no dry run in front", async () => {
    const contract = contractFor(11155111)!;
    const h = { contractAddr: contract, owner: m.OWNER as Hex, id: 11n };
    const w = hooks();
    void w.ping.write(h).catch(() => {});
    void w.cancel.write(h).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(m.asked).toEqual([["ping", 0], ["cancel", 0]]);
    expect(m.simulated).toEqual([]);
  });

  it(`a top-up or markDark is dry-run, and asks the wallet within ${DRY_RUN_TIMEOUT_MS} ms (plus the top-up's own capped reads) whatever the RPC does`, async () => {
    const contract = contractFor(11155111)!;
    const h = { contractAddr: contract, owner: m.OWNER as Hex, id: 11n };
    const w = hooks();
    void w.mark.write(h).catch(() => {});
    void w.fund.write(h, 10n ** 15n).catch(() => {});
    await vi.advanceTimersByTimeAsync(2 * DRY_RUN_TIMEOUT_MS);
    expect(m.simulated.sort()).toEqual(["fundBounty", "markDark"]);
    const at = new Map(m.asked);
    expect(at.get("markDark")).toBeLessThanOrEqual(DRY_RUN_TIMEOUT_MS);
    expect(at.get("fundBounty")).toBeLessThanOrEqual(2 * DRY_RUN_TIMEOUT_MS);
  });
});
