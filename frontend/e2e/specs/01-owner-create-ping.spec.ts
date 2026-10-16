// Scenario 1: the owner creates a switch (short secret, 1-minute interval,
// small bounty), sees it on /dashboard with the right state and countdown,
// and pings it: the deadline moves.

import { parseEther } from "viem";
import { POLL_TIMEOUT, TX_TIMEOUT } from "../support/app";
import { appAddress, rainbowKitAddress } from "../support/env";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("owner creates a switch, sees it on the dashboard, and pings it", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Connect a wallet" })).toBeVisible();
  const owner = await app.connect();
  await expect(page.getByRole("heading", { name: "My switches", level: 1 })).toBeVisible();

  const sw = await app.createSwitch({ secret: `create-ping ${Date.now()}`, interval: "1 minute (testing)", bountyEth: "0.01" });
  expect(sw.owner).toBe(owner);

  // F1: without a reload the new switch only shows at the list's next 60 s
  // poll (see "lists a just-created switch without a reload" below). A reload
  // scans the SwitchCreated logs afresh.
  await page.reload();
  await expect(app.accountButton()).toContainText(rainbowKitAddress(owner));
  const card = app.card(sw.id);
  await expect(card).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(card, "Alive")).toBeVisible();
  await expect(app.pill(card, "You")).toBeVisible();
  await expect(card).toContainText(appAddress(owner));
  await expect(app.fact(card, "Bounty")).toHaveText("0.01 ETH");
  await expect(app.fact(card, "Ping interval")).toHaveText("1m");
  const left = await app.countdown(card);
  expect(left).toBeGreaterThan(30);
  expect(left).toBeLessThanOrEqual(60);

  // 28 s pass on-chain. The page's chain clock picks that up at its next poll (12 s);
  // under 36 s left, it warns that a ping may land too late.
  const pingWarning = card.getByText(/^Under 36 s to the deadline: a ping or cancel sent now may be mined after the deadline\./);
  expect(await pingWarning.count()).toBe(0);
  const before = await chain.switchInfo(sw.owner, sw.id);
  await chain.travel(28);
  await expect
    .poll(() => app.countdown(card), { timeout: POLL_TIMEOUT, message: "countdown after +28 s" })
    .toBeLessThanOrEqual(34);
  await expect(pingWarning).toBeVisible();

  const ping = card.getByRole("button", { name: "Ping: I'm alive" });
  await expect(ping).toBeEnabled(); // warned, never disabled
  await ping.click();
  await app.expectToast("Pinged: the deadline moved out by one interval", TX_TIMEOUT);
  await expect(ping).toBeEnabled();
  await expect(pingWarning).toHaveCount(0);

  const after = await chain.switchInfo(sw.owner, sw.id);
  expect(after.state).toBe("alive");
  expect(after.lastPing).toBeGreaterThanOrEqual(before.lastPing + 28n);
  expect(after.expiresAt).toBe(after.lastPing + 60n);
  expect(after.bounty).toBe(parseEther("0.01"));

  // The countdown is back to (nearly) the full interval.
  await expect
    .poll(() => app.countdown(card), { timeout: POLL_TIMEOUT, message: "countdown after the ping" })
    .toBeGreaterThanOrEqual(48);
  await expect(app.pill(card, "Alive")).toBeVisible();
});

// FINDING F1 (frontend-lib, wiring): after a create, the dashboard's "Your
// switches" keeps showing the old list until the next 60 s scan. The create
// invalidates the scan, but syncSwitchScan (lib/switchScan.ts) reads the head
// with viem's cached getBlockNumber (4 s cacheTime), gets the block of the
// previous scan, and returns the previous result. On Anvil the receipt is
// there at viem's first look, so nothing refreshed that cache.
test("the dashboard lists a just-created switch without a reload", async ({ app, page }) => {
  await page.goto("/dashboard");
  await app.connect();
  const sw = await app.createSwitch({ secret: `no-reload ${Date.now()}`, interval: "1 hour", bountyEth: "0.002" });
  // Well under the list's own 60 s poll: the create's invalidation alone must bring it in.
  await expect(app.card(sw.id)).toBeVisible({ timeout: 20_000 });
  await expect(app.pill(app.card(sw.id), "Alive")).toBeVisible();
});
