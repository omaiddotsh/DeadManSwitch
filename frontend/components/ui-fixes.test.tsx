// UI regressions from the r1 audit. Rendered with react-dom/server against
// mocked data hooks (no browser, no chain). A click is simulated by calling
// the onClick of a button captured from the ActionGate that wraps it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  encodeAbiParameters, encodeEventTopics, getAddress, parseEther, toHex, type Hex, type Log, type TransactionReceipt,
} from "viem";
import { dmsAbi } from "@/lib/abi";
import { RESCUE_DELAY, usd8ToWei, type SwitchHandle, type SwitchInfo } from "@/lib/switch";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const H1 = `0x${"11".repeat(32)}` as Hex;
const H2 = `0x${"22".repeat(32)}` as Hex;

const m = vi.hoisted(() => {
  // The switch page reads the deployment from the env (lib/contracts).
  process.env.NEXT_PUBLIC_CONTRACT_11155111 = "0x00000000000000000000000000000000000d3ad5";
  return {
  pathname: "/",
  params: {} as Record<string, string>,
  account: { address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined },
  chain: { chainId: 11155111, address: "0x00000000000000000000000000000000000d3ad5" as string | null, isConnected: false, isSupported: true },
  switchInfo: { info: null as unknown, error: null as string | null, isLoading: false },
  nowSec: null as bigint | null,
  config: { data: undefined as unknown, isLoading: false, error: null as unknown },
  isAdmin: false,
  funderStake: undefined as bigint | undefined,
  kms: { result: null as unknown },
  revealWrite: (async () => ({})) as (...a: unknown[]) => Promise<unknown>,
  revealedSecret: { data: undefined as unknown, isLoading: false, error: null as unknown },
  published: { data: undefined as unknown, isLoading: false, isError: false, isFetching: false, error: null as unknown, refetch: () => {} },
  /** The argument each lib write hook was called with (the switch it shows), by hook name. */
  hookArgs: {} as Record<string, unknown[]>,
  /** pending / hash / error per write hook, e.g. writes.usePing = { pending: true, hash }. */
  writes: {} as Record<string, { pending: boolean; hash: string | null; error?: string | null }>,
  /** Children of every ActionGate rendered, by its `what`. */
  gated: new Map<string, unknown>(),
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
vi.mock("@/components/ui/Toast", () => ({ useToast: () => m.toast }));
vi.mock("@/components/ui/NetworkGuard", () => ({ NetworkGuard: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/gas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/gas")>()),
  useGasPrice: () => null,
  useCallGas: () => null,
}));
vi.mock("@/components/ui/ActionGate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ui/ActionGate")>();
  return {
    ActionGate: (p: Parameters<typeof real.ActionGate>[0]) => {
      m.gated.set(p.what ?? "", p.children);
      return real.ActionGate(p);
    },
  };
});
vi.mock("@/lib/hooks", () => {
  /** A lib write hook: records the handle it was given; pending / hash / error from m.writes[name]. */
  const writeHook = (name: string, write: () => (...a: unknown[]) => Promise<unknown> = () => async () => ({})) =>
    (h?: unknown) => {
      (m.hookArgs[name] ??= []).push(h);
      return { write: write(), error: null, reset: () => {}, ...(m.writes[name] ?? { pending: false, hash: null }) };
    };
  return {
    usePing: writeHook("usePing"),
    useCancelSwitch: writeHook("useCancelSwitch"),
    useRescueOwnerStake: writeHook("useRescueOwnerStake"),
    useFundBounty: writeHook("useFundBounty"),
    useReclaimContribution: writeHook("useReclaimContribution"),
    useMarkDark: writeHook("useMarkDark"),
    useRevealKey: writeHook("useRevealKey", () => m.revealWrite),
    usePublishPlaintext: writeHook("usePublishPlaintext"),
    useFunderStake: () => ({ data: m.funderStake }),
    useKmsKey: () => ({
      fetchKey: async () => ({}), stage: m.kms.result ? "done" : "idle", progress: null, attempt: 0,
      result: m.kms.result, error: null, reset: () => {}, pending: false,
    }),
    useEffectiveChain: () => m.chain,
    ChainScope: ({ children }: { children: unknown }) => children,
    useSwitchInfo: () => ({ ...m.switchInfo, refetch: () => {} }),
    useChainTime: () => ({ nowSec: m.nowSec, blockTimestamp: m.nowSec, isLoading: false }),
    useContractConfig: () => m.config,
    useIsAdmin: () => m.isAdmin,
    useIsPendingAdmin: () => false,
    useAdminActions: () => ({
      setMinBountyUsd: async () => ({}), transferAdmin: async () => ({}), acceptAdmin: async () => ({}),
      renounceAdmin: async () => ({}), error: null, reset: () => {}, pending: false, hash: null,
    }),
    useRevealedSecret: () => m.revealedSecret,
    usePublishedPlaintext: () => m.published,
    useFheKeyStatus: () => ({ state: "idle", loadedBytes: 0, totalBytes: null, fromCache: false }),
    useCreateSwitch: () => ({
      create: async () => null, startOver: () => {}, forgetAttempt: async () => {}, checkNow: () => {},
      stage: "idle", error: null, errorTitle: "", failedAt: null, fhe: null, hash: null, attempt: null, outcome: null,
      lastCheckedAt: null, created: null, rechecking: false, recheckError: null, block: null, pending: false,
    }),
  };
});

// Imported after the mocks (vi.mock is hoisted).
import AdminPage from "@/app/admin/page";
import DocsPage from "@/app/docs/page";
import SwitchDetailPage from "@/app/switch/[chainId]/[owner]/[id]/page";
import { parseEthInput, parseUsdInput } from "./amount";
import { CreateSwitchForm } from "./CreateSwitchForm";
import { CancelConfirm } from "./switch/OwnerActions";
import { SwitchCard } from "./switch/SwitchCard";

const USD8 = 10n ** 8n;
const PRICE8 = 312_345n * 10n ** 6n; // $3,123.45
const config = (minBountyUsd: bigint) => ({
  admin: OWNER, pendingAdmin: "0x0000000000000000000000000000000000000000", adminRenounced: false,
  minBountyUsd, minBounty: usd8ToWei(minBountyUsd, PRICE8),
  ethUsdPriceFeed: `0x${"0".repeat(36)}feed`, maxPriceAge: 3600n,
  oracleOk: true, oraclePrice: PRICE8, feedDecimals: 8, ethUsd: 3123.45, oracleDown: false,
});

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
const connect = (address: string) => {
  m.account = { address, isConnected: true, chainId: 11155111 };
  m.chain = { ...m.chain, isConnected: true };
};
const show = (i: SwitchInfo, nowSec: bigint) => {
  m.switchInfo = { info: i, error: null, isLoading: false };
  m.nowSec = nowSec;
};
/** The single <button> a gate wraps (or the first one found in its children). */
const gatedButton = (what: string): ReactElement<{ onClick: () => Promise<unknown> | void; children?: ReactNode }> => {
  const find = (n: unknown): ReactElement | null => {
    if (Array.isArray(n)) { for (const c of n) { const f = find(c); if (f) return f; } return null; }
    if (!isValidElement(n)) return null;
    if (n.type === "button") return n;
    return find((n.props as { children?: unknown }).children);
  };
  const b = find(m.gated.get(what));
  if (!b) throw new Error(`no button under ActionGate "${what}"`);
  return b as ReactElement<{ onClick: () => Promise<unknown> | void }>;
};

beforeEach(() => {
  m.pathname = "/";
  m.params = {};
  m.account = { address: undefined, isConnected: false, chainId: undefined };
  m.chain = { chainId: 11155111, address: CONTRACT, isConnected: false, isSupported: true };
  m.switchInfo = { info: null, error: null, isLoading: false };
  m.nowSec = null;
  m.config = { data: undefined, isLoading: false, error: null };
  m.isAdmin = false;
  m.funderStake = undefined;
  m.kms = { result: null };
  m.revealWrite = async () => ({});
  m.revealedSecret = { data: undefined, isLoading: false, error: null };
  m.published = { data: undefined, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} };
  m.gated = new Map();
  m.hookArgs = {};
  m.writes = {};
  for (const f of Object.values(m.toast)) f.mockClear();
});

// ---------- the owner's own top-ups ----------

describe("#5 owner who also topped up their own switch", () => {
  const ESCROW = parseEther("0.01");
  const TOPUP = parseEther("0.02");

  it("cancel confirmation: the owner's own top-ups are not called other funders' money", () => {
    const html = renderToStaticMarkup(
      <CancelConfirm
        info={info({ bounty: ESCROW + TOPUP, ownerStake: ESCROW })}
        ownTopUps={TOPUP}
        nowSec={1_000n}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const t = text(html);
    expect(t).toContain("Your escrow of 0.01 ETH is refunded.");
    expect(t).toMatch(/Your own top-ups \( 0\.02 ETH \) are not part of the escrow/);
    expect(t).toContain("reclaim them");
    expect(t).not.toContain("other funders");
  });

  it("cancel confirmation: own top-ups and other funders are split", () => {
    const own = parseEther("0.005");
    const t = text(renderToStaticMarkup(
      <CancelConfirm
        info={info({ bounty: ESCROW + TOPUP, ownerStake: ESCROW })}
        ownTopUps={own}
        nowSec={1_000n}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    ));
    expect(t).toMatch(/Your own top-ups \( 0\.005 ETH \)/);
    expect(t).toMatch(/other funders \( 0\.015 ETH \)/);
  });

  it("cancel confirmation: while the owner's stake is unknown it does not call the whole pot other funders' money", () => {
    const t = text(renderToStaticMarkup(
      <CancelConfirm
        info={info({ bounty: ESCROW + TOPUP, ownerStake: ESCROW })}
        ownTopUps={undefined}
        nowSec={1_000n}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    ));
    expect(t).not.toContain("other funders");
    expect(t).toContain("you included");
  });

  it("dashboard card of a cancelled switch offers to reclaim the owner's own top-ups", () => {
    connect(OWNER);
    // After cancel: the escrow left (ownerStake 0); the owner's top-up stays in the pot as a funder stake.
    show(info({ state: "cancelled", stateCode: 5, bounty: TOPUP, ownerStake: 0n }), 2_000n);
    m.funderStake = TOPUP;
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />));
    expect(t).toContain("You cancelled this switch.");
    expect(t).toMatch(/Your own top-ups of 0\.02 ETH/);
    expect(t).toContain("Reclaim 0.02 ETH");
  });

  it("dashboard card, rescue open, no escrow left: the owner's own top-ups are still offered", () => {
    connect(OWNER);
    show(info({ bounty: TOPUP, ownerStake: 0n }), EXPIRES + BigInt(RESCUE_DELAY) + 10n);
    m.funderStake = TOPUP;
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />));
    expect(t).toContain("Reclaim 0.02 ETH");
  });

  it("no top-ups: the cancelled dashboard card is unchanged and offers no reclaim", () => {
    connect(OWNER);
    show(info({ state: "cancelled", stateCode: 5, bounty: 0n, ownerStake: 0n }), 2_000n);
    m.funderStake = 0n;
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />));
    expect(t).toContain("You cancelled this switch. Your escrow was refunded and the key will never be released.");
    expect(t).not.toContain("Reclaim");
    expect(t).not.toContain("top-ups");
  });
});

// ---------- cancel in the last slots ----------

describe("#23 cancel in the last slots before the deadline", () => {
  const confirm = (secondsLeft: bigint) => renderToStaticMarkup(
    <CancelConfirm
      info={info()}
      ownTopUps={0n}
      nowSec={EXPIRES - secondsLeft}
      busy={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );
  const checkboxes = (html: string) => (html.match(/type="checkbox"/g) ?? []).length;

  it("under 36 s: the confirmation says the cancel may land after the deadline and needs a second acknowledgement", () => {
    for (const left of [35n, 20n, 1n]) {
      const html = confirm(left);
      const t = text(html);
      expect(t, `${left}s`).toContain("may be mined after the deadline");
      expect(t, `${left}s`).toContain("dark");
      expect(t, `${left}s`).toMatch(/refunds? nothing|no refund/);
      expect(checkboxes(html), `${left}s`).toBe(2);
      expect(html, `${left}s`).toMatch(/role="alert"/);
    }
  });

  it("36 s or more: one acknowledgement, no warning", () => {
    for (const left of [36n, 3_600n]) {
      const html = confirm(left);
      expect(text(html), `${left}s`).not.toContain("may be mined after the deadline");
      expect(checkboxes(html), `${left}s`).toBe(1);
    }
  });

  it("the owner card's late warning names the cancel too", () => {
    connect(OWNER);
    show(info(), EXPIRES - 20n);
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />));
    expect(t).toMatch(/ping or (a )?cancel/);
    expect(t).toContain("may be mined after the deadline");
  });
});

// ---------- reveal toast and label ----------

const keyRevealedReceipt = (bountyPaid: bigint, from: string = CONTRACT): TransactionReceipt => {
  const topics = encodeEventTopics({ abi: dmsAbi, eventName: "KeyRevealed", args: { switchKey: H1, revealer: OTHER } });
  const data = encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint64" }], [H2, bountyPaid, 5_000n]);
  const log = {
    address: from, topics, data, blockHash: H1, blockNumber: 10n, logIndex: 0, transactionHash: H1,
    transactionIndex: 0, removed: false,
  } as unknown as Log;
  return { logs: [log], status: "success", transactionHash: H1, blockNumber: 10n } as unknown as TransactionReceipt;
};

describe("#10 reveal reports what KeyRevealed paid, not the bounty read before sending", () => {
  const darkMarked = (over: Partial<SwitchInfo> = {}) =>
    info({ state: "darkMarked", stateCode: 3, darkMarkedAt: EXPIRES + 10n, bounty: parseEther("0.05"), ...over });
  const kmsResult = { dataKey: H2, decryptionProof: "0x1234", check: { status: "ok" } };

  const clickReveal = async (paid: bigint) => {
    connect(OTHER);
    show(darkMarked(), EXPIRES + 100n);
    m.kms = { result: kmsResult };
    m.revealWrite = async () => ({ hash: H1, receipt: keyRevealedReceipt(paid) });
    renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />);
    await gatedButton("reveal the key").props.onClick();
    expect(m.toast.success).toHaveBeenCalledTimes(1);
    return m.toast.success.mock.calls[0][0] as string;
  };

  it("bounty drained before the reveal landed: the toast does not claim the stale 0.05 ETH", async () => {
    const msg = await clickReveal(0n);
    expect(msg).not.toContain("0.05");
    expect(msg).toMatch(/nothing was paid/i);
  });

  it("partly drained: the toast states the amount actually paid", async () => {
    const msg = await clickReveal(parseEther("0.03"));
    expect(msg).toContain("0.03 ETH paid to you");
    expect(msg).not.toContain("0.05");
  });

  it("rescue open: the claim is labelled 'up to', since depositors may reclaim first", () => {
    connect(OTHER);
    show(darkMarked(), EXPIRES + BigInt(RESCUE_DELAY) + 10n);
    m.kms = { result: kmsResult };
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
    expect(t).toContain("Reveal and claim up to 0.05 ETH");
    expect(t).toMatch(/depositors may reclaim/i);
  });

  it("rescue not open: the claim keeps the plain amount", () => {
    connect(OTHER);
    show(darkMarked(), EXPIRES + 100n);
    m.kms = { result: kmsResult };
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
    expect(t).toContain("Reveal and claim 0.05 ETH");
  });
});

// ---------- create form inputs ----------

describe("#24 custom interval below 1 unit", () => {
  it("the create form leaves validation to the app (no native min check blocks a valid 0.5 days)", () => {
    m.config = { data: config(5n * USD8), isLoading: false, error: null };
    connect(OWNER);
    const html = renderToStaticMarkup(<CreateSwitchForm />);
    // HTML attribute names are case-insensitive: React 18 wrote `novalidate=""`, React 19 writes the
    // prop name as is (`noValidate=""`); the browser parses both as the form's novalidate attribute.
    expect(html).toMatch(/<form[^>]*novalidate=""/i);
  });
});

describe("#25 decimal comma in amount fields", () => {
  it("ETH: a lone decimal comma reads as a decimal point", () => {
    expect(parseEthInput("0,005")).toBe(parseEther("0.005"));
    expect(parseEthInput(" 1,5 ")).toBe(parseEther("1.5"));
    expect(parseEthInput("0.005")).toBe(parseEther("0.005"));
  });

  it("ETH: anything else is still rejected or empty", () => {
    expect(parseEthInput("")).toBeNull();
    expect(parseEthInput("1,000.5")).toBeUndefined();
    expect(parseEthInput("1,2,3")).toBeUndefined();
    expect(parseEthInput("-1")).toBeUndefined();
    expect(parseEthInput("abc")).toBeUndefined();
  });

  it("USD (admin floor): a lone decimal comma reads as a decimal point", () => {
    expect(parseUsdInput("12,50")).toBe(1_250_000_000n);
    expect(parseUsdInput("10")).toBe(1_000_000_000n);
    expect(() => parseUsdInput("1,000.50")).toThrow();
  });
});

// ---------- commitment mismatch with a published plaintext ----------

describe("#26 revealed switch: key opens the ciphertext, commitment mismatch, committed plaintext published", () => {
  const B = new TextEncoder().encode("DECRYPTABLE-BUT-UNCOMMITTED-B");
  const A = "COMMITTED-PLAINTEXT-A";
  const revealed = () => info({ state: "revealed", stateCode: 4, revealedAt: 5_000n, revealedKey: H2, bounty: 0n, published: true });
  const mismatch = { status: "commitment-mismatch", commitmentMatches: false, salt: new Uint8Array(32), saltHex: H1, plaintext: B, plaintextHex: toHex(B), commitment: H2 };

  it("shows the commitment-checked published copy next to the decrypted one, and does not call publishing impossible", () => {
    for (const variant of ["detail", "archive"] as const) {
      show(revealed(), 10_000n);
      m.revealedSecret = { data: mismatch, isLoading: false, error: null };
      m.published = { ...m.published, data: { payload: toHex(new TextEncoder().encode(A)), publisher: OTHER, txHash: H1, blockNumber: 9n } };
      const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant={variant} />));
      expect(t, variant).toContain("DECRYPTABLE-BUT-UNCOMMITTED-B");
      expect(t, variant).toContain(A);
      expect(t, variant).toContain("commitment-checked by the contract");
      expect(t, variant).not.toContain("publishing it on-chain is impossible");
      expect(t, variant).toContain("both shown");
    }
  });

  it("not published: says the decrypted bytes can never be published", () => {
    show(info({ state: "revealed", stateCode: 4, revealedAt: 5_000n, revealedKey: H2, bounty: 0n, published: false }), 10_000n);
    m.revealedSecret = { data: mismatch, isLoading: false, error: null };
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
    expect(t).toContain("can never be published on-chain");
    expect(t).not.toContain("commitment-checked by the contract");
  });
});

// ---------- the owner's full address ----------

describe("#29 a party's address is shown in full", () => {
  it("switch page: the header and Technical details show the full checksummed owner as text", () => {
    m.params = { chainId: "11155111", owner: OWNER.toLowerCase(), id: "7" };
    show(info(), 2_000n);
    const t = text(renderToStaticMarkup(<SwitchDetailPage />));
    expect(t.split(getAddress(OWNER)).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("list cards show the full owner as text (not only in a title or link)", () => {
    show(info(), 2_000n);
    for (const variant of ["hunter", "archive", "owner"] as const) {
      expect(text(renderToStaticMarkup(<SwitchCard handle={handle} variant={variant} />)), variant).toContain(OWNER);
    }
  });

  it("the publisher of a published plaintext is shown in full", () => {
    show(info({ state: "revealed", stateCode: 4, revealedAt: 5_000n, revealedKey: H2, bounty: 0n, published: true }), 10_000n);
    const pt = new TextEncoder().encode("hello");
    m.revealedSecret = { data: { status: "ok", commitmentMatches: true, salt: new Uint8Array(32), saltHex: H1, plaintext: pt, plaintextHex: toHex(pt), commitment: H1 }, isLoading: false, error: null };
    m.published = { ...m.published, data: { payload: toHex(pt), publisher: OTHER, txHash: H1, blockNumber: 9n } };
    expect(text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />))).toContain(OTHER);
  });

  it("admin page: the admin address is not clipped with an ellipsis", () => {
    m.config = { data: config(5n * USD8), isLoading: false, error: null };
    const html = renderToStaticMarkup(<AdminPage />);
    const tag = new RegExp(`<a[^>]*>${OWNER}</a>`).exec(html)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toContain("truncate");
  });
});

// ---------- cancelled switch "bounty" ----------

describe("#32 a cancelled switch's leftover contributions are not a bounty", () => {
  const cell = (html: string) => /<dl[^>]*>(.*?)<\/dl>/.exec(html)?.[1] ?? "";

  it("labels them as unreclaimed contributions, without the USD bounty hint", () => {
    m.config = { data: config(5n * USD8), isLoading: false, error: null };
    show(info({ state: "cancelled", stateCode: 5, bounty: parseEther("0.005"), ownerStake: 0n }), 2_000n);
    const dl = cell(renderToStaticMarkup(<SwitchCard handle={handle} variant="hunter" />));
    expect(text(dl)).toContain("Unreclaimed contributions 0.005 ETH");
    expect(dl).not.toContain(">Bounty<");
    expect(dl).not.toContain("≈ $");
  });

  it("all reclaimed: says none", () => {
    show(info({ state: "cancelled", stateCode: 5, bounty: 0n, ownerStake: 0n }), 2_000n);
    const dl = cell(renderToStaticMarkup(<SwitchCard handle={handle} variant="hunter" />));
    expect(text(dl)).toContain("Unreclaimed contributions None");
  });

  it("alive and revealed switches keep their bounty cell", () => {
    m.config = { data: config(5n * USD8), isLoading: false, error: null };
    show(info(), 2_000n);
    expect(cell(renderToStaticMarkup(<SwitchCard handle={handle} variant="hunter" />))).toContain(">Bounty<");
    expect(cell(renderToStaticMarkup(<SwitchCard handle={handle} variant="hunter" />))).toContain("≈ $");
  });
});

// ---------- funders' contributions are locked while the owner pings ----------

describe("#34 funders are told a contribution cannot be withdrawn while the owner keeps pinging", () => {
  it("the funding form of someone else's switch says so", () => {
    connect(OTHER);
    show(info(), 2_000n);
    const t = text(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />));
    expect(t).toMatch(/cannot withdraw/i);
    expect(t).toContain("keeps pinging");
    expect(t).toContain("cancels");
    expect(t).toContain("30 days");
  });

  it("the docs page says so", () => {
    const t = text(renderToStaticMarkup(<DocsPage />));
    expect(t).toMatch(/cannot (be )?withdraw/i);
    expect(t).toContain("keeps pinging");
  });
});

// ---------- renounce admin ----------

describe("#36 renounce admin does not promise it cannot block new switches", () => {
  it("states that a live feed with an absurd price would block new switches for good", () => {
    m.config = { data: config(5n * USD8), isLoading: false, error: null };
    m.isAdmin = true;
    connect(OWNER);
    const t = text(renderToStaticMarkup(<AdminPage />));
    expect(t).not.toContain("cannot brick");
    expect(t).toContain("absurd price");
    expect(t).toContain("nobody could set");
  });
});

// ---------- writes sent before a reload ----------

describe("a write sent before a reload is shown by the switch it belongs to", () => {
  const TX_LINK = `https://sepolia.etherscan.io/tx/${H1}`;
  /** Every call of these hooks was given this switch (so lib resumes its pending write, and refuses a duplicate). */
  const gotHandle = (...names: string[]) => {
    for (const n of names) {
      expect(m.hookArgs[n], n).toBeDefined();
      expect(m.hookArgs[n], n).toEqual(m.hookArgs[n].map(() => handle));
    }
  };
  const revealedOk = () => {
    const pt = new TextEncoder().encode("hello");
    m.revealedSecret = {
      data: { status: "ok", commitmentMatches: true, salt: new Uint8Array(32), saltHex: H1, plaintext: pt, plaintextHex: toHex(pt), commitment: H1 },
      isLoading: false, error: null,
    };
  };

  it("owner controls: ping, cancel and rescue hooks are given the switch", () => {
    connect(OWNER);
    show(info(), 2_000n);
    renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />);
    gotHandle("usePing", "useCancelSwitch", "useRescueOwnerStake");
  });

  it("release panel: markDark and revealKey hooks are given the switch", () => {
    connect(OTHER);
    show(info({ state: "darkMarked", stateCode: 3, darkMarkedAt: EXPIRES + 10n }), EXPIRES + 100n);
    renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />);
    gotHandle("useMarkDark", "useRevealKey");
  });

  it("publish action: the publishPlaintext hook is given the switch", () => {
    connect(OTHER);
    show(info({ state: "revealed", stateCode: 4, revealedAt: 5_000n, revealedKey: H2, bounty: 0n }), 10_000n);
    revealedOk();
    renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />);
    gotHandle("usePublishPlaintext");
  });

  it("a resumed reveal and a resumed publish show their hash", () => {
    connect(OTHER);
    show(info({ state: "darkMarked", stateCode: 3, darkMarkedAt: EXPIRES + 10n }), EXPIRES + 100n);
    m.writes.useRevealKey = { pending: true, hash: H1 };
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />)).toContain(TX_LINK);
    m.writes = { usePublishPlaintext: { pending: true, hash: H1 } };
    show(info({ state: "revealed", stateCode: 4, revealedAt: 5_000n, revealedKey: H2, bounty: 0n }), 10_000n);
    revealedOk();
    expect(renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />)).toContain(TX_LINK);
  });

  it("the verdict on a resumed write stays in view (no toast reports it)", () => {
    const VERDICT = `Transaction ${H1} was replaced: another transaction from your account used its nonce.`;
    connect(OWNER);
    show(info(), 2_000n);
    m.writes.useCancelSwitch = { pending: false, hash: null, error: VERDICT };
    let html = renderToStaticMarkup(<SwitchCard handle={handle} variant="owner" />);
    expect(html).toMatch(/role="alert"[^>]*>[^<]*was replaced/);

    connect(OTHER);
    m.writes = { useMarkDark: { pending: false, hash: null, error: VERDICT } };
    show(info(), EXPIRES + 100n);
    html = renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />);
    expect(html).toMatch(/role="alert"[^>]*>[^<]*was replaced/);

    m.writes = { usePublishPlaintext: { pending: false, hash: null, error: VERDICT } };
    show(info({ state: "revealed", stateCode: 4, revealedAt: 5_000n, revealedKey: H2, bounty: 0n }), 10_000n);
    revealedOk();
    html = renderToStaticMarkup(<SwitchCard handle={handle} variant="detail" />);
    expect(html).toMatch(/role="alert"[^>]*>[^<]*was replaced/);
  });
});
