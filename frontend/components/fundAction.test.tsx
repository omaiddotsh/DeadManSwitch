// The funder's form and the pending-transaction line, rendered with
// react-dom/server against mocked data hooks (no browser, no chain): a top-up
// still pending after a reload stays in view and blocks a second one, a lost
// wallet answer is shown as "may have been sent", a verdict stays visible, and
// the amount field reads a decimal comma.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseEther, type Hex } from "viem";
import { LATE_TX_RISK_SECONDS, type SwitchHandle, type SwitchInfo } from "@/lib/switch";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const H1 = `0x${"11".repeat(32)}` as Hex;

type Write = { pending: boolean; hash: string | null; error?: string | null; unconfirmed?: boolean; dismissUnconfirmed?: () => void; contractAccount?: boolean };
const m = vi.hoisted(() => ({
  account: { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as string | undefined, isConnected: true },
  fund: { pending: false, hash: null } as Write,
  reclaim: { pending: false, hash: null } as Write,
  stake: 0n,
  hookArgs: [] as unknown[],
  nowSec: 1_000n as bigint | null,
}));

vi.mock("wagmi", () => ({ useAccount: () => m.account }));
vi.mock("@/components/ui/ActionGate", () => ({ ActionGate: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }) }));
vi.mock("@/lib/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hooks")>()),
  useEffectiveChain: () => ({ chainId: 11155111, address: CONTRACT, isConnected: true, isSupported: true }),
  useChainTime: () => ({ nowSec: m.nowSec, blockTimestamp: m.nowSec, isLoading: false }),
  useFunderStake: () => ({ data: m.stake }),
  useFundBounty: (h?: unknown) => { m.hookArgs.push(h); return { write: async () => ({}), error: null, reset: () => {}, ...m.fund }; },
  useReclaimContribution: (h?: unknown) => { m.hookArgs.push(h); return { write: async () => ({}), error: null, reset: () => {}, ...m.reclaim }; },
}));

const { FundAction, sendTopUp, topUpInput } = await import("./switch/FundAction");
const { TxDroppedError, TxUnconfirmedError } = await import("@/lib/hooks");
const { WriteUnconfirmedError } = await import("@/lib/pendingWrites");
const { PendingTx } = await import("./ui/PendingTx");

const HANDLE: SwitchHandle = { contractAddr: CONTRACT, owner: OWNER, id: 11n };
const INFO = {
  owner: OWNER, stateCode: 1, state: "alive", lastPing: 0n, pingInterval: 86_400n, createdAt: 0n, expiresAt: 10_000n,
  darkMarkedAt: 0n, revealedAt: 0n, bounty: parseEther("0.01"), ownerStake: parseEther("0.01"), exists: true,
  plaintextCommitment: "0x", encKeyHandle: "0x", revealedKey: "0x", ciphertextLength: 0n, published: false, rescuable: false,
} as unknown as SwitchInfo;

const render = (nowSec = 1_000n, state: "alive" | "cancelled" = "alive", isOwner = false) =>
  renderToStaticMarkup(<FundAction handle={HANDLE} info={INFO} state={state} nowSec={nowSec} isOwner={isOwner} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ");

beforeEach(() => {
  m.fund = { pending: false, hash: null };
  m.reclaim = { pending: false, hash: null };
  m.stake = 0n;
  m.hookArgs = [];
  m.nowSec = 1_000n;
});

describe("#0: a top-up sent before a reload", () => {
  it("the form asks the hooks for this switch's writes, so one sent before the reload shows (and blocks) here", () => {
    render();
    expect(m.hookArgs).toEqual([HANDLE, HANDLE]);
  });

  it("still pending: its hash shows and 'Add ETH' and the amount are disabled", () => {
    m.fund = { pending: true, hash: H1 };
    const html = render();
    expect(html).toContain(H1);
    expect(text(html)).toMatch(/Don't send it again/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Add ETH/);
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });
});

describe("F2: a top-up whose wallet answer was lost", () => {
  it("says it may have been sent, to check the wallet, and offers a way out once checked; the form stays off", () => {
    const dismiss = vi.fn();
    m.fund = { pending: true, hash: null, unconfirmed: true, dismissUnconfirmed: dismiss };
    const html = render();
    const t = text(html);
    expect(t).toMatch(/may have been sent/i);
    expect(t).toMatch(/check your wallet/i);
    expect(t).not.toMatch(/revert/i);
    expect(t).toMatch(/Nothing was sent/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Add ETH/);
  });

  it("PendingTx shows the same for any write hook (the line is shared)", () => {
    const html = renderToStaticMarkup(<PendingTx writes={[{ pending: true, hash: null, unconfirmed: true, dismissUnconfirmed: () => {} }]} />);
    expect(text(html)).toMatch(/may have been sent/i);
    // A write still in the wallet (no hash, not unconfirmed) shows nothing yet.
    expect(renderToStaticMarkup(<PendingTx writes={[{ pending: true, hash: null }]} />)).toBe("");
  });
});

describe("K2: a verdict about a top-up stays in view", () => {
  it("'the app can't see it, check your wallet' is shown under the form, not only in a toast", () => {
    m.fund = { pending: false, hash: null, error: `Transaction ${H1} has not been mined, and this app can't see it on the network any more. Check your wallet's activity before sending another top-up.` };
    const t = text(render());
    expect(t).toContain(H1);
    expect(t).toMatch(/check your wallet/i);
  });

  it("a reclaim's verdict too, on a cancelled switch", () => {
    m.stake = parseEther("0.5");
    m.reclaim = { pending: false, hash: null, error: "Transaction reverted on-chain." };
    expect(text(render(1_000n, "cancelled"))).toMatch(/reverted on-chain/);
  });
});

describe("#25: the top-up amount reads a decimal comma like the create form", () => {
  it("'0,005' is 0.005 ETH, echoed back", () => {
    expect(topUpInput("0,005")).toEqual({ value: parseEther("0.005"), error: null, readAs: "0.005" });
  });
  it("plain amounts, empty, zero and garbage", () => {
    expect(topUpInput(" 0.25 ")).toEqual({ value: parseEther("0.25"), error: null, readAs: null });
    expect(topUpInput("")).toEqual({ value: null, error: null, readAs: null });
    expect(topUpInput("0")).toMatchObject({ value: null, error: expect.stringMatching(/above zero/) });
    expect(topUpInput("1,000.5")).toMatchObject({ value: null, error: expect.stringMatching(/above zero/) });
    expect(topUpInput("abc")).toMatchObject({ value: null, error: expect.any(String) });
  });
});

describe("a top-up in the last slots before the deadline", () => {
  it(`under ${Number(LATE_TX_RISK_SECONDS)} s left: warns that it may be mined after the deadline, revert and cost gas`, () => {
    const t = text(render(INFO.expiresAt - LATE_TX_RISK_SECONDS + 1n));
    expect(t).toMatch(/may be mined after the deadline/);
    expect(t).toMatch(/cost gas/);
  });
  it("with more time left: no warning", () => {
    expect(text(render(INFO.expiresAt - LATE_TX_RISK_SECONDS))).not.toMatch(/after the deadline/);
  });
});

describe("a stuck ping or cancel says to speed it up in the wallet, with the time left", () => {
  it("a pending ping with 100 s to the deadline: speed it up (same transaction, higher fee); 1m 40s left", () => {
    const t = text(renderToStaticMarkup(<PendingTx writes={[{ pending: true, hash: H1, deadline: 1_100n }]} />));
    expect(t).toMatch(/speed it up in your wallet/i);
    expect(t).toMatch(/higher fee/);
    expect(t).toContain("1m 40s");
    expect(t).toMatch(/another one would not help|sending another/i);
  });

  it("past the deadline: says it can no longer help", () => {
    m.nowSec = 1_200n;
    const t = text(renderToStaticMarkup(<PendingTx writes={[{ pending: true, hash: H1, deadline: 1_100n }]} />));
    expect(t).toMatch(/deadline has passed/i);
    expect(t).not.toMatch(/speed it up/i);
  });

  it("writes not bound to the deadline (a top-up, markDark) get no such hint", () => {
    const t = text(renderToStaticMarkup(<PendingTx writes={[{ pending: true, hash: H1 }]} />));
    expect(t).not.toMatch(/speed it up/i);
  });
});

describe("F2b: a top-up whose wallet answer was lost, then shows up on the switch, is a success like any other", () => {
  /** useTxToast's contract: the result, or null after showing the error. */
  const harness = () => {
    const log: string[] = [];
    let landed: ((how: { matched: boolean }) => void) | undefined;
    const d = {
      tx: async <T,>(send: () => Promise<T>, success: string): Promise<T | null> => {
        try { const r = await send(); log.push(`success toast: ${success}`); return r; } catch (e) { log.push(`error toast: ${(e as Error).name}`); return null; }
      },
      success: (msg: string) => { log.push(`success toast: ${msg}`); },
      clear: () => { log.push("amount cleared"); },
    };
    const write = (outcome: () => Promise<{ hash: Hex }>) =>
      vi.fn(async (_h: SwitchHandle, _v: bigint, opts?: { landed?: (how: { matched: boolean }) => void }) => { landed = opts?.landed; return outcome(); });
    return { log, d, write, land: (matched = true) => landed?.({ matched }) };
  };
  const lostAnswer = () => new WriteUnconfirmedError({
    chainId: 11155111, contract: CONTRACT, fn: "fundBounty", owner: OWNER, id: 11n, hash: null, from: OWNER, nonce: 7,
    value: parseEther("0.005"), sentAt: 1, stakeBefore: 0n, call: null,
  }, new Error("lost"));

  it("the wallet's answer is lost: 'may have been sent', the amount kept (the form is locked); it lands: cleared, with the success toast", async () => {
    const h = harness();
    const write = h.write(async () => { throw lostAnswer(); });
    await sendTopUp({ ...h.d, write }, HANDLE, parseEther("0.005"));
    expect(h.log).toEqual(["error toast: WriteUnconfirmedError"]);
    h.land(true);
    expect(h.log).toEqual(["error toast: WriteUnconfirmedError", "amount cleared", "success toast: Bounty topped up by 0.005 ETH"]);
  });

  it("a top-up that landed but is not matched to this send (another tab, device or the CLI) is worded neutrally; the amount is still cleared", async () => {
    const h = harness();
    await sendTopUp({ ...h.d, write: h.write(async () => { throw lostAnswer(); }) }, HANDLE, parseEther("0.005"));
    h.land(false);
    expect(h.log).toEqual([
      "error toast: WriteUnconfirmedError", "amount cleared", "success toast: A top-up of 0.005 ETH from your account landed on this switch.",
    ]);
  });

  it("a plain success clears the amount; a rejection or a refusal before the wallet keeps it", async () => {
    const ok = harness();
    await sendTopUp({ ...ok.d, write: ok.write(async () => ({ hash: H1 })) }, HANDLE, parseEther("0.005"));
    expect(ok.log).toEqual(["success toast: Bounty topped up by 0.005 ETH", "amount cleared"]);
    const no = harness();
    await sendTopUp({ ...no.d, write: no.write(async () => { throw new Error("Request rejected in the wallet."); }) }, HANDLE, parseEther("0.005"));
    expect(no.log).toEqual(["error toast: Error"]);
  });

  it("a verdict that it may still land ('dropped' for a top-up, not confirmed, a Safe's request not executed): the amount is cleared", async () => {
    for (const e of [new TxDroppedError(H1, true), new TxUnconfirmedError("check your wallet")]) {
      const h = harness();
      await sendTopUp({ ...h.d, write: h.write(async () => { throw e; }) }, HANDLE, parseEther("0.005"));
      expect(h.log).toEqual(["amount cleared", `error toast: ${e.name}`]);
    }
  });
});

describe("G9: a write from a contract account (a Safe) is not linked as a transaction the explorer knows", () => {
  it("its id is shown with no Etherscan link, and the line says a Safe may wait for its other owners", () => {
    const html = renderToStaticMarkup(<PendingTx writes={[{ pending: true, hash: H1, contractAccount: true }]} />);
    expect(html).toContain(H1);
    expect(html).not.toMatch(/etherscan/i);
    expect(text(html)).toMatch(/Safe/);
    expect(text(html)).toMatch(/other owners/i);
    expect(text(html)).toMatch(/Don't send it again/);
  });

  it("an ordinary account's write keeps its explorer link", () => {
    expect(renderToStaticMarkup(<PendingTx writes={[{ pending: true, hash: H1 }]} />)).toMatch(/etherscan\.io\/tx\//);
  });
});

describe("the owner's own top-ups (FundAction shown to the owner)", () => {
  it("after the owner cancelled, the owner reads 'You cancelled', not 'The owner cancelled' about themselves", () => {
    m.stake = parseEther("0.002");
    const own = text(render(1_000n, "cancelled", true));
    expect(own).toMatch(/You cancelled/);
    expect(own).not.toMatch(/The owner cancelled/i);
    expect(own).toContain("Reclaim 0.002 ETH");
    // Anyone else still reads it about the owner.
    expect(text(render(1_000n, "cancelled", false))).toContain("The owner cancelled. Your contribution is yours to take back.");
  });

  it(`under ${Number(LATE_TX_RISK_SECONDS)} s left: no second late warning for the owner (OwnerActions already warns); a funder still gets it`, () => {
    const near = INFO.expiresAt - LATE_TX_RISK_SECONDS + 1n;
    expect(text(render(near, "alive", true))).not.toMatch(/Under \d+ s to the deadline/);
    expect(text(render(near, "alive", false))).toMatch(/Under \d+ s to the deadline: a top-up sent now may be mined after the deadline/);
  });
});
