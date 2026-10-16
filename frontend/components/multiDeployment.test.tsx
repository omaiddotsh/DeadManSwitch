// G14 / G15: a redeploy on the same chain. Sepolia's current DeadManSwitch is
// CUR; OLD is the previous deployment (NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111)
// and still holds live switches. Before the fix every path read and wrote CUR
// only: OLD's switches vanished from the dashboard and /hunt, their links said
// "No switch" or showed CUR's switch with the same (owner, id), and a ping sent
// from a page about OLD's switch landed on CUR. So OLD's switches went dark
// while their owners were trying to ping them.
//
// The pages and cards render with react-dom/server and the real data hooks
// over a react-query cache; wagmi, RainbowKit, next/navigation and the chain
// clock are mocked, and so are the card's action panels (their tests are
// elsewhere), which here only show the handle they were given.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const CUR = "0x00000000000000000000000000000000000C0FFe";
  const OLD = "0x00000000000000000000000000000000000A11cE";
  process.env.NEXT_PUBLIC_CONTRACT_11155111 = CUR;
  process.env.NEXT_PUBLIC_FROM_BLOCK_11155111 = "9000000";
  process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111 = `${OLD}:8000000`;
  return {
    CUR, OLD,
    OWNER: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    NOW: 1_000_000n,
    account: { address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined },
    params: {} as Record<string, string>,
    search: "",
    writes: [] as { address: string; functionName: string; args: readonly unknown[]; chainId?: number }[],
    /** Receipt waits held until released, by hash (null until the wait has started). */
    held: new Map<string, (() => void) | null>(),
    holdNext: false,
    nonce: 0,
    simulated: [] as [string, string][],
    estimated: [] as [string, string][],
  };
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_CONTRACT_11155111;
  delete process.env.NEXT_PUBLIC_FROM_BLOCK_11155111;
  delete process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111;
});

const fakeClient = {
  chain: { id: 11155111 },
  waitForTransactionReceipt: ({ hash }: { hash: string }) => new Promise((resolve) => {
    const receipt = { status: "success", blockNumber: 100n, transactionHash: hash, logs: [] };
    if (m.held.has(hash)) m.held.set(hash, () => resolve(receipt));
    else resolve(receipt);
  }),
  getTransactionReceipt: async () => null,
  getBlockNumber: async () => 100n,
  getCode: async () => "0x",
  estimateContractGas: async (req: { address: string; functionName: string }) => {
    m.estimated.push([req.functionName, req.address]);
    return 100_000n;
  },
  /** The dry run before the wallet (sendIfSimulated): records where it was aimed. */
  simulateContract: async (req: { address: string; functionName: string }) => {
    m.simulated.push([req.functionName, req.address]);
    return { request: req };
  },
};

vi.mock("wagmi", () => ({
  useAccount: () => m.account,
  useChainId: () => 11155111,
  usePublicClient: () => fakeClient,
  useWriteContract: () => ({
    writeContractAsync: async (req: { address: string; functionName: string; args: readonly unknown[]; chainId?: number }) => {
      m.writes.push(req);
      const hash = `0x${(++m.nonce).toString(16).padStart(64, "0")}`;
      if (m.holdNext) { m.held.set(hash, null); m.holdNext = false; }
      return hash;
    },
  }),
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
  useConfig: () => ({}),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: undefined }), ConnectButton: () => null }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ success() {}, error() {}, info() {}, push() {} }) }));
vi.mock("next/navigation", () => ({
  useParams: () => m.params,
  useSearchParams: () => new URLSearchParams(m.search),
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
vi.mock("@/components/CreateSwitchForm", async (orig) => ({
  ...(await orig<typeof import("@/components/CreateSwitchForm")>()),
  CreateSwitchForm: () => null,
}));

import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getAddress, type Hex } from "viem";
import {
  dmsKeys, useCancelSwitch, useFundBounty, useMarkDark, usePing, usePublishPlaintext, useReclaimContribution,
  useRescueOwnerStake, useRevealKey,
} from "@/lib/hooks";
import type { SwitchListing } from "@/lib/switchScan";
import { toSwitchInfo, type RawSwitchInfo, type SwitchHandle } from "@/lib/switch";
import HuntPage from "@/app/hunt/page";
import DashboardPage from "@/app/dashboard/page";
import SwitchDetailPage from "@/app/switch/[chainId]/[owner]/[id]/page";
import { CreatedCard } from "@/components/CreateSwitchForm";
import { useCallGas } from "@/components/gas";

const CHAIN = 11155111;
const UNKNOWN = "0x000000000000000000000000000000000000dEaD";
const handle = (contractAddr: string, id: bigint): SwitchHandle => ({ contractAddr: contractAddr as Hex, owner: m.OWNER as Hex, id });
const listing = (contractAddr: string, id: bigint, blockNumber: bigint): SwitchListing => ({
  ...handle(contractAddr, id), key: `0x${id.toString(16).padStart(64, "0")}`,
  pingInterval: 60n, createdAt: 1n, initialBounty: 10n ** 16n, plaintextCommitment: `0x${"11".repeat(32)}`,
  encKeyHandle: `0x${"22".repeat(32)}`, blockNumber, txHash: `0x${"33".repeat(32)}`,
});
/** state 1 alive, 2 dark; 0 = no such switch. */
const raw = (state: number): RawSwitchInfo => ({
  owner: state === 0 ? "0x0000000000000000000000000000000000000000" : m.OWNER as Hex, state,
  lastPing: 1000n, pingInterval: 60n, createdAt: 1000n, expiresAt: state === 2 ? 1060n : m.NOW + 3_600n,
  darkMarkedAt: 0n, revealedAt: 0n, bounty: 10n ** 16n, ownerStake: 10n ** 16n,
  plaintextCommitment: `0x${"11".repeat(32)}`, encKeyHandle: `0x${"22".repeat(32)}`, revealedKey: `0x${"00".repeat(32)}`,
  ciphertextLength: 100n, published: false, rescuable: false,
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: 0, refetchOnWindowFocus: false, retryOnMount: false } } });
const setInfo = (qc: QueryClient, contract: string, id: bigint, state: number) =>
  qc.setQueryData(dmsKeys.info(CHAIN, handle(contract, id)), toSwitchInfo(raw(state)));
const render = (qc: QueryClient, el: ReactElement) => renderToStaticMarkup(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const hrefs = (html: string) => [...html.matchAll(/href="(\/switch\/[^"]+)"/g)].map((x) => x[1]!.replace(/&amp;/g, "&"));
const link = (contract: string, id: bigint) => `/switch/${CHAIN}/${m.OWNER}/${id}?contract=${getAddress(contract)}`;
/** The cards, each as "<id>@<contract of its link or panel>". */
const cards = (html: string) => [...html.matchAll(/<article[^>]*aria-label="Switch (\d+)"[\s\S]*?<\/article>/g)]
  .map((x) => `${x[1]}@${/(?:contract=|on )(0x[0-9a-fA-F]{40})/.exec(x[0])?.[1]?.toLowerCase() ?? "?"}`).sort();

beforeEach(() => {
  m.account = { address: undefined, isConnected: false, chainId: undefined };
  m.params = {};
  m.search = "";
  m.writes = [];
  m.held.clear();
  m.holdNext = false;
  m.simulated = [];
  m.estimated = [];
});

describe("G14: the lists cover previous deployments", () => {
  /** CUR holds #1 and #5; OLD holds #1 (same owner and id as CUR's) and #9. */
  const scans = (qc: QueryClient, state: number) => {
    qc.setQueryData(dmsKeys.switches(CHAIN, m.CUR), {
      contract: m.CUR, fromBlock: 9_000_000n, scannedTo: 9_100_000n, items: [listing(m.CUR, 5n, 9_000_200n), listing(m.CUR, 1n, 9_000_100n)],
    });
    qc.setQueryData(dmsKeys.switches(CHAIN, m.OLD), {
      contract: m.OLD, fromBlock: 8_000_000n, scannedTo: 9_100_000n, items: [listing(m.OLD, 9n, 8_000_200n), listing(m.OLD, 1n, 8_000_100n)],
    });
    for (const [c, id] of [[m.CUR, 1n], [m.CUR, 5n], [m.OLD, 1n], [m.OLD, 9n]] as const) setInfo(qc, c, id, state);
  };

  it("/dashboard lists the owner's switches on both deployments, the old ones marked, with their actions on their own contract", () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    const qc = newClient();
    scans(qc, 1);
    const html = render(qc, <DashboardPage />);
    const cur = m.CUR.toLowerCase();
    const old = m.OLD.toLowerCase();
    expect(cards(html)).toEqual([`1@${cur}`, `1@${old}`, `5@${cur}`, `9@${old}`].sort());
    expect(text(html)).toContain(`OwnerActions for #9 on ${m.OLD}`);
    expect(text(html)).toContain(`OwnerActions for #1 on ${m.OLD}`);
    expect(text(html)).toContain(`OwnerActions for #1 on ${m.CUR}`);
    // The old deployment's cards say so; the current one's do not.
    const old9 = /<article[^>]*aria-label="Switch 9"[\s\S]*?<\/article>/.exec(html)![0];
    const cur5 = /<article[^>]*aria-label="Switch 5"[\s\S]*?<\/article>/.exec(html)![0];
    expect(text(old9)).toMatch(/Older deployment/);
    expect(text(cur5)).not.toMatch(/Older deployment/);
    expect(text(html)).not.toContain("No switches yet");
  });

  it("/hunt offers the old deployment's dark switches too, each linked with its own contract", () => {
    const qc = newClient();
    scans(qc, 2);
    const html = render(qc, <HuntPage />);
    // Each dark switch's card links its page twice ("Start release", "Switch page").
    expect(hrefs(html).sort()).toEqual(
      [link(m.CUR, 1n), link(m.CUR, 5n), link(m.OLD, 1n), link(m.OLD, 9n)].flatMap((l) => [l, l]).sort(),
    );
  });
});

describe("G14: every write goes to its switch's own deployment", () => {
  type Hooks = {
    ping: ReturnType<typeof usePing>; fund: ReturnType<typeof useFundBounty>; cancel: ReturnType<typeof useCancelSwitch>;
    reclaim: ReturnType<typeof useReclaimContribution>; rescue: ReturnType<typeof useRescueOwnerStake>;
    mark: ReturnType<typeof useMarkDark>; reveal: ReturnType<typeof useRevealKey>; publish: ReturnType<typeof usePublishPlaintext>;
  };
  /** The write hooks of one switch, as its card gets them. */
  const hooksFor = (h: SwitchHandle): Hooks => {
    let out: Hooks | null = null;
    const Probe = () => {
      out = {
        ping: usePing(h), fund: useFundBounty(h), cancel: useCancelSwitch(h), reclaim: useReclaimContribution(h),
        rescue: useRescueOwnerStake(h), mark: useMarkDark(h), reveal: useRevealKey(h), publish: usePublishPlaintext(h),
      };
      return null;
    };
    const Wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={newClient()}>{children}</QueryClientProvider>;
    renderToStaticMarkup(<Wrap><Probe /></Wrap>);
    return out!;
  };
  const B32 = `0x${"ab".repeat(32)}` as Hex;

  it("ping, top-up, cancel, reclaims, mark dark, reveal and publish of an old switch are sent to the old contract", async () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    const h = handle(m.OLD, 9n);
    const w = hooksFor(h);
    await w.ping.write(h);
    await w.fund.write(h, 10n ** 15n);
    await w.cancel.write(h);
    await w.reclaim.write(h);
    await w.rescue.write(h);
    await w.mark.write(h);
    await w.reveal.write(h, B32, "0x1234");
    await w.publish.write(h, B32, "0x68656c6c6f");
    expect(m.writes.map((x) => [x.functionName, x.address])).toEqual([
      ["ping", m.OLD], ["fundBounty", m.OLD], ["cancel", m.OLD], ["reclaimContribution", m.OLD],
      ["reclaimOwnerStake", m.OLD], ["markDark", m.OLD], ["revealKey", m.OLD], ["publishPlaintext", m.OLD],
    ]);
    expect(m.writes.every((x) => x.chainId === CHAIN)).toBe(true);
    // Every dry run before a wallet prompt is aimed at the same contract.
    expect(m.simulated.length).toBeGreaterThan(0);
    expect(m.simulated.every(([, address]) => address === m.OLD)).toBe(true);
    expect(m.writes[0]!.args).toEqual([9n]);
    expect(m.writes[1]!.args).toEqual([m.OWNER, 9n]);
  });

  it("a current switch's writes still go to the current contract", async () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    const h = handle(m.CUR, 1n);
    await hooksFor(h).ping.write(h);
    expect(m.writes.map((x) => x.address)).toEqual([m.CUR]);
  });

  it("the hunter's gas estimates (markDark, revealKey, publish) are made on the switch's own contract", async () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    const h = handle(m.OLD, 9n);
    const qc = newClient();
    const Probe = () => {
      useCallGas({ contract: h.contractAddr, functionName: "markDark", args: [h.owner, h.id] });
      return null;
    };
    render(qc, <Probe />);
    const [q] = qc.getQueryCache().findAll({ queryKey: ["callGas"] });
    await (q!.options.queryFn as () => Promise<unknown>)();
    expect(m.estimated).toEqual([["markDark", m.OLD]]);
  });

  it("a contract this app does not know is refused before the wallet", async () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    const h = handle(UNKNOWN, 1n);
    const w = hooksFor(h);
    await expect(w.ping.write(h)).rejects.toThrow(/not a DeadManSwitch deployment/);
    await expect(w.fund.write(h, 1n)).rejects.toThrow(/not a DeadManSwitch deployment/);
    expect(m.writes).toEqual([]);
  });

  it("a ping still pending on OLD's #1 does not block a ping of CUR's #1 (the pending-write record names the contract)", async () => {
    m.account = { address: m.OWNER, isConnected: true, chainId: CHAIN };
    const old1 = handle(m.OLD, 1n);
    const cur1 = handle(m.CUR, 1n);
    m.holdNext = true;
    const first = hooksFor(old1).ping.write(old1);
    await vi.waitFor(() => expect([...m.held.values()].every((r) => r !== null) && m.held.size === 1).toBe(true));
    await hooksFor(cur1).ping.write(cur1);
    for (const release of m.held.values()) release?.();
    await first;
    expect(m.writes.map((x) => x.address)).toEqual([m.OLD, m.CUR]);
  });
});

describe("G15: the switch page and its links", () => {
  const open = (qc: QueryClient, id: bigint, search = "") => {
    m.params = { chainId: String(CHAIN), owner: m.OWNER, id: id.toString() };
    m.search = search;
    return render(qc, <SwitchDetailPage />);
  };
  const shown = (html: string) => /FundAction for #\d+ on (0x[0-9a-fA-F]{40})/.exec(text(html))?.[1] ?? null;

  it("?contract=<previous deployment>: that deployment's switch, marked as older, even when the current one has the same (owner, id)", () => {
    const qc = newClient();
    setInfo(qc, m.OLD, 1n, 1);
    setInfo(qc, m.CUR, 1n, 1);
    const html = open(qc, 1n, `?contract=${m.OLD.toLowerCase()}`);
    expect(shown(html)).toBe(m.OLD);
    expect(text(html)).toMatch(/Older deployment/);
    expect(text(html)).toContain(m.OLD);
  });

  it("?contract=<current deployment>: the current one, not marked", () => {
    const qc = newClient();
    setInfo(qc, m.CUR, 1n, 1);
    const html = open(qc, 1n, `?contract=${m.CUR}`);
    expect(shown(html)).toBe(m.CUR);
    expect(text(html)).not.toMatch(/Older deployment/);
  });

  it("?contract=<a contract this site does not know>: refused, and nothing is read from it", () => {
    const qc = newClient();
    const html = open(qc, 1n, `?contract=${UNKNOWN}`);
    expect(text(html)).toMatch(/not a DeadManSwitch deployment this site knows/);
    expect(shown(html)).toBeNull();
    const keys = qc.getQueryCache().findAll().map((q) => JSON.stringify(q.queryKey, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(keys.some((k) => k.includes(UNKNOWN.toLowerCase()))).toBe(false);
    expect(text(open(newClient(), 1n, "?contract=0x12"))).toContain("That link isn't valid");
  });

  // A ping from this page could land on the wrong one of the two (the CLI lets owners pick ids
  // like #1), and the other goes dark and releases its secret. Nothing can be sent until the visitor picks one.
  it("an old link (no contract) whose (owner, id) exists on both: a chooser, both summarised, no action until one is picked", () => {
    const qc = newClient();
    setInfo(qc, m.OLD, 1n, 2);
    setInfo(qc, m.CUR, 1n, 1);
    const html = open(qc, 1n);
    const t = text(html);
    expect(t).toMatch(/Two switches match this link/);
    // No card's actions: no ping, cancel, top-up or release on either.
    expect(t).not.toMatch(/(OwnerActions|FundAction|RevealPanel|RevealedView) for/);
    expect(shown(html)).toBeNull();
    // Each one summarised (state, deployment) and linked by its contract.
    expect(t).toContain("Alive");
    expect(t).toContain("Dark");
    expect(t).toContain(m.CUR);
    expect(t).toContain(m.OLD);
    expect(hrefs(html)).toEqual(expect.arrayContaining([link(m.CUR, 1n), link(m.OLD, 1n)]));
  });

  // With one deployment unread, the switch shown could be the wrong one of two (#1 on both), and a ping
  // there leaves the other to go dark. So: no actions at all; Retry, and a link per deployment that was read.
  it("an old link while one deployment's read failed: no actions, a Retry, and links to the deployments that were read", async () => {
    const qc = newClient();
    setInfo(qc, m.CUR, 1n, 1);
    await qc.prefetchQuery({ queryKey: dmsKeys.info(CHAIN, handle(m.OLD, 1n)), queryFn: () => Promise.reject(new Error("rpc down")) });
    const html = open(qc, 1n);
    const t = text(html);
    expect(t).not.toMatch(/(OwnerActions|FundAction|RevealPanel|RevealedView) for/);
    expect(shown(html)).toBeNull();
    expect(t).toMatch(/Could not check every deployment/);
    expect(t).toContain("rpc down");
    expect(html).toMatch(/<button[^>]*>[\s\S]*?Retry<\/button>/);
    expect(hrefs(html)).toEqual([link(m.CUR, 1n)]);
  });

  it("an old link whose switch exists only on the previous deployment: that switch, not 'No switch'", () => {
    const qc = newClient();
    setInfo(qc, m.OLD, 9n, 1);
    setInfo(qc, m.CUR, 9n, 0);
    const html = open(qc, 9n);
    expect(shown(html)).toBe(m.OLD);
    expect(text(html)).toMatch(/Older deployment/);
    expect(text(html)).not.toContain("No switch #9");
  });

  it("an old link whose switch exists only on the current deployment: as before, with no note", () => {
    const qc = newClient();
    setInfo(qc, m.OLD, 5n, 0);
    setInfo(qc, m.CUR, 5n, 1);
    const html = open(qc, 5n);
    expect(shown(html)).toBe(m.CUR);
    expect(text(html)).not.toMatch(/older deployment/i);
  });

  it("an old link while the previous deployment's read is still out: waits, rather than show the current one's 'No switch'", () => {
    const qc = newClient();
    setInfo(qc, m.CUR, 9n, 0);
    const html = open(qc, 9n);
    expect(text(html)).not.toContain("No switch #9");
    expect(shown(html)).toBeNull();
  });

  it("the 'Switch created' card links the switch with its contract", () => {
    const html = renderToStaticMarkup(
      <CreatedCard
        created={{ chainId: CHAIN, contract: m.CUR as Hex, owner: m.OWNER as Hex, id: 42n, pingInterval: 3_600n, state: "alive", hash: null, adopted: false }}
        onStartOver={() => {}}
      />,
    );
    expect(hrefs(html)).toContain(link(m.CUR, 42n));
  });
});
