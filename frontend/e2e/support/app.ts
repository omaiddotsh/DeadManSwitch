// Page helpers for the DeadManSwitch UI. The app has no data-testid hooks,
// so these use roles, labels and visible text (RainbowKit's own rk-* test ids
// for its buttons). Every wait is on visible state, never a fixed sleep.
//
// UI polling cadence (lib/hooks.ts), which bounds how long a change made
// outside the page takes to show: chain time every 12 s, a switch's info
// every 15 s (5 min once cancelled or revealed), the SwitchCreated scan every
// 60 s. A write made in the page refreshes its switch at once.

import { expect, type Locator, type Page } from "@playwright/test";
import { getAddress, parseEther, type Address } from "viem";
import { addressOf, rainbowKitAddress, type Role } from "./env";
import type { Chain } from "./chain";
import { WALLET_NAME, type WalletHandle } from "./wallet";

/** One chain-time poll (12 s) plus one switch-info poll (15 s), with margin. */
export const POLL_TIMEOUT = 45_000;
/** A write: wallet → anvil (automine) → viem's receipt poll (4 s) → refetch. */
export const TX_TIMEOUT = 45_000;

export interface CreatedSwitch {
  id: bigint;
  owner: Address;
  /** /switch/31337/<owner>/<id> */
  path: string;
}

export type IntervalPreset = "1 minute (testing)" | "1 hour" | "1 day" | "7 days" | "30 days" | "90 days" | "1 year";

/** "1m", "59s", "1h 2m 3s" (lib/switch.ts fmtDuration) → seconds. */
export const parseDuration = (text: string): number => {
  const t = text.trim();
  const neg = t.startsWith("-");
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+)\s*([dhms])/g)) {
    matched = true;
    total += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2] as "d" | "h" | "m" | "s"];
  }
  if (!matched) throw new Error(`not a duration: "${text}"`);
  return neg ? -total : total;
};

export class App {
  constructor(
    readonly page: Page,
    readonly wallet: WalletHandle,
    readonly chain: Chain,
  ) {}

  // ---------- navigation and wallet ----------

  /** The site header (the only top-level <header>). */
  header(): Locator {
    return this.page.getByRole("banner");
  }

  nav(label: "My switches" | "Hunt" | "Archive" | "How it works" | "Admin"): Locator {
    return this.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label, exact: true });
  }

  accountButton(): Locator {
    return this.page.getByTestId("rk-account-button");
  }

  /** Connect through RainbowKit's modal as the wallet's current account. */
  async connect(): Promise<Address> {
    const { account } = await this.wallet.snapshot();
    await this.page.getByTestId("rk-connect-button").click();
    const dialog = this.page.getByRole("dialog");
    await expect(dialog.getByText("Installed", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: WALLET_NAME }).click();
    await expect(dialog).toBeHidden();
    await expect(this.accountButton()).toContainText(rainbowKitAddress(account));
    return getAddress(account);
  }

  /** Switch the wallet's account (accountsChanged) and wait for the app to follow. */
  async switchAccount(role: Role): Promise<Address> {
    const a = await this.wallet.use(role);
    await expect(this.accountButton()).toContainText(rainbowKitAddress(a));
    return a;
  }

  // ---------- toasts ----------

  /**
   * A success or info toast (role=status) containing `text`. Toasts are told
   * apart from other live regions (pending-transaction lines, Next's route
   * announcer) by their "Dismiss notification" button.
   */
  toast(text: string | RegExp): Locator {
    return this.page.getByRole("status").filter({ hasText: text }).filter({ has: this.dismiss() });
  }

  /** An error toast (role=alert) containing `text`. */
  errorToast(text: string | RegExp): Locator {
    return this.page.getByRole("alert").filter({ hasText: text }).filter({ has: this.dismiss() });
  }

  private dismiss(): Locator {
    return this.page.getByRole("button", { name: "Dismiss notification" });
  }

  async expectToast(text: string | RegExp, timeout = TX_TIMEOUT): Promise<void> {
    await expect(this.toast(text).first()).toBeVisible({ timeout });
  }

  // ---------- create ----------

  /** On /dashboard: fill the create form, submit, and wait for "Switch created". */
  async createSwitch(opts: { secret: string; interval: IntervalPreset; bountyEth: string }): Promise<CreatedSwitch> {
    const form = this.page.locator("form").filter({ has: this.page.getByRole("heading", { name: "Create a switch" }) });
    await expect(form).toBeVisible();
    await form.getByLabel("The secret").fill(opts.secret);
    await form.getByRole("button", { name: opts.interval, exact: true }).click();
    await expect(form.getByRole("button", { name: opts.interval, exact: true })).toHaveAttribute("aria-pressed", "true");
    await form.getByLabel("Bounty").fill(opts.bountyEth);
    const submit = form.getByRole("button", { name: "Encrypt and create" });
    await expect(submit).toBeEnabled();
    await submit.click();

    const created = this.page.locator("section").filter({ has: this.page.getByRole("heading", { name: "Switch created" }) });
    await expect(created).toBeVisible({ timeout: 120_000 });
    const href = await created.getByRole("link", { name: "Open the switch page" }).getAttribute("href");
    // Links name the switch's deployment (lib/switch.ts switchPath).
    const m = /^\/switch\/31337\/(0x[0-9a-fA-F]{40})\/(\d+)\?contract=0x[0-9a-fA-F]{40}$/.exec(href ?? "");
    if (!m) throw new Error(`unexpected switch link "${href}"`);
    const sw = { id: BigInt(m[2]!), owner: getAddress(m[1]!), path: href! };
    await expect(created).toContainText(`Switch #${sw.id} is live on Anvil (local).`);

    // The chain agrees.
    const info = await this.chain.switchInfo(sw.owner, sw.id);
    expect(info.state).toBe("alive");
    expect(info.bounty).toBe(parseEther(opts.bountyEth));
    return sw;
  }

  // ---------- switch cards ----------

  /** The card of one switch (dashboard, hunt, archive or switch page): <article aria-label="Switch <id>">. */
  card(id: bigint): Locator {
    return this.page.getByRole("article", { name: `Switch ${id}`, exact: true });
  }

  /** The state pill of a card ("Alive", "Dark", "Key release requested", "Revealed", "Cancelled"). */
  pill(card: Locator, label: string): Locator {
    return card.locator(".pill").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });
  }

  /** The value next to a <dt> label in a card's summary (Bounty, Ping interval, Last ping, Deadline). */
  fact(card: Locator, label: string): Locator {
    return card.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
  }

  /** Seconds the card's "Goes dark in" countdown shows. */
  async countdown(card: Locator): Promise<number> {
    const value = card.getByText("Goes dark in", { exact: true }).locator("xpath=following-sibling::div[1]");
    return parseDuration(await value.innerText());
  }

  /** Open a switch page directly and wait for its card. */
  async openSwitch(sw: CreatedSwitch): Promise<Locator> {
    await this.page.goto(sw.path);
    await expect(this.page.getByRole("heading", { name: `Switch #${sw.id}` })).toBeVisible();
    const card = this.card(sw.id);
    await expect(card).toBeVisible({ timeout: POLL_TIMEOUT });
    return card;
  }

  addressOf(role: Role): Address {
    return addressOf(role);
  }
}
