// The UI screenshot set, for a UI/UX design review. Skipped unless E2E_SCREENS=1:
//
//   E2E_SCREENS=1 E2E_SCREENS_DIR=/some/dir ../scripts/browser-e2e.sh e2e/screens.spec.ts
//
// Drives the real app on the local stack (the same Anvil, contract, CLI and
// test wallet as the specs) into every page and state worth reviewing, and
// saves a full-page screenshot of each:
//
//   <dir>/desktop/<NN>-<page>-<state>.png   1440x900
//   <dir>/mobile/<NN>-<page>-<state>.png    390x844, touch, 2x (desktop user agent, so RainbowKit
//                                           lists the injected test wallet; 03 shows the modal an
//                                           iPhone user agent gets)
//   <dir>/desktop-dark/…                    only if the app renders differently under
//                                           prefers-color-scheme: dark (checked first, see index.json)
//   <dir>/index.json                        every shot (file, page, state, viewport, and the console
//                                           errors, page errors and failed requests seen while reaching
//                                           it), the states that were not captured and why, and the
//                                           colour-scheme check
//
// E2E_SCREENS_DIR defaults to test-results/screens. Run it on a fresh stack
// (scripts/browser-e2e.sh starts one): the empty dashboard, /hunt and /archive
// need a contract with no switches yet; on a used chain they are listed as
// skipped. It moves the chain clock by 31 days.
//
// Transient states are held still rather than raced:
//  - the FHE library load (create's "Prepare FHE", the hunter's key fetch): its
//    script chunks are held at the network until the shot is taken;
//  - "Confirm in your wallet": the test wallet holds eth_sendTransaction (holdNext);
//  - a sent transaction waiting for its block: Anvil's automine is off until the shot is taken;
//  - a reverted transaction (the error toast): a funder's top-up and the owner's
//    cancel land in the same block, the cancel first (a higher tip).

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Browser, BrowserContext, Locator, Page, Request, Route, TestInfo } from "@playwright/test";
import { createWalletClient, getAddress, http, parseGwei, type Hex } from "viem";
import { foundry } from "viem/chains";
import { dmsAbi } from "../lib/abi";
import { App, POLL_TIMEOUT, TX_TIMEOUT, type CreatedSwitch } from "./support/app";
import type { Chain } from "./support/chain";
import type { Cli } from "./support/cli";
import { emptyDiagnostics, watchContext, type Diagnostics } from "./support/diagnostics";
import { CHAIN_ID, addressOf, type Role } from "./support/env";
import { env, expect, test, walletConfig } from "./support/fixtures";
import { installInjectedWallet } from "./support/injected-wallet";
import { WALLET_NAME, WalletHandle } from "./support/wallet";

const SCREENS_DIR = resolve(process.env.E2E_SCREENS_DIR?.trim() || resolve(__dirname, "../test-results/screens"));

type ViewportName = "desktop" | "mobile" | "desktop-dark";
type ContextOptions = NonNullable<Parameters<Browser["newContext"]>[0]>;

const VIEWPORTS: Record<ViewportName, ContextOptions> = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" },
  "desktop-dark": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" },
};

/** What a phone's browser sends: RainbowKit then shows its mobile wallet list (deep links), not "Installed". */
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Secrets the screenshots show once released: realistic lengths and shapes.
const SECRET_UI =
  "If you are reading this, I have not checked in for an hour.\n\n" +
  "The spare key is taped under the third drawer of the oak desk. The safe code is 4-17-29-8.\n" +
  "Tell Sam the lawyer's number is in the blue folder.\n— A.";
const SECRET_UI2 =
  "Newsletter archive: every draft is on the encrypted drive labelled 2026-Q3.\n" +
  "Password hint: our first street, then the year we met.";
const SECRET_HUNT: Record<ViewportName, string> = {
  desktop:
    "To whoever releases this,\n\n" +
    "I kept a journal of everything that happened at the plant between March and September. The originals are in a " +
    "safe-deposit box at the Elm Street branch, box 1142; the bank has instructions to open it for my sister.\n\n" +
    "Copies of the inspection reports, with the dates that were changed, are on the drive in the envelope marked " +
    "\"taxes 2019\". Please send them to the two reporters named on the first page.\n\n" +
    "Thank you. I hope this was never needed.",
  mobile: `Meeting notes <b>not bold</b> & "quoted" ✓ 🔑\nThe second line is plain text.\n\tAn indented third line.`,
  "desktop-dark": "Dark-scheme release: a short note.",
};
const SECRET_FLAGGED = "invoice\u202etxt.exe\u0007 — check the attachment name above.\nThe bidi override and the bell are flagged.";

// ---------------------------------------------------------------------------

interface Mark {
  console: number;
  pageErrors: number;
  failed: number;
  http: number;
}

interface Viewer {
  name: ViewportName;
  context: BrowserContext;
  page: Page;
  wallet: WalletHandle;
  app: App;
  diag: Diagnostics;
  mark: Mark;
  /** App requests (not Anvil) in flight. */
  inflight: () => number;
}

interface ShotEntry {
  file: string;
  viewport: ViewportName;
  id: string;
  page: string;
  state: string;
  consoleErrors: string[];
  consoleWarnings: string[];
  /** Console lines about blocked non-local hosts (WalletConnect, telemetry). */
  externalConsole: number;
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
  /** false: the viewport only (a modal, whose backdrop is fixed to the viewport). */
  fullPage: boolean;
}

interface ShootOptions {
  /** Keep toasts on screen (otherwise they are dismissed first). */
  keepToasts?: boolean;
  /** Shoot at once: no waiting for skeletons and lazy requests (held or short-lived states). */
  quick?: boolean;
  /** The viewport only, for a modal. */
  viewportOnly?: boolean;
}

interface NotCaptured {
  id: string;
  state: string;
  viewport: string;
  reason: string;
}

const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 4)
    .join(" | ")
    .slice(0, 600);

const openViewer = async (browser: Browser, chain: Chain, name: ViewportName, extra: ContextOptions = {}): Promise<Viewer> => {
  const context = await browser.newContext({
    baseURL: env().baseURL,
    locale: "en-US",
    timezoneId: "UTC",
    ...VIEWPORTS[name],
    ...extra,
  });
  await context.addInitScript(installInjectedWallet, walletConfig("owner", CHAIN_ID));
  const diag = emptyDiagnostics();
  await watchContext(context, diag, { rpcUrl: env().rpcUrl });
  const page = await context.newPage();
  const appOrigin = new URL(env().baseURL).origin;
  const isApp = (r: Request) => {
    try {
      return new URL(r.url()).origin === appOrigin;
    } catch {
      return false;
    }
  };
  let inflight = 0;
  page.on("request", (r) => void (isApp(r) && inflight++));
  page.on("requestfinished", (r) => void (isApp(r) && inflight--));
  page.on("requestfailed", (r) => void (isApp(r) && inflight--));
  const wallet = new WalletHandle(page);
  return {
    name, context, page, wallet, app: new App(page, wallet, chain), diag,
    mark: { console: 0, pageErrors: 0, failed: 0, http: 0 },
    inflight: () => inflight,
  };
};

/** Until no app request has been in flight for 500 ms (lazy chunks, icons), at most `maxMs`. */
const quiet = async (v: Viewer, maxMs = 5_000): Promise<void> => {
  const end = Date.now() + maxMs;
  let since = 0;
  while (Date.now() < end) {
    if (v.inflight() <= 0) {
      if (!since) since = Date.now();
      else if (Date.now() - since >= 500) return;
    } else {
      since = 0;
    }
    await v.page.waitForTimeout(100);
  }
};

const settle = async (v: Viewer): Promise<void> => {
  await v.page.waitForLoadState("load").catch(() => {});
  // Skeleton cards while switch data loads.
  await expect(v.page.locator(".card.animate-pulse")).toHaveCount(0, { timeout: 30_000 }).catch(() => {});
  await quiet(v);
  await v.page.evaluate(async () => { await document.fonts.ready; }).catch(() => {});
};

const dismissToasts = async (page: Page): Promise<void> => {
  const x = page.getByRole("button", { name: "Dismiss notification" });
  for (let i = 0; i < 10 && (await x.count()) > 0; i++) await x.first().click({ timeout: 2_000 }).catch(() => {});
};

/** The console, page errors and failed requests since the last shot of this viewer. */
const take = (v: Viewer) => {
  const d = v.diag;
  const con = d.console.slice(v.mark.console);
  const out = {
    consoleErrors: con.filter((c) => c.type === "error" && !c.external).map((c) => c.text.slice(0, 400)),
    consoleWarnings: con.filter((c) => c.type === "warning" && !c.external).map((c) => c.text.slice(0, 400)),
    externalConsole: con.filter((c) => c.external).length,
    pageErrors: d.pageErrors.slice(v.mark.pageErrors).map((e) => e.message.slice(0, 400)),
    failedRequests: d.failedRequests.slice(v.mark.failed).filter((f) => !f.aborted).map((f) => `${f.method} ${f.url} (${f.failure})`),
    httpErrors: d.httpErrors.slice(v.mark.http).map((h) => `${h.status} ${h.method} ${h.url}`),
  };
  v.mark = { console: d.console.length, pageErrors: d.pageErrors.length, failed: d.failedRequests.length, http: d.httpErrors.length };
  return out;
};

class Screens {
  readonly shots: ShotEntry[] = [];
  readonly missing: NotCaptured[] = [];
  readonly skipped: NotCaptured[] = [];
  colorScheme: Record<string, unknown> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly dir: string,
    readonly testInfo: TestInfo,
  ) {}

  write(): Promise<void> {
    const data = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseURL: env().baseURL,
        contract: env().dmsAddress,
        viewports: VIEWPORTS,
        colorScheme: this.colorScheme,
        shots: this.shots,
        notCaptured: this.missing,
        skipped: this.skipped,
      },
      null,
      2,
    );
    this.writing = this.writing.then(() => writeFile(join(this.dir, "index.json"), data)).catch(() => {});
    return this.writing;
  }

  async shoot(v: Viewer, id: string, state: string, opts: ShootOptions = {}): Promise<void> {
    if (!opts.keepToasts) await dismissToasts(v.page);
    if (!opts.quick) await settle(v);
    // A full-page capture draws the sticky header (and fixed toasts) where the page is scrolled to.
    await v.page.evaluate(() => window.scrollTo(0, 0));
    const file = join(this.dir, v.name, `${id}.png`);
    await mkdir(dirname(file), { recursive: true });
    const fullPage = !opts.viewportOnly;
    await v.page.screenshot({ path: file, fullPage, animations: "disabled" });
    this.shots.push({ file, viewport: v.name, id, page: new URL(v.page.url()).pathname, state, fullPage, ...take(v) });
    console.log(`[screens] ${v.name}/${id}.png`);
    await this.write();
  }

  /** Drive `v` into a state and shoot it; a failure is recorded (index.json notCaptured) and the run goes on. */
  async step(
    v: Viewer,
    id: string,
    state: string,
    drive: () => Promise<void>,
    opts: ShootOptions = {},
  ): Promise<boolean> {
    try {
      await drive();
      await this.shoot(v, id, state, opts);
      return true;
    } catch (e) {
      const reason = errText(e);
      this.missing.push({ id, state, viewport: v.name, reason });
      console.log(`[screens] NOT CAPTURED ${v.name}/${id}: ${reason}`);
      await v.page.screenshot({ path: this.testInfo.outputPath(`not-captured-${v.name}-${id}.png`), fullPage: true }).catch(() => {});
      await this.write();
      return false;
    }
  }

  skip(id: string, state: string, viewports: string, reason: string): void {
    this.skipped.push({ id, state, viewport: viewports, reason });
    console.log(`[screens] skipped ${id}: ${reason}`);
  }
}

/** Hold every script chunk the page asks for until release() (the FHE SDK loads as chunks on first use). */
const holdChunks = async (page: Page) => {
  const pattern = "**/_next/static/chunks/**";
  const held: Route[] = [];
  const handler = (route: Route) => void held.push(route);
  await page.route(pattern, handler);
  let released = false;
  return {
    count: () => held.length,
    release: async () => {
      if (released) return;
      released = true;
      await page.unroute(pattern, handler).catch(() => {});
      for (const r of held.splice(0)) await r.continue().catch(() => {});
    },
  };
};

/** Run `fn` with Anvil's automine off; `mine` mines one block. Automine is back on (and the mempool mined) afterwards. */
const withAutomineOff = async <T>(chain: Chain, fn: (mine: () => Promise<void>) => Promise<T>): Promise<T> => {
  await chain.client.setAutomine(false);
  try {
    return await fn(async () => {
      await chain.client.mine({ blocks: 1 });
    });
  } finally {
    await chain.client.setAutomine(true).catch(() => {});
    await chain.client.mine({ blocks: 1 }).catch(() => {});
  }
};

const randomId = (): bigint => {
  let id = 0n;
  while (id === 0n) id = BigInt(`0x${randomBytes(8).toString("hex")}`);
  return id;
};

const switchAt = (owner: string, id: bigint): CreatedSwitch => {
  const o = getAddress(owner);
  return { id, owner: o, path: `/switch/31337/${o}/${id}` };
};

const parseSwitchHref = (href: string | null): CreatedSwitch => {
  const m = /^\/switch\/31337\/(0x[0-9a-fA-F]{40})\/(\d+)\?contract=0x[0-9a-fA-F]{40}$/.exec(href ?? "");
  if (!m) throw new Error(`unexpected switch link "${href}"`);
  return switchAt(m[1]!, BigInt(m[2]!));
};

/** `dms create` as `who` (the secret from a file, so any bytes go through unchanged). */
const cliCreate = async (cli: Cli, who: "owner" | "hunter" | "funder", intervalSec: number, bountyEth: string, secret: string, label: string) => {
  const id = randomId();
  const file = await cli.file(`secret-${label}.txt`, Buffer.from(secret, "utf8"));
  await cli.ok(who, ["create", id.toString(), String(intervalSec), bountyEth, "--file", file]);
  return switchAt(addressOf(who), id);
};

const createForm = (page: Page): Locator => page.locator("form").filter({ has: page.getByRole("heading", { name: "Create a switch" }) });
const submitOf = (form: Locator): Locator => form.locator('button[type="submit"]');
const pending = (scope: Locator): Locator => scope.getByText(/Waiting for it to be mined/).first();

/** Connect through RainbowKit's modal (the account button shows only an avatar on narrow screens). */
const connect = async (v: Viewer): Promise<void> => {
  await v.page.getByTestId("rk-connect-button").click();
  const dialog = v.page.getByRole("dialog");
  await dialog.getByRole("button", { name: WALLET_NAME }).click();
  await expect(dialog).toBeHidden();
  await expect(v.page.getByTestId("rk-account-button")).toBeVisible();
};

/** Select `role` in the wallet, then load `path` fresh, so the page starts as that account. */
const openAs = async (v: Viewer, role: Role, path: string): Promise<void> => {
  await v.wallet.use(role);
  await v.page.goto(path);
};

// ---------------------------------------------------------------------------

test.describe("UI screenshot set", () => {
  test.skip(process.env.E2E_SCREENS !== "1", "the UI screenshot set runs only with E2E_SCREENS=1");

  test("every page and state, at desktop and mobile widths", async ({ browser, chain, cli }, testInfo) => {
    test.setTimeout(75 * 60_000);
    await mkdir(SCREENS_DIR, { recursive: true });
    const screens = new Screens(SCREENS_DIR, testInfo);
    const dms = env().dmsAddress;
    const owner = addressOf("owner");
    const ownerWallet = createWalletClient({ chain: foundry, transport: http(env().rpcUrl) });
    const viewers: Viewer[] = [];

    try {
      // ---------------- 0. does the app have a dark scheme of its own? ----------------
      await test.step("colour scheme check", async () => {
        const probe = async (scheme: "light" | "dark") => {
          const v = await openViewer(browser, chain, "desktop", { colorScheme: scheme });
          try {
            await v.page.goto("/");
            await expect(v.page.getByRole("heading", { level: 1 })).toBeVisible();
            await settle(v);
            const png = await v.page.screenshot({ fullPage: true, animations: "disabled" });
            const css = await v.page.evaluate(() => {
              const rules: string[] = [];
              const walk = (list: CSSRuleList) => {
                for (const r of Array.from(list)) {
                  if (r instanceof CSSMediaRule) {
                    if (/prefers-color-scheme/.test(r.conditionText)) rules.push(`@media ${r.conditionText} (${r.cssRules.length} rules)`);
                    walk(r.cssRules);
                  }
                }
              };
              for (const s of Array.from(document.styleSheets)) {
                try { walk(s.cssRules); } catch { /* cross-origin */ }
              }
              const meta = document.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? null;
              return {
                prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
                colorSchemeProperty: getComputedStyle(document.documentElement).colorScheme,
                colorSchemeMeta: meta,
                bodyBackground: getComputedStyle(document.body).backgroundColor,
                mediaRules: rules,
              };
            });
            return { png, css };
          } finally {
            await v.context.close();
          }
        };
        const light = await probe("light");
        const dark = await probe("dark");
        const identical = light.png.equals(dark.png);
        screens.colorScheme = {
          emulatedLight: light.css,
          emulatedDark: dark.css,
          homeScreenshotsIdentical: identical,
          darkSchemeSupported: !identical,
          note: identical
            ? "The app has one (dark) palette and no prefers-color-scheme rule: emulating a dark preference changes nothing, so no desktop-dark set."
            : "The app renders differently under prefers-color-scheme: dark: the desktop-dark set is captured.",
        };
        await screens.write();
      });
      const darkSupported = screens.colorScheme.darkSchemeSupported === true;

      for (const name of ["desktop", "mobile", ...(darkSupported ? ["desktop-dark"] : [])] as ViewportName[]) {
        viewers.push(await openViewer(browser, chain, name));
      }

      // What is on the contract already (a fresh stack has nothing).
      const created0 = await chain.client.getContractEvents({ address: dms, abi: dmsAbi, eventName: "SwitchCreated", fromBlock: 0n });
      const revealed0 = await chain.client.getContractEvents({ address: dms, abi: dmsAbi, eventName: "KeyRevealed", fromBlock: 0n });
      const ownerHad = created0.filter((l) => getAddress(String(l.args.owner)) === owner).length;

      // ---------------- A. disconnected, then connected; nothing on the contract ----------------
      await test.step("A: home, docs, connect, empty lists", async () => {
        for (const v of viewers) {
          await screens.step(v, "01-home-disconnected", "Home, no wallet connected", async () => {
            await v.page.goto("/");
            await expect(v.page.getByRole("heading", { level: 1 })).toBeVisible();
            await expect(v.page.getByTestId("rk-connect-button")).toBeVisible();
          });
          await screens.step(v, "02-home-connect-modal", "RainbowKit connect modal (the test wallet under Installed)", async () => {
            await v.page.getByTestId("rk-connect-button").click();
            await expect(v.page.getByRole("dialog").getByRole("button", { name: WALLET_NAME })).toBeVisible();
          }, { viewportOnly: true });
          await screens.step(v, "04-docs", "How it works (/docs)", async () => {
            await v.page.goto("/docs");
            await expect(v.page.getByRole("heading", { name: "How it works", level: 1 })).toBeVisible();
          });
          await screens.step(v, "05-dashboard-disconnected", "My switches without a wallet: connect prompt", async () => {
            await v.page.goto("/dashboard");
            await expect(v.page.getByRole("heading", { name: "Connect a wallet" })).toBeVisible();
          });
          if (created0.length === 0) {
            await screens.step(v, "06-hunt-empty", "Hunt with no switches on the contract (read-only, no wallet)", async () => {
              await v.page.goto("/hunt");
              await expect(v.page.getByRole("heading", { name: "No switches on this contract yet" })).toBeVisible({ timeout: POLL_TIMEOUT });
            });
          }
          if (revealed0.length === 0) {
            await screens.step(v, "07-archive-empty", "Archive with nothing released (read-only, no wallet)", async () => {
              await v.page.goto("/archive");
              await expect(v.page.getByRole("heading", { name: "Nothing has been released yet" })).toBeVisible({ timeout: POLL_TIMEOUT });
            });
          }
          await screens.step(v, "08-home-connected", "Home, wallet connected", async () => {
            await v.page.goto("/");
            await connect(v);
          });
          if (ownerHad === 0) {
            await screens.step(v, "09-dashboard-empty", "My switches: empty create form and no switches yet", async () => {
              await v.page.goto("/dashboard");
              await expect(v.page.getByRole("heading", { name: "Create a switch" })).toBeVisible();
              await expect(v.page.getByRole("heading", { name: "No switches yet" })).toBeVisible({ timeout: POLL_TIMEOUT });
            });
          }
        }
        if (created0.length) screens.skip("06-hunt-empty", "Hunt, empty", "all", `the contract already has ${created0.length} switches`);
        if (revealed0.length) screens.skip("07-archive-empty", "Archive, empty", "all", `the contract already has ${revealed0.length} released switches`);
        if (ownerHad) screens.skip("09-dashboard-empty", "My switches, empty", "all", `the owner account already has ${ownerHad} switches`);

        // What a phone's browser gets from RainbowKit (its mobile wallet list). Not used to connect:
        // that list holds RainbowKit's own wallets (deep links), not EIP-6963 injected ones.
        const phone = await openViewer(browser, chain, "mobile", { userAgent: IPHONE_UA });
        try {
          await screens.step(phone, "03-home-connect-modal-iphone-ua", "RainbowKit connect modal with an iPhone user agent (mobile wallet list)", async () => {
            await phone.page.goto("/");
            await phone.page.getByTestId("rk-connect-button").click();
            await expect(phone.page.getByRole("dialog")).toBeVisible();
          }, { viewportOnly: true });
        } finally {
          await phone.context.close();
        }
      });

      // ---------------- A2. the create flow, every stage, once per viewport ----------------
      const swUi = {} as Record<ViewportName, CreatedSwitch>;
      const swUi2 = {} as Record<ViewportName, CreatedSwitch>;
      await test.step("A2: create flow", async () => {
        for (const v of viewers) {
          const form = createForm(v.page);
          const submit = submitOf(form);
          const fillValid = async () => {
            await form.getByLabel("The secret").fill(SECRET_UI);
            await form.getByRole("button", { name: "1 hour", exact: true }).click();
            await form.getByLabel("Bounty").fill("0.01");
            await expect(submit).toBeEnabled();
          };
          await screens.step(v, "10-create-form-filled", "Create form filled in (1 hour, 0.01 ETH)", async () => {
            await v.page.goto("/dashboard");
            await expect(form).toBeVisible();
            await fillValid();
          });
          await screens.step(v, "11-create-form-validation-errors", "Create form: secret over 2,048 bytes, interval 0, bad amount", async () => {
            await form.getByLabel("The secret").fill(`${SECRET_UI}\n${"x".repeat(2_100)}`);
            await form.getByRole("button", { name: "Custom", exact: true }).click();
            await form.getByLabel("Custom interval").fill("0");
            await form.getByLabel("Bounty").fill("0.01.5");
            await expect(form.getByText(/of 2,048 bytes: .* over the limit/)).toBeVisible();
            await expect(form.getByText("Between 1 minute and 365 days.")).toBeVisible();
            await expect(form.getByText("Not a valid ETH amount.")).toBeVisible();
            await expect(submit).toBeDisabled();
          });

          const chunks = await holdChunks(v.page);
          let sent = false;
          try {
            await screens.step(v, "12-create-encrypting", "Create in progress: sealed, loading the FHE library (Prepare FHE)", async () => {
              await fillValid();
              await v.wallet.holdNext("eth_sendTransaction");
              await submit.click();
              await expect(submit).toContainText(/Prepare FHE|Encrypt the key to Zama/, { timeout: 30_000 });
              expect(chunks.count(), "script chunks held").toBeGreaterThan(0);
            }, { quick: true });
            await chunks.release();
            await screens.step(v, "13-create-waiting-for-wallet", "Create in progress: confirm in your wallet (prompt open)", async () => {
              await expect.poll(async () => (await v.wallet.snapshot()).held, { timeout: 60_000 }).toBe(1);
              await expect(submit).toContainText("Confirm in your wallet");
            }, { quick: true });
            await withAutomineOff(chain, async (mine) => {
              await screens.step(v, "14-create-mining", "Create in progress: sent, waiting for the block", async () => {
                expect(await v.wallet.releaseHeld()).toBe(1);
                sent = true;
                await expect(submit).toContainText("Wait for the block", { timeout: TX_TIMEOUT });
              }, { quick: true });
              await mine();
            });
          } finally {
            await chunks.release();
            if (!sent) await v.wallet.releaseHeld().catch(() => 0);
          }
          await screens.step(v, "15-create-success-card", "Switch created card", async () => {
            const card = v.page.locator("section").filter({ has: v.page.getByRole("heading", { name: "Switch created" }) });
            await expect(card).toBeVisible({ timeout: 120_000 });
            swUi[v.name] = parseSwitchHref(await card.getByRole("link", { name: "Open the switch page" }).getAttribute("href"));
          });

          await screens.step(v, "16-create-error-rejected", "Create form after the wallet rejected the transaction (Try again)", async () => {
            await v.page.getByRole("button", { name: "Create another" }).click();
            await form.getByLabel("The secret").fill(SECRET_UI2);
            await form.getByRole("button", { name: "7 days", exact: true }).click();
            await form.getByLabel("Bounty").fill("0.005");
            await v.wallet.rejectNext("eth_sendTransaction");
            await submit.click();
            await expect(form.getByRole("alert")).toBeVisible({ timeout: 60_000 });
            await expect(submit).toContainText("Try again");
          });
          // The retry lands (same id).
          try {
            await submit.click();
            const card = v.page.locator("section").filter({ has: v.page.getByRole("heading", { name: "Switch created" }) });
            await expect(card).toBeVisible({ timeout: 120_000 });
            swUi2[v.name] = parseSwitchHref(await card.getByRole("link", { name: "Open the switch page" }).getAttribute("href"));
          } catch (e) {
            console.log(`[screens] ${v.name}: the retried create did not land: ${errText(e)}`);
          }
        }
      });

      // ---------------- B. switches for the remaining states (the CLI, as the owner unless noted) ----------------
      let rescue: CreatedSwitch | null = null;
      let flagged: CreatedSwitch | null = null;
      const hunt = {} as Partial<Record<ViewportName, CreatedSwitch>>;
      const err = {} as Partial<Record<ViewportName, CreatedSwitch>>;
      const others: CreatedSwitch[] = [];
      await test.step("B: switches from the CLI", async () => {
        // First: funded by the funder while still alive (1 minute), rescuable after 31 days.
        rescue = await cliCreate(cli, "owner", 60, "0.01", "Rescue demo: nobody released this switch within 30 days of its deadline.", "rescue");
        await cli.ok("funder", ["fund-bounty", rescue.owner, rescue.id.toString(), "0.003"]);
        for (const v of viewers) hunt[v.name] = await cliCreate(cli, "owner", 60, "0.01", SECRET_HUNT[v.name], `hunt-${v.name}`);
        flagged = await cliCreate(cli, "owner", 60, "0.004", SECRET_FLAGGED, "flagged");
        for (const v of viewers) err[v.name] = await cliCreate(cli, "owner", 3600, "0.01", `Cancelled demo (${v.name}).`, `err-${v.name}`);
        // Other owners' long-lived switches: /hunt's "Still alive", and enough for a second page.
        others.push(await cliCreate(cli, "hunter", 365 * 86400, "0.05", "A long-lived switch (one year).", "long-1"));
        others.push(await cliCreate(cli, "funder", 365 * 86400, "0.02", "Another long-lived switch.", "long-2"));
        others.push(await cliCreate(cli, "hunter", 90 * 86400, "0.1", "A ninety-day switch with a bigger bounty.", "long-3"));
      });

      // ---------------- B2. a live switch: owner, pending tx, toasts, non-owner, error toast, cancelled, visitor ----------------
      await test.step("B2: live switch states", async () => {
        for (const v of viewers) {
          const sw = swUi[v.name];
          if (!sw) {
            for (const id of ["17", "18", "19", "20", "21", "22", "23", "27"]) screens.missing.push({ id, state: "live switch state", viewport: v.name, reason: "no UI-created switch (15 failed)" });
            continue;
          }
          const card = v.app.card(sw.id);
          const ping = card.getByRole("button", { name: "Ping: I'm alive" });
          const openAsOwner = async () => {
            await openAs(v, "owner", sw.path);
            await expect(ping).toBeVisible({ timeout: POLL_TIMEOUT });
          };
          await screens.step(v, "17-switch-alive-owner", "Switch page, alive, owner view (ping, cancel, top-up)", openAsOwner);
          await screens.step(v, "18-switch-alive-technical-details", "Switch page, alive, owner view, Technical details open", async () => {
            await card.getByText("Technical details").click();
            await expect(card.getByText("Plaintext commitment")).toBeVisible();
          });
          await screens.step(v, "19-switch-alive-cancel-confirm", "Switch page: cancel confirmation panel", async () => {
            await openAsOwner();
            await card.getByRole("button", { name: "Cancel switch…" }).click();
            await expect(card.getByText("Cancel this switch for good?")).toBeVisible();
          });
          await card.getByRole("button", { name: "Back" }).click().catch(() => {});

          await withAutomineOff(chain, async (mine) => {
            await screens.step(v, "20-switch-alive-ping-pending", "Ping sent, waiting to be mined (pending-transaction line)", async () => {
              await openAsOwner();
              await ping.click();
              await expect(pending(card)).toBeVisible({ timeout: TX_TIMEOUT });
            }, { quick: true });
            await mine();
          });
          await screens.step(v, "21-switch-alive-ping-success-toast", "Ping mined: success toast", async () => {
            await expect(v.app.toast("Pinged: the deadline moved out by one interval").first()).toBeVisible({ timeout: TX_TIMEOUT });
          }, { keepToasts: true, quick: true });

          const amount = card.getByLabel("Add to the bounty");
          await screens.step(v, "22-switch-alive-non-owner", "Switch page, alive, another account (top-up, release steps ahead)", async () => {
            await openAs(v, "funder", sw.path);
            await expect(amount).toBeVisible({ timeout: POLL_TIMEOUT });
            await expect(card.getByRole("heading", { name: "Release the key" })).toBeVisible();
            await expect(ping).toHaveCount(0);
          });
          await screens.step(v, "23-switch-alive-topup-success-toast", "Funder topped up the bounty: success toast", async () => {
            await amount.fill("0.002");
            await card.getByRole("button", { name: "Add ETH" }).click();
            await expect(v.app.toast("Bounty topped up by 0.002 ETH").first()).toBeVisible({ timeout: TX_TIMEOUT });
          }, { keepToasts: true, quick: true });

          // A top-up that loses to the owner's cancel in the same block: reverted on-chain.
          const e = err[v.name];
          if (e) {
            const eCard = v.app.card(e.id);
            const eAmount = eCard.getByLabel("Add to the bounty");
            await screens.step(v, "24-switch-topup-reverted-error-toast", "A top-up mined as a revert (the owner cancelled first): error toast", async () => {
              await openAs(v, "funder", e.path);
              await expect(eAmount).toBeVisible({ timeout: POLL_TIMEOUT });
              await eAmount.fill("0.002");
              await eCard.getByRole("button", { name: "Add ETH" }).click();
              await expect(v.app.toast("Bounty topped up by 0.002 ETH").first()).toBeVisible({ timeout: TX_TIMEOUT });
              await dismissToasts(v.page);
              const { fundTx, cancelTx } = await withAutomineOff(chain, async (mine) => {
                await eAmount.fill("0.001");
                await eCard.getByRole("button", { name: "Add ETH" }).click();
                await expect(pending(eCard)).toBeVisible({ timeout: TX_TIMEOUT });
                const fund: Hex = await v.wallet.lastSentHash();
                const cancel: Hex = await ownerWallet.writeContract({
                  account: owner, address: dms, abi: dmsAbi, functionName: "cancel", args: [e.id],
                  gas: 500_000n, maxPriorityFeePerGas: parseGwei("50"), maxFeePerGas: parseGwei("500"),
                });
                await mine();
                return { fundTx: fund, cancelTx: cancel };
              });
              expect((await chain.receipt(cancelTx)).status, "the owner's cancel").toBe("success");
              expect((await chain.receipt(fundTx)).status, "the funder's top-up").toBe("reverted");
              await expect(v.app.errorToast(/./).first()).toBeVisible({ timeout: TX_TIMEOUT });
            }, { keepToasts: true, quick: true });
            await screens.step(v, "25-switch-cancelled-funder", "Cancelled switch, a funder's view (reclaim the contribution)", async () => {
              await openAs(v, "funder", e.path);
              await expect(v.app.pill(eCard, "Cancelled")).toBeVisible({ timeout: POLL_TIMEOUT });
              await expect(eCard.getByRole("button", { name: /^Reclaim / })).toBeVisible({ timeout: POLL_TIMEOUT });
            });
            await screens.step(v, "26-switch-cancelled-owner", "Cancelled switch, owner view", async () => {
              await openAs(v, "owner", e.path);
              await expect(eCard.getByText("You cancelled this switch.", { exact: false })).toBeVisible({ timeout: POLL_TIMEOUT });
            });
          }

          await screens.step(v, "27-switch-alive-visitor", "Switch page, alive, no wallet connected (read-only, connect prompts)", async () => {
            await v.wallet.use("owner");
            await v.wallet.disconnect();
            await v.page.goto(sw.path);
            await expect(v.page.getByTestId("rk-connect-button")).toBeVisible();
            await expect(card.getByRole("button", { name: "Connect wallet" }).first()).toBeVisible({ timeout: POLL_TIMEOUT });
          });
          try {
            await v.page.goto("/");
            await connect(v);
          } catch (e) {
            console.log(`[screens] ${v.name}: reconnecting after 27 failed: ${errText(e)}`);
          }
        }

        // Near the deadline (under 36 s): both viewports at once, the window is short.
        const near = await cliCreate(cli, "owner", 60, "0.002", "Near-deadline demo.", "near");
        others.push(near);
        const info = await chain.switchInfo(near.owner, near.id);
        const left = Number(info.expiresAt - (await chain.now()));
        if (left > 32) await chain.travel(left - 32);
        await Promise.all(
          viewers.map((v) =>
            screens.step(v, "28-switch-alive-near-deadline", "Switch page, owner, under 36 s to the deadline (ping warning)", async () => {
              await openAs(v, "owner", near.path);
              await expect(v.app.card(near.id).getByText(/Under 36 s to the deadline: a ping or cancel/)).toBeVisible({ timeout: 20_000 });
            }),
          ),
        );
        // Afterwards: key release requested (the CLI hunter), for the lists.
        await chain.travel(120);
        await cli.ok("hunter", ["mark-dark", near.owner, near.id.toString()]);
        if (flagged) {
          const f = flagged as CreatedSwitch;
          await cli.ok("hunter", ["mark-dark", f.owner, f.id.toString()]);
          await cli.ok("hunter", ["reveal", f.owner, f.id.toString()]);
        }
      });

      // ---------------- C. dark: /hunt, the hunter flow step by step, the archive, the dashboard ----------------
      await test.step("C: dark, hunter flow, lists", async () => {
        for (const v of viewers) {
          await screens.step(v, "29-hunt-claimable", "Hunt: Claimable (dark and release-requested switches)", async () => {
            await openAs(v, "hunter", "/hunt");
            await expect(v.page.getByRole("button", { name: "Claimable" })).toHaveAttribute("aria-pressed", "true");
            await expect(v.page.getByRole("article").first()).toBeVisible({ timeout: POLL_TIMEOUT });
          });
          const pager = v.page.getByRole("navigation", { name: "Pagination" });
          await screens.step(v, "30-hunt-all-page-1", "Hunt: All, page 1 of 2", async () => {
            await v.page.getByRole("button", { name: "All", exact: true }).click();
            await expect(pager).toContainText("Page 1 of 2", { timeout: POLL_TIMEOUT });
          });
          await screens.step(v, "31-hunt-all-page-2", "Hunt: All, page 2 of 2", async () => {
            await pager.getByRole("button", { name: "Next" }).click();
            await expect(pager).toContainText("Page 2 of 2");
          });
        }

        for (const v of viewers) {
          const sw = hunt[v.name];
          if (!sw) continue;
          const card = v.app.card(sw.id);
          await screens.step(v, "32-switch-dark-owner", "Dark switch (deadline passed, not marked), owner view", async () => {
            await openAs(v, "owner", sw.path);
            await expect(card.getByText(/^Your deadline passed on /)).toBeVisible({ timeout: POLL_TIMEOUT });
          });
          await screens.step(v, "33-switch-dark-hunter", "Dark switch, hunter view: step 1 Mark dark", async () => {
            await openAs(v, "hunter", sw.path);
            await expect(card.getByRole("button", { name: "Mark dark" })).toBeVisible({ timeout: POLL_TIMEOUT });
            await expect(card.getByText(/^Your deadline passed on /)).toHaveCount(0);
          });
          await withAutomineOff(chain, async (mine) => {
            await screens.step(v, "34-switch-mark-dark-pending", "Hunter: Mark dark sent, waiting to be mined", async () => {
              await card.getByRole("button", { name: "Mark dark" }).click();
              await expect(pending(card)).toBeVisible({ timeout: TX_TIMEOUT });
            }, { quick: true });
            await mine();
          });
          await screens.step(v, "35-switch-key-release-requested", "Hunter: marked dark, step 2 Fetch the key", async () => {
            await expect(v.app.pill(card, "Key release requested")).toBeVisible({ timeout: TX_TIMEOUT });
            await expect(card.getByRole("button", { name: "Fetch key" })).toBeVisible();
          });
          const chunks = await holdChunks(v.page);
          try {
            await screens.step(v, "36-switch-fetching-key", "Hunter: fetching the key from Zama's KMS (in progress)", async () => {
              await card.getByRole("button", { name: "Fetch key" }).click();
              await expect(card.getByRole("button", { name: "Stop" })).toBeVisible();
            }, { quick: true });
          } finally {
            await chunks.release();
          }
          const reveal = card.getByRole("button", { name: /^Reveal and claim / });
          await screens.step(v, "37-switch-key-verified", "Hunter: key received and verified, step 4 Reveal and claim", async () => {
            await expect(card.getByText("Key received with a KMS threshold proof.")).toBeVisible({ timeout: 60_000 });
            await expect(card.getByText(/AES-GCM tag verified/)).toBeVisible();
            await expect(reveal).toBeEnabled();
          });
          await withAutomineOff(chain, async (mine) => {
            await screens.step(v, "38-switch-reveal-pending", "Hunter: reveal sent, waiting to be mined", async () => {
              await reveal.click();
              await expect(pending(card)).toBeVisible({ timeout: TX_TIMEOUT });
            }, { quick: true });
            await mine();
          });
          await screens.step(v, "39-switch-revealed", "Revealed: plaintext decrypted in the browser, optional publish", async () => {
            await expect(v.app.pill(card, "Revealed")).toBeVisible({ timeout: TX_TIMEOUT });
            await expect(card.locator("pre")).toBeVisible({ timeout: POLL_TIMEOUT });
            await expect(card.getByRole("button", { name: "Publish plaintext" })).toBeVisible();
          });
          await screens.step(v, "40-switch-published", "Revealed and published on-chain", async () => {
            await card.getByRole("button", { name: "Publish plaintext" }).click();
            await expect(v.app.pill(card, "Plaintext published")).toBeVisible({ timeout: TX_TIMEOUT });
            await expect(card.getByText(/identical to the decrypted bytes/)).toBeVisible({ timeout: POLL_TIMEOUT });
          });
        }

        const releasedCount = (await chain.client.getContractEvents({ address: dms, abi: dmsAbi, eventName: "KeyRevealed", fromBlock: 0n })).length;
        for (const v of viewers) {
          await screens.step(v, "41-archive-with-items", `Archive with ${releasedCount} released secrets (one with flagged characters)`, async () => {
            await v.page.goto("/archive");
            await expect(v.page.locator("article pre")).toHaveCount(Math.min(releasedCount, 10), { timeout: POLL_TIMEOUT });
          });
          // The "Switch created" card of 16 is kept (sessionStorage, until "Create another"): it stays on top.
          await screens.step(v, "42-dashboard-mixed-states", "My switches: alive, dark, release requested, revealed, cancelled (16's Switch created card still on top)", async () => {
            await openAs(v, "owner", "/dashboard");
            await expect(v.page.getByRole("heading", { name: /^Your switches/ })).toBeVisible();
            await expect(v.page.getByRole("article").first()).toBeVisible({ timeout: POLL_TIMEOUT });
          });
        }
      });

      // ---------------- D. 31 days later: rescue ----------------
      await test.step("D: rescue window", async () => {
        await chain.travel(31 * 86400);
        const r = rescue as CreatedSwitch | null;
        for (const v of viewers) {
          if (r) {
            const card = v.app.card(r.id);
            await screens.step(v, "43-switch-rescuable-owner", "31 days past the deadline: Rescue open, owner reclaims the escrow", async () => {
              await openAs(v, "owner", r.path);
              await expect(v.app.pill(card, "Rescue open")).toBeVisible({ timeout: POLL_TIMEOUT });
              await expect(card.getByText("Rescue your escrow", { exact: true })).toBeVisible();
            });
            await screens.step(v, "44-switch-rescuable-funder", "31 days past the deadline: a funder reclaims the contribution", async () => {
              await openAs(v, "funder", r.path);
              await expect(card.getByRole("button", { name: "Reclaim 0.003 ETH" })).toBeVisible({ timeout: POLL_TIMEOUT });
            });
          }
          await screens.step(v, "45-dashboard-rescue-open", "My switches 31 days later: rescue open on the unreleased ones; the Switch created card still says the 7-day switch is live", async () => {
            await openAs(v, "owner", "/dashboard");
            await expect(v.page.getByRole("heading", { name: /^Your switches/ })).toBeVisible();
            await expect(v.page.getByRole("article").first()).toBeVisible({ timeout: POLL_TIMEOUT });
          });
        }
      });

      // ---------------- E. account, admin, network guard, bad links ----------------
      await test.step("E: account, admin, guards, bad links", async () => {
        const alive = others[0]; // another owner's one-year switch
        for (const v of viewers) {
          await screens.step(v, "46-account-modal", "RainbowKit account modal (connected)", async () => {
            await openAs(v, "owner", "/");
            await v.page.getByTestId("rk-account-button").click();
            await expect(v.page.getByTestId("rk-disconnect-button")).toBeVisible();
          }, { viewportOnly: true });
          await v.page.keyboard.press("Escape").catch(() => {});
          await screens.step(v, "47-admin", "Admin page as the admin (deployer)", async () => {
            await openAs(v, "admin", "/admin");
            await expect(v.page.getByRole("heading", { name: "Transfer admin", level: 2 })).toBeVisible({ timeout: POLL_TIMEOUT });
          });
          await screens.step(v, "48-admin-read-only", "Admin page as anyone else (read-only)", async () => {
            await openAs(v, "owner", "/admin");
            await expect(v.page.getByRole("heading", { name: "Read-only" })).toBeVisible({ timeout: POLL_TIMEOUT });
          });
          await screens.step(v, "49-network-guard-unsupported", "Wallet on an unsupported chain (8453): network guard", async () => {
            await v.page.goto("/dashboard");
            await expect(v.page.getByRole("heading", { name: "My switches", level: 1 })).toBeVisible();
            await v.wallet.setChainId(8453);
            await expect(v.page.getByRole("heading", { name: "chain 8453 is not supported" })).toBeVisible();
          });
          await screens.step(v, "50-network-guard-not-deployed", "Wallet on Ethereum mainnet (no deployment in this build): network guard", async () => {
            await v.wallet.setChainId(1);
            await expect(v.page.getByRole("heading", { name: "Not deployed on Ethereum" })).toBeVisible();
          });
          await v.wallet.setChainId(CHAIN_ID);
          if (alive) {
            await screens.step(v, "51-switch-wrong-network", "Switch page with the wallet on another chain (read-only note, switch prompt)", async () => {
              await v.page.goto(alive.path);
              const card = v.app.card(alive.id);
              await expect(card.getByLabel("Add to the bounty")).toBeVisible({ timeout: POLL_TIMEOUT });
              await v.wallet.setChainId(8453);
              await expect(v.page.getByText("This switch lives on Anvil (local)", { exact: true })).toBeVisible();
              await expect(card.getByRole("button", { name: "Switch wallet to Anvil (local)" }).first()).toBeVisible();
            });
            await v.wallet.setChainId(CHAIN_ID);
          }
          await screens.step(v, "52-switch-invalid-link", "Malformed switch link", async () => {
            await v.page.goto("/switch/31337/not-an-address/1");
            await expect(v.page.getByRole("heading", { name: "That link isn't valid" })).toBeVisible();
          });
          await screens.step(v, "53-switch-unsupported-chain", "Switch link for an unsupported chain", async () => {
            await v.page.goto(`/switch/8453/${owner}/1`);
            await expect(v.page.getByRole("heading", { name: "chain 8453 is not supported" })).toBeVisible();
          });
          await screens.step(v, "54-switch-not-found", "Well-formed switch link, no such switch", async () => {
            await v.page.goto(`/switch/31337/${owner}/424242`);
            await expect(v.page.getByText(/^No switch #424242 for owner /)).toBeVisible({ timeout: POLL_TIMEOUT });
          });
          await screens.step(v, "55-page-404", "404 page", async () => {
            await v.page.goto("/no-such-page");
            await expect(v.page.getByRole("heading", { name: "Page not found" })).toBeVisible();
          });
        }
      });
    } finally {
      await screens.write();
      for (const v of viewers) await v.context.close().catch(() => {});
      await chain.client.setAutomine(true).catch(() => {});
    }

    console.log(
      `[screens] ${screens.shots.length} screenshots in ${SCREENS_DIR}; ${screens.missing.length} not captured, ${screens.skipped.length} skipped`,
    );
    expect(screens.missing, "states that could not be captured (see index.json)").toEqual([]);
  });
});
