// UI polish: amounts, labels, warnings and empty states across the switch
// views, and the reveal label of a drained bounty. Rendered with react-dom/server against mocked data hooks
// (no browser, no chain), like ui-fixes.test.tsx.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseEther, type Hex } from "viem";
import { createdFor, type CreatedSwitch } from "@/lib/createAttempt";
import { RESCUE_DELAY, type SwitchHandle, type SwitchInfo } from "@/lib/switch";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;

const m = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CONTRACT_11155111 = "0x00000000000000000000000000000000000d3ad5";
  return {
    pathname: "/",
    params: {} as Record<string, string>,
    account: { address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined },
    chain: { chainId: 11155111, address: "0x00000000000000000000000000000000000d3ad5" as string | null, isConnected: false, isSupported: true },
    switchInfo: { info: null as unknown, error: null as string | null, isLoading: false },
    nowSec: null as bigint | null,
    config: { data: undefined as unknown, isLoading: false, error: null as unknown },
    funderStake: undefined as bigint | undefined,
    kms: { result: null as unknown, stage: "idle" as string, retryReason: null as string | null, attempt: 0 },
    revealedSecret: { data: undefined as unknown, isLoading: false, error: null as unknown },
    owned: [] as { contractAddr: string; owner: string; id: bigint; key: string }[],
    scan: { loading: false, progress: null as { done: bigint; total: bigint } | null },
    infos: new Map<string, unknown>(),
    create: { stage: "idle" as string, pending: false, created: null as unknown, startingOver: false, startOverError: null as string | null },
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), push: vi.fn() },
  };
});

vi.mock("wagmi", () => ({
  useAccount: () => m.account,
  useSwitchChain: () => ({ switchChain: () => {}, isPending: false }),
}));
vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: () => null,
  useConnectModal: () => ({ openConnectModal: undefined }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => m.pathname, useParams: () => m.params, useSearchParams: () => new URLSearchParams() }));
vi.mock("@/app/providers", () => ({ Providers: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/ui/Toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/Toast")>()),
  useToast: () => m.toast,
}));
vi.mock("@/components/gas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/gas")>()),
  useGasPrice: () => null,
  useCallGas: () => null,
}));
vi.mock("@/lib/hooks", () => {
  const writeHook = () => () => ({ write: async () => ({}), error: null, reset: () => {}, pending: false, hash: null });
  return {
    usePing: writeHook(),
    useCancelSwitch: writeHook(),
    useRescueOwnerStake: writeHook(),
    useFundBounty: writeHook(),
    useReclaimContribution: writeHook(),
    useMarkDark: writeHook(),
    useRevealKey: writeHook(),
    usePublishPlaintext: writeHook(),
    useFunderStake: () => ({ data: m.funderStake }),
    useKmsKey: () => ({
      fetchKey: async () => ({}), stage: m.kms.result ? "done" : m.kms.stage, progress: null, attempt: m.kms.attempt,
      result: m.kms.result, error: null, reset: () => {}, pending: m.kms.stage === "waiting-retry",
      retryReason: m.kms.stage === "waiting-retry" ? m.kms.retryReason : null,
    }),
    useEffectiveChain: () => m.chain,
    ChainScope: ({ children }: { children: unknown }) => children,
    useSwitchInfo: () => ({ ...m.switchInfo, refetch: () => {} }),
    useChainTime: () => ({ nowSec: m.nowSec, blockTimestamp: m.nowSec, isLoading: false }),
    useContractConfig: () => m.config,
    useIsAdmin: () => false,
    useIsPendingAdmin: () => false,
    useRevealedSecret: () => m.revealedSecret,
    usePublishedPlaintext: () => ({ data: undefined, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }),
    useFheKeyStatus: () => ({ state: "idle", loadedBytes: 0, totalBytes: null, fromCache: false }),
    useOwnerSwitches: () => ({ switches: m.owned, loading: m.scan.loading, progress: m.scan.progress, error: null, contractAddress: CONTRACT, chainId: 11155111 }),
    useSwitches: () => ({ switches: m.owned, loading: m.scan.loading, progress: m.scan.progress, error: null, contractAddress: CONTRACT, chainId: 11155111 }),
    useSwitchInfos: (hs: { owner: string; id: bigint }[]) => hs.map((handle) => ({
      handle, info: m.infos.get(`${handle.owner}-${handle.id}`) ?? null, isLoading: false, error: null, refetch: () => {},
    })),
    useCreateSwitch: () => ({
      create: async () => null, startOver: () => {}, forgetAttempt: async () => {}, checkNow: () => {},
      stage: m.create.stage, error: null, errorTitle: "", failedAt: null, fhe: null, hash: null, attempt: null,
      outcome: null, lastCheckedAt: null, created: m.create.created, rechecking: false, recheckError: null,
      block: null, pending: m.create.pending,
      startingOver: m.create.startingOver, startOverError: m.create.startOverError,
    }),
  };
});

// Imported after the mocks (vi.mock is hoisted).
import DocsPage from "@/app/docs/page";
import ArchivePage from "@/app/archive/page";
import DashboardPage from "@/app/dashboard/page";
import HuntPage from "@/app/hunt/page";
import * as layout from "@/app/layout";
import SwitchDetailPage from "@/app/switch/[chainId]/[owner]/[id]/page";
import { showInAppBrowserWallet } from "@/lib/injectedWallet";
import { CreateSwitchForm, CreatedCard } from "./CreateSwitchForm";
import { FheKeyStatus, fhevmHint } from "./FheKeyStatus";
import { FhevmError } from "@/lib/fhevm";
import { Header } from "./Header";
import { byDeadline, ownerOrder } from "./switch/order";
import { PlaintextView } from "./switch/PlaintextView";
import { SwitchCard } from "./switch/SwitchCard";
import { NetworkGuard } from "./ui/NetworkGuard";
import { ToastProvider } from "./ui/Toast";

const EXPIRES = 87_400n;
const info = (over: Partial<SwitchInfo> = {}): SwitchInfo => ({
  owner: OWNER, exists: true, state: "alive", stateCode: 1,
  lastPing: 1_000n, pingInterval: 86_400n, createdAt: 1_000n, expiresAt: EXPIRES,
  darkMarkedAt: 0n, revealedAt: 0n, bounty: 10n ** 16n, ownerStake: 10n ** 16n,
  plaintextCommitment: H1, encKeyHandle: H2, revealedKey: `0x${"00".repeat(32)}`,
  ciphertextLength: 113n, published: false, rescuable: false,
  ...over,
});
const handle: SwitchHandle = { contractAddr: CONTRACT, owner: OWNER, id: 7n };

/** Visible text only: tags (and so title / href / aria attributes) removed. */
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const connect = (address: string) => {
  m.account = { address, isConnected: true, chainId: 11155111 };
  m.chain = { ...m.chain, isConnected: true };
};
const show = (i: SwitchInfo, nowSec: bigint) => {
  m.switchInfo = { info: i, error: null, isLoading: false };
  m.nowSec = nowSec;
};

beforeEach(() => {
  m.pathname = "/";
  m.params = {};
  m.account = { address: undefined, isConnected: false, chainId: undefined };
  m.chain = { chainId: 11155111, address: CONTRACT, isConnected: false, isSupported: true };
  m.switchInfo = { info: null, error: null, isLoading: false };
  m.nowSec = null;
  m.config = { data: undefined, isLoading: false, error: null };
  m.funderStake = undefined;
  m.kms = { result: null, stage: "idle", retryReason: null, attempt: 0 };
  m.revealedSecret = { data: undefined, isLoading: false, error: null };
  m.owned = [];
  m.scan = { loading: false, progress: null };
  m.infos = new Map();
  m.create = { stage: "idle", pending: false, created: null, startingOver: false, startOverError: null };
});

// ---------- E3 / F4: the "Switch created" card belongs to its account and network ----------

describe("E3 the 'Switch created' card is shown only to the account and network that created it", () => {
  const created: CreatedSwitch = {
    chainId: 11155111, contract: CONTRACT, owner: OWNER, id: 42n, pingInterval: 86_400n, state: "alive",
    hash: H1, adopted: false,
  };

  it("the creating account on the same chain and contract sees it (addresses compared case-insensitively)", () => {
    expect(createdFor(created, { chainId: 11155111, contract: CONTRACT, owner: OWNER.toLowerCase() as `0x${string}` }))
      .toBe(created);
  });

  it("another account, another chain or another contract does not", () => {
    expect(createdFor(created, { chainId: 11155111, contract: CONTRACT, owner: OTHER })).toBeNull();
    expect(createdFor(created, { chainId: 1, contract: CONTRACT, owner: OWNER })).toBeNull();
    expect(createdFor(created, { chainId: 11155111, contract: `0x${"ab".repeat(20)}`, owner: OWNER })).toBeNull();
  });

  it("no wallet (or no deployment) and no stored card: nothing", () => {
    expect(createdFor(created, null)).toBeNull();
    expect(createdFor(null, { chainId: 11155111, contract: CONTRACT, owner: OWNER })).toBeNull();
  });
});

// ---------- E4: the card does not keep saying "is live" ----------

describe("E4 the 'Switch created' card follows the switch's live state", () => {
  const created: CreatedSwitch = {
    chainId: 11155111, contract: CONTRACT, owner: OWNER, id: 42n, pingInterval: 86_400n * 7n, state: "alive",
    hash: H1, adopted: false,
  };
  const card = (live?: Parameters<typeof CreatedCard>[0]["live"]) =>
    text(renderToStaticMarkup(<CreatedCard created={created} live={live} onStartOver={() => {}} />));

  it("alive: live, with the ping interval", () => {
    const t = card("alive");
    expect(t).toContain("Switch #42 is live on Sepolia.");
    expect(t).toContain("7d");
  });

  it("dark days later: no longer called live, and no ping advice", () => {
    for (const s of ["dark", "darkMarked"] as const) {
      const t = card(s);
      expect(t, s).not.toContain("is live");
      expect(t, s).not.toContain("Ping at least");
      expect(t, s).toContain("gone dark");
    }
  });

  it("cancelled or released: says so", () => {
    expect(card("cancelled")).toContain("cancelled");
    expect(card("cancelled")).not.toContain("is live");
    expect(card("revealed")).toContain("released");
    expect(card("revealed")).not.toContain("is live");
  });

  it("while the state is being read: no claim that it is live", () => {
    const t = card(null);
    expect(t).not.toContain("is live");
    expect(t).toContain("Switch #42 was created on Sepolia.");
    expect(t).toContain("7d");
  });

  it("the dashboard's card reads the switch's state", () => {
    connect(OWNER);
    m.create = { ...m.create, stage: "done", created };
    show(info({ state: "dark", stateCode: 2 }), EXPIRES + 31n * 86_400n);
    const t = text(renderToStaticMarkup(<CreateSwitchForm />));
    expect(t).toContain("Switch created");
    expect(t).not.toContain("is live");
    expect(t).toContain("gone dark");
  });
});

// ---------- E5: divider rules span the card ----------

describe("E5 a <p> drawn with a top rule is not cut to the 68ch measure", () => {
  const ruledParagraphs = (html: string) => [...html.matchAll(/<p class="([^"]*)"/g)].map((x) => x[1]).filter((c) => /\bborder-t\b/.test(c));

  it("cancelled (owner and visitor), revealed owner card and the hunter's alive note", () => {
    const cases: [string, () => string][] = [
      ["owner cancelled, detail", () => { connect(OWNER); show(info({ state: "cancelled", stateCode: 5, bounty: 0n, ownerStake: 0n }), 2_000n); m.funderStake = 0n; return renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />); }],
      ["visitor cancelled, detail", () => { show(info({ state: "cancelled", stateCode: 5, bounty: 0n, ownerStake: 0n }), 2_000n); return renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />); }],
      ["owner revealed, dashboard", () => { connect(OWNER); show(info({ state: "revealed", stateCode: 4, revealedAt: 5_000n, bounty: 0n }), 10_000n); return renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />); }],
      ["alive, hunter list", () => { show(info(), 2_000n); return renderToStaticMarkup(<SwitchCard handle={handle} variant="hunter" />); }],
    ];
    for (const [name, render] of cases) {
      const ruled = ruledParagraphs(render());
      expect(ruled.length, name).toBeGreaterThan(0);
      for (const cls of ruled) expect(cls, name).toContain("max-w-none");
    }
  });
});

// ---------- E6: dark color scheme for native controls ----------

describe("E6 the page declares a dark color scheme", () => {
  it("in the viewport metadata (meta color-scheme) and in CSS", () => {
    expect(layout.viewport).toMatchObject({ colorScheme: "dark" });
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark/);
  });
});

// ---------- E7: wallet browsers on phones ----------

describe("E7 a phone's wallet browser gets a 'Browser Wallet' option", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  const provider = { request: async () => null };

  it("shown on a phone or tablet whose browser injects a provider", () => {
    expect(showInAppBrowserWallet({ userAgent: IPHONE }, provider)).toBe(true);
    expect(showInAppBrowserWallet({ userAgent: ANDROID }, provider)).toBe(true);
    // iPadOS reports a Mac; RainbowKit treats it as mobile too.
    expect(showInAppBrowserWallet({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5 }, provider)).toBe(true);
  });

  it("hidden without a provider, on a desktop (EIP-6963 lists it there), and on the server", () => {
    expect(showInAppBrowserWallet({ userAgent: IPHONE }, undefined)).toBe(false);
    expect(showInAppBrowserWallet({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 }, provider)).toBe(false);
    expect(showInAppBrowserWallet(undefined, provider)).toBe(false);
  });
});

// ---------- E8: toasts do not cover the header ----------

describe("E8 toasts stay clear of the header's wallet button", () => {
  it("the stack sits at the bottom of the viewport, not the top", () => {
    const html = renderToStaticMarkup(<ToastProvider><span /></ToastProvider>);
    const stack = /<div class="([^"]*\bfixed\b[^"]*)"/.exec(html)?.[1] ?? "";
    expect(stack).toContain("bottom-4");
    expect(stack).not.toMatch(/\btop-\d/);
  });
});

// ---------- E9: one-row header on a phone ----------

describe("E9 the header fits one row at 390 px", () => {
  it("below sm the brand is the icon alone, and the link keeps its accessible name", () => {
    const html = renderToStaticMarkup(<Header />);
    const brand = /<a[^>]*href="\/"[^>]*>(.*?)<\/a>/.exec(html)?.[1] ?? "";
    expect(brand).toMatch(/<span class="[^"]*\bsr-only\b[^"]*\bsm:not-sr-only\b[^"]*">Dead Man(&#x27;|')s Switch<\/span>/);
  });
});

// ---------- E10: names and capitals ----------

describe("E10 accessible names and headings", () => {
  it("'Your switches' and its count are separate words in the heading's name", () => {
    connect(OWNER);
    m.owned = [{ contractAddr: CONTRACT, owner: OWNER, id: 7n, key: "k7" }];
    const html = renderToStaticMarkup(<DashboardPage />);
    const h2 = /<h2 id="mine"[^>]*>(.*?)<\/h2>/.exec(html)?.[1] ?? "";
    expect(h2).toMatch(/^Your switches /);
  });

  it("an unknown chain's network-guard heading starts with a capital", () => {
    m.account = { address: OWNER, isConnected: true, chainId: 8453 };
    const html = renderToStaticMarkup(<NetworkGuard><span /></NetworkGuard>);
    expect(html).toContain(">Chain 8453 is not supported<");
  });

  it("and so does the switch page's for a link on an unknown chain", () => {
    m.params = { chainId: "8453", owner: OWNER, id: "7" };
    expect(renderToStaticMarkup(<SwitchDetailPage />)).toContain(">Chain 8453 is not supported<");
  });
});

// ---------- E11: one statement per card ----------

describe("E11 the same fact is not stated twice in one card", () => {
  it("owner, dark: the rescue date once (dashboard and switch page)", () => {
    for (const variant of ["owner", "detail"] as const) {
      connect(OWNER);
      m.funderStake = parseEther("0.002");
      show(info({ state: "dark", stateCode: 2, bounty: parseEther("0.012") }), EXPIRES + 100n);
      const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant={variant} />));
      expect(count(t, "If nobody releases the key by"), variant).toBe(1);
    }
  });

  it("a funder of a cancelled switch is told once that the owner cancelled", () => {
    connect(OTHER);
    m.funderStake = parseEther("0.002");
    show(info({ state: "cancelled", stateCode: 5, bounty: parseEther("0.002"), ownerStake: 0n }), 2_000n);
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
    expect(t).toContain("Reclaim 0.002 ETH");
    expect(count(t.toLowerCase(), "owner cancelled")).toBe(1);
  });

  it("a visitor with nothing to reclaim still gets the explanation", () => {
    connect(OTHER);
    m.funderStake = 0n;
    show(info({ state: "cancelled", stateCode: 5, bounty: 0n, ownerStake: 0n }), 2_000n);
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
    expect(t).toContain("The owner cancelled this switch while alive. Its key will never be made decryptable");
  });
});

// ---------- E12: lists ordered by what needs attention ----------

describe("E12 list order", () => {
  const row = (id: bigint, over: Partial<SwitchInfo> | null) => ({
    handle: { contractAddr: CONTRACT, owner: OWNER, id } as SwitchHandle,
    info: over === null ? null : info(over),
  });

  it("dashboard: unread, then alive by soonest deadline, then dark (longest dark first), then settled in scan order", () => {
    const rows = [
      row(11n, { state: "revealed", stateCode: 4, expiresAt: 50n }),
      row(10n, { state: "cancelled", stateCode: 5, expiresAt: 9_000n }),
      row(9n, { state: "dark", stateCode: 2, expiresAt: 600n }),
      row(8n, { state: "darkMarked", stateCode: 3, expiresAt: 300n }),
      row(7n, null),
      row(6n, { state: "alive", expiresAt: 5_000n }),
      row(5n, { state: "alive", expiresAt: 1_000n }),
      row(4n, { state: "revealed", stateCode: 4, expiresAt: 70n }),
    ];
    expect(ownerOrder(rows).map((r) => r.handle.id)).toEqual([7n, 5n, 6n, 8n, 9n, 11n, 10n, 4n]);
  });

  it("/hunt's Deadline sort: switches still in play by deadline, revealed and cancelled last", () => {
    const list = [
      info({ state: "revealed", stateCode: 4, expiresAt: 100n }),
      info({ state: "alive", expiresAt: 900n }),
      info({ state: "cancelled", stateCode: 5, expiresAt: 50n }),
      info({ state: "dark", stateCode: 2, expiresAt: 200n }),
      info({ state: "darkMarked", stateCode: 3, expiresAt: 150n }),
    ];
    expect([...list].sort(byDeadline).map((i) => i.state)).toEqual(["darkMarked", "dark", "alive", "cancelled", "revealed"]);
  });
});

// ---------- E13: long plaintext is not cut without a cue ----------

describe("E13 long plaintext offers 'Show all'", () => {
  const LETTER = [
    "To whoever releases this,",
    "",
    "I kept a journal of everything that happened at the plant between March and September. The originals are in a safe-deposit box at the Elm Street branch, box 1142; the bank has instructions to open it for my sister.",
    "",
    "Copies of the inspection reports, with the dates that were changed, are on the drive in the envelope marked \"taxes 2019\". Please send them to the two reporters named on the first page.",
    "",
    "Thank you. I hope this was never needed.",
  ].join("\n");
  const render = (s: string, compact: boolean) =>
    renderToStaticMarkup(<PlaintextView plaintext={new TextEncoder().encode(s)} filenameBase="x" compact={compact} />);

  it("a letter in the archive card: clipped with a fade and a 'Show all' button", () => {
    const html = render(LETTER, true);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>.*Show all.*<\/button>/);
    expect(html).toContain("bg-gradient-to-t");
    expect(html).toContain(LETTER.split("\n")[6]); // the hidden part is in the DOM (and copied), only clipped
  });

  it("a short secret: no toggle", () => {
    expect(render("hello", true)).not.toContain("Show all");
    expect(render("hello", false)).not.toContain("Show all");
  });
});

// ---------- E14: invalid fields ----------

describe("E14 invalid fields", () => {
  it("a focused invalid field gets a red ring, not the green one", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.input-invalid:focus-visible[^{]*\{[^}]*outline-color:\s*rgb\(var\(--gone\)\)/);
  });
});

// ---------- G4: the FHE key size and the KMS signature threshold ----------

describe("G4 user-facing facts about Zama's KMS and key", () => {
  it("the FHE key is about 4.6 MB everywhere it is mentioned", () => {
    const docs = text(renderToStaticMarkup(<DocsPage />));
    expect(docs).not.toContain("50 MB");
    expect(docs).toContain("4.6 MB");
    const status = text(renderToStaticMarkup(<FheKeyStatus chainId={11155111} />));
    expect(status).not.toContain("50 MB");
    expect(status).toContain("4.6 MB");
    connect(OWNER);
    m.create = { ...m.create, stage: "sealing", pending: true };
    const form = text(renderToStaticMarkup(<CreateSwitchForm />));
    expect(form).toContain("Prepare FHE");
    expect(form).not.toContain("50 MB");
    expect(form).toContain("4.6 MB");
  });

  it("the docs give the signature threshold revealKey accepts (7 of 13 on Sepolia), apart from decryption", () => {
    const docs = text(renderToStaticMarkup(<DocsPage />));
    expect(docs).toContain("7 of 13");
    expect(docs).not.toContain("9 of them must cooperate");
    expect(docs).not.toContain("9-of-13");
  });
});

// ---------- the reveal label once rescue drained the bounty ----------

describe("reveal and claim, rescue open", () => {
  const kmsResult = { dataKey: H2, decryptionProof: "0x1234", check: { status: "ok" } };
  const darkMarked = (bounty: bigint) =>
    info({ state: "darkMarked", stateCode: 3, darkMarkedAt: EXPIRES + 10n, bounty, rescuable: true });

  it("nothing left: 'Reveal and claim 0 ETH', not 'up to 0 ETH'", () => {
    connect(OTHER);
    show(darkMarked(0n), EXPIRES + BigInt(RESCUE_DELAY) + 10n);
    m.kms = { ...m.kms, result: kmsResult };
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
    expect(t).toContain("Reveal and claim 0 ETH");
    expect(t).not.toContain("up to 0 ETH");
    expect(t).not.toContain("up to");
  });

  it("something left: still 'up to'", () => {
    connect(OTHER);
    show(darkMarked(parseEther("0.003")), EXPIRES + BigInt(RESCUE_DELAY) + 10n);
    m.kms = { ...m.kms, result: kmsResult };
    expect(text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />))).toContain("Reveal and claim up to 0.003 ETH");
  });
});

// ---------- wiring for the writes round (coordinator) ----------

describe("wiring: a page left over from before a redeploy (STALE_PAGE)", () => {
  it("gets reload advice", () => {
    const hint = fhevmHint(new FhevmError("STALE_PAGE", "This page is out of date.")) ?? "";
    expect(hint).toMatch(/reload/i);
  });

  it("the server-settings hint no longer blames this page's contract (that is STALE_PAGE now)", () => {
    const hint = fhevmHint(new FhevmError("RELAYER_NOT_CONFIGURED", "the relayer proxy refused the request (contract_not_configured)")) ?? "";
    expect(hint).not.toMatch(/this page's contract/i);
  });
});

describe("wiring: the KMS retry line says what it waits for", () => {
  const waiting = (retryReason: string) => {
    connect(OTHER);
    show(info({ state: "darkMarked", stateCode: 3, darkMarkedAt: EXPIRES + 10n }), EXPIRES + 100n);
    m.kms = { result: null, stage: "waiting-retry", retryReason, attempt: 3 };
    return text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
  };

  it("the relayer is down or busy", () => {
    const t = waiting("relayer-unavailable");
    expect(t).toMatch(/relayer/i);
    expect(t).not.toContain("has not released it yet");
    expect(t).toContain("attempt 3 of 20");
  });

  it("the KMS has not finished", () => {
    const t = waiting("not-decryptable-yet");
    expect(t).toContain("has not released it yet");
    expect(t).toContain("attempt 3 of 20");
  });
});

describe("wiring: 'Create another' re-reads the switch first", () => {
  const created: CreatedSwitch = {
    chainId: 11155111, contract: CONTRACT, owner: OWNER, id: 42n, pingInterval: 86_400n, state: "alive",
    hash: H1, adopted: false,
  };
  const anotherButton = (html: string) => /<button[^>]*>(?:(?!<\/button>).)*Create another(?:(?!<\/button>).)*<\/button>/.exec(html)?.[0] ?? "";

  it("disabled while the re-read runs", () => {
    connect(OWNER);
    m.create = { ...m.create, stage: "done", created, startingOver: true };
    expect(anotherButton(renderToStaticMarkup(<CreateSwitchForm />))).toContain("disabled");
  });

  it("its failure is shown, and the button is offered again", () => {
    connect(OWNER);
    const why = "Could not check that switch #42 is still on-chain (timeout), so the form was not reset. Try again.";
    m.create = { ...m.create, stage: "done", created, startOverError: why };
    const html = renderToStaticMarkup(<CreateSwitchForm />);
    expect(html).toMatch(new RegExp(`role="alert"[^>]*>[^<]*${why.slice(0, 40).replace(/[.*+?^${}()|[\]\\#]/g, "\\$&")}`));
    expect(anotherButton(html)).not.toContain("disabled");
  });
});

describe("wiring: a switch that does not read on-chain", () => {
  it("says it may not be mined yet or was dropped by a reorg", () => {
    show(info({ exists: false, owner: "0x0000000000000000000000000000000000000000", state: "none", stateCode: 0 }), 2_000n);
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
    expect(t).toContain(`No switch #7 for owner ${OWNER} on this network.`);
    expect(t).toMatch(/not be mined yet/);
    expect(t).toMatch(/reorg/);
  });
});

// ---------- the first scan's progress (scan round) ----------

describe("lists say how far the first scan got, and show what it found meanwhile", () => {
  const found = { contractAddr: CONTRACT, owner: OWNER, id: 7n, key: "k7" };

  it("dashboard, hunt and archive: 'Scanning the chain… 42%' while the scan runs", () => {
    connect(OWNER);
    m.nowSec = 2_000n;
    m.scan = { loading: true, progress: { done: 42n, total: 100n } };
    for (const [name, Page] of [["dashboard", DashboardPage], ["hunt", HuntPage], ["archive", ArchivePage]] as const) {
      expect(text(renderToStaticMarkup(<Page />)), name).toMatch(/Scanning the chain… 42 ?%/);
    }
  });

  it("switches found so far are listed under the progress line, and no 'none' state yet", () => {
    connect(OWNER);
    m.nowSec = 2_000n;
    m.scan = { loading: true, progress: { done: 10n, total: 100n } };
    m.owned = [found];
    m.infos.set(`${OWNER}-7`, info());
    show(info(), 2_000n);
    const html = renderToStaticMarkup(<DashboardPage />);
    expect(html).toContain('aria-label="Switch 7"');
    expect(text(html)).not.toContain("No switches yet");
    expect(html).not.toContain('aria-label="Loading switches"');
  });

  it("no line once the scan has finished", () => {
    connect(OWNER);
    m.nowSec = 2_000n;
    expect(text(renderToStaticMarkup(<DashboardPage />))).not.toContain("Scanning the chain");
  });
});
