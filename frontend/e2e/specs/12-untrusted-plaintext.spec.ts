// A released secret is attacker-controlled text. At the 2,048-byte limit
// (counted in UTF-8 bytes), with markup, a bidi override and a control
// character, it must come back as inert text: markup not parsed, the override
// removed, the control character replaced, each flagged.

import { POLL_TIMEOUT, TX_TIMEOUT } from "../support/app";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

const LIMIT = 2048;
const utf8 = (s: string) => new TextEncoder().encode(s).length;

test("a released secret at the size limit is shown as inert, flagged text", async ({ app, page, chain }) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  const head = `🔑 invoice\u202etxt.exe <img src=x onerror="alert(1)"> <b>bold</b> bell\u0007 é ${Date.now()} `;
  const secret = head + "a".repeat(LIMIT - utf8(head));
  expect(utf8(secret)).toBe(LIMIT);
  const shown = secret.replace("\u202e", "").replace("\u0007", "�");

  await page.goto("/dashboard");
  await app.connect();
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Create a switch" }) });
  const submit = form.getByRole("button", { name: "Encrypt and create" });

  // One byte over: refused before anything is encrypted.
  await form.getByLabel("The secret").fill(`${secret}a`);
  await form.getByRole("button", { name: "1 minute (testing)", exact: true }).click();
  await form.getByLabel("Bounty").fill("0.002");
  await expect(form.getByText("2,049 of 2,048 bytes: 1 over the limit")).toBeVisible();
  await expect(submit).toBeDisabled();

  const sw = await app.createSwitch({ secret, interval: "1 minute (testing)", bountyEth: "0.002" });
  expect((await chain.switchInfo(sw.owner, sw.id)).ciphertextLength).toBe(BigInt(LIMIT + 61));

  // Release it.
  await chain.travel(120);
  await app.switchAccount("hunter");
  await page.goto(sw.path);
  const card = app.card(sw.id);
  await card.getByRole("button", { name: "Mark dark" }).click();
  await app.expectToast("Marked dark: Zama's KMS may now decrypt the key");
  await card.getByRole("button", { name: "Fetch key" }).click();
  await expect(card.getByText("Key received with a KMS threshold proof.")).toBeVisible({ timeout: 60_000 });
  await card.getByRole("button", { name: "Reveal and claim 0.002 ETH" }).click();
  await app.expectToast("Key revealed: 0.002 ETH paid to you");
  await expect(app.pill(card, "Revealed")).toBeVisible({ timeout: TX_TIMEOUT });

  const pre = card.locator("pre");
  await expect(pre).toBeVisible({ timeout: POLL_TIMEOUT });
  expect(await pre.evaluate((el) => el.textContent)).toBe(shown);
  expect(await pre.evaluate((el) => el.childElementCount), "markup rendered as elements").toBe(0);
  await expect(card.getByText(`${LIMIT.toLocaleString("en-US")} bytes`)).toBeVisible();
  await expect(card.getByText("Control characters were replaced with �.")).toBeVisible();
  await expect(card.getByText(/^Bidirectional-override characters were removed/)).toBeVisible();
  // The bytes are exactly what the owner committed to, so publishing is offered.
  await expect(card.getByText("Commitment verified", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Publish plaintext" })).toBeVisible();
  expect(dialogs, "dialogs opened by the plaintext").toEqual([]);
});
