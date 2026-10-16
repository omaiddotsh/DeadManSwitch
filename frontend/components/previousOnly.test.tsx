// A chain whose current deployment was removed (the operator
// stopped creates there) but whose previous deployment still holds live
// switches: NEXT_PUBLIC_CONTRACT_11155111 unset, NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111
// set. The app must not drop the chain, or those switches would vanish and
// could not be pinged: the chain stays listed, its switches are found and
// usable, and only creates (and admin) are off.
//
// Rendered with react-dom/server and the real data hooks over a react-query
// cache, like multiDeployment.test.tsx; the card's action panels only show
// the handle they were given.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const OLD = "0x00000000000000000000000000000000000A11cE";
  delete process.env.NEXT_PUBLIC_CONTRACT_1;
  delete process.env.NEXT_PUBLIC_CONTRACT_11155111;
  process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111 = `${OLD}:8000000`;
  return {
    OLD,
    OWNER: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    NOW: 1_000_000n,
    account: { address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined },
    params: {} as Record<string, string>,
    writes: [] as { address: string; functionName: string }[],
  };
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111;
});

const fakeClient = {
  chain: { id: 11155111 },
  waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: "success", blockNumber: 100n, transactionHash: hash, logs: [] }),
  getTransactionReceipt: async () => null,
  getBlockNumber: async () => 100n,
  getCode: async () => "0x",
  simulateContract: async (req: unknown) => ({ request: req }),
};

vi.mock("wagmi", () => ({
  useAccount: () => m.account,
  useChainId: () => 11155111,
  usePublicClient: () => fakeClient,
  useWriteContract: () => ({
    writeContractAsync: async (req: { address: string; functionName: string }) => {
      m.writes.push(req);
      return `0x${"0a".repeat(32)}`;
    },
  }),
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
  useConfig: () => ({}),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: undefined }), ConnectButton: () => null }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ success() {}, error() {}, info() {}, push() {} }) }));
vi.mock("next/navigation", () => ({
  useParams: () => m.params,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => "/",
}));
vi.mock("@/lib/hooks", async (orig) => ({
  ...(await orig<typeof import("@/lib/hooks")>()),
  useChainTime: () => ({ nowSec: m.NOW, blockTimestamp: m.NOW, isLoading: false }),
}));
/** A stand-in panel that only shows the handle it was given. */
const shows = vi.hoisted(() => async (name: string) => {
  const { createElement } = await import("react");
  return { [name]: ({ handle }: { handle: { contractAddr: string; id: bigint } }) =>
    createElement("p", null, `${name} for #${handle.id} on ${handle.contractAddr}`) };
});
vi.mock("@/components/switch/OwnerActions", () => shows("OwnerActions"));
vi.mock("@/components/switch/FundAction", () => shows("FundAction"));
vi.mock("@/components/switch/RevealPanel", () => shows("RevealPanel"));
vi.mock("@/components/switch/RevealedView", () => shows("RevealedView"));

import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Hex } from "viem";
import { contractFor, defaultReadChain, deploymentOf, deploymentsFor, supportedChains } from "@/lib/contracts";
import { dmsKeys, usePing } from "@/lib/hooks";
import type { SwitchListing } from "@/lib/switchScan";
import { toSwitchInfo, type RawSwitchInfo, type SwitchHandle } from "@/lib/switch";
import HuntPage from "@/app/hunt/page";
import DashboardPage from "@/app/dashboard/page";
import AdminPage from "@/app/admin/page";
import SwitchDetailPage from "@/app/switch/[chainId]/[owner]/[id]/page";

const CHAIN = 11155111;
const handle = (id: bigint): SwitchHandle => ({ contractAddr: m.OLD as Hex, owner: m.OWNER as Hex, id });
const listing = (id: bigint): SwitchListing => ({
  ...handle(id), key: `0x${id.toString(16).padStart(64, "0")}`, pingInterval: 60n, createdAt: 1n, initialBounty: 10n ** 16n,
  plaintextCommitment: `0x${"11".repeat(32)}`, encKeyHandle: `0x${"22".repeat(32)}`, blockNumber: 8_000_100n, txHash: `0x${"33".repeat(32)}`,
});
/** state 1 alive, 2 dark. */
const raw = (state: number): RawSwitchInfo => ({
  owner: m.OWNER as Hex, state, lastPing: 1000n, pingInterval: 60n, createdAt: 1000n,
  expiresAt: state === 2 ? 1060n : m.NOW + 3_600n, darkMarkedAt: 0n, revealedAt: 0n, bounty: 10n ** 16n, ownerStake: 10n ** 16n,
  plaintextCommitment: `0x${"11".repeat(32)}`, encKeyHandle: `0x${"22".repeat(32)}`, revealedKey: `0x${"00".repeat(32)}`,
  ciphertextLength: 100n, published: false, rescuable: false,
});
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false, retryOnMount: false } } });
/** The old deployment's scan found #9, which reads `state`. */
const withSwitch = (state: number) => {
  const qc = newClient();
  qc.setQueryData(dmsKeys.switches(CHAIN, m.OLD), { contract: m.OLD, fromBlock: 8_000_000n, scannedTo: 9_000_000n, items: [listing(9n)] });
  qc.setQueryData(dmsKeys.info(CHAIN, handle(9n)), toSwitchInfo(raw(state)));
  return qc;
};
const render = (qc: QueryClient, el: ReactElement) => renderToStaticMarkup(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");

beforeEach(() => {
  m.account = { address: undefined, isConnected: false, chainId: undefined };
  m.params = {};
  m.writes = [];
});

describe("a chain with only a previous deployment", () => {
  it("stays a chain of the app, and its previous deployment a known one; it has no current deployment (no creates)", () => {
    expect(contractFor(CHAIN)).toBeUndefined();
    expect(deploymentsFor(CHAIN)).toEqual([{ address: m.OLD, fromBlock: 8_000_000n, current: false }]);
    expect(deploymentOf(CHAIN, m.OLD.toLowerCase())).toMatchObject({ address: m.OLD, current: false });
    expect(supportedChains.map((c) => c.id)).toContain(CHAIN);
    expect(defaultReadChain()).toEqual({ id: CHAIN, address: null });
  });

  it("/dashboard lists the owner's switch there with its actions, and says new switches cannot be created", () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    const t = text(render(withSwitch(1), <DashboardPage />));
    expect(t).not.toMatch(/Not deployed on/);
    expect(t).toContain(`OwnerActions for #9 on ${m.OLD}`);
    expect(t).toContain("Older deployment");
    expect(t).toMatch(/New switches cannot be created on Sepolia/);
    expect(t).not.toContain("Encrypt and create");
  });

  it("/hunt, with no wallet, offers its dark switches", () => {
    const html = render(withSwitch(2), <HuntPage />);
    expect(html).toContain(`aria-label="Switch 9"`);
  });

  it("a switch link without a contract opens the switch on that deployment", () => {
    m.params = { chainId: String(CHAIN), owner: m.OWNER, id: "9" };
    expect(text(render(withSwitch(1), <SwitchDetailPage />))).toContain(`FundAction for #9 on ${m.OLD}`);
  });

  it("a ping goes to that deployment", async () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    let ping: ReturnType<typeof usePing> | null = null;
    const Probe = () => { ping = usePing(handle(9n)); return null; };
    const Wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={newClient()}>{children}</QueryClientProvider>;
    renderToStaticMarkup(<Wrap><Probe /></Wrap>);
    await ping!.write(handle(9n));
    expect(m.writes.map((w) => [w.functionName, w.address])).toEqual([["ping", m.OLD]]);
  });

  it("/admin says there is no current deployment to administer, instead of reading settings for ever", () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    const t = text(render(newClient(), <AdminPage />));
    expect(t).not.toMatch(/Reading contract settings/);
    expect(t).toMatch(/No current deployment on Sepolia/);
  });
});
