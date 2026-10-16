// The create flow's idempotency (lib/createAttempt.ts) in the browser: a
// rejected send is retried with the same switch id; a send whose response the
// wallet lost is found on-chain and adopted, never sent twice; "Create
// another" starts a new form session with a new id.

import { POLL_TIMEOUT } from "../support/app";
import type { WalletLogEntry } from "../support/injected-wallet";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

/** The switch id a createSwitch send carried: its calldata starts with the (static) params tuple, id first. */
const sentId = (e: WalletLogEntry): bigint => BigInt(`0x${(e.dataHead ?? "").slice(10, 74)}`);

test("a rejected create is retried with the same switch id", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  const owner = await app.connect();
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Create a switch" }) });

  await form.getByLabel("The secret").fill(`retry ${Date.now()}`);
  await form.getByRole("button", { name: "1 hour", exact: true }).click();
  await form.getByLabel("Bounty").fill("0.003");
  await app.wallet.rejectNext("eth_sendTransaction");
  await form.getByRole("button", { name: "Encrypt and create" }).click();

  const alert = form.getByRole("alert");
  await expect(alert).toContainText("Could not create the switch");
  await expect(alert).toContainText("Request rejected in the wallet.");
  await expect(alert).not.toContainText("The wallet may have sent the transaction anyway");
  const retry = form.getByRole("button", { name: "Try again" });
  await expect(retry).toBeEnabled();
  // The secret is still there for the retry.
  await expect(form.getByLabel("The secret")).not.toHaveValue("");

  await retry.click();
  await expect(page.getByRole("heading", { name: "Switch created" })).toBeVisible({ timeout: 120_000 });

  const sends = (await app.wallet.log()).filter((e) => e.method === "eth_sendTransaction");
  expect(sends).toHaveLength(2);
  expect(sends[0]!.ok).toBe(false);
  expect(sends[0]!.code).toBe(4001);
  expect(sends[1]!.ok).toBe(true);
  expect(sentId(sends[1]!)).toBe(sentId(sends[0]!));
  const id = sentId(sends[1]!);
  await expect(page.getByText(`Switch #${id} is live on Anvil (local).`)).toBeVisible();
  expect((await chain.switchInfo(owner, id)).state).toBe("alive");
});

test("a create whose wallet response was lost is found on-chain, not sent again", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  const owner = await app.connect();
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Create a switch" }) });

  await form.getByLabel("The secret").fill(`lost-response ${Date.now()}`);
  await form.getByRole("button", { name: "1 hour", exact: true }).click();
  await form.getByLabel("Bounty").fill("0.003");
  await app.wallet.failNext("eth_sendTransaction", "lose-response");
  await form.getByRole("button", { name: "Encrypt and create" }).click();

  // The transaction was broadcast (and mined) although the page was told it failed.
  await expect.poll(async () => (await app.wallet.log()).some((e) => e.broadcast)).toBe(true);
  const lost = (await app.wallet.log()).find((e) => e.broadcast)!;
  const id = sentId(lost);
  expect((await chain.switchInfo(owner, id)).state).toBe("alive");

  // The page keeps checking that id, finds the switch and adopts it.
  const created = page.locator("section").filter({ has: page.getByRole("heading", { name: "Switch created" }) });
  await expect(created).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(created).toContainText(`Switch #${id} is live on Anvil (local).`);
  await expect(created.getByText("Found on-chain", { exact: true })).toBeVisible();

  // Exactly one createSwitch went out.
  const sends = (await app.wallet.log()).filter((e) => e.method === "eth_sendTransaction");
  expect(sends).toHaveLength(1);
});

test("“Create another” starts a new switch with a new id", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  const owner = await app.connect();
  const first = await app.createSwitch({ secret: `first ${Date.now()}`, interval: "1 day", bountyEth: "0.001" });
  await page.getByRole("button", { name: "Create another" }).click();
  await expect(page.getByRole("heading", { name: "Create a switch" })).toBeVisible();
  // The form is empty again: the first secret is gone.
  await expect(page.getByLabel("The secret")).toHaveValue("");
  const second = await app.createSwitch({ secret: `second ${Date.now()}`, interval: "1 day", bountyEth: "0.001" });
  expect(second.id).not.toBe(first.id);
  expect((await chain.switchInfo(owner, first.id)).state).toBe("alive");
  expect((await chain.switchInfo(owner, second.id)).state).toBe("alive");
});
