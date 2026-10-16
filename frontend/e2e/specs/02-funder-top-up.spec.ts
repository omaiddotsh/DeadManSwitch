// Scenario 2: a funder tops up the bounty on the switch page; the bounty updates.
// The owner creates the switch, opens its page, and the wallet then switches
// to the funder's account (accountsChanged): the page must follow.

import { parseEther } from "viem";
import { TX_TIMEOUT } from "../support/app";
import { addressOf } from "../support/env";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

test("funder tops up the bounty on the switch page", async ({ app, page, chain }) => {
  await page.goto("/dashboard");
  await app.connect();
  const sw = await app.createSwitch({ secret: `top-up ${Date.now()}`, interval: "1 hour", bountyEth: "0.01" });

  await page.getByRole("link", { name: "Open the switch page" }).click();
  await expect(page).toHaveURL(sw.path);
  const card = app.card(sw.id);
  await expect(card).toBeVisible();
  await expect(app.pill(card, "You")).toBeVisible();
  await expect(card.getByRole("button", { name: "Ping: I'm alive" })).toBeVisible();
  await expect(app.fact(card, "Bounty")).toHaveText("0.01 ETH");

  // The same page, now as the funder.
  const funder = await app.switchAccount("funder");
  expect(funder).toBe(addressOf("funder"));
  await expect(app.pill(card, "You")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Ping: I'm alive" })).toHaveCount(0);
  await expect(card.getByText("A bigger bounty makes it likelier someone releases this secret on time.")).toBeVisible();

  const amount = card.getByLabel("Add to the bounty");
  const add = card.getByRole("button", { name: "Add ETH" });
  await expect(add).toBeDisabled();
  await amount.fill("0.005");
  await expect(add).toBeEnabled();
  await add.click();
  await app.expectToast("Bounty topped up by 0.005 ETH", TX_TIMEOUT);

  // The write refreshes the switch at once: the new bounty and the funder's stake.
  await expect(app.fact(card, "Bounty")).toHaveText("0.015 ETH");
  await expect(card.getByText("You have contributed 0.005 ETH.")).toBeVisible();
  await expect(amount).toHaveValue("");

  const info = await chain.switchInfo(sw.owner, sw.id);
  expect(info.bounty).toBe(parseEther("0.015"));
  expect(info.ownerStake).toBe(parseEther("0.01"));
  expect(await chain.funderStake(sw.owner, sw.id, funder)).toBe(parseEther("0.005"));

  // The fundBounty transaction came from the funder's account.
  const log = await app.wallet.log();
  const sent = log.filter((e) => e.method === "eth_sendTransaction" && e.ok);
  expect(sent.at(-1)?.from?.toLowerCase()).toBe(funder.toLowerCase());
});
