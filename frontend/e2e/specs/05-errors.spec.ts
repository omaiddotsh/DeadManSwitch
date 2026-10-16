// Scenario 5: errors. A rejection in the wallet is non-destructive; malformed
// switch links show the invalid-link page; a wallet on another chain gets the
// network guard (and can switch back from it).

import { getAddress } from "viem";
import { TX_TIMEOUT } from "../support/app";
import { addressOf } from "../support/env";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("a wallet rejection on ping is non-destructive and the button recovers", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  await app.connect();
  const sw = await app.createSwitch({ secret: `reject ${Date.now()}`, interval: "1 hour", bountyEth: "0.002" });
  await page.goto(sw.path);
  const card = app.card(sw.id);
  await expect(app.pill(card, "Alive")).toBeVisible();
  const before = await chain.switchInfo(sw.owner, sw.id);
  const sentBefore = (await app.wallet.sentHashes()).length;

  await app.wallet.rejectNext("eth_sendTransaction");
  const ping = card.getByRole("button", { name: "Ping: I'm alive" });
  await ping.click();

  // An info toast, not an error; nothing sent; the switch and the button as they were.
  await app.expectToast("Request rejected in the wallet.");
  expect(await app.errorToast(/./).count(), "error toasts").toBe(0);
  await expect(ping).toBeEnabled();
  await expect(card.getByRole("button", { name: "Cancel switch…" })).toBeEnabled();
  await expect(app.pill(card, "Alive")).toBeVisible();
  await expect(card.getByText(/Waiting for it to be mined/)).toHaveCount(0);
  expect((await app.wallet.snapshot()).pendingRejection).toBeNull();
  expect((await app.wallet.sentHashes()).length).toBe(sentBefore);
  const rejected = (await app.wallet.log()).filter((e) => e.method === "eth_sendTransaction" && !e.ok);
  expect(rejected.at(-1)?.code).toBe(4001);
  expect((await chain.switchInfo(sw.owner, sw.id)).lastPing).toBe(before.lastPing);

  // The same button works on the next try.
  await chain.travel(5);
  await ping.click();
  await app.expectToast("Pinged: the deadline moved out by one interval", TX_TIMEOUT);
  await expect(ping).toBeEnabled();
  expect((await chain.switchInfo(sw.owner, sw.id)).lastPing).toBeGreaterThan(before.lastPing);
});

test("malformed switch links show the invalid-link page", async ({ app, page }) => {
  const owner = addressOf("owner");
  const invalid = [
    `/switch/31337/not-an-address/1`,
    `/switch/31337/${owner}/0`,
    `/switch/31337/${owner}/12abc`,
    `/switch/31337/${owner}/-1`,
    `/switch/31337/${owner}/${(1n << 256n).toString()}`,
    `/switch/abc/${owner}/1`,
    `/switch/31337/${owner.slice(0, 20)}/1`,
  ];
  for (const path of invalid) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "That link isn't valid" }), path).toBeVisible();
    await expect(page.getByText("A switch link looks like /switch/<chainId>/<owner address>/<id>, with a decimal id.")).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
  }

  // Well-formed, but for a chain this build does not support / has no deployment on.
  await page.goto(`/switch/8453/${owner}/1`);
  await expect(page.getByRole("heading", { name: "chain 8453 is not supported" })).toBeVisible();
  await page.goto(`/switch/1/${owner}/1`);
  await expect(page.getByRole("heading", { name: "No deployment on Ethereum" })).toBeVisible();

  // Well-formed, on this chain, but no such switch. A lowercase owner is accepted.
  await page.goto(`/switch/31337/${owner.toLowerCase()}/424242`);
  await expect(page.getByRole("heading", { name: "Switch #424242" })).toBeVisible();
  await expect(page.getByText(`No switch #424242 for owner ${getAddress(owner)} on this network.`)).toBeVisible();

  // Not a route at all.
  await page.goto("/switch/31337");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(app.header()).toBeVisible();
});

test("a wallet on another chain gets the network guard and can switch back", async ({ app, page }) => {
  await page.goto("/dashboard");
  await app.connect();
  await expect(page.getByRole("heading", { name: "My switches", level: 1 })).toBeVisible();

  // An unsupported chain (Base).
  await app.wallet.setChainId(8453);
  await expect(page.getByRole("heading", { name: "chain 8453 is not supported" })).toBeVisible();
  await expect(page.getByText(/^Dead Man's Switch runs only on /)).toBeVisible();
  await expect(page.getByRole("heading", { name: "My switches", level: 1 })).toHaveCount(0);
  // RainbowKit's chain button in the header says so too.
  await expect(page.getByTestId("rk-wrong-network-button")).toContainText("Wrong network");

  // The guard's own button switches the wallet back (wallet_switchEthereumChain).
  await page.getByRole("button", { name: "Switch to Anvil (local)" }).click();
  await expect(page.getByRole("heading", { name: "My switches", level: 1 })).toBeVisible();
  expect((await app.wallet.snapshot()).chainId).toBe(31337);

  // A supported chain without a deployment in this build (Ethereum mainnet).
  await app.wallet.setChainId(1);
  await expect(page.getByRole("heading", { name: "Not deployed on Ethereum" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Anvil (local)" }).click();
  await expect(page.getByRole("heading", { name: "My switches", level: 1 })).toBeVisible();

  // A switch page reads its own chain whatever the wallet is on: a note, and actions ask to switch first.
  const sw = await app.createSwitch({ secret: `guard ${Date.now()}`, interval: "1 hour", bountyEth: "0.001" });
  await page.goto(sw.path);
  const card = app.card(sw.id);
  await expect(card.getByRole("button", { name: "Ping: I'm alive" })).toBeVisible();
  await app.wallet.setChainId(8453);
  await expect(page.getByText("This switch lives on Anvil (local)", { exact: true })).toBeVisible();
  await expect(page.getByText(/Your wallet is on chain 8453\. Everything below is read from Anvil \(local\)/)).toBeVisible();
  await expect(app.pill(card, "Alive")).toBeVisible();
  await expect(card.getByRole("button", { name: "Ping: I'm alive" })).toHaveCount(0);
  const switchBack = card.getByRole("button", { name: "Switch wallet to Anvil (local)" }).first();
  await expect(switchBack).toBeVisible();
  await switchBack.click();
  await expect(card.getByRole("button", { name: "Ping: I'm alive" })).toBeVisible();
  await expect(page.getByText("This switch lives on Anvil (local)", { exact: true })).toHaveCount(0);
  expect((await app.wallet.snapshot()).chainId).toBe(31337);
});
