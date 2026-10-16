// Scenario 4: the cancel path. The owner creates a switch, a funder tops it
// up, the owner cancels: it shows cancelled, stays off /hunt's claimable list
// even once its deadline is long past, offers no release, and the funder
// reclaims the contribution.

import { parseEther } from "viem";
import { POLL_TIMEOUT, TX_TIMEOUT } from "../support/app";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("a cancelled switch is never offered for release, and the funder reclaims", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  const owner = await app.connect();
  const sw = await app.createSwitch({ secret: `cancel ${Date.now()}`, interval: "1 hour", bountyEth: "0.01" });

  await page.goto(sw.path);
  const card = app.card(sw.id);
  await expect(app.pill(card, "Alive")).toBeVisible();

  // The funder adds 0.004 ETH.
  const funder = await app.switchAccount("funder");
  await card.getByLabel("Add to the bounty").fill("0.004");
  await card.getByRole("button", { name: "Add ETH" }).click();
  await app.expectToast("Bounty topped up by 0.004 ETH");
  await expect(app.fact(card, "Bounty")).toHaveText("0.014 ETH");

  // The owner cancels, behind the confirmation panel.
  await app.switchAccount("owner");
  const ownerBalanceBefore = await chain.balance(owner);
  await card.getByRole("button", { name: "Cancel switch…" }).click();
  const confirm = card.getByRole("group", { name: "Cancel this switch for good?" });
  await expect(confirm).toContainText("Contributions from other funders (0.004 ETH) are not yours");
  const doCancel = confirm.getByRole("button", { name: "Cancel switch and refund my escrow" });
  await expect(doCancel).toBeDisabled();
  await confirm.getByRole("checkbox", { name: "I understand the secret stays sealed forever and this cannot be undone." }).check();
  await doCancel.click();
  await app.expectToast("Switch cancelled: your escrow was refunded");
  const cancelTx = await app.wallet.lastSentHash();
  await expect(app.pill(card, "Cancelled")).toBeVisible({ timeout: TX_TIMEOUT });
  await expect(card.getByText("You cancelled this switch. Your escrow was refunded and the key will never be released.")).toBeVisible();
  await expect(app.fact(card, "Deadline")).toHaveCount(0);
  await expect(app.fact(card, "Went dark")).toHaveText("Never");
  expect((await chain.balance(owner)) - ownerBalanceBefore + (await chain.feeOf(cancelTx))).toBe(parseEther("0.01"));
  const cancelled = await chain.switchInfo(sw.owner, sw.id);
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.bounty).toBe(parseEther("0.004"));

  // Two hours later on-chain, far past the 1-hour deadline it would have had.
  await chain.travel(2 * 3600);

  // The hunter, on a fresh load of /hunt (the page reads the chain clock after the jump).
  await app.switchAccount("hunter");
  await page.goto("/hunt");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Newest" }).click();
  const listed = app.card(sw.id);
  await expect(listed).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(listed, "Cancelled")).toBeVisible();
  await expect(listed.getByRole("link", { name: /Start release|Fetch key and claim/ })).toHaveCount(0);
  // The same, already loaded, data under "Claimable": the cancelled switch is not there.
  await page.getByRole("button", { name: "Claimable" }).click();
  await expect(page.getByRole("button", { name: "Claimable" })).toHaveAttribute("aria-pressed", "true");
  expect(await app.card(sw.id).count(), "the cancelled switch under Claimable").toBe(0);

  // Its page offers no release to the hunter either.
  await page.goto(sw.path);
  await expect(app.pill(card, "Cancelled")).toBeVisible();
  await expect(card.getByText(/The owner cancelled this switch while alive\. Its key will never be made decryptable/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Mark dark" })).toHaveCount(0);
  await expect(card.getByRole("heading", { name: "Release the key" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: /^Reclaim/ })).toHaveCount(0); // nothing to reclaim for the hunter

  // The funder reclaims the contribution.
  await app.switchAccount("funder");
  await expect(card.getByText("The owner cancelled. Your contribution is yours to take back.")).toBeVisible();
  const funderBalanceBefore = await chain.balance(funder);
  await card.getByRole("button", { name: "Reclaim 0.004 ETH" }).click();
  await app.expectToast("Contribution reclaimed");
  const reclaimTx = await app.wallet.lastSentHash();
  await expect(card.getByRole("button", { name: /^Reclaim/ })).toHaveCount(0, { timeout: TX_TIMEOUT });
  expect((await chain.balance(funder)) - funderBalanceBefore + (await chain.feeOf(reclaimTx))).toBe(parseEther("0.004"));
  expect(await chain.funderStake(sw.owner, sw.id, funder)).toBe(0n);
  expect((await chain.switchInfo(sw.owner, sw.id)).state).toBe("cancelled");
});
