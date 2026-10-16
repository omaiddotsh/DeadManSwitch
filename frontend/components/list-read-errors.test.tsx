// /hunt and /archive with the real data hooks (useSwitches, useSwitchInfos,
// useSwitchInfo) over a react-query cache: the SwitchCreated scan succeeded,
// some per-switch getSwitchInfo reads failed. Only wagmi, RainbowKit and the
// chain clock are mocked.

import { describe, expect, it, vi } from "vitest";

const C = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CONTRACT_11155111 = "0x00000000000000000000000000000000000d3ad5";
  return {
    CONTRACT: "0x00000000000000000000000000000000000d3ad5" as const,
    OWNER: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
    NOW: 1_000_000n,
  };
});

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chainId: undefined }),
  useChainId: () => 11155111,
  usePublicClient: () => ({ fake: true }),
  useWriteContract: () => ({ writeContractAsync: async () => "0x" }),
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: undefined }), ConnectButton: () => null }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ success() {}, error() {}, info() {}, push() {} }) }));
vi.mock("@/lib/hooks", async (orig) => ({
  ...(await orig<typeof import("@/lib/hooks")>()),
  useChainTime: () => ({ nowSec: C.NOW, blockTimestamp: C.NOW, isLoading: false }),
}));

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { dmsKeys } from "@/lib/hooks";
import type { SwitchListing } from "@/lib/switchScan";
import { toSwitchInfo, type RawSwitchInfo } from "@/lib/switch";
import HuntPage from "@/app/hunt/page";
import ArchivePage from "@/app/archive/page";

const CHAIN = 11155111;
const listing = (id: bigint): SwitchListing => ({
  contractAddr: C.CONTRACT, owner: C.OWNER, id, key: `0x${id.toString(16).padStart(64, "0")}`,
  pingInterval: 60n, createdAt: 1n, initialBounty: 10n ** 16n, plaintextCommitment: `0x${"11".repeat(32)}`,
  encKeyHandle: `0x${"22".repeat(32)}`, blockNumber: 10n, txHash: `0x${"33".repeat(32)}`,
});
const raw = (state: number, over: Partial<RawSwitchInfo> = {}): RawSwitchInfo => ({
  owner: C.OWNER, state, lastPing: 1000n, pingInterval: 60n, createdAt: 1000n, expiresAt: 1060n,
  darkMarkedAt: 0n, revealedAt: 0n, bounty: 10n ** 16n, ownerStake: 10n ** 16n,
  plaintextCommitment: `0x${"11".repeat(32)}`, encKeyHandle: `0x${"22".repeat(32)}`, revealedKey: `0x${"00".repeat(32)}`,
  ciphertextLength: 100n, published: false, rescuable: false, ...over,
});
/** #1 dark, #2 release requested, #3 revealed. */
const STATE: Record<string, number> = { 1: 2, 2: 3, 3: 4 };

/**
 * `failed`: ids whose getSwitchInfo read failed (retries exhausted) with
 * nothing read before. `scanError`: the last SwitchCreated refresh failed
 * after an earlier scan succeeded.
 */
const setup = async ({ failed = [] as bigint[], scanError = false } = {}) => {
  // retryOnMount: false = the page was already mounted when the read failed
  // (react-query keeps status "error" with no data until a refetch succeeds).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false, retryOnMount: false } } });
  const items = [listing(1n), listing(2n), listing(3n)];
  const scanKey = dmsKeys.switches(CHAIN, C.CONTRACT);
  qc.setQueryData(scanKey, { contract: C.CONTRACT, fromBlock: 0n, scannedTo: 100n, items });
  if (scanError) await qc.fetchQuery({ queryKey: scanKey, staleTime: 0, queryFn: () => Promise.reject(new Error("scan refresh 429")) }).catch(() => {});
  for (const it of items) {
    const queryKey = dmsKeys.info(CHAIN, it);
    if (failed.includes(it.id)) {
      await qc.prefetchQuery({ queryKey, queryFn: () => Promise.reject(new Error("HTTP request failed. Status: 429")) });
    } else {
      const state = STATE[it.id.toString()];
      qc.setQueryData(queryKey, toSwitchInfo(raw(state, state === 4 ? { revealedAt: 2000n, bounty: 0n } : {})));
    }
  }
  return qc;
};

const render = (qc: QueryClient, el: ReactElement) =>
  renderToStaticMarkup(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const cards = (html: string) => [...html.matchAll(/aria-label="Switch (\d+)"/g)].map((x) => x[1]).sort();

describe("#22 /hunt and /archive when per-switch reads fail", () => {
  it("control: every read OK lists the claimable and the released switches, no error", async () => {
    const qc = await setup();
    const hunt = render(qc, <HuntPage />);
    const archive = render(qc, <ArchivePage />);
    expect(cards(hunt)).toEqual(["1", "2"]);
    expect(cards(archive)).toEqual(["3"]);
    expect(text(hunt)).not.toMatch(/Could not/);
    expect(text(archive)).not.toMatch(/Could not/);
  });

  it("all reads failed: an error with a retry, never 'nothing to claim' or 'nothing released'", async () => {
    const qc = await setup({ failed: [1n, 2n, 3n] });
    for (const [name, page] of [["hunt", <HuntPage key="h" />], ["archive", <ArchivePage key="a" />]] as const) {
      const html = render(qc, page);
      const t = text(html);
      expect(t, name).toContain("Could not read 3 switches");
      expect(t, name).toContain("429");
      expect(html, name).toMatch(/role="alert"/);
      expect(html, name).toMatch(/<button[^>]*>.*Retry<\/button>/);
      expect(t, name).not.toContain("Nothing to claim");
      expect(t, name).not.toContain("Every switch is either alive or already settled");
      expect(t, name).not.toContain("Nothing has been released yet");
    }
  });

  it("some reads failed: the readable switches are listed, and the error says some are missing", async () => {
    const qc = await setup({ failed: [2n] });
    const hunt = render(qc, <HuntPage />);
    expect(cards(hunt)).toEqual(["1"]);
    expect(text(hunt)).toContain("Could not read 1 switch");
    // The archive's only released switch was read; one unread switch is still reported.
    const archive = render(qc, <ArchivePage />);
    expect(cards(archive)).toEqual(["3"]);
    expect(text(archive)).toContain("Could not read 1 switch");
  });

  it("a failed refresh of the switch list over a valid list is a small note, not an alert", async () => {
    const qc = await setup({ scanError: true });
    expect(qc.getQueryState(dmsKeys.switches(CHAIN, C.CONTRACT))?.status).toBe("error");
    for (const [name, page] of [["hunt", <HuntPage key="h" />], ["archive", <ArchivePage key="a" />]] as const) {
      const html = render(qc, page);
      expect(text(html), name).not.toContain("Could not scan for switches");
      expect(text(html), name).toContain("Could not refresh the switch list");
      expect(html, name).not.toMatch(/role="alert"/);
    }
    expect(cards(render(qc, <HuntPage />))).toEqual(["1", "2"]);
  });
});
