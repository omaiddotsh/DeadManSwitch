// Browser e2e: Playwright against the real app (next build + next start) on a
// local Anvil with Zama's forge-fhevm mock host. Run it with
// scripts/browser-e2e.sh (or `npm run test:e2e`), which starts and stops the
// stack and sets E2E_BASE_URL, E2E_RPC_URL and E2E_DMS_ADDRESS. See e2e/README.md.

import { defineConfig, devices } from "@playwright/test";

const outputDir = process.env.E2E_OUTPUT_DIR?.trim() || "test-results";

/**
 * Only the app and Anvil (both on 127.0.0.1) are reachable: every other host
 * fails to resolve inside Chromium (WalletConnect, RainbowKit and wallet-SDK
 * telemetry). Done in the browser rather than with page.route, which would
 * send every request, Anvil's included, through the test runner.
 */
const EXTERNAL_BLOCK = process.env.E2E_ALLOW_EXTERNAL === "1" ? [] : ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"];
const trace = (process.env.E2E_TRACE?.trim() || "retain-on-failure") as "on" | "off" | "retain-on-failure" | "on-first-retry";
const reportDir = process.env.E2E_REPORT_DIR?.trim() || "playwright-report";
/** e2e/screens.spec.ts (the UI screenshot set) runs only with E2E_SCREENS=1, and takes longer than the suite. */
const screens = process.env.E2E_SCREENS === "1";

export default defineConfig({
  testDir: "./e2e",
  // The specs, plus the screenshot set (skipped unless E2E_SCREENS=1). Not e2e/support.
  testMatch: ["specs/**/*.spec.ts", "screens.spec.ts"],
  globalSetup: "./e2e/global-setup.ts",
  outputDir,
  // One chain for every test, and tests move its clock (evm_increaseTime):
  // they run one at a time, in file order. Each test creates its own switches.
  fullyParallel: false,
  workers: 1,
  retries: Number(process.env.E2E_RETRIES ?? 0),
  forbidOnly: !!process.env.CI,
  // A whole lifecycle (create, time travel, mark dark, fetch key, reveal,
  // publish) waits on several 12-15 s UI polls.
  timeout: 240_000,
  // A backstop: the suite takes about two minutes; a starved machine must not hang for hours.
  globalTimeout: (screens ? 90 : 30) * 60_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: reportDir, open: "never" }],
    ["json", { outputFile: `${outputDir}/results.json` }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL?.trim() || "http://127.0.0.1:3100",
    headless: process.env.E2E_HEADED !== "1",
    trace,
    screenshot: "only-on-failure",
    video: process.env.E2E_VIDEO === "1" ? "retain-on-failure" : "off",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    // Fixed locale, timezone and viewport: the app formats dates and numbers for the browser's locale.
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, launchOptions: { args: EXTERNAL_BLOCK } },
    },
  ],
});
