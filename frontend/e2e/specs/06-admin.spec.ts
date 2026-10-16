// Scenario 6: the admin page. As the deployer (anvil #0, the contract's admin)
// the nav offers Admin and the page loads every setting without an error;
// anyone else gets the same settings read-only.

import { addressOf } from "../support/env";
import { expect, test } from "../support/fixtures";

test.describe("as the deployer", () => {
  test.use({ role: "admin" });

  test("the admin page loads its settings without errors", async ({ app, page, chain }) => {
    await page.goto("/");
    const admin = await app.connect();
    expect(admin).toBe(addressOf("admin"));
    expect(await chain.client.readContract({ address: chain.dms, abi: adminAbi, functionName: "admin" })).toBe(admin);

    await app.nav("Admin").click();
    await expect(page).toHaveURL("/admin");
    await expect(page.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible();
    await expect(page.getByText(`Anvil (local) · contract ${chain.dms}`)).toBeVisible();
    const settings = page.locator("section").filter({ has: page.getByRole("heading", { name: "Current settings" }) });
    await expect(settings).toBeVisible();
    expect(await page.getByRole("alert").filter({ hasText: "Could not read the contract settings" }).count()).toBe(0);
    expect(await page.getByText(/Could not refresh the settings/).count()).toBe(0);
    const row = (label: string) => settings.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
    await expect(row("Admin")).toContainText(admin);
    await expect(row("Pending admin")).toHaveText("None");
    await expect(row("Minimum bounty")).toHaveText("Disabled");
    await expect(row("Minimum right now")).toHaveText("0 ETH");
    await expect(row("ETH/USD feed")).toHaveText("None (floor can never be enabled)");

    // The admin's controls, and no read-only notice.
    for (const title of ["Minimum bounty", "Transfer admin", "Renounce admin"]) {
      await expect(page.getByRole("heading", { name: title, level: 2 })).toBeVisible();
    }
    // Without a price feed only $0 is allowed: caught before any transaction.
    const minInput = page.getByRole("textbox", { name: "New minimum bounty in USD" });
    const minSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Minimum bounty", level: 2 }) });
    await minInput.fill("5");
    await expect(minSection.getByText("This deployment has no price feed: only $0 (disabled) is allowed.")).toBeVisible();
    await expect(minSection.getByRole("button", { name: "Review" })).toBeDisabled();
    await minInput.fill("");
    await expect(page.getByRole("textbox", { name: "New admin address" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Read-only" })).toHaveCount(0);
  });
});

test.describe("as anyone else", () => {
  test.use({ role: "owner" });

  test("the admin page is read-only and not in the nav", async ({ app, page }) => {
    await page.goto("/");
    await app.connect();
    await expect(app.nav("Hunt")).toBeVisible();
    await expect(app.nav("Admin")).toHaveCount(0);

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Current settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Read-only" })).toBeVisible();
    await expect(page.getByText("Connect the admin wallet (or the pending admin) to make changes.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Transfer admin" })).toHaveCount(0);
  });
});

const adminAbi = [
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
