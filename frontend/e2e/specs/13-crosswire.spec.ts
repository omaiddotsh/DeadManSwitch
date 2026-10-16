// Cross-component wiring: the contract, the client (the `dms` CLI and the
// watcher, run as real subprocesses of client/dist) and the frontend, on one
// Anvil and one DeadManSwitch. Each side must read what the other wrote.
//
//   A  a switch created with the CLI is shown by the UI (the owner's open
//      dashboard at its next scan, and the switch page, technical details
//      included), released through the UI hunter flow, then `dms read` returns
//      the exact bytes; a `dms publish` shows on the page
//   B  a switch created in the UI is discovered by the watcher, left alone
//      before its deadline, then marked, revealed, archived and published by
//      one `--once` pass; the open page follows to REVEALED with the text
//   B2 a switch created in the UI is released with `dms mark-dark` and
//      `dms reveal --publish --out`: the exact bytes, and the open page follows
//   C1 ping, fund-bounty and cancel from the CLI show on an open switch page;
//      a UI reclaim shows in `dms info`
//   C2 ping, top-up and cancel in the UI show in `dms info`; the CLI then
//      refuses mark-dark on the cancelled switch, and a CLI reclaim shows in
//      the UI
//   C3 an admin nomination made in the UI, and its cancellation, show in
//      `dms status`
//   C4 and F6: regression tests for fixed app bugs (FINDING comments above each)
//
// The CLI signs with the same Anvil dev keys the browser wallet uses (owner
// #1, hunter #2, funder #3, admin #0); the watcher signs with #4.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { encodePacked, keccak256, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { dmsAbi } from "../../lib/abi";
import { fmtBytes32 } from "../../lib/switch";
import { POLL_TIMEOUT, TX_TIMEOUT, type App } from "../support/app";
import { bigSwitchId, cliAddress, describeRun, type CliRun } from "../support/cli";
import { addressOf, appAddress } from "../support/env";
import { expect, test } from "../support/fixtures";

test.use({ role: "owner" });

const switchUrl = (owner: Address, id: bigint): string => `/switch/31337/${owner}/${id}`;
const iso = (unix: bigint): string => new Date(Number(unix) * 1000).toISOString();
const keyOf = (owner: Address, id: bigint) => keccak256(encodePacked(["address", "uint256"], [owner, id]));

/** lib/switch.ts fmtDateTime as the test browser renders it (locale en-US, timezone UTC). */
const uiDateTime = (unix: bigint): string =>
  norm(new Date(Number(unix) * 1000).toLocaleString("en-US", {
    timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }));
/** ICU puts a narrow no-break space before AM/PM; compare with plain spaces. */
const norm = (s: string): string => s.replace(/[\s\u00a0\u202f]+/g, " ").trim();
const textOf = async (l: Locator): Promise<string> => norm(await l.innerText());

/** The `key: value` lines `dms create` prints. */
const createdFields = (r: CliRun) => {
  const field = (label: string): string => {
    const m = new RegExp(`^\\s+${label}:\\s+(0x[0-9a-fA-F]{64})$`, "m").exec(r.stdout);
    if (!m) throw new Error(`no "${label}" in the create output\n${describeRun(r)}`);
    return m[1]!.toLowerCase();
  };
  return { switchKey: field("switch key"), handle: field("key handle"), commitment: field("commitment") };
};

/** The watcher's "pass: polled N, marked N, …" line (the last one). */
const passLine = (r: CliRun) => {
  const all = [...`${r.stdout}\n${r.stderr}`.matchAll(
    /pass: polled (\d+), marked (\d+), revealed (\d+), saved (\d+), published (\d+), lost races (\d+), unprofitable (\d+), pending (\d+), errors (\d+)/g,
  )];
  const m = all.at(-1);
  if (!m) throw new Error(`no pass line in the watcher output\n${describeRun(r)}`);
  const [polled, marked, revealed, saved, published, lostRaces, unprofitable, pending, errors] = m.slice(1).map(Number);
  return { polled, marked, revealed, saved, published, lostRaces, unprofitable, pending, errors };
};

/** Bounty, interval, last ping, deadline and countdown of a live switch, against the chain's numbers. */
const expectAliveCard = async (
  app: App,
  card: Locator,
  want: { lastPing: bigint; expiresAt: bigint; pingInterval: bigint },
  shown: { bounty: string; interval: string },
): Promise<void> => {
  await expect(app.pill(card, "Alive")).toBeVisible();
  await expect(app.fact(card, "Bounty")).toHaveText(shown.bounty);
  await expect(app.fact(card, "Ping interval")).toHaveText(shown.interval);
  expect(await textOf(app.fact(card, "Last ping"))).toBe(uiDateTime(want.lastPing));
  expect(await textOf(app.fact(card, "Deadline"))).toBe(uiDateTime(want.expiresAt));
  const left = await app.countdown(card);
  expect(left).toBeLessThanOrEqual(Number(want.pingInterval));
  expect(left).toBeGreaterThan(Number(want.pingInterval) - 300);
};

/** The switch page's "Technical details" rows, by label. */
const technicalDetails = async (card: Locator): Promise<Record<string, string>> => {
  await card.getByText("Technical details", { exact: true }).click();
  const rows = card.locator("details dl > div");
  await expect(rows.first()).toBeVisible();
  const out: Record<string, string> = {};
  for (const row of await rows.all()) out[await textOf(row.locator("dt"))] = await textOf(row.locator("dd"));
  return out;
};

/** On a dark switch's page, as the hunter: mark dark, fetch the key, check it, reveal and claim `bounty`. */
const releaseInUi = async (app: App, card: Locator, bounty: string): Promise<void> => {
  await expect(card.getByRole("heading", { name: "Release the key", level: 3 })).toBeVisible();
  await card.getByRole("button", { name: "Mark dark" }).click();
  await app.expectToast("Marked dark: Zama's KMS may now decrypt the key");
  await expect(app.pill(card, "Key release requested")).toBeVisible({ timeout: TX_TIMEOUT });
  await card.getByRole("button", { name: "Fetch key" }).click();
  await expect(card.getByText("Key received with a KMS threshold proof.")).toBeVisible({ timeout: 60_000 });
  // The UI's own check of what the CLI sealed: AES-GCM tag and the owner's commitment.
  await expect(
    card.getByText("The key opens the ciphertext (AES-GCM tag verified) and the plaintext matches the owner's commitment."),
  ).toBeVisible();
  await card.getByRole("button", { name: `Reveal and claim ${bounty}` }).click();
  await app.expectToast(`Key revealed: ${bounty} paid to you`);
  await expect(app.pill(card, "Revealed")).toBeVisible({ timeout: TX_TIMEOUT });
};

/** The released text on a page: exactly `secret`, as text. */
const expectPlaintext = async (card: Locator, secret: string): Promise<void> => {
  const pre = card.locator("pre");
  await expect(pre).toHaveCount(1, { timeout: POLL_TIMEOUT });
  await expect.poll(() => pre.evaluate((el) => el.textContent), { timeout: POLL_TIMEOUT, message: "the released text" }).toBe(secret);
  expect(await pre.evaluate((el) => el.childElementCount), "markup rendered as elements").toBe(0);
  await expect(card.getByText("Tag verified", { exact: true })).toBeVisible();
  await expect(card.getByText("Commitment verified", { exact: true })).toBeVisible();
};

// ---------------------------------------------------------------------------

test("A: a switch created with the CLI shows in the UI, the UI hunter releases it, and `dms read` returns the same bytes", async ({
  app,
  page,
  chain,
  cli,
}) => {
  const owner = cliAddress("owner");
  expect(owner).toBe(addressOf("owner"));
  const id = bigSwitchId();
  // Markup, quotes, non-ASCII, an emoji, a tab, newlines and a trailing newline (as `echo … > file` leaves).
  const secret = `cli to ui ${Date.now()}\n<b>not bold</b> & "quoted" ✓ 🔑 ünïcødé\n\tan indented line\n`;
  const bytes = Buffer.from(secret, "utf8");
  const file = await cli.file("secret-a.txt", bytes);

  // 1. The owner's dashboard is open (connected with the same key) when they create the switch from a terminal.
  await page.goto("/dashboard");
  expect(await app.connect()).toBe(owner);
  const mine = page.getByRole("region", { name: /^Your switches/ });
  await expect(mine.getByRole("article").first().or(mine.getByText("No switches yet"))).toBeVisible({ timeout: POLL_TIMEOUT });
  const created = await cli.ok("owner", ["create", id.toString(), "3600", "0.01", "--file", file]);
  expect(created.stdout).toContain(`sealed ${bytes.length} bytes -> ${bytes.length + 61}-byte ciphertext (AES-256-GCM, v1)`);
  expect(created.stdout).toContain(`created switch ${id} for ${owner}`);
  const printed = createdFields(created);
  const info = await chain.switchInfo(owner, id);
  expect(info.state).toBe("alive");
  expect(info.bounty).toBe(parseEther("0.01"));
  expect(info.ownerStake).toBe(parseEther("0.01"));
  expect(info.pingInterval).toBe(3600n);
  expect(info.ciphertextLength).toBe(BigInt(bytes.length + 61));
  expect(info.encKeyHandle.toLowerCase()).toBe(printed.handle);
  expect(info.plaintextCommitment.toLowerCase()).toBe(printed.commitment);
  expect(printed.switchKey).toBe(keyOf(owner, id));
  expect(created.stdout).toContain(`deadline:     ${iso(info.expiresAt)}`);

  // 2. The open dashboard lists it at its next scan of SwitchCreated logs (every 60 s), with the chain's numbers.
  const listed = app.card(id);
  await expect(listed).toBeVisible({ timeout: 60_000 + POLL_TIMEOUT });
  await expect(app.pill(listed, "You")).toBeVisible();
  await expectAliveCard(app, listed, info, { bounty: "0.01 ETH", interval: "1h" });
  await expect(listed.getByRole("button", { name: "Ping: I'm alive" })).toBeVisible();

  // 3. Its page: the same, and the technical details the UI derives match what the CLI printed.
  await page.goto(switchUrl(owner, id));
  await expect(page.getByRole("heading", { name: `Switch #${id}` })).toBeVisible();
  const card = app.card(id);
  await expect(card).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(card, "You")).toBeVisible();
  await expectAliveCard(app, card, info, { bounty: "0.01 ETH", interval: "1h" });
  const details = await technicalDetails(card);
  expect(details).toMatchObject({
    Contract: chain.dms,
    "Switch id": id.toString(),
    "Switch key": fmtBytes32(printed.switchKey),
    "Encrypted key handle (euint256)": fmtBytes32(printed.handle),
    "Plaintext commitment": fmtBytes32(printed.commitment),
    Ciphertext: `${bytes.length + 61} bytes (secret ${bytes.length} bytes)`,
    Created: uiDateTime(info.createdAt),
    "Owner escrow": `${parseEther("0.01")} wei`,
  });

  // 4. An hour and two minutes later on-chain, nobody pinged: the page goes dark.
  await chain.travel(3600 + 120);
  await expect(app.pill(card, "Dark")).toBeVisible({ timeout: POLL_TIMEOUT });

  // 5. The hunter (the wallet's hunter account) finds it on /hunt and releases it in the UI.
  const hunter = await app.switchAccount("hunter");
  await app.nav("Hunt").click();
  await expect(page).toHaveURL("/hunt");
  await expect(page.getByRole("button", { name: "Claimable" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Newest" }).click();
  const huntCard = app.card(id);
  await expect(huntCard).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(huntCard, "Dark")).toBeVisible();
  await huntCard.getByRole("link", { name: "Start release" }).click();
  // The hunt card's link names the switch's deployment (lib/switch.ts switchPath).
  await expect(page).toHaveURL(new RegExp(`${switchUrl(owner, id)}\\?contract=0x[0-9a-fA-F]{40}$`));
  const hunterBefore = await chain.balance(hunter);
  const sentBefore = (await app.wallet.sentHashes()).length;
  await releaseInUi(app, card, "0.01 ETH");
  // The hunter's two transactions (markDark, revealKey): paid the bounty, less their fees.
  const sent = (await app.wallet.sentHashes()).slice(sentBefore);
  expect(sent).toHaveLength(2);
  let fees = 0n;
  for (const h of sent) fees += await chain.feeOf(h);
  expect((await chain.balance(hunter)) - hunterBefore + fees).toBe(parseEther("0.01"));
  await expectPlaintext(card, secret);
  const revealed = await chain.switchInfo(owner, id);
  expect(revealed.state).toBe("revealed");

  // 6. The CLI sees the reveal, and decrypts the same bytes from chain state alone.
  const after = await cli.info(owner, id);
  expect(after).toMatchObject({
    state: "REVEALED",
    revealedKey: revealed.revealedKey,
    revealedAt: revealed.revealedAt.toString(),
    bountyWei: "0",
    published: false,
    plaintextLength: String(bytes.length),
  });
  const out = cli.path("read-a.bin");
  const toFile = await cli.ok("reader", ["read", owner, id.toString(), "--out", out]);
  expect(toFile.stdout).toContain(`wrote ${bytes.length} plaintext bytes to ${out}`);
  expect((await cli.read(out)).equals(bytes), "dms read --out: the exact bytes").toBe(true);
  const shown = await cli.ok("reader", ["read", owner, id.toString()]);
  expect(shown.stdout).toContain("AES-GCM tag:  verified");
  expect(shown.stdout).toContain("commitment:   verified");
  expect(shown.stdout).toContain("published:    no");
  // TAB and LF are kept; nothing here needed escaping.
  expect(shown.stdout).toContain(`----- plaintext (${bytes.length} bytes) -----\n${secret}\n----- end plaintext -----`);
  expect(shown.stderr).not.toContain("escaped");

  // 7. Anyone publishes it from the CLI (here the funder's key); the page shows who did, and that it matches.
  const funder = cliAddress("funder");
  const published = await cli.ok("funder", ["publish", owner, id.toString()]);
  expect(published.stdout).toContain(`published ${bytes.length} plaintext bytes for switch ${id}`);
  expect((await chain.switchInfo(owner, id)).published).toBe(true);
  // A revealed switch is re-read every 5 minutes (lib/hooks.ts switchInfoPollMs): reload rather than wait.
  await page.reload();
  await expect(app.pill(card, "Revealed")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(card, "Plaintext published")).toBeVisible();
  await expect(card.getByText(/Also published on-chain by/)).toContainText(appAddress(funder), { timeout: POLL_TIMEOUT });
  await expect(card.getByText(/identical to the decrypted bytes\./)).toBeVisible();
  await expectPlaintext(card, secret);
});

test("B: the watcher marks, reveals and publishes a switch created in the UI, and the UI follows", async ({ app, page, chain, cli }) => {
  const fromBlock = await chain.client.getBlockNumber();
  const secret = `ui to watcher ${Date.now()}\n<script>alert(1)</script> & "quoted" ✓ 🔑`;
  const bytes = Buffer.from(secret, "utf8");

  await page.goto("/dashboard");
  const owner = await app.connect();
  const sw = await app.createSwitch({ secret, interval: "1 hour", bountyEth: "0.01" });

  // Discovery from the block before the create: this switch and no other (earlier specs left dark ones behind).
  const outDir = cli.path("released");
  const stateFile = cli.path("watcher-state.json");
  const config = await cli.file(
    "watcher.config.json",
    JSON.stringify({ outDir, stateFile, fromBlock: fromBlock.toString(), discover: true, publish: true }, null, 2),
  );
  const watcher = cliAddress("watcher");

  // 1. Before the deadline the watcher finds the switch and leaves it alone.
  const early = await cli.watcher(["--once", "--config", config]);
  expect(early.code, describeRun(early)).toBe(0);
  expect(passLine(early)).toMatchObject({ marked: 0, revealed: 0, saved: 0, published: 0, lostRaces: 0, pending: 0, errors: 0 });
  const tracked = Object.values((JSON.parse(await readFile(stateFile, "utf8")) as { switches: Record<string, { owner: string; id: string }> }).switches);
  expect(tracked.map((t) => [t.owner.toLowerCase(), t.id]), "switches the watcher discovered").toEqual([[owner.toLowerCase(), sw.id.toString()]]);
  expect((await chain.switchInfo(owner, sw.id)).state).toBe("alive");

  // 2. The owner's page is open while the deadline passes.
  await page.goto(sw.path);
  const card = app.card(sw.id);
  await expect(app.pill(card, "Alive")).toBeVisible({ timeout: POLL_TIMEOUT });
  await chain.travel(3600 + 120);
  await expect(app.pill(card, "Dark")).toBeVisible({ timeout: POLL_TIMEOUT });

  // 3. One pass: mark dark, public decrypt (forge-fhevm's cleartext KMS), reveal, archive, publish.
  const watcherBefore = await chain.balance(watcher);
  const pass = await cli.watcher(["--once", "--config", config]);
  expect(pass.code, describeRun(pass)).toBe(0);
  expect(passLine(pass)).toMatchObject({ marked: 1, revealed: 1, saved: 1, published: 1, lostRaces: 0, unprofitable: 0, pending: 0, errors: 0 });
  // Its three transactions, as it logged them: the bounty, less their fees, is exactly what it gained.
  const sent = [...pass.stdout.matchAll(/: (markDark|revealKey|publishPlaintext) sent (0x[0-9a-f]{64}) /g)].map((m) => [m[1], m[2] as Hex] as const);
  expect(sent.map(([kind]) => kind)).toEqual(["markDark", "revealKey", "publishPlaintext"]);
  let fees = 0n;
  for (const [, hash] of sent) {
    const receipt = await chain.receipt(hash);
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(watcher.toLowerCase());
    fees += receipt.gasUsed * receipt.effectiveGasPrice;
  }
  expect((await chain.balance(watcher)) - watcherBefore + fees).toBe(parseEther("0.01"));
  const revealed = await chain.switchInfo(owner, sw.id);
  expect(revealed.state).toBe("revealed");
  expect(revealed.published).toBe(true);
  expect(revealed.bounty).toBe(0n);
  const [paid] = await chain.client.getContractEvents({
    address: chain.dms, abi: dmsAbi, eventName: "KeyRevealed", args: { switchKey: keyOf(owner, sw.id) }, fromBlock,
  });
  expect(paid?.args.revealer).toBe(watcher);
  expect(paid?.args.bountyPaid).toBe(parseEther("0.01"));
  const [pub] = await chain.client.getContractEvents({
    address: chain.dms, abi: dmsAbi, eventName: "PlaintextPublished", args: { switchKey: keyOf(owner, sw.id) }, fromBlock,
  });
  expect(pub?.args.publisher).toBe(watcher);
  expect(Buffer.from((pub?.args.payload ?? "0x").slice(2), "hex").equals(bytes), "published payload: the exact bytes").toBe(true);

  // Its archive: the exact bytes, and a record of what it did.
  const dir = join(outDir, `31337-${chain.dms.toLowerCase()}`);
  const stem = `${owner.toLowerCase()}-${sw.id}`;
  expect((await readdir(dir)).sort()).toEqual([`${stem}.bin`, `${stem}.json`]);
  expect((await readFile(join(dir, `${stem}.bin`))).equals(bytes), "archived plaintext: the exact bytes").toBe(true);
  const record = JSON.parse(await readFile(join(dir, `${stem}.json`), "utf8")) as Record<string, unknown>;
  expect(record).toMatchObject({
    chainId: 31337,
    id: sw.id.toString(),
    revealedKey: revealed.revealedKey,
    revealedByUs: true,
    lostRaces: [],
    keyMismatch: false,
    commitmentMatches: true,
    plaintextBytes: bytes.length,
  });
  expect(String(record.owner).toLowerCase()).toBe(owner.toLowerCase());
  expect(String(record.contract).toLowerCase()).toBe(chain.dms.toLowerCase());

  // 4. The owner's page, untouched since, follows at its next poll: REVEALED, the exact text, published by the watcher.
  await expect(app.pill(card, "Revealed")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(card, "Plaintext published")).toBeVisible();
  await expectPlaintext(card, secret);
  await expect(card.getByText(/Also published on-chain by/)).toContainText(appAddress(watcher), { timeout: POLL_TIMEOUT });
  await expect(card.getByText(/identical to the decrypted bytes\./)).toBeVisible();
  await expect(card.getByRole("button", { name: "Publish plaintext" })).toHaveCount(0);

  // The archive page lists it too.
  await app.nav("Archive").click();
  await expect(page).toHaveURL("/archive");
  const archived = app.card(sw.id);
  await expect(archived).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(archived, "Plaintext published")).toBeVisible();
  await expect.poll(() => archived.locator("pre").evaluate((el) => el.textContent), { timeout: POLL_TIMEOUT }).toBe(secret);

  // 5. Another pass has nothing left to do: no second publish, no new files.
  const again = await cli.watcher(["--once", "--config", config]);
  expect(again.code, describeRun(again)).toBe(0);
  expect(passLine(again)).toMatchObject({ marked: 0, revealed: 0, published: 0, lostRaces: 0, errors: 0 });
  expect((await readdir(dir)).sort()).toEqual([`${stem}.bin`, `${stem}.json`]);
});

test("B2: `dms mark-dark` and `dms reveal --publish` release a switch created in the UI, and the UI follows", async ({ app, page, chain, cli }) => {
  const secret = `ui to cli hunter ${Date.now()}\n<i>not italic</i> & "quoted" ✓`;
  const bytes = Buffer.from(secret, "utf8");
  await page.goto("/dashboard");
  const owner = await app.connect();
  const sw = await app.createSwitch({ secret, interval: "1 minute (testing)", bountyEth: "0.01" });
  const id = sw.id.toString();
  await page.goto(sw.path);
  const card = app.card(sw.id);
  await chain.travel(120);
  await expect(app.pill(card, "Dark")).toBeVisible({ timeout: POLL_TIMEOUT });

  // A hunter with the CLI marks it dark; the owner's open page follows.
  const hunter = cliAddress("hunter");
  const dark = await cli.ok("hunter", ["mark-dark", owner, id]);
  const handle = (await chain.switchInfo(owner, sw.id)).encKeyHandle;
  expect(dark.stdout).toContain(`marked switch ${id} dark; the KMS will now decrypt key handle ${handle} for anyone`);
  await expect(app.pill(card, "Key release requested")).toBeVisible({ timeout: POLL_TIMEOUT });

  // It fetches the key (one handle), opens what the browser sealed, reveals, publishes and saves the exact bytes.
  const out = cli.path("released-b2.bin");
  const before = await chain.balance(hunter);
  const reveal = await cli.ok("hunter", ["reveal", owner, id, "--publish", "--out", out]);
  expect(reveal.stdout).toContain(`revealed the key of switch ${id}; bounty paid to ${hunter}: 0.01 ETH`);
  expect(reveal.stdout).toMatch(/^published plaintext on-chain: 0x[0-9a-f]{64} \(gas \d+\)$/m);
  expect(reveal.stderr).not.toContain("WARNING");
  expect((await cli.read(out)).equals(bytes), "dms reveal --out: the exact bytes the browser sealed").toBe(true);
  const fees = [...reveal.stdout.matchAll(/(0x[0-9a-f]{64}) \(gas \d+\)$/gm)].map((m) => m[1] as Hex);
  expect(fees).toHaveLength(2);
  let paid = 0n;
  for (const h of fees) paid += await chain.feeOf(h);
  expect((await chain.balance(hunter)) - before + paid).toBe(parseEther("0.01"));

  // The owner's page, untouched, follows: REVEALED, the exact text, published by the CLI's account.
  await expect(app.pill(card, "Revealed")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(card, "Plaintext published")).toBeVisible();
  await expectPlaintext(card, secret);
  await expect(card.getByText(/Also published on-chain by/)).toContainText(appAddress(hunter), { timeout: POLL_TIMEOUT });
  await expect(card.getByText(/identical to the decrypted bytes\./)).toBeVisible();
});

test("C1: ping, fund-bounty and cancel from the CLI show on an open switch page", async ({ app, page, chain, cli }) => {
  const owner = cliAddress("owner");
  const funder = cliAddress("funder");
  const id = bigSwitchId();
  const created = await cli.ok("owner", ["create", id.toString(), "3600", "0.01", `cli spot checks ${Date.now()}`]);
  expect(created.stderr).toContain("note: an inline secret is visible in shell history");

  await page.goto(switchUrl(owner, id));
  await app.connect();
  const card = app.card(id);
  await expect(card).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.pill(card, "You")).toBeVisible();
  await expectAliveCard(app, card, await chain.switchInfo(owner, id), { bounty: "0.01 ETH", interval: "1h" });

  // Ping: 20 minutes pass, then the owner pings from the terminal.
  await chain.travel(1200);
  await expect.poll(() => app.countdown(card), { timeout: POLL_TIMEOUT, message: "countdown after +20 min" }).toBeLessThanOrEqual(2400);
  const before = await chain.switchInfo(owner, id);
  const ping = await cli.ok("owner", ["ping", id.toString()]);
  const pinged = await chain.switchInfo(owner, id);
  expect(pinged.lastPing).toBeGreaterThanOrEqual(before.lastPing + 1200n);
  expect(pinged.expiresAt).toBe(pinged.lastPing + 3600n);
  expect(ping.stdout).toContain(`pinged switch ${id}; next deadline ${iso(pinged.expiresAt)}`);
  await expect.poll(() => app.countdown(card), { timeout: POLL_TIMEOUT, message: "countdown after the CLI ping" }).toBeGreaterThan(3300);
  await expect.poll(() => textOf(app.fact(card, "Last ping")), { timeout: POLL_TIMEOUT }).toBe(uiDateTime(pinged.lastPing));
  expect(await textOf(app.fact(card, "Deadline"))).toBe(uiDateTime(pinged.expiresAt));

  // fund-bounty: the funder adds 0.005 ETH from the terminal.
  const fund = await cli.ok("funder", ["fund-bounty", owner, id.toString(), "0.005"]);
  expect(fund.stdout).toContain("funded 0.005 ETH; bounty is now 0.015 ETH");
  await expect(app.fact(card, "Bounty")).toHaveText("0.015 ETH", { timeout: POLL_TIMEOUT });
  // The same funder in the browser sees the contribution as theirs.
  await app.switchAccount("funder");
  await expect(card.getByText("You have contributed 0.005 ETH.")).toBeVisible({ timeout: POLL_TIMEOUT });
  await app.switchAccount("owner");

  // Cancel from the terminal: the page shows it cancelled, with the funder's 0.005 ETH still in the pot.
  const cancel = await cli.ok("owner", ["cancel", id.toString()]);
  expect(cancel.stdout).toContain(`cancelled switch ${id}; refunded 0.01 ETH. The key will never be released.`);
  await expect(app.pill(card, "Cancelled")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.fact(card, "Went dark")).toHaveText("Never");
  await expect(app.fact(card, "Unreclaimed contributions")).toHaveText("0.005 ETH");
  await expect(card.getByText("You cancelled this switch. Your escrow was refunded and the key will never be released.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Ping: I'm alive" })).toHaveCount(0);

  // The funder reclaims in the browser; `dms info` with the funder's key agrees.
  await app.switchAccount("funder");
  await expect(card.getByText("The owner cancelled. Your contribution is yours to take back.")).toBeVisible();
  await card.getByRole("button", { name: "Reclaim 0.005 ETH" }).click();
  await app.expectToast("Contribution reclaimed");
  await expect(card.getByRole("button", { name: /^Reclaim/ })).toHaveCount(0, { timeout: TX_TIMEOUT });
  const info = await cli.info(owner, id, "funder");
  expect(info).toMatchObject({ state: "CANCELLED", bountyWei: "0", ownerStakeWei: "0", yourFunderStakeWei: "0" });
  expect(await chain.funderStake(owner, id, funder)).toBe(0n);
});

test("C2: ping, top-up and cancel in the UI show in `dms info`; the CLI refuses mark-dark on the cancelled switch", async ({
  app,
  page,
  chain,
  cli,
}) => {
  const secret = `ui spot checks ${Date.now()} ✓`;
  const bytes = Buffer.from(secret, "utf8");
  await page.goto("/dashboard");
  const owner = await app.connect();
  const sw = await app.createSwitch({ secret, interval: "1 hour", bountyEth: "0.01" });
  const id = sw.id.toString();

  // Created in the UI: `dms info` reads every field as the contract stores it.
  const onChain = await chain.switchInfo(owner, sw.id);
  let info = await cli.info(owner, sw.id);
  expect(info).toMatchObject({
    contract: chain.dms,
    owner,
    id,
    switchKey: keyOf(owner, sw.id),
    state: "ALIVE",
    lastPing: onChain.lastPing.toString(),
    createdAt: onChain.createdAt.toString(),
    pingInterval: "3600",
    expiresAt: (onChain.lastPing + 3600n).toString(),
    bountyWei: parseEther("0.01").toString(),
    ownerStakeWei: parseEther("0.01").toString(),
    plaintextCommitment: onChain.plaintextCommitment,
    encKeyHandle: onChain.encKeyHandle,
    revealedKey: `0x${"0".repeat(64)}`,
    ciphertextLength: String(bytes.length + 61),
    plaintextLength: String(bytes.length),
    published: false,
    rescuable: false,
  });
  expect(info).not.toHaveProperty("yourFunderStakeWei");
  const text = await cli.ok("reader", ["info", owner, id]);
  expect(text.stdout).toContain(`state          ALIVE — the owner is alive; the deadline is ${iso(onChain.expiresAt)} (in `);
  expect(text.stdout).toContain(`ciphertext     ${bytes.length + 61} bytes (${bytes.length}-byte plaintext)`);

  // Ping in the UI after 15 minutes.
  await page.goto(sw.path);
  const card = app.card(sw.id);
  await expect(app.pill(card, "Alive")).toBeVisible({ timeout: POLL_TIMEOUT });
  await chain.travel(900);
  await expect.poll(() => app.countdown(card), { timeout: POLL_TIMEOUT, message: "countdown after +15 min" }).toBeLessThanOrEqual(2700);
  await card.getByRole("button", { name: "Ping: I'm alive" }).click();
  await app.expectToast("Pinged: the deadline moved out by one interval");
  const pinged = await chain.switchInfo(owner, sw.id);
  expect(pinged.lastPing).toBeGreaterThanOrEqual(onChain.lastPing + 900n);
  info = await cli.info(owner, sw.id);
  expect(info).toMatchObject({ state: "ALIVE", lastPing: pinged.lastPing.toString(), expiresAt: (pinged.lastPing + 3600n).toString() });

  // The funder tops up 0.004 ETH in the UI; `dms info` with the funder's key shows it as theirs.
  const funder = await app.switchAccount("funder");
  await card.getByLabel("Add to the bounty").fill("0.004");
  await card.getByRole("button", { name: "Add ETH" }).click();
  await app.expectToast("Bounty topped up by 0.004 ETH");
  info = await cli.info(owner, sw.id, "funder");
  expect(info).toMatchObject({
    bountyWei: parseEther("0.014").toString(),
    ownerStakeWei: parseEther("0.01").toString(),
    yourFunderStakeWei: parseEther("0.004").toString(),
  });
  expect((await cli.info(owner, sw.id, "hunter")).yourFunderStakeWei).toBe("0");

  // The owner cancels in the UI.
  await app.switchAccount("owner");
  await card.getByRole("button", { name: "Cancel switch…" }).click();
  const confirm = card.getByRole("group", { name: "Cancel this switch for good?" });
  await confirm.getByRole("checkbox", { name: "I understand the secret stays sealed forever and this cannot be undone." }).check();
  await confirm.getByRole("button", { name: "Cancel switch and refund my escrow" }).click();
  await app.expectToast("Switch cancelled: your escrow was refunded");
  await expect(app.pill(card, "Cancelled")).toBeVisible({ timeout: TX_TIMEOUT });
  info = await cli.info(owner, sw.id);
  expect(info).toMatchObject({ state: "CANCELLED", stateCode: 5, ownerStakeWei: "0", bountyWei: parseEther("0.004").toString() });
  expect((await cli.ok("reader", ["info", owner, id])).stdout).toContain(
    "state          CANCELLED — the owner cancelled this switch; its key is never released",
  );

  // Two hours later, far past the deadline it had: the CLI refuses to mark it dark.
  await chain.travel(2 * 3600);
  const markDark = await cli.run("hunter", ["mark-dark", owner, id]);
  expect(markDark.code, describeRun(markDark)).toBe(1);
  expect(markDark.stderr).toContain("cannot mark dark: the owner cancelled this switch; its key is never released");
  expect((await chain.switchInfo(owner, sw.id)).state).toBe("cancelled");

  // The funder reclaims from the terminal; the page (reloaded: cancelled switches are re-read every 5 minutes) agrees.
  const reclaim = await cli.ok("funder", ["reclaim", owner, id]);
  expect(reclaim.stdout).toContain("reclaimed 0.004 ETH");
  expect(await chain.funderStake(owner, sw.id, funder)).toBe(0n);
  await app.switchAccount("funder");
  await page.reload();
  await expect(app.pill(card, "Cancelled")).toBeVisible({ timeout: POLL_TIMEOUT });
  await expect(app.fact(card, "Unreclaimed contributions")).toHaveText("None");
  await expect(card.getByRole("button", { name: /^Reclaim/ })).toHaveCount(0);
});

test.describe("as the deployer", () => {
  test.use({ role: "admin" });

  test("C3: an admin nomination in the UI, and its cancellation, show in `dms status`", async ({ app, page, chain, cli }) => {
    const admin = addressOf("admin");
    const nominee = addressOf("funder");
    let status = await cli.status();
    expect(status).toMatchObject({ chainId: 31337, address: chain.dms, admin, pendingAdmin: zeroAddress, minBountyUsd: "0", ethUsdPriceFeed: zeroAddress });
    expect(status.relayer).toContain("cleartext()");

    await page.goto("/admin");
    expect(await app.connect()).toBe(admin);
    const settings = page.locator("section").filter({ has: page.getByRole("heading", { name: "Current settings" }) });
    const row = (label: string) => settings.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
    await expect(row("Admin")).toContainText(admin);
    await expect(row("Pending admin")).toHaveText("None");

    // Nominate the funder's account.
    const transfer = page.locator("section").filter({ has: page.getByRole("heading", { name: "Transfer admin", level: 2 }) });
    await transfer.getByRole("textbox", { name: "New admin address" }).fill(nominee);
    await transfer.getByRole("button", { name: "Review" }).click();
    const confirm = transfer.getByRole("group", { name: "Nominate a new admin?" });
    await confirm.getByRole("checkbox").check();
    await confirm.getByRole("textbox").fill("TRANSFER");
    await confirm.getByRole("button", { name: "Nominate" }).click();
    await app.expectToast("Admin nominated: it must now call acceptAdmin");
    status = await cli.status();
    expect(status).toMatchObject({ admin, pendingAdmin: nominee });
    expect((await cli.ok("reader", ["status"])).stdout).toMatch(new RegExp(`^pending admin +${nominee}$`, "m"));
    await expect(row("Pending admin")).toContainText(nominee, { timeout: POLL_TIMEOUT });

    // Cancel the nomination: the CLI sees no pending admin again.
    await transfer.getByRole("button", { name: "Cancel pending transfer" }).click();
    await app.expectToast("Pending transfer cancelled");
    status = await cli.status();
    expect(status).toMatchObject({ admin, pendingAdmin: zeroAddress });
    expect((await cli.ok("reader", ["status"])).stdout).toMatch(/^pending admin +-$/m);
    await expect(row("Pending admin")).toHaveText("None", { timeout: POLL_TIMEOUT });
  });
});

// FINDING F5 (frontend-lib, wiring): the viewer's own contribution
// (useFunderStake, lib/hooks.ts) is read once per page and account and never
// re-read: it has no refetchInterval, and the switch-info poll does not
// invalidate it. When the same funder adds or takes back a contribution
// elsewhere (the CLI, another tab or device), the open page keeps the old
// figure while the bounty next to it moves on. After a reclaim made
// elsewhere it keeps offering "Reclaim X ETH", whose transaction can only
// revert (NothingToReclaim; sent unsimulated, see F3).
test.describe("as the funder", () => {
  test.use({ role: "funder" });

  test("C4: an open page follows a contribution its viewer made from the CLI", async ({ app, page, cli }) => {
    const owner = cliAddress("owner");
    const id = bigSwitchId();
    await cli.ok("owner", ["create", id.toString(), "3600", "0.01", `stake follow ${Date.now()}`]);
    await cli.ok("funder", ["fund-bounty", owner, id.toString(), "0.005"]);

    // The funder's own page, open and connected.
    await page.goto(switchUrl(owner, id));
    await app.connect();
    const card = app.card(id);
    await expect(card.getByText("You have contributed 0.005 ETH.")).toBeVisible({ timeout: POLL_TIMEOUT });

    // The same funder adds 0.002 ETH from a terminal: the bounty follows at the next poll, so must the contribution.
    await cli.ok("funder", ["fund-bounty", owner, id.toString(), "0.002"]);
    await expect(app.fact(card, "Bounty")).toHaveText("0.017 ETH", { timeout: POLL_TIMEOUT });
    await expect(card.getByText("You have contributed 0.007 ETH.")).toBeVisible({ timeout: POLL_TIMEOUT });
  });
});

// FINDING F6 (frontend-ui, security/ux): the two readers of a released secret
// disagree on invisible characters. `dms read` / `dms reveal` escape every
// format character (\p{Cf}: zero-width space and joiner, soft hyphen, BOM,
// the tag characters U+E0000–E007F that can carry a hidden ASCII message) and
// say so; the browser (lib/envelope.ts toDisplayText) only removes bidi
// controls and replaces C0/C1 controls, so it shows such text as if it were
// plain, with no warning, its Copy button copies the hidden characters, and a
// leading BOM is dropped silently by TextDecoder. A released "Pay Alice 1 ETH."
// can carry an invisible "IGNORE PREVIOUS" for whoever pastes it into an
// assistant.
test("F6: invisible characters the CLI escapes are neutralised and flagged in the UI too", async ({ page, chain, cli }) => {
  const owner = cliAddress("owner");
  const id = bigSwitchId();
  const hidden = [..."IGNORE PREVIOUS"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
  const secret = `\uFEFFPay Alice${hidden} 1 ETH. zero\u200Bwidth soft\u00ADhyphen word\u2060joiner`;
  await cli.ok("owner", ["create", id.toString(), "60", "0.01", "--file", await cli.file("f6.txt", Buffer.from(secret, "utf8"))]);
  await chain.travel(120);
  await cli.ok("hunter", ["mark-dark", owner, id.toString()]);
  await cli.ok("hunter", ["reveal", owner, id.toString()]);
  const read = await cli.ok("reader", ["read", owner, id.toString()]);
  expect(read.stdout).toContain("Pay Alice\\u{e0049}\\u{e0047}");
  expect(read.stderr).toContain("note: control/invisible characters in the plaintext were escaped");

  await page.goto(switchUrl(owner, id));
  const card = page.getByRole("article", { name: `Switch ${id}`, exact: true });
  const pre = card.locator("pre");
  await expect(pre).toHaveCount(1, { timeout: POLL_TIMEOUT });
  const shown = (await pre.evaluate((el) => el.textContent)) ?? "";
  expect(/\p{Cf}/u.test(shown), "invisible format characters shown as-is").toBe(false);
  await expect(card.locator("ul.text-warn li").first()).toBeVisible();
});
