// The wallet session: reconnect after a reload, disconnect through RainbowKit,
// the app's own "Connect wallet" prompt, and switching accounts in the wallet.

import { POLL_TIMEOUT } from "../support/app";
import { appAddress, rainbowKitAddress } from "../support/env";
import { WALLET_NAME } from "../support/wallet";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("the connection survives a reload, and disconnecting leaves read-only pages", async ({ app, page }) => {
  await page.goto("/dashboard");
  const owner = await app.connect();
  await expect(page.getByRole("heading", { name: "My switches", level: 1 })).toBeVisible();

  await page.reload();
  await expect(app.accountButton()).toContainText(rainbowKitAddress(owner));
  await expect(page.getByRole("heading", { name: "My switches", level: 1 })).toBeVisible();

  // Disconnect from RainbowKit's account modal.
  await app.accountButton().click();
  await page.getByTestId("rk-disconnect-button").click();
  await expect(page.getByRole("heading", { name: "Connect a wallet" })).toBeVisible();
  await expect(page.getByTestId("rk-connect-button")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Connect a wallet" })).toBeVisible();
  await expect(page.getByTestId("rk-connect-button")).toBeVisible();

  // Read-only pages work without a wallet.
  await app.nav("Hunt").click();
  await expect(page.getByRole("heading", { name: "Hunt", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Claimable" })).toBeVisible();
  await app.nav("Archive").click();
  await expect(page.getByRole("heading", { name: "Archive", level: 1 })).toBeVisible();

  // The dashboard's own "Connect wallet" button opens the same modal.
  await app.nav("My switches").click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("dialog").getByRole("button", { name: WALLET_NAME }).click();
  await expect(app.accountButton()).toContainText(rainbowKitAddress(owner));
  await expect(page.getByRole("heading", { name: "My switches", level: 1 })).toBeVisible();
});

test("switching accounts in the wallet switches the dashboard's list", async ({ app, page }) => {
  await page.goto("/dashboard");
  const owner = await app.connect();
  const sw = await app.createSwitch({ secret: `accounts ${Date.now()}`, interval: "1 day", bountyEth: "0.001" });
  await page.reload(); // F1: the list picks the new switch up only at its next scan
  const card = app.card(sw.id);
  await expect(card).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(page.getByText(`contract ${app.chain.dms}`)).toBeVisible();

  // The admin account (anvil #0) has never created a switch.
  await app.switchAccount("admin");
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No switches yet" })).toBeVisible();

  await app.switchAccount("owner");
  await expect(card).toBeVisible();
  await expect(app.pill(card, "You")).toBeVisible();
  await expect(card).toContainText(appAddress(owner));
});

// FINDING F4 (frontend-ui, ux): the "Switch created" card is not tied to the
// account that created the switch. After switching the wallet to another
// account, the dashboard keeps telling that account "Switch #… is live … Ping
// at least every …", above its own "No switches yet", and hides the create
// form until "Create another" is clicked. useCreateSwitch's `created` comes
// from the tab-wide attempt store (lib/hooks.ts), and CreateSwitchForm shows it
// whatever the connected account (components/CreateSwitchForm.tsx).
test("the “Switch created” card is not shown to another account", async ({ app, page }) => {
  await page.goto("/dashboard");
  await app.connect();
  await app.createSwitch({ secret: `created-card ${Date.now()}`, interval: "1 day", bountyEth: "0.001" });
  await app.switchAccount("admin");
  await expect(page.getByRole("heading", { name: "Create a switch" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Switch created" })).toHaveCount(0);
});
