// RESCUE_DELAY: 30 days past the deadline without a reveal, the owner and the
// funders may take back their own deposits; the switch stays active, so a
// late release still lands (and collects whatever is left: here nothing).

import { parseEther } from "viem";
import { POLL_TIMEOUT, TX_TIMEOUT } from "../support/app";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("30 days past the deadline depositors reclaim, and a late release still lands", async ({ app, page, chain }) => {
  const secret = `rescue ${Date.now()}`;
  await page.goto("/dashboard");
  const owner = await app.connect();
  const sw = await app.createSwitch({ secret, interval: "1 minute (testing)", bountyEth: "0.01" });
  await page.goto(sw.path);
  const card = app.card(sw.id);

  const funder = await app.switchAccount("funder");
  await card.getByLabel("Add to the bounty").fill("0.003");
  await card.getByRole("button", { name: "Add ETH" }).click();
  await app.expectToast("Bounty topped up by 0.003 ETH");
  await expect(app.fact(card, "Bounty")).toHaveText("0.013 ETH");

  // 31 days later, nobody has released it.
  await chain.travel(31 * 86400);
  await app.switchAccount("owner");
  await expect(app.pill(card, "Rescue open")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(card, "Dark")).toBeVisible();
  expect((await chain.switchInfo(sw.owner, sw.id)).rescuable).toBe(true);

  // The owner rescues the escrow.
  await expect(card.getByText("Rescue your escrow", { exact: true })).toBeVisible();
  const ownerBefore = await chain.balance(owner);
  await card.getByRole("button", { name: "Reclaim 0.01 ETH" }).click();
  await app.expectToast("Escrow rescued");
  const rescueTx = await app.wallet.lastSentHash();
  expect((await chain.balance(owner)) - ownerBefore + (await chain.feeOf(rescueTx))).toBe(parseEther("0.01"));
  await expect(app.fact(card, "Bounty")).toHaveText("0.003 ETH", { timeout: TX_TIMEOUT });
  await expect(card.getByRole("button", { name: "Reclaim 0.01 ETH" })).toHaveCount(0);

  // The funder takes back the contribution.
  await app.switchAccount("funder");
  await expect(card.getByText(/^Nobody released the key within 30 days of the deadline\. You may take back your contribution/)).toBeVisible();
  const funderBefore = await chain.balance(funder);
  await card.getByRole("button", { name: "Reclaim 0.003 ETH" }).click();
  await app.expectToast("Contribution reclaimed");
  const reclaimTx = await app.wallet.lastSentHash();
  expect((await chain.balance(funder)) - funderBefore + (await chain.feeOf(reclaimTx))).toBe(parseEther("0.003"));
  await expect(app.fact(card, "Bounty")).toHaveText("0 ETH", { timeout: TX_TIMEOUT });

  // A late release still works, for a zero bounty.
  await app.switchAccount("hunter");
  await card.getByRole("button", { name: "Mark dark" }).click();
  await app.expectToast("Marked dark: Zama's KMS may now decrypt the key");
  await card.getByRole("button", { name: "Fetch key" }).click();
  await expect(card.getByText("Key received with a KMS threshold proof.")).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "Reveal and claim 0 ETH" }).click();
  await app.expectToast("Key revealed. The bounty was empty by then, so nothing was paid.");
  await expect(app.pill(card, "Revealed")).toBeVisible({ timeout: TX_TIMEOUT });
  await expect(card.locator("pre")).toHaveText(secret, { timeout: POLL_TIMEOUT });
  const info = await chain.switchInfo(sw.owner, sw.id);
  expect(info.state).toBe("revealed");
  expect(info.bounty).toBe(0n);
});
