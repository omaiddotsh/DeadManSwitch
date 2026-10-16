// Two hunters, two browsers, one dark switch. Each page learns of the other
// hunter's writes at its next poll (switch info every 15 s).

import { parseEther } from "viem";
import { POLL_TIMEOUT, TX_TIMEOUT } from "../support/app";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("a second hunter's page follows the first hunter's mark dark and reveal", async ({ app, page, chain, actor }) => {
  const secret = `two-hunters ${Date.now()}`;
  await page.goto("/dashboard");
  await app.connect();
  const sw = await app.createSwitch({ secret, interval: "1 minute (testing)", bountyEth: "0.01" });
  await chain.travel(120);

  // Hunter A: this browser, now on the hunter account. Hunter B: another browser, the funder's account.
  await app.switchAccount("hunter");
  await page.goto(sw.path);
  const cardA = app.card(sw.id);
  await expect(app.pill(cardA, "Dark")).toBeVisible({ timeout: POLL_TIMEOUT });
  const b = await actor("funder");
  await b.page.goto(sw.path);
  await b.app.connect();
  const cardB = b.app.card(sw.id);
  await expect(b.app.pill(cardB, "Dark")).toBeVisible({ timeout: POLL_TIMEOUT });

  // A marks dark; B's page moves on by itself.
  await cardA.getByRole("button", { name: "Mark dark" }).click();
  await app.expectToast("Marked dark: Zama's KMS may now decrypt the key");
  await expect(b.app.pill(cardB, "Key release requested")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(cardB.getByRole("button", { name: "Mark dark" })).toHaveCount(0);

  // Both fetch the key; A reveals and is paid; B's page shows the revealed secret by itself.
  await cardB.getByRole("button", { name: "Fetch key" }).click();
  await expect(cardB.getByText("Key received with a KMS threshold proof.")).toBeVisible({ timeout: 60_000 });
  await cardA.getByRole("button", { name: "Fetch key" }).click();
  await expect(cardA.getByText("Key received with a KMS threshold proof.")).toBeVisible({ timeout: 60_000 });
  const hunterA = app.addressOf("hunter");
  const balanceA = await chain.balance(hunterA);
  await cardA.getByRole("button", { name: "Reveal and claim 0.01 ETH" }).click();
  await app.expectToast("Key revealed: 0.01 ETH paid to you");
  const revealTx = await app.wallet.lastSentHash();
  expect((await chain.balance(hunterA)) - balanceA + (await chain.feeOf(revealTx))).toBe(parseEther("0.01"));

  await expect(b.app.pill(cardB, "Revealed")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(cardB.locator("pre")).toHaveText(secret, { timeout: POLL_TIMEOUT });
  await expect(cardB.getByRole("button", { name: /^Reveal and claim/ })).toHaveCount(0);
  expect(await b.wallet.sentHashes(), "B sent nothing").toEqual([]);
});

// FINDING F3 (frontend-lib, wiring): writes are not simulated before the
// wallet prompt. wagmi 2's writeContract sends eth_sendTransaction straight to
// a JSON-RPC (injected / WalletConnect) wallet, so a hunter acting on a card
// that is up to one poll stale (another hunter already marked dark or
// revealed) signs a transaction that can only revert: it is mined as a revert
// (gas paid) and the page says only "Transaction reverted on-chain.". The
// decoded messages in lib/errors.ts (AlreadyDarkMarked, AlreadyRevealed,
// NotActive, Expired …) and runWrite's "refused at simulation" path
// (lib/hooks.ts) never trigger for these wallets.
test("a hunter acting on a stale card is stopped before the wallet, with the reason", async ({ app, page, chain, actor }) => {
  await page.goto("/dashboard");
  await app.connect();
  const sw = await app.createSwitch({ secret: `stale ${Date.now()}`, interval: "1 minute (testing)", bountyEth: "0.01" });
  await chain.travel(120);
  await app.switchAccount("hunter");
  await page.goto(sw.path);
  const cardA = app.card(sw.id);
  await expect(app.pill(cardA, "Dark")).toBeVisible({ timeout: POLL_TIMEOUT });

  const b = await actor("funder");
  await b.page.goto(sw.path);
  await b.app.connect();
  const cardB = b.app.card(sw.id);
  await cardB.getByRole("button", { name: "Mark dark" }).click();
  await b.app.expectToast("Marked dark: Zama's KMS may now decrypt the key");

  // A's card still says "Dark" (its next poll is up to 15 s away).
  await expect(app.pill(cardA, "Dark")).toBeVisible();
  const sentBefore = (await app.wallet.sentHashes()).length;
  await cardA.getByRole("button", { name: "Mark dark" }).click();
  await expect(app.errorToast("Key release was already requested for this switch.")).toBeVisible({ timeout: TX_TIMEOUT });
  await expect(app.pill(cardA, "Key release requested")).toBeVisible({ timeout: TX_TIMEOUT });
  expect((await app.wallet.sentHashes()).length, "nothing sent to the chain").toBe(sentBefore);
});
