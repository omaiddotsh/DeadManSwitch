// Scenario 3: the deadline passes, the switch shows dark, the hunter finds it
// on /hunt and releases it: mark dark → fetch the key (forge-fhevm's
// cleartext KMS) → verify → reveal (bounty paid) → publish. The switch page
// then shows REVEALED and the exact plaintext, as text; /archive lists it.

import { parseEther, type Hex } from "viem";
import { POLL_TIMEOUT, TX_TIMEOUT } from "../support/app";
import { addressOf } from "../support/env";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("hunter releases a dark switch and the plaintext is public", async ({ app, page, chain, actor }) => {
  // Markup and quotes must come back as literal text, never as HTML.
  const secret = `release <b>not bold</b> & "quoted" ✓ ${Date.now()}`;

  await page.goto("/dashboard");
  await app.connect();
  const sw = await app.createSwitch({ secret, interval: "1 minute (testing)", bountyEth: "0.01" });

  await page.getByRole("link", { name: "Open the switch page" }).click();
  await expect(page).toHaveURL(sw.path);
  // F1: this tab's switch list still lacks the new switch (see 01-owner-create-ping). A reload
  // drops it, as the hunter's own browser would never have had it.
  await page.reload();
  const card = app.card(sw.id);
  await expect(app.pill(card, "Alive")).toBeVisible();

  // Two minutes pass on-chain: the deadline is behind us. The page's chain clock follows at its next poll.
  await chain.travel(120);
  await expect(app.pill(card, "Dark")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(card.getByText("Ready to release")).toBeVisible();
  await expect(card.getByText(/^Your deadline passed on /)).toBeVisible();
  await expect(card.getByRole("button", { name: "Ping: I'm alive" })).toHaveCount(0);

  // The hunter (another account in the same wallet) looks for claimable switches.
  const hunter = await app.switchAccount("hunter");
  await app.nav("Hunt").click();
  await expect(page).toHaveURL("/hunt");
  await expect(page.getByRole("button", { name: "Claimable" })).toHaveAttribute("aria-pressed", "true");
  // Newest first, so this run's switch is on the first page however many earlier runs left behind.
  await page.getByRole("button", { name: "Newest" }).click();
  const huntCard = app.card(sw.id);
  await expect(huntCard).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(huntCard, "Dark")).toBeVisible();
  await expect(huntCard).toContainText("Deadline passed: mark it dark, fetch the key, claim the bounty.");
  await huntCard.getByRole("link", { name: "Start release" }).click();
  await expect(page).toHaveURL(sw.path);

  // 1. Mark dark.
  await expect(card.getByRole("heading", { name: "Release the key", level: 3 })).toBeVisible();
  await card.getByRole("button", { name: "Mark dark" }).click();
  await app.expectToast("Marked dark: Zama's KMS may now decrypt the key");
  await expect(app.pill(card, "Key release requested")).toBeVisible({ timeout: TX_TIMEOUT });
  expect((await chain.switchInfo(sw.owner, sw.id)).state).toBe("darkMarked");

  // 2. Fetch the key, 3. verify it against the ciphertext.
  await card.getByRole("button", { name: "Fetch key" }).click();
  await expect(card.getByText("Key received with a KMS threshold proof.")).toBeVisible({ timeout: 60_000 });
  await expect(
    card.getByText("The key opens the ciphertext (AES-GCM tag verified) and the plaintext matches the owner's commitment."),
  ).toBeVisible();

  // 4. Reveal and claim the bounty.
  const balanceBefore = await chain.balance(hunter);
  await card.getByRole("button", { name: "Reveal and claim 0.01 ETH" }).click();
  await app.expectToast("Key revealed: 0.01 ETH paid to you");
  const revealTx: Hex = await app.wallet.lastSentHash();
  await expect(app.pill(card, "Revealed")).toBeVisible({ timeout: TX_TIMEOUT });
  const balanceAfter = await chain.balance(hunter);
  expect(balanceAfter - balanceBefore + (await chain.feeOf(revealTx))).toBe(parseEther("0.01"));
  const revealed = await chain.switchInfo(sw.owner, sw.id);
  expect(revealed.state).toBe("revealed");
  expect(revealed.bounty).toBe(0n);

  // 5. Decrypted in this browser from chain state, shown as text.
  const plaintext = card.locator("pre");
  await expect(plaintext).toHaveText(secret, { timeout: POLL_TIMEOUT });
  expect(await plaintext.evaluate((el) => el.textContent), "the exact bytes, as text").toBe(secret);
  expect(await plaintext.evaluate((el) => el.childElementCount), "markup rendered as elements").toBe(0);
  await expect(card.getByText("Tag verified", { exact: true })).toBeVisible();
  await expect(card.getByText("Commitment verified", { exact: true })).toBeVisible();

  // 6. Publish the plaintext on-chain.
  await card.getByRole("button", { name: "Publish plaintext" }).click();
  await app.expectToast("Plaintext published on-chain");
  await expect(app.pill(card, "Plaintext published")).toBeVisible({ timeout: TX_TIMEOUT });
  await expect(card.getByText(/identical to the decrypted bytes\./)).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(card.getByText(/Also published on-chain by/)).toContainText("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
  expect((await chain.switchInfo(sw.owner, sw.id)).published).toBe(true);

  // A fresh load of the switch page, without a wallet's help: still REVEALED with the exact text.
  await page.reload();
  await expect(app.pill(card, "Revealed")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(card.locator("pre")).toHaveText(secret);

  // The archive lists it with the plaintext.
  await app.nav("Archive").click();
  await expect(page).toHaveURL("/archive");
  const archived = app.card(sw.id);
  await expect(archived).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(archived, "Revealed")).toBeVisible();
  await expect(app.pill(archived, "Plaintext published")).toBeVisible();
  await expect(archived.locator("pre")).toHaveText(secret);
  expect(hunter).toBe(addressOf("hunter"));

  // Anyone reads it, without connecting a wallet: another browser, on the archive and on the switch page.
  const visitor = await actor("funder");
  await visitor.page.goto("/archive");
  await expect(visitor.page.getByTestId("rk-connect-button")).toBeVisible();
  await expect(visitor.app.card(sw.id).locator("pre")).toHaveText(secret, { timeout: POLL_TIMEOUT });
  await visitor.page.goto(sw.path);
  const visitorCard = visitor.app.card(sw.id);
  await expect(visitor.app.pill(visitorCard, "Revealed")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(visitorCard.locator("pre")).toHaveText(secret);
  await expect(visitorCard.getByText("Commitment verified", { exact: true })).toBeVisible();
});
