// UI hardening regressions. Rendered with react-dom/server against mocked
// data hooks (no browser, no chain): each test pins one concrete defect.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Hex } from "viem";
import { parseEther } from "viem";
import { usd8ToWei, type SwitchHandle, type SwitchInfo } from "@/lib/switch";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;

const m = vi.hoisted(() => ({
  pathname: "/",
  account: { address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined },
  chain: { chainId: 11155111, address: "0x00000000000000000000000000000000000d3ad5" as string | null, isConnected: false, isSupported: true },
  switchInfo: { info: null as unknown, error: null as string | null, isLoading: false },
  infos: new Map<string, unknown>(),
  switches: [] as unknown[],
  nowSec: null as bigint | null,
  config: { data: undefined as unknown, isLoading: false, error: null as unknown },
  isAdmin: false,
  /** pending / hash per write hook, e.g. writes.usePing = { pending: true, hash }. */
  funderStake: 0n as bigint,
  revealedSecret: { data: undefined as unknown, isLoading: false, error: null as unknown },
  published: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false, error: null as unknown, refetch: vi.fn() },
  writes: {} as Record<string, { pending: boolean; hash: string | null }>,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), push: vi.fn() },
}));

vi.mock("wagmi", () => ({
  useAccount: () => m.account,
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: () => null,
  useConnectModal: () => ({ openConnectModal: undefined }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => m.pathname }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => m.toast }));
vi.mock("@/components/ui/NetworkGuard", () => ({ NetworkGuard: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/gas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/gas")>()),
  useGasPrice: () => null,
  useCallGas: () => null,
}));
vi.mock("@/lib/hooks", () => {
  /** A lib write hook (usePing, …) whose pending / hash come from m.writes[name]. */
  const writeHook = (name: string) => () => ({
    write: async () => ({}), error: null, reset: () => {},
    ...(m.writes[name] ?? { pending: false, hash: null }),
  });
  return {
  usePing: writeHook("usePing"),
  useCancelSwitch: writeHook("useCancelSwitch"),
  useRescueOwnerStake: writeHook("useRescueOwnerStake"),
  useFundBounty: writeHook("useFundBounty"),
  useReclaimContribution: writeHook("useReclaimContribution"),
  useMarkDark: writeHook("useMarkDark"),
  useRevealKey: writeHook("useRevealKey"),
  useFunderStake: () => ({ data: m.funderStake }),
  useKmsKey: () => ({
    fetchKey: async () => ({}), stage: "idle", progress: null, attempt: 0, result: null, error: null, reset: () => {}, pending: false,
  }),
  useEffectiveChain: () => m.chain,
  useSwitchInfo: (h: { id: bigint }) =>
    ({ ...m.switchInfo, ...(m.infos.has(h.id.toString()) ? { info: m.infos.get(h.id.toString()) } : {}), refetch: () => {} }),
  useSwitches: () => ({ switches: m.switches, loading: false, error: null, refetch: () => {}, chainId: 11155111, contractAddress: m.chain.address }),
  useSwitchInfos: (hs: { id: bigint }[]) => hs.map((handle) => ({ handle, info: m.infos.get(handle.id.toString()) ?? null, isLoading: false })),
  useChainTime: () => ({ nowSec: m.nowSec, blockTimestamp: m.nowSec, isLoading: false }),
  useContractConfig: () => m.config,
  useIsAdmin: () => m.isAdmin,
  useIsPendingAdmin: () => false,
  useAdminActions: () => ({
    setMinBountyUsd: async () => ({}), transferAdmin: async () => ({}), acceptAdmin: async () => ({}),
    renounceAdmin: async () => ({}), error: null, reset: () => {},
    ...(m.writes.useAdminActions ?? { pending: false, hash: null }),
  }),
  useRevealedSecret: () => m.revealedSecret,
  usePublishedPlaintext: () => m.published,
  usePublishPlaintext: writeHook("usePublishPlaintext"),
  useFheKeyStatus: () => ({ state: "idle", loadedBytes: 0, totalBytes: null, fromCache: false }),
  useCreateSwitch: () => ({
    create: async () => null, startOver: () => {}, forgetAttempt: async () => {}, checkNow: () => {},
    stage: "idle", error: null, errorTitle: "", failedAt: null, fhe: null, hash: null, attempt: null, outcome: null,
    lastCheckedAt: null, created: null, rechecking: false, recheckError: null, block: null, pending: false,
  }),
  };
});

// Imported after the mocks (vi.mock is hoisted, so plain imports are fine).
import AdminPage from "@/app/admin/page";
import ArchivePage from "@/app/archive/page";
import HuntPage from "@/app/hunt/page";
import { CreateSwitchForm } from "./CreateSwitchForm";
import { Header } from "./Header";
import { SwitchCard } from "./switch/SwitchCard";

const USD8 = 10n ** 8n;
/** Chainlink-style ETH/USD answer, 8 decimals: $3,123.45. */
const PRICE8 = 312_345n * 10n ** 6n;

const config = (minBountyUsd: bigint) => ({
  admin: OWNER, pendingAdmin: "0x0000000000000000000000000000000000000000", adminRenounced: false,
  minBountyUsd, minBounty: usd8ToWei(minBountyUsd, PRICE8),
  ethUsdPriceFeed: `0x${"0".repeat(36)}feed`, maxPriceAge: 3600n,
  oracleOk: true, oraclePrice: PRICE8, feedDecimals: 8, ethUsd: 3123.45, oracleDown: false,
});

const info = (over: Partial<SwitchInfo> = {}): SwitchInfo => ({
  owner: OWNER, exists: true, state: "alive", stateCode: 1,
  lastPing: 1_000n, pingInterval: 86_400n, createdAt: 1_000n, expiresAt: 87_400n,
  darkMarkedAt: 0n, revealedAt: 0n, bounty: 10n ** 16n, ownerStake: 10n ** 16n,
  plaintextCommitment: H1, encKeyHandle: H2, revealedKey: `0x${"00".repeat(32)}`,
  ciphertextLength: 113n, published: false, rescuable: false,
  ...over,
});

beforeEach(() => {
  m.pathname = "/";
  m.account = { address: undefined, isConnected: false, chainId: undefined };
  m.chain = { chainId: 11155111, address: CONTRACT, isConnected: false, isSupported: true };
  m.switchInfo = { info: null, error: null, isLoading: false };
  m.infos = new Map();
  m.switches = [];
  m.nowSec = null;
  m.config = { data: undefined, isLoading: false, error: null };
  m.isAdmin = false;
  m.writes = {};
  m.funderStake = 0n;
  m.revealedSecret = { data: undefined, isLoading: false, error: null };
  m.published = { data: undefined, isLoading: false, isError: false, isFetching: false, error: null, refetch: vi.fn() };
  for (const f of Object.values(m.toast)) f.mockClear();
});

describe("SwitchCard: a failed background refresh", () => {
  const handle: SwitchHandle = { contractAddr: CONTRACT, owner: OWNER, id: 7n };

  it("keeps showing the switch it already read (an RPC hiccup must not unmount the actions under it)", () => {
    m.switchInfo = { info: info(), error: "HTTP request failed.", isLoading: false };
    m.nowSec = 2_000n;
    const html = renderToStaticMarkup(<SwitchCard handle={handle} variant="hunter" />);
    expect(html).not.toContain("Could not load switch");
    expect(html).toContain("Goes dark in");
    expect(html).toContain("Claimable in");
    // Says the data is from the last successful read.
    expect(html).toContain("Could not refresh");
  });

  it("still shows the error when nothing was ever read", () => {
    m.switchInfo = { info: null, error: "HTTP request failed.", isLoading: false };
    m.nowSec = 2_000n;
    const html = renderToStaticMarkup(<SwitchCard handle={handle} variant="hunter" />);
    expect(html).toContain("Could not load switch");
  });
});

describe("/admin: a failed background refresh of the settings", () => {
  it("keeps the settings and the admin forms on screen instead of replacing the page with an error", () => {
    m.config = { data: config(5n * USD8), isLoading: false, error: new Error("HTTP request failed.") };
    m.isAdmin = true;
    m.account = { address: OWNER, isConnected: true, chainId: 11155111 };
    const html = renderToStaticMarkup(<AdminPage />);
    expect(html).not.toContain("Could not read the contract settings");
    expect(html).toContain("Current settings");
    expect(html).toContain("Transfer admin");
    expect(html).toContain("Could not refresh");
    // "Minimum right now" is a floor: rounded up, like the create form's.
    expect(html).toContain("0.001601 ETH");
  });

  it("still shows the error when the settings were never read", () => {
    m.config = { data: undefined, isLoading: false, error: new Error("HTTP request failed.") };
    expect(renderToStaticMarkup(<AdminPage />)).toContain("Could not read the contract settings");
  });
});

describe("create form: minimum bounty", () => {
  it("never displays a minimum below the contract's minBounty() (entering the shown value must pass)", () => {
    // $5 at $3,123.45 = 0.0016007939… ETH. Truncating to 6 decimals showed 0.0016 ETH,
    // and typing 0.0016 was then rejected as "Below the current minimum of 0.0016 ETH".
    const cfg = config(5n * USD8);
    m.config = { data: cfg, isLoading: false, error: null };
    m.account = { address: OWNER, isConnected: true, chainId: 11155111 };
    m.chain = { chainId: 11155111, address: CONTRACT, isConnected: true, isSupported: true };
    const html = renderToStaticMarkup(<CreateSwitchForm />);
    const shown = /Minimum <span[^>]*>([0-9.]+) ETH<\/span>/.exec(html)?.[1];
    expect(shown).toBeDefined();
    expect(parseEther(shown!)).toBeGreaterThanOrEqual(cfg.minBounty);
    expect(shown).toBe("0.001601");
  });
});

describe("Header navigation", () => {
  it("every nav link has an accessible name at every screen width", () => {
    const html = renderToStaticMarkup(<Header />);
    const nav = /<nav[^>]*aria-label="Main"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
    const links = [...nav.matchAll(/<a([^>]*)>(.*?)<\/a>/g)];
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const [, attrs, inner] of links) {
      const label = /aria-label="([^"]+)"/.exec(attrs)?.[1];
      // Text inside a `hidden` (display: none) element is not part of the accessible name.
      const visibleText = inner.replace(/<span class="hidden[^"]*">.*?<\/span>/g, "").replace(/<[^>]+>/g, "").trim();
      expect(label ?? visibleText, `link ${attrs}`).not.toBe("");
    }
  });
});

describe("/hunt: list order and filter (the chain clock moved out of the data component)", () => {
  it("Claimable, by deadline: dark and release-requested switches only, most overdue first", () => {
    const now = 100_000n;
    const h = (id: bigint): SwitchHandle => ({ contractAddr: CONTRACT, owner: OWNER, id });
    const set = (id: bigint, over: Partial<SwitchInfo>) => m.infos.set(id.toString(), info(over));
    set(1n, { expiresAt: now + 3_600n });                                     // alive
    set(2n, { expiresAt: now - 100n });                                       // alive on the last read, dark by chain time now
    set(3n, { state: "darkMarked", stateCode: 3, expiresAt: now - 5_000n });   // release requested, most overdue
    set(4n, { state: "revealed", stateCode: 4, expiresAt: now - 9_000n });     // settled
    m.switches = [h(1n), h(2n), h(3n), h(4n)];
    m.nowSec = now;
    const html = renderToStaticMarkup(<HuntPage />);
    const shown = [...html.matchAll(/aria-label="Switch (\d+)"/g)].map((x) => x[1]);
    expect(shown).toEqual(["3", "2"]);
  });

  it("waits for the chain clock before deciding what is claimable", () => {
    m.infos.set("1", info({ expiresAt: 5n }));
    m.switches = [{ contractAddr: CONTRACT, owner: OWNER, id: 1n }];
    m.nowSec = null;
    const html = renderToStaticMarkup(<HuntPage />);
    expect(html).toContain("Loading switches");
    expect(html).not.toContain("Nothing to claim");
  });
});

describe("/archive: a long archive", () => {
  it("renders one page of released switches (each card reads, decrypts and scans for its publication), not all of them", () => {
    m.switches = Array.from({ length: 23 }, (_, i) => ({ contractAddr: CONTRACT, owner: OWNER, id: BigInt(i + 1) }));
    for (let i = 1; i <= 23; i++) {
      m.infos.set(String(i), info({ state: "revealed", stateCode: 4, revealedAt: BigInt(1_000 + i), bounty: 0n }));
    }
    m.nowSec = 10_000n;
    const html = renderToStaticMarkup(<ArchivePage />);
    const cards = [...html.matchAll(/aria-label="Switch (\d+)"/g)].map((x) => x[1]);
    // Most recently revealed first, ten per page.
    expect(cards).toEqual(["23", "22", "21", "20", "19", "18", "17", "16", "15", "14"]);
    expect(html).toMatch(/Page <span[^>]*>1<\/span> of <span[^>]*>3<\/span>/);
  });
});

describe("a sent write that is still pending shows its hash and an explorer link (lib waits up to 30 min)", () => {
  const handle: SwitchHandle = { contractAddr: CONTRACT, owner: OWNER, id: 7n };
  const TX_LINK = `https://sepolia.etherscan.io/tx/${H1}`;
  const owner = () => {
    m.account = { address: OWNER, isConnected: true, chainId: 11155111 };
    m.nowSec = 2_000n;
  };

  it("owner: a pending ping", () => {
    owner();
    m.switchInfo = { info: info(), error: null, isLoading: false };
    m.writes.usePing = { pending: true, hash: H1 };
    const html = renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />);
    expect(html).toContain(TX_LINK);
    expect(html).toContain("Don&#x27;t send it again");
  });

  it("owner: the ping stays visible after the switch went dark while it was pending", () => {
    owner();
    m.nowSec = 90_000n; // past expiresAt: the alive controls are gone
    m.switchInfo = { info: info(), error: null, isLoading: false };
    m.writes.usePing = { pending: true, hash: H1 };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />)).toContain(TX_LINK);
  });

  it("before the wallet returns a hash, and once settled, nothing is shown", () => {
    owner();
    m.switchInfo = { info: info(), error: null, isLoading: false };
    m.writes.usePing = { pending: true, hash: null };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />)).not.toContain("/tx/");
    m.writes.usePing = { pending: false, hash: H1 };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />)).not.toContain("/tx/");
  });

  it("funder: a pending top-up, and a pending reclaim on a cancelled switch", () => {
    m.account = { address: H2.slice(0, 42), isConnected: true, chainId: 11155111 };
    m.nowSec = 2_000n;
    m.switchInfo = { info: info(), error: null, isLoading: false };
    m.writes.useFundBounty = { pending: true, hash: H1 };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />)).toContain(TX_LINK);
    m.writes = { useReclaimContribution: { pending: true, hash: H1 } };
    m.funderStake = 10n ** 15n;
    m.switchInfo = { info: info({ state: "cancelled", stateCode: 5 }), error: null, isLoading: false };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />)).toContain(TX_LINK);
  });

  it("hunter: a pending markDark", () => {
    m.account = { address: H2.slice(0, 42), isConnected: true, chainId: 11155111 };
    m.nowSec = 90_000n;
    m.switchInfo = { info: info(), error: null, isLoading: false };
    m.writes.useMarkDark = { pending: true, hash: H1 };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />)).toContain(TX_LINK);
  });

  it("admin: a pending admin transaction", () => {
    m.config = { data: config(5n * USD8), isLoading: false, error: null };
    m.isAdmin = true;
    m.account = { address: OWNER, isConnected: true, chainId: 11155111 };
    m.writes.useAdminActions = { pending: true, hash: H1 };
    expect(renderToStaticMarkup(<AdminPage />)).toContain(TX_LINK);
  });
});

describe("revealed switch: the PlaintextPublished lookup failed", () => {
  const handle: SwitchHandle = { contractAddr: CONTRACT, owner: OWNER, id: 7n };
  const revealed = () => info({ state: "revealed", stateCode: 4, revealedAt: 5_000n, revealedKey: H2, bounty: 0n, published: true });

  it("bad ciphertext: the event is the only readable copy, so say the lookup failed and offer a retry (not a blank)", () => {
    m.nowSec = 10_000n;
    m.switchInfo = { info: revealed(), error: null, isLoading: false };
    m.revealedSecret = { data: { status: "invalid-key", warning: "Key accepted by the KMS proof but does not open the ciphertext" }, isLoading: false, error: null };
    m.published = { ...m.published, isError: true, error: new Error("HTTP request failed.") };
    for (const variant of ["detail", "archive"] as const) {
      const html = renderToStaticMarkup(<SwitchCard handle={handle} variant={variant} />);
      expect(html, variant).toContain("Couldn&#x27;t look up the published plaintext");
      expect(html, variant).toContain("only readable copy");
      expect(html, variant).toMatch(/<button type="button"[^>]*>.*Retry<\/button>/);
    }
  });

  it("while retrying the button is disabled; without an error nothing is added", () => {
    m.nowSec = 10_000n;
    m.switchInfo = { info: revealed(), error: null, isLoading: false };
    m.published = { ...m.published, isError: true, isFetching: true, error: new Error("HTTP request failed.") };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />)).toMatch(/<button type="button"[^>]*disabled=""[^>]*>.*Retry<\/button>/);
    m.published = { ...m.published, isError: false, isFetching: false, error: null };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />)).not.toContain("look up the published plaintext");
  });
});

describe("owner: pinging in the last seconds before the deadline", () => {
  const handle: SwitchHandle = { contractAddr: CONTRACT, owner: OWNER, id: 7n };
  const EXPIRES = 87_400n;
  const render = (secondsLeft: bigint) => {
    m.account = { address: OWNER, isConnected: true, chainId: 11155111 };
    m.switchInfo = { info: info({ expiresAt: EXPIRES }), error: null, isLoading: false };
    m.nowSec = EXPIRES - secondsLeft;
    return renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />);
  };
  const WARNING = "may be mined after the deadline";
  const pingButton = (html: string) => /<button[^>]*>(?:(?!<\/button>).)*Ping: I&#x27;m alive<\/button>/.exec(html)?.[0] ?? "";

  it("36 s or more left (3 slots): no warning", () => {
    expect(render(36n)).not.toContain(WARNING);
    expect(render(3_600n)).not.toContain(WARNING);
  });

  it("under 36 s left: warns that the ping may revert and still cost gas, and keeps the button enabled", () => {
    for (const left of [35n, 12n, 1n]) {
      const html = render(left);
      expect(html, `${left}s`).toContain(WARNING);
      expect(html, `${left}s`).toContain("still cost gas");
      expect(pingButton(html), `${left}s`).not.toBe("");
      expect(pingButton(html), `${left}s`).not.toContain("disabled");
    }
  });

  it("at the deadline the switch is dark: no ping button and no warning", () => {
    const html = render(0n);
    expect(pingButton(html)).toBe("");
    expect(html).not.toContain(WARNING);
  });

  it("the switch page (owner actions and the top-up form on one card): one late warning, the ping/cancel one", () => {
    m.account = { address: OWNER, isConnected: true, chainId: 11155111 };
    m.switchInfo = { info: info({ expiresAt: EXPIRES }), error: null, isLoading: false };
    m.nowSec = EXPIRES - 20n;
    const html = renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />);
    expect(html.match(/Under 36 s to the deadline/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/Under 36 s to the deadline: a ping or cancel sent now may be mined after the/);
  });
});
