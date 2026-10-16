// A wallet that broadcasts a transaction and then loses the answer (a dropped
// WalletConnect session, a wallet RPC failing after the broadcast) reports an
// internal error and no hash. The create flow treats that as "may have been
// sent" (07-create-retries); the other writes go through lib/hooks.ts runWrite.

import { parseEther } from "viem";
import { POLL_TIMEOUT } from "../support/app";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("a ping whose wallet response was lost leaves the switch pinged and the button usable", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  await app.connect();
  const sw = await app.createSwitch({ secret: `lost-ping ${Date.now()}`, interval: "1 hour", bountyEth: "0.002" });
  await page.goto(sw.path);
  const card = app.card(sw.id);
  const before = await chain.switchInfo(sw.owner, sw.id);
  await chain.travel(30);
  await expect.poll(() => app.countdown(card), { timeout: POLL_TIMEOUT, message: "countdown after +30 s" }).toBeLessThanOrEqual(3575);

  await app.wallet.failNext("eth_sendTransaction", "lose-response");
  const ping = card.getByRole("button", { name: "Ping: I'm alive" });
  await ping.click();
  await expect(app.errorToast(/./).first()).toBeVisible();
  await expect(ping).toBeEnabled();
  // The ping did land, and the page re-read the switch after the failure: the countdown is back to the full hour.
  const after = await chain.switchInfo(sw.owner, sw.id);
  expect(after.lastPing).toBeGreaterThanOrEqual(before.lastPing + 30n);
  await expect.poll(() => app.countdown(card), { timeout: POLL_TIMEOUT, message: "countdown after the ping" }).toBeGreaterThanOrEqual(3590);
});

// FINDING F2 (frontend-lib, bug): a value-carrying write whose wallet response
// was lost is reported as a revert and offered again. runWrite (lib/hooks.ts)
// treats every send error but a rejection as "did not happen", and viem words
// the wallet's -32603 as 'The contract function "fundBounty" reverted with the
// following reason: …'. The amount stays typed and "Add ETH" enabled, while
// the top-up is already on-chain: one more click pays it twice. The create
// flow handles this case (createAttempt.mayHaveBroadcast); fundBounty does not.
test("a top-up whose wallet response was lost is not reported as reverted nor offered again", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  await app.connect();
  const sw = await app.createSwitch({ secret: `lost-topup ${Date.now()}`, interval: "1 hour", bountyEth: "0.01" });
  await page.goto(sw.path);
  const card = app.card(sw.id);
  const funder = await app.switchAccount("funder");

  await card.getByLabel("Add to the bounty").fill("0.005");
  await app.wallet.failNext("eth_sendTransaction", "lose-response");
  await card.getByRole("button", { name: "Add ETH" }).click();
  await expect.poll(async () => (await app.wallet.log()).some((e) => e.broadcast)).toBe(true);
  expect(await chain.funderStake(sw.owner, sw.id, funder)).toBe(parseEther("0.005"));
  // Settled: the write is over and the page re-read the switch.
  await expect(card.getByText("You have contributed 0.005 ETH.")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(card.getByLabel("Add to the bounty")).toBeEditable();

  // It did not revert, and the page must not say so (checked now: an error toast goes away after 9 s).
  expect(await page.getByText(/reverted/).count(), "a message saying it reverted").toBe(0);
  // The same top-up must not be one click away without a warning that the first may have gone through.
  const addAgain = card.getByRole("button", { name: "Add ETH" });
  const typed = await card.getByLabel("Add to the bounty").inputValue();
  if (typed === "0.005" && (await addAgain.isEnabled())) {
    await expect(card.getByText(/may (already )?have (been sent|gone through|landed)/i)).toBeVisible();
  }
});
