// Playwright fixtures: every test gets a fresh browser context with the test
// wallet injected (on the `role` account), external hosts blocked, browser
// diagnostics collected (and the test failed on an uncaught page error), a
// handle on Anvil, and the page helpers. `actor` opens further, independent
// browsers (another person with another wallet), watched the same way.

import { writeFile } from "node:fs/promises";
import { test as base, expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { Chain } from "./chain";
import { emptyDiagnostics, summarize, watchContext, type Diagnostics } from "./diagnostics";
import { ACCOUNTS, CHAIN_ID, ROLES, e2eEnv, type Role } from "./env";
import { installInjectedWallet, type InjectedWalletConfig } from "./injected-wallet";
import { App } from "./app";
import { Cli } from "./cli";
import { WALLET_ICON, WALLET_NAME, WALLET_RDNS, WalletHandle } from "./wallet";

/** Another person: their own browser context, page, wallet and diagnostics. */
export interface Actor {
  role: Role;
  context: BrowserContext;
  page: Page;
  wallet: WalletHandle;
  app: App;
  diagnostics: Diagnostics;
}

export interface E2EFixtures {
  /** Account the wallet starts on (anvil #1 owner, #2 hunter, #3 funder, #0 admin). */
  role: Role;
  /** Chain id the wallet reports on first load. */
  walletChainId: number;
  diagnostics: Diagnostics;
  wallet: WalletHandle;
  chain: Chain;
  app: App;
  /** Open another browser for `role` (its wallet not connected yet). */
  actor: (role: Role) => Promise<Actor>;
  /** The `dms` CLI and the watcher (client/), as subprocesses against the same chain and contract. */
  cli: Cli;
}

// Read on first use, so `playwright test --list` works without a running stack.
let cachedEnv: ReturnType<typeof e2eEnv> | null = null;
export const env = (): ReturnType<typeof e2eEnv> => (cachedEnv ??= e2eEnv());

/** The test wallet's configuration for `role`, first reporting `chainId`. */
export const walletConfig = (role: Role, chainId: number): InjectedWalletConfig => ({
  rpcUrl: env().rpcUrl,
  rpcChainId: CHAIN_ID,
  accounts: ACCOUNTS,
  accountIndex: ROLES[role],
  chainId,
  knownChainIds: [CHAIN_ID, 1, 11155111],
  storageKey: "dms-e2e-wallet",
  info: { uuid: "6f1d4c1e-6b8e-4c55-9a51-d3ad3a1e2e2e", name: WALLET_NAME, icon: WALLET_ICON, rdns: WALLET_RDNS },
  exposeWindowEthereum: false,
});

const watch = async (context: BrowserContext): Promise<Diagnostics> => {
  const diag = emptyDiagnostics();
  await watchContext(context, diag, { rpcUrl: env().rpcUrl });
  return diag;
};

/** Write and attach one context's diagnostics; fail on uncaught page errors. */
const report = async (diag: Diagnostics, testInfo: TestInfo, label: string): Promise<void> => {
  const name = label ? `${label}-` : "";
  const { rpc, ...rest } = diag;
  const diagPath = testInfo.outputPath(`${name}diagnostics.json`);
  await writeFile(diagPath, JSON.stringify(rest, null, 2));
  await testInfo.attach(`${name}diagnostics.json`, { path: diagPath, contentType: "application/json" });
  if (process.env.E2E_LOG_RPC === "1" || testInfo.status !== testInfo.expectedStatus) {
    const rpcPath = testInfo.outputPath(`${name}rpc-log.txt`);
    await writeFile(rpcPath, rpc.map((r) => `${r.at} ${r.method} ${r.params} => ${r.result}`).join("\n") + "\n");
    await testInfo.attach(`${name}rpc-log.txt`, { path: rpcPath, contentType: "text/plain" });
  }
  console.log(`[diagnostics] ${testInfo.title}${label ? ` (${label})` : ""}: ${summarize(diag)}`);
  // Uncaught exceptions and unhandled rejections in the page fail the test.
  expect(diag.pageErrors, `uncaught page errors${label ? ` (${label})` : ""}`).toEqual([]);
};

export const test = base.extend<E2EFixtures>({
  role: ["owner", { option: true }],
  walletChainId: [CHAIN_ID, { option: true }],

  context: async ({ context, role, walletChainId }, provide) => {
    await context.addInitScript(installInjectedWallet, walletConfig(role, walletChainId));
    await provide(context);
  },

  diagnostics: [
    async ({ context }, provide, testInfo) => {
      const diag = await watch(context);
      await provide(diag);
      await report(diag, testInfo, "");
    },
    { auto: true },
  ],

  wallet: async ({ page }, provide) => {
    await provide(new WalletHandle(page));
  },

  // No dependencies, but Playwright requires the destructuring pattern.
  chain: async ({}, provide) => {
    await provide(new Chain(env().rpcUrl, env().dmsAddress));
  },

  app: async ({ page, wallet, chain }, provide) => {
    await provide(new App(page, wallet, chain));
  },

  cli: async ({}, provide, testInfo) => {
    const cli = new Cli(env().rpcUrl, env().dmsAddress, testInfo.outputPath("client"));
    try {
      await provide(cli);
    } finally {
      cli.stopAll();
      if (cli.runs.length) {
        const logPath = testInfo.outputPath("client-log.txt");
        await writeFile(logPath, cli.log());
        await testInfo.attach("client-log.txt", { path: logPath, contentType: "text/plain" });
      }
    }
  },

  actor: async ({ browser, chain }, provide, testInfo) => {
    const actors: Actor[] = [];
    await provide(async (role: Role) => {
      const use = testInfo.project.use;
      const context = await browser.newContext({
        baseURL: use.baseURL,
        locale: use.locale,
        timezoneId: use.timezoneId,
        viewport: use.viewport,
        userAgent: use.userAgent,
      });
      await context.addInitScript(installInjectedWallet, walletConfig(role, CHAIN_ID));
      const diagnostics = await watch(context);
      const page = await context.newPage();
      const wallet = new WalletHandle(page);
      const actor = { role, context, page, wallet, app: new App(page, wallet, chain), diagnostics };
      actors.push(actor);
      return actor;
    });
    for (const a of actors) await a.context.close();
    const failures: unknown[] = [];
    for (const [i, a] of actors.entries()) {
      try {
        await report(a.diagnostics, testInfo, `actor${i + 1}-${a.role}`);
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length) throw failures[0];
  },
});

export { expect };
