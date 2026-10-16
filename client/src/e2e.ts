// End-to-end lifecycle tests against a local Anvil running Zama's forge-fhevm
// host (chain 31337) and a deployed DeadManSwitch at DMS_ADDRESS. Uses
// evm_increaseTime, so run it only against a node whose clock you own.
//
//   (a) create → fund → ping → early public decrypt refused → warp → mark-dark
//       → reveal (bounty paid) → read verifies tag + commitment → publish
//   (b) cancel path: create → fund → cancel → warp → markDark reverts NotActive,
//       the key is never decryptable, funder reclaims
//   (c) watcher --once: reveals a profitable dark switch automatically (and
//       publishes it), skips an unprofitable one, reveals a switch whose
//       ciphertext the key does not open — with the warning — and a second
//       --altruistic pass reveals the unprofitable one
//   (d) races, automine OFF: a competitor front-runs the watcher's markDark and
//       then its revealKey (higher tip, same block). Both of the watcher's
//       transactions revert on-chain; it records the lost races, archives the
//       plaintext (revealedByUs=false) and exits 0. A switch created before the
//       next --once pass is discovered by it. Automine is restored afterwards.
//
// Run: scripts/local-e2e.sh   (or: DMS_ADDRESS=0x... npm run e2e:local)
// Exits non-zero on the first failed check.

import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, getAddress, hexToBytes, parseEther, parseGwei, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { dmsAbi } from "./abi.js";
import { createClients, Dms, findEvent } from "./chain.js";
import { runCli } from "./cli.js";
import { parseConfig, type Env } from "./config.js";
import { KEY_MISMATCH_WARNING, seal } from "./envelope.js";
import { describeError } from "./errors.js";
import { createFhevm, type Fhevm } from "./fhevm.js";

dotenv.config({ quiet: true });

const CLIENT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const MNEMONIC = "test test test test test test test test test test test junk";
const keyAt = (i: number): Hex => bytesToHex(mnemonicToAccount(MNEMONIC, { addressIndex: i }).getHdKey().privateKey!);

// Anvil default accounts 5..8 — away from #0 (deployer) and the low indices other local tooling tends to use.
const KEYS = { owner: keyAt(5), funder: keyAt(6), hunter: keyAt(7), watcher: keyAt(8) };
const ADDR = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v).address])) as Record<keyof typeof KEYS, Address>;

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const DMS_ADDRESS = process.env.DMS_ADDRESS;
const BASE_ENV: Env = { RPC_URL, CHAIN_ID: "31337", DMS_ADDRESS };

// ---------- harness ---------- //

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
let checks = 0;
const log = (m: string) => console.log(`[${elapsed()}] ${m}`);

class CheckFailed extends Error {}
const check = (cond: unknown, msg: string): void => {
  checks++;
  if (!cond) throw new CheckFailed(msg);
  log(`  ok  ${msg}`);
};
const eq = <T>(actual: T, expected: T, msg: string) =>
  check(actual === expected, `${msg}${actual === expected ? "" : ` (expected ${String(expected)}, got ${String(actual)})`}`);

interface Captured {
  out: string[];
  err: string[];
}

const cli = async (role: keyof typeof KEYS | "reader", argv: string[]): Promise<{ result: Record<string, unknown>; io: Captured }> => {
  const io: Captured = { out: [], err: [] };
  const env = { ...BASE_ENV, ...(role === "reader" ? {} : { PRIVATE_KEY: KEYS[role] }) };
  const result = (await runCli(argv, { env, io: { out: (l) => io.out.push(l), err: (l) => io.err.push(l) } })) as Record<string, unknown>;
  log(`  dms ${argv.map((a) => (a.length > 24 ? `${a.slice(0, 21)}...` : a)).join(" ")}  [${role}]`);
  return { result, io };
};

/** Expect a promise to reject with a message matching `re`. */
const fails = async (p: Promise<unknown>, re: RegExp, msg: string): Promise<void> => {
  try {
    await p;
  } catch (err) {
    const d = describeError(err);
    check(re.test(d), `${msg} → "${d.length > 140 ? `${d.slice(0, 137)}...` : d}"`);
    return;
  }
  check(false, `${msg} (expected a failure, but it succeeded)`);
};

const dmsFor = (role: keyof typeof KEYS | "reader"): Dms => {
  const cfg = parseConfig({ ...BASE_ENV, ...(role === "reader" ? {} : { PRIVATE_KEY: KEYS[role] }) });
  return new Dms(createClients(cfg), cfg.dmsAddress);
};

const run = (cmd: string, args: string[], env: Env, timeoutMs = 180_000): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { cwd: CLIENT_DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });

const TSX = join(CLIENT_DIR, "node_modules", ".bin", "tsx");

let idSeq = BigInt(Date.now()) * 1000n;
const nextId = () => ++idSeq;

// ---------- scenarios ---------- //

const reader = dmsFor("reader");
const rpc = (method: string, params: unknown[] = []) => reader.publicClient.request({ method, params } as never);
const warp = async (seconds: number) => {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine");
  log(`  warped chain time +${seconds}s`);
};

const scenarioA = async (fhe: Fhevm) => {
  log("(a) full lifecycle: create → ping → early decrypt refused → warp → mark-dark → reveal → read → publish");
  const id = nextId();
  // Hostile-looking plaintext: ANSI colour, OSC title, bidi override. Must never reach a terminal raw.
  const secret = "If you are reading this, I stopped pinging. \u001b[31mRED\u001b[0m \u001b]0;pwned\u0007 \u202eevil\u202c ünïcødé ✓";
  const secretBytes = new TextEncoder().encode(secret);

  const { result: created } = await cli("owner", ["create", id.toString(), "120", "0.01", secret]);
  const handle = created.handle as Hex;
  check(/^0x[0-9a-f]{64}$/i.test(handle), "create returned an FHE key handle");
  let info = await reader.info(ADDR.owner, id);
  eq(info.stateName, "ALIVE", "state after create");
  eq(info.ciphertextLength, BigInt(secretBytes.length + 61), "ciphertext length = plaintext + 61");
  eq(info.encKeyHandle.toLowerCase(), handle.toLowerCase(), "stored key handle matches");
  check(await reader.keyHandleUsed(handle), "keyHandleUsed(handle) is set");

  const { result: funded } = await cli("funder", ["fund-bounty", ADDR.owner, id.toString(), "0.005"]);
  eq(funded.newTotal, parseEther("0.015"), "bounty after funding");
  eq(await reader.funderStake(ADDR.owner, id, ADDR.funder), parseEther("0.005"), "funder stake recorded");

  const before = info.expiresAt;
  await rpc("evm_increaseTime", [30]);
  await rpc("evm_mine");
  const { result: pinged } = await cli("owner", ["ping", id.toString()]);
  check((pinged.expiresAt as bigint) > before, "ping extended the deadline");

  // Early public decryption must be refused by the KMS (cleartext host ACL).
  await fails(fhe.publicDecryptDek(handle), /refused or failed/i, "public decrypt while ALIVE is refused");
  await fails(cli("hunter", ["reveal", ADDR.owner, id.toString()]), /owner is alive/, "CLI reveal refused while ALIVE");
  await fails(dmsFor("hunter").markDark(ADDR.owner, id), /reverted: NotDark/, "markDark reverts NotDark while ALIVE");

  await warp(121);
  eq(await reader.state(ADDR.owner, id), "DARK", "state after missing the deadline");
  await fails(dmsFor("owner").ping(id), /reverted: Expired/, "ping reverts Expired once dark");
  await fails(dmsFor("funder").fundBounty(ADDR.owner, id, 1n), /reverted: Expired/, "fundBounty reverts Expired once dark");
  await fails(dmsFor("owner").cancel(id), /reverted: Expired/, "cancel reverts Expired once dark");
  await fails(cli("hunter", ["reveal", ADDR.owner, id.toString()]), /mark-dark/, "CLI reveal before mark-dark points to mark-dark");
  await fails(dmsFor("hunter").revealKey(ADDR.owner, id, `0x${"00".repeat(32)}`, "0x00"), /reverted: NotDarkMarked/, "revealKey reverts NotDarkMarked");

  const { result: marked } = await cli("hunter", ["mark-dark", ADDR.owner, id.toString()]);
  eq((marked.handle as Hex).toLowerCase(), handle.toLowerCase(), "SwitchDarkMarked carries the key handle");
  eq(await reader.state(ADDR.owner, id), "DARK_MARKED", "state after mark-dark");
  await fails(dmsFor("funder").markDark(ADDR.owner, id), /reverted: AlreadyDarkMarked/, "second markDark reverts AlreadyDarkMarked");

  // A forged proof (right key, garbage signature) must not verify.
  const dec = await fhe.publicDecryptDek(handle);
  check(dec.dek.length === 32, "public decrypt after mark-dark returns a 32-byte key");
  await fails(
    dmsFor("funder").revealKey(ADDR.owner, id, dec.dataKey, `0x01${"11".repeat(65)}00` as Hex),
    /reverted/,
    "revealKey with a forged KMS proof reverts",
  );
  const wrongKey = bytesToHex(dec.dek.map((b, i) => (i === 31 ? b ^ 1 : b)));
  await fails(dmsFor("funder").revealKey(ADDR.owner, id, wrongKey, dec.decryptionProof), /reverted/, "revealKey with the wrong key reverts");

  // --out is claimed before the irreversible revealKey: a name clash fails while nothing has been spent.
  const clash = join(mkdtempSync(join(tmpdir(), "dms-e2e-out-")), "exists.bin");
  writeFileSync(clash, "already here");
  await fails(cli("hunter", ["reveal", ADDR.owner, id.toString(), "--out", clash]), /refusing to overwrite/, "reveal --out <existing file> fails before revealing");
  eq(await reader.state(ADDR.owner, id), "DARK_MARKED", "...so the key is not revealed and no bounty is claimed");
  eq(readFileSync(clash, "utf8"), "already here", "...and the existing file is untouched");

  const hunterBalBefore = await reader.publicClient.getBalance({ address: ADDR.hunter });
  const { result: revealed, io: revealIo } = await cli("hunter", ["reveal", ADDR.owner, id.toString()]);
  eq(revealed.bountyPaid, parseEther("0.015"), "revealKey paid the whole pot (owner + funder)");
  eq(revealed.keyOpensCiphertext, true, "KMS key opens the on-chain ciphertext (tag verified)");
  eq(revealed.commitmentMatches, true, "decrypted plaintext matches the commitment");
  check(bytesToHex(revealed.plaintext as Uint8Array) === bytesToHex(secretBytes), "reveal decrypted the exact plaintext");
  const hunterBalAfter = await reader.publicClient.getBalance({ address: ADDR.hunter });
  check(hunterBalAfter > hunterBalBefore, "hunter balance increased (bounty > gas)");
  const printed = revealIo.out.join("\n");
  check(!/[\u001b\u0007\u202e]/.test(printed), "reveal output contains no raw ESC/BEL/bidi characters");
  check(printed.includes("\\x1b[31mRED") && printed.includes("\\u{202e}"), "control characters were shown escaped");

  info = await reader.info(ADDR.owner, id);
  eq(info.stateName, "REVEALED", "state after reveal");
  eq(info.bounty, 0n, "bounty is zero after reveal");
  eq(info.revealedKey.toLowerCase(), dec.dataKey.toLowerCase(), "getRevealedKey = KMS-proven key");
  eq(await reader.funderStake(ADDR.owner, id, ADDR.funder), 0n, "funder stake reads 0 once revealed");
  await fails(dmsFor("funder").revealKey(ADDR.owner, id, dec.dataKey, dec.decryptionProof), /reverted: AlreadyRevealed/, "second revealKey reverts AlreadyRevealed");

  // Anyone, from chain state alone, no key material and no FHE.
  const { result: readRes } = await cli("reader", ["read", ADDR.owner, id.toString()]);
  check(bytesToHex(readRes.plaintext as Uint8Array) === bytesToHex(secretBytes), "read (no PRIVATE_KEY) decrypts the plaintext from chain state");
  eq(readRes.commitmentMatches, true, "read verifies the commitment");
  const dir = mkdtempSync(join(tmpdir(), "dms-e2e-"));
  const outFile = join(dir, "secret.bin");
  await cli("reader", ["read", ADDR.owner, id.toString(), "--out", outFile]);
  check(bytesToHex(new Uint8Array(readFileSync(outFile))) === bytesToHex(secretBytes), "read --out writes the exact raw bytes");
  await fails(cli("reader", ["read", ADDR.owner, id.toString(), "--out", outFile]), /refusing to overwrite/, "read --out never overwrites");

  const { result: pub } = await cli("hunter", ["publish", ADDR.owner, id.toString()]);
  const logs = await reader.publicClient.getContractEvents({
    address: reader.address,
    abi: (await import("./abi.js")).dmsAbi,
    eventName: "PlaintextPublished",
    args: { switchKey: created.switchKey as Hex },
    fromBlock: 0n,
  });
  check(logs.length === 1 && logs[0].args.payload?.toLowerCase() === bytesToHex(secretBytes), "PlaintextPublished carries the plaintext");
  check(typeof pub.txHash === "string", "publish sent a transaction");
  check((await reader.info(ADDR.owner, id)).published, "info.published is true");
  await fails(cli("hunter", ["publish", ADDR.owner, id.toString()]), /already published/, "CLI publish refuses a second publish");
  await fails(
    dmsFor("hunter").publishPlaintext(ADDR.owner, id, bytesToHex(readRes.salt as Uint8Array), bytesToHex(secretBytes)),
    /reverted: AlreadyPublished/,
    "publishPlaintext reverts AlreadyPublished",
  );

  // The real binary, as a subprocess: exit codes and terminal safety.
  const env = { ...BASE_ENV } as Env;
  const infoProc = await run(TSX, ["src/index.ts", "info", ADDR.owner, id.toString()], env);
  eq(infoProc.code, 0, "`dms info` exits 0");
  check(/state\s+REVEALED/.test(infoProc.stdout), "`dms info` shows the state name REVEALED");
  const readProc = await run(TSX, ["src/index.ts", "read", ADDR.owner, id.toString()], env);
  eq(readProc.code, 0, "`dms read` exits 0");
  check(!/[\u001b\u0007\u202e]/.test(readProc.stdout + readProc.stderr), "`dms read` stdout/stderr carry no raw control characters");
  check(readProc.stdout.includes("commitment:   verified"), "`dms read` reports the verified commitment");
  const badProc = await run(TSX, ["src/index.ts", "ping", "0"], { ...env, PRIVATE_KEY: KEYS.owner });
  eq(badProc.code, 2, "`dms ping 0` is a usage error (exit 2)");
  const jsonProc = await run(TSX, ["src/index.ts", "status", "--json"], env);
  eq(jsonProc.code, 0, "`dms status --json` exits 0");
  eq(JSON.parse(jsonProc.stdout).address, getAddress(DMS_ADDRESS!), "`dms status --json` is valid JSON for this contract");
};

const scenarioB = async (fhe: Fhevm) => {
  log("(b) cancel path: create → fund → cancel → warp → markDark reverts NotActive; key never decryptable");
  const id = nextId();
  const { result: created } = await cli("owner", ["create", id.toString(), "60", "0.02", "cancelled secret — must never be readable"]);
  const handle = created.handle as Hex;
  await cli("funder", ["fund-bounty", ADDR.owner, id.toString(), "0.01"]);
  const ownerBal = await reader.publicClient.getBalance({ address: ADDR.owner });
  const { result: cancelled } = await cli("owner", ["cancel", id.toString()]);
  eq(cancelled.refund, parseEther("0.02"), "cancel refunds exactly the owner's escrow");
  check((await reader.publicClient.getBalance({ address: ADDR.owner })) > ownerBal, "owner balance went up");
  let info = await reader.info(ADDR.owner, id);
  eq(info.stateName, "CANCELLED", "state after cancel");
  eq(info.bounty, parseEther("0.01"), "funder contribution stays in the pot after cancel");

  await warp(61);
  eq(await reader.state(ADDR.owner, id), "CANCELLED", "still CANCELLED after the deadline passes");
  check(!(await reader.isDark(ADDR.owner, id)), "isDark is false for a cancelled switch");
  await fails(dmsFor("hunter").markDark(ADDR.owner, id), /reverted: NotActive/, "markDark reverts NotActive on a cancelled switch");
  await fails(cli("hunter", ["mark-dark", ADDR.owner, id.toString()]), /cancelled/, "CLI mark-dark explains the switch is cancelled");
  await fails(fhe.publicDecryptDek(handle), /refused or failed/i, "the cancelled switch's key is never publicly decryptable");
  await fails(cli("hunter", ["reveal", ADDR.owner, id.toString()]), /cancelled/, "CLI reveal refused on a cancelled switch");
  await fails(dmsFor("owner").ping(id), /reverted: NotActive/, "ping reverts NotActive after cancel");

  const { result: reclaimed } = await cli("funder", ["reclaim", ADDR.owner, id.toString()]);
  eq(reclaimed.amount, parseEther("0.01"), "funder reclaims their contribution after cancel");
  info = await reader.info(ADDR.owner, id);
  eq(info.bounty, 0n, "pot empty after reclaim");
  await fails(cli("funder", ["reclaim", ADDR.owner, id.toString()]), /no contribution/, "second reclaim refused");
  await fails(cli("owner", ["rescue", id.toString()]), /not rescuable/, "rescue refused on a cancelled switch");
  eq(info.revealedKey, `0x${"00".repeat(32)}` as Hex, "revealed key stays zero");
};

const scenarioC = async (fhe: Fhevm) => {
  log("(c) watcher --once reveals dark switches automatically");
  const fromBlock = (await reader.publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
  const owner = dmsFor("owner");

  const idGood = nextId();
  const goodSecret = "watcher test: profitable switch";
  await cli("owner", ["create", idGood.toString(), "60", "0.01", goodSecret]);

  const idFree = nextId();
  const freeSecret = "watcher test: zero bounty";
  await cli("owner", ["create", idFree.toString(), "60", "0", freeSecret]);

  // A malicious owner: the ciphertext is sealed under one key, a different key is FHE-encrypted.
  const idBad = nextId();
  const sealed = await seal(new TextEncoder().encode("never decryptable with the revealed key"));
  const otherDek = crypto.getRandomValues(new Uint8Array(32));
  const enc = await fhe.encryptDek(otherDek, owner.address, ADDR.owner);
  // The reader's SDK has no signer, so the input proof is bound to ADDR.owner (userAddress) — exactly what createSwitch checks.
  await owner.createSwitch(
    { id: idBad, pingInterval: 60n, plaintextCommitment: sealed.commitment },
    bytesToHex(sealed.ciphertext),
    enc.handle,
    enc.inputProof,
    parseEther("0.01"),
  );
  log(`  created a switch whose ciphertext does not match its FHE key (id ${idBad})`);

  await warp(61);
  for (const id of [idGood, idFree, idBad]) eq(await reader.state(ADDR.owner, id), "DARK", `switch ${id} is DARK`);

  const dir = mkdtempSync(join(tmpdir(), "dms-watcher-"));
  const outDir = join(dir, "out");
  const stateFile = join(dir, "state.json");
  const configFile = join(dir, "watcher.config.json");
  writeFileSync(configFile, JSON.stringify({ outDir, stateFile, pollIntervalSec: 1, decryptAttemptsPerPass: 2, logChunkBlocks: 3 }, null, 2));
  const wenv: Env = { ...BASE_ENV, PRIVATE_KEY: KEYS.watcher, FROM_BLOCK: fromBlock.toString() };

  const watcherBal = await reader.publicClient.getBalance({ address: ADDR.watcher });
  const p1 = await run(TSX, ["src/watcher.ts", "--once", "--publish", "--config", configFile], wenv);
  for (const l of (p1.stdout + p1.stderr).trim().split("\n")) log(`    | ${l}`);
  eq(p1.code, 0, "watcher --once exits 0");
  check(p1.stdout.includes(KEY_MISMATCH_WARNING), "watcher printed the key-mismatch warning for the bad switch");
  check(/discovered switch/.test(p1.stdout), "watcher discovered switches from SwitchCreated logs (3-block chunks)");

  const good = await reader.info(ADDR.owner, idGood);
  eq(good.stateName, "REVEALED", "profitable switch revealed by the watcher");
  check(good.published, "profitable switch published by the watcher (--publish)");
  const revealLogs = await reader.publicClient.getContractEvents({
    address: reader.address,
    abi: (await import("./abi.js")).dmsAbi,
    eventName: "KeyRevealed",
    args: { revealer: ADDR.watcher },
    fromBlock,
  });
  const revealedKeys = new Set(revealLogs.map((l) => l.args.switchKey));
  check(
    revealedKeys.has(await reader.switchKey(ADDR.owner, idGood)) && revealedKeys.has(await reader.switchKey(ADDR.owner, idBad)),
    "watcher is the revealer of the good and the mismatched switch",
  );
  check((await reader.publicClient.getBalance({ address: ADDR.watcher })) > watcherBal, "watcher earned more in bounties than it spent on gas");

  const base = (id: bigint) => join(outDir, `31337-${reader.address.toLowerCase()}`, `${ADDR.owner.toLowerCase()}-${id}`);
  check(existsSync(`${base(idGood)}.bin`), "watcher saved the plaintext file");
  eq(readFileSync(`${base(idGood)}.bin`, "utf8"), goodSecret, "saved plaintext is exact");
  const goodMeta = JSON.parse(readFileSync(`${base(idGood)}.json`, "utf8"));
  eq(goodMeta.commitmentMatches, true, "metadata records the verified commitment");

  eq(await reader.state(ADDR.owner, idFree), "DARK", "zero-bounty switch left alone (unprofitable)");
  const bad = await reader.info(ADDR.owner, idBad);
  eq(bad.stateName, "REVEALED", "mismatched switch still revealed (bounty is for the KMS-proven key)");
  check(!bad.published, "mismatched switch not published");
  check(!existsSync(`${base(idBad)}.bin`), "no plaintext file for the mismatched switch");
  eq(JSON.parse(readFileSync(`${base(idBad)}.json`, "utf8")).keyMismatch, true, "mismatch recorded in metadata");
  await fails(cli("reader", ["read", ADDR.owner, idBad.toString()]), /does not open the ciphertext/, "`dms read` refuses with the key-mismatch warning");

  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const tracked = Object.values(state.switches) as { id: string; note?: string; terminal: boolean; revealTx?: string }[];
  eq(tracked.length, 3, "state file tracks the three discovered switches");
  check(tracked.find((t) => t.id === idFree.toString())?.note?.startsWith("not marking dark") === true, "state file explains why the free switch was skipped");
  check(tracked.find((t) => t.id === idGood.toString())?.terminal === true, "good switch is terminal in the state file");

  // Second pass, altruistic: picks up the zero-bounty switch; finished switches are not touched again.
  const p2 = await run(TSX, ["src/watcher.ts", "--once", "--altruistic", "--config", configFile], wenv);
  for (const l of (p2.stdout + p2.stderr).trim().split("\n")) log(`    | ${l}`);
  eq(p2.code, 0, "watcher --once --altruistic exits 0");
  eq(await reader.state(ADDR.owner, idFree), "REVEALED", "altruistic pass revealed the zero-bounty switch");
  eq(readFileSync(`${base(idFree)}.bin`, "utf8"), freeSecret, "zero-bounty plaintext saved");
  check(!/discovered switch/.test(p2.stdout), "second pass resumed from the state file (no re-discovery)");
  check(!p2.stdout.includes(`/${idGood}: `), "second pass did not act on the finished switch");
};

/** Resolves once `addr` has a transaction in the mempool (pending nonce > mined nonce). */
const waitForMempoolTx = async (addr: Address, what: string, gaveUp: () => boolean, timeoutMs = 120_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !gaveUp()) {
    const [pending, latest] = await Promise.all([
      reader.publicClient.getTransactionCount({ address: addr, blockTag: "pending" }),
      reader.publicClient.getTransactionCount({ address: addr, blockTag: "latest" }),
    ]);
    if (pending > latest) {
      log(`  ${what} is in the mempool`);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new CheckFailed(`timed out waiting for ${what} in the mempool${gaveUp() ? " (the watcher exited)" : ""}`);
};

const scenarioD = async (fhe: Fhevm) => {
  log("(d) watcher loses the markDark and revealKey races (automine off, competitor tips higher, same block)");
  const fromBlock = (await reader.publicClient.getBlockNumber({ cacheTime: 0 })) + 1n;
  const id = nextId();
  const secret = "watcher test: front-run twice, archived anyway";
  const { result: created } = await cli("owner", ["create", id.toString(), "60", "0.01", secret]);
  await warp(61);
  eq(await reader.state(ADDR.owner, id), "DARK", "switch is DARK");

  const dir = mkdtempSync(join(tmpdir(), "dms-race-"));
  const outDir = join(dir, "out");
  const stateFile = join(dir, "state.json");
  const configFile = join(dir, "watcher.config.json");
  writeFileSync(configFile, JSON.stringify({ outDir, stateFile, decryptAttemptsPerPass: 2, txReceiptTimeoutSec: 90 }, null, 2));
  const wenv: Env = { ...BASE_ENV, PRIVATE_KEY: KEYS.watcher, FROM_BLOCK: fromBlock.toString() };

  // The competitor sends raw transactions with a fixed gas limit: gas estimation on Anvil runs against the
  // pending block, where the watcher's own transaction would already make it revert.
  const rival = dmsFor("hunter");
  const wallet = rival.clients.walletClient!;
  const account = rival.clients.account!;
  const frontRun = async (functionName: "markDark" | "revealKey", args: readonly unknown[], gas: bigint) => {
    const { maxFeePerGas } = await reader.publicClient.estimateFeesPerGas();
    const tip = parseGwei("50");
    const hash = await wallet.writeContract({
      address: reader.address,
      abi: dmsAbi,
      functionName,
      args,
      gas,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: maxFeePerGas + tip,
      account,
      chain: rival.clients.chain,
    } as never);
    log(`  competitor sent ${functionName} ${hash.slice(0, 12)}… with a 50 gwei tip`);
    return hash;
  };

  const watcherBal = await reader.publicClient.getBalance({ address: ADDR.watcher });
  await rpc("evm_setAutomine", [false]);
  log("  automine OFF");
  let exited = false;
  try {
    const done = run(TSX, ["src/watcher.ts", "--once", "--config", configFile], wenv, 300_000);
    done.then(
      () => (exited = true),
      () => (exited = true),
    );

    await waitForMempoolTx(ADDR.watcher, "the watcher's markDark", () => exited);
    const markHash = await frontRun("markDark", [ADDR.owner, id], 300_000n);
    await rpc("evm_mine");
    const markReceipt = await reader.publicClient.getTransactionReceipt({ hash: markHash });
    eq(markReceipt.status, "success", "competitor's markDark landed first in the block");

    await waitForMempoolTx(ADDR.watcher, "the watcher's revealKey", () => exited);
    const dec = await fhe.publicDecryptDek(created.handle as Hex);
    const revealHash = await frontRun("revealKey", [ADDR.owner, id, dec.dataKey, dec.decryptionProof], 3_000_000n);
    await rpc("evm_mine");
    eq((await reader.publicClient.getTransactionReceipt({ hash: revealHash })).status, "success", "competitor's revealKey landed first in the block");

    const p = await done;
    for (const l of (p.stdout + p.stderr).trim().split("\n")) log(`    | ${l}`);
    eq(p.code, 0, "watcher --once exits 0 after losing both races");
    check(/lost the markDark race: 0x[0-9a-f]{64} reverted on-chain with AlreadyDarkMarked/.test(p.stdout), "lost markDark race decoded (AlreadyDarkMarked, replayed at the block)");
    check(/lost the revealKey race: 0x[0-9a-f]{64} reverted on-chain with AlreadyRevealed/.test(p.stdout), "lost revealKey race decoded (AlreadyRevealed)");
    check(/lost races 2, .*errors 0/.test(p.stdout), "pass summary: 2 lost races, 0 errors");
  } finally {
    await rpc("evm_setAutomine", [true]);
    log("  automine restored");
  }
  check((await reader.publicClient.getBalance({ address: ADDR.watcher })) < watcherBal, "the watcher paid gas for its two reverted transactions");

  const info = await reader.info(ADDR.owner, id);
  eq(info.stateName, "REVEALED", "switch revealed (by the competitor)");
  const [ev] = await reader.publicClient.getContractEvents({
    address: reader.address,
    abi: dmsAbi,
    eventName: "KeyRevealed",
    args: { switchKey: created.switchKey as Hex },
    fromBlock,
  });
  eq(ev?.args.revealer, ADDR.hunter, "KeyRevealed.revealer is the competitor");

  const base = join(outDir, `31337-${reader.address.toLowerCase()}`, `${ADDR.owner.toLowerCase()}-${id}`);
  eq(readFileSync(`${base}.bin`, "utf8"), secret, "watcher archived the exact plaintext anyway");
  const meta = JSON.parse(readFileSync(`${base}.json`, "utf8"));
  eq(meta.revealedByUs, false, "archive metadata: revealedByUs = false");
  eq(
    (meta.lostRaces as { errorName: string }[]).map((r) => r.errorName).join(","),
    "AlreadyDarkMarked,AlreadyRevealed",
    "archive metadata records both lost races",
  );
  const t = JSON.parse(readFileSync(stateFile, "utf8")).switches[`${ADDR.owner.toLowerCase()}/${id}`];
  check(t.terminal === true && t.pendingTx === undefined && t.lostRaces?.length === 2, "state file: terminal, nothing pending, 2 lost races");

  // Discovery between passes (automine back on): a switch created now is found by the next --once pass.
  const id2 = nextId();
  await cli("owner", ["create", id2.toString(), "3600", "0.01", "created between two watcher passes"]);
  const p2 = await run(TSX, ["src/watcher.ts", "--once", "--config", configFile], wenv);
  eq(p2.code, 0, "second watcher pass exits 0");
  check(p2.stdout.includes(`discovered switch ${ADDR.owner}/${id2}`), "second pass discovered the switch created between passes");
  check(!p2.stdout.includes(`discovered switch ${ADDR.owner}/${id} `), "and did not rediscover the first one");
  eq(Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).switches).length, 2, "state file now tracks both switches");
};

const main = async () => {
  if (!DMS_ADDRESS) throw new Error("DMS_ADDRESS is required (scripts/local-e2e.sh deploys one and sets it)");
  const cfg = parseConfig({ ...BASE_ENV });
  const clients = createClients(cfg);
  const dms = new Dms(clients, cfg.dmsAddress);
  await dms.assertDeployment(31337);
  log(`DeadManSwitch ${dms.address} on ${RPC_URL}; owner ${ADDR.owner}, funder ${ADDR.funder}, hunter ${ADDR.hunter}, watcher ${ADDR.watcher}`);
  const fhe = await createFhevm(cfg, clients);
  const failures: string[] = [];
  try {
    for (const [name, fn] of [
      ["a", scenarioA],
      ["b", scenarioB],
      ["c", scenarioC],
      ["d", scenarioD],
    ] as const) {
      try {
        await fn(fhe);
        log(`(${name}) PASSED`);
      } catch (err) {
        failures.push(`(${name}) ${err instanceof CheckFailed ? err.message : describeError(err)}`);
        log(`(${name}) FAILED: ${err instanceof CheckFailed ? err.message : describeError(err)}`);
        if (!(err instanceof CheckFailed)) console.error(err);
      }
    }
  } finally {
    fhe.close();
  }
  if (failures.length) {
    log(`E2E FAILED — ${failures.length} scenario(s), ${checks} checks run:\n  ${failures.join("\n  ")}`);
    return 1;
  }
  log(`E2E PASSED — 4 scenarios, ${checks} checks`);
  return 0;
};

main()
  .catch((err) => {
    console.error(`e2e: ${describeError(err)}`);
    console.error(err);
    return 1;
  })
  .then((code) => process.exit(code));
