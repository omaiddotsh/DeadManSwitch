// CLI commands. `runCli` is I/O-injected so the e2e runner can drive several
// actors (owner, funder, hunter, reader) in one process; src/index.ts is the
// thin binary entry point.

import { mainnet as fheMainnet, sepolia as fheSepolia } from "@zama-fhe/sdk/chains";
import { open as openFile, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { bytesToHex, formatEther, formatGwei, zeroAddress, type Address, type Hex } from "viem";
import { parseCliArgs, USAGE, type Command, type PlaintextSource, type TxFlags } from "./args.js";
import { createClients, Dms, findEvent, type SwitchInfo, type WriteOpts } from "./chain.js";
import { CHAIN_NAMES, parseConfig, type Config, type Env } from "./config.js";
import {
  assertPayloadSize,
  CIPHERTEXT_OVERHEAD,
  KEY_MISMATCH_WARNING,
  MAX_PAYLOAD_SIZE,
  seal,
  verifyKeyOpensCiphertext,
  wipe,
  dekFromBytes32,
  type Opened,
} from "./envelope.js";
import { describeError, PartialSuccessError, revertErrorName, TxTimeoutError, UserFacingError } from "./errors.js";
import { createFhevm, FhevmError, NO_ROUTE_RECHECK_MS, type DecryptedDek, type Fhevm } from "./fhevm.js";
import { fmtDuration, fmtEth, fmtTime, fmtTimeRel, fmtUsd, fmtUsd8, toJson } from "./format.js";
import { renderPlaintext } from "./sanitize.js";

export interface CliIO {
  /** Primary output (stdout). */
  out(line: string): void;
  /** Warnings and diagnostics (stderr). */
  err(line: string): void;
}

export interface CliContext {
  env: Env;
  io: CliIO;
  /** Injected for tests; defaults to process.stdin. */
  readStdin?: () => Promise<Uint8Array>;
  /** Override the FHE factory (tests). */
  fhevmFactory?: (cfg: Config, dms: Dms) => Promise<Fhevm>;
  /** How long a write waits for its receipt (tests); default viem's 180 s. */
  receiptTimeoutMs?: number;
}

interface Run {
  cfg: Config;
  dms: Dms;
  io: CliIO;
  fhevm: () => Promise<Fhevm>;
  readStdin: () => Promise<Uint8Array>;
  receiptTimeoutMs?: number;
}

const readProcessStdin = async (): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > MAX_PAYLOAD_SIZE) throw new UserFacingError(`stdin exceeds ${MAX_PAYLOAD_SIZE} bytes`);
    chunks.push(b);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const loadPlaintext = async (src: PlaintextSource, run: Run): Promise<Uint8Array> => {
  let bytes: Uint8Array;
  if (src.kind === "arg") {
    bytes = new TextEncoder().encode(src.text);
  } else if (src.path === "-") {
    bytes = await run.readStdin();
  } else {
    let size: number;
    try {
      size = (await stat(src.path)).size;
    } catch (err) {
      throw new UserFacingError(`cannot read --file ${src.path}: ${(err as Error).message}`);
    }
    if (size > MAX_PAYLOAD_SIZE) throw new UserFacingError(`--file ${src.path} is ${size} bytes; the contract accepts at most ${MAX_PAYLOAD_SIZE}`);
    bytes = new Uint8Array(await readFile(src.path));
  }
  if (bytes.length === 0) throw new UserFacingError("plaintext is empty");
  assertPayloadSize(bytes);
  return bytes;
};

/** Create the --out file (never overwrites), owner-only permissions. */
const openOut = async (path: string): Promise<FileHandle> => {
  try {
    return await openFile(path, "wx", 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new UserFacingError(code === "EEXIST" ? `--out ${path} already exists; refusing to overwrite` : `cannot write --out ${path}: ${(err as Error).message}`);
  }
};

/**
 * Write raw plaintext bytes into the --out file `path`, opened (created) by openOut, then close it. If the
 * write fails (disk full, file size limit) the file is removed: an empty or partial file would stand in the
 * way of the `--out` retry, which never overwrites.
 */
const fillOut = async (fh: FileHandle, bytes: Uint8Array, path: string): Promise<void> => {
  try {
    await fh.writeFile(bytes);
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw new UserFacingError(`writing --out ${path} failed (${(err as Error).message}); the file was removed`);
  }
  await fh.close();
};

/** Write raw plaintext bytes to a new file (never overwrites), owner-only permissions. */
const writeOut = async (path: string, bytes: Uint8Array): Promise<void> => fillOut(await openOut(path), bytes, path);

const requireExists = (info: SwitchInfo, owner: Address, id: bigint): void => {
  if (info.owner === zeroAddress) throw new UserFacingError(`no switch ${id} for owner ${owner}`);
};

const explainState = (info: SwitchInfo, now: bigint): string => {
  switch (info.stateName) {
    case "ALIVE":
      return `the owner is alive; the deadline is ${fmtTimeRel(info.expiresAt, now)}`;
    case "DARK":
      return `the owner missed the deadline (${fmtTimeRel(info.expiresAt, now)}) but nobody called mark-dark yet`;
    case "DARK_MARKED":
      return `the key was made publicly decryptable at ${fmtTime(info.darkMarkedAt)}; it awaits a reveal`;
    case "REVEALED":
      return `the key was revealed at ${fmtTime(info.revealedAt)}${info.published ? " and the plaintext published" : ""}`;
    case "CANCELLED":
      return "the owner cancelled this switch; its key is never released";
    default:
      return "the switch does not exist";
  }
};

const txLine = (label: string, hash: Hex, gasUsed: bigint): string => `${label}: ${hash} (gas ${gasUsed})`;

/** Print plaintext safely, or write raw bytes to --out (a path, or a handle opened earlier with openOut). */
const emitPlaintext = async (run: Run, opened: Opened, out: string | undefined, outHandle?: FileHandle): Promise<void> => {
  if (out !== undefined) {
    await (outHandle ? fillOut(outHandle, opened.plaintext, out) : writeOut(out, opened.plaintext));
    run.io.out(`wrote ${opened.plaintext.length} plaintext bytes to ${out}`);
    return;
  }
  const r = renderPlaintext(opened.plaintext);
  run.io.out(`----- plaintext (${opened.plaintext.length} bytes${r.binary ? ", binary: shown as hex" : ""}) -----`);
  run.io.out(r.text);
  run.io.out("----- end plaintext -----");
  if (r.escaped) run.io.err("note: control/invisible characters in the plaintext were escaped; use --out <file> for the exact bytes");
};

/** Decrypt a revealed switch from chain state. Throws on tag failure (KEY_MISMATCH_WARNING). */
const openRevealed = async (run: Run, owner: Address, id: bigint, info: SwitchInfo): Promise<{ opened: Opened; commitmentMatches: boolean }> => {
  const ct = await run.dms.ciphertext(owner, id);
  const check = await verifyKeyOpensCiphertext(ct, dekFromBytes32(info.revealedKey), info.plaintextCommitment);
  if (!check.ok) throw new UserFacingError(`${KEY_MISMATCH_WARNING} (${check.reason})`);
  return { opened: check.opened, commitmentMatches: check.commitmentMatches === true };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public-decrypt the DEK with a few short retries (the KMS may lag mark-dark by minutes on real networks). */
const fetchKey = async (run: Run, handle: Hex, attempts = 3): Promise<DecryptedDek> => {
  const fhe = await run.fhevm();
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fhe.publicDecryptDek(handle, { timeoutMs: 120_000 }).catch(async (err: unknown) => {
        // One "no route" answer can be an edge reloading its routes: only a second one a few seconds later means a wrong ZAMA_RELAYER_URL.
        if (!(err instanceof FhevmError && err.noRoute)) throw err;
        run.io.err(`the relayer has no route for the request (${describeError(err)}); asking again in ${NO_ROUTE_RECHECK_MS / 1000}s`);
        await sleep(NO_ROUTE_RECHECK_MS);
        return fhe.publicDecryptDek(handle, { timeoutMs: 120_000 });
      });
    } catch (err) {
      last = err;
      if (err instanceof FhevmError && err.fatal) break; // e.g. HTTP 401/403, or no route at ZAMA_RELAYER_URL: a retry cannot help
      if (i + 1 < attempts) {
        const wait = (err instanceof FhevmError && err.retryAfterSec !== undefined ? err.retryAfterSec : 5 * (i + 1)) * 1000;
        run.io.err(`KMS has not served the key yet (${describeError(err)}); retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }
  throw new UserFacingError(
    `could not obtain the key from the KMS: ${describeError(last)}. ` +
      (last instanceof FhevmError && last.fatal
        ? `The relayer refused the request: ${last.hint ?? "check ZAMA_RELAYER_API_KEY (and ZAMA_RELAYER_URL)"}.`
        : "After mark-dark the KMS can take a few minutes; retry `reveal` later."),
  );
};

// ---------- Transactions ---------- //

/** For create / fund-bounty: what sending the same command twice would do, and where to check first. */
interface Twice {
  harm: string;
  check: string;
}

/**
 * Nonce, fees and receipt timeout for a write. With --replace, the given pending transaction's nonce at fees
 * above its own and the market's (it is not mined then). Otherwise, when a transaction from this key is not
 * mined yet, this one is mined only after it: create and fund-bounty refuse unless --queue (it may be the
 * same command, from a run that timed out, and both could be mined); anything else goes out with a note.
 */
const txOpts = async (run: Run, flags: TxFlags, what: string, twice?: Twice): Promise<WriteOpts> => {
  const { dms, io } = run;
  const base: WriteOpts = { onNote: (m) => io.err(`note: ${m}`), ...(run.receiptTimeoutMs !== undefined ? { timeoutMs: run.receiptTimeoutMs } : {}) };
  if (flags.replace) {
    const r = await dms.replacementFor(flags.replace);
    io.err(`replacing ${flags.replace} (nonce ${r.nonce}) with this ${what}, max fee ${formatGwei(r.fees.maxFeePerGas)} gwei: ${flags.replace} will not be mined`);
    return { ...base, nonce: r.nonce, fees: r.fees };
  }
  let { latest, pending } = await dms.nonces();
  // Behind a load balancer the two counts can come from nodes at different heights: look again before believing it.
  if (pending > latest) ({ latest, pending } = await dms.nonces());
  if (pending > latest && !flags.queue) {
    const more = pending - latest - 1;
    const busy = `${dms.signer} has a transaction that is not mined yet (nonce ${latest}${more > 0 ? ` and ${more} more after it` : ""})`;
    if (twice) {
      throw new UserFacingError(
        `${busy}, perhaps from an earlier run that timed out. It may still be mined, so sending this ${what} as well could ${twice.harm}. ` +
          `Check \`${twice.check}\` first; then wait for it, re-run with --replace <its hash> to send this ${what} in its place at higher fees, ` +
          "or re-run with --queue to send this one after it.",
      );
    }
    io.err(`note: ${busy}; this ${what} is mined only after it. If that one is stuck, stop and re-run with --replace <its hash> to send this ${what} in its place at higher fees.`);
  }
  return base;
};

/** A write that was not mined in time: it may still be. What to do about it, by command. */
const timeoutAdvice = (c: Command, err: TxTimeoutError, signer: Address): string => {
  const specific =
    c.cmd === "create"
      ? `run \`dms info ${signer} ${c.id}\` before retrying: if the switch is there, it was created, so ping it rather than creating another switch for the same secret.`
      : c.cmd === "fund-bounty"
        ? `do not simply re-run fund-bounty: if this one is mined too, you fund twice (your stake shows in \`dms info ${c.owner} ${c.id}\`).`
        : "re-running the command without --replace sends a second transaction that waits behind this one.";
  return `${err.message}. It may still be mined: ${specific} To get it mined sooner, re-run the same command with --replace ${err.hash} (same nonce, higher fees).`;
};

/** `create` found a switch of the owner's with this id: perhaps an earlier create that timed out and was mined after all. */
const alreadyHave = (id: bigint, info: SwitchInfo, now: bigint): string =>
  `you already have switch ${id} (state ${info.stateName}; ${explainState(info, now)}). If an earlier \`create\` of yours timed out, ` +
  "this is that switch, mined after all: " +
  (info.stateName === "ALIVE"
    ? `keep it alive with \`dms ping ${id}\` (or disable it with \`dms cancel ${id}\`) rather than creating another switch for the same secret. `
    : "do not create another switch for the same secret. ") +
  "Use another id only for a different secret.";

// ---------- Commands ---------- //

type Handler<C extends Command["cmd"]> = (c: Extract<Command, { cmd: C }>, run: Run) => Promise<unknown>;

const create: Handler<"create"> = async (c, run) => {
  const { dms, io, cfg } = run;
  const owner = dms.signer;
  const plaintext = await loadPlaintext(c.source, run);
  if (c.source.kind === "arg") io.err("note: an inline secret is visible in shell history and the process list; prefer --file <path> or --file -");

  const existing = await dms.info(owner, c.id);
  if (existing.owner !== zeroAddress) throw new UserFacingError(alreadyHave(c.id, existing, await dms.latestTimestamp()));
  const floor = await dms.minBounty();
  if (c.bountyWei < floor) throw new UserFacingError(`bounty ${fmtEth(c.bountyWei)} is below the contract minimum ${fmtEth(floor)}`);

  const sealed = await seal(plaintext);
  try {
    const self = await verifyKeyOpensCiphertext(sealed.ciphertext, sealed.dek, sealed.commitment);
    if (!self.ok || self.commitmentMatches !== true) throw new Error("internal: freshly sealed ciphertext failed its self-check");

    io.out(`sealed ${plaintext.length} bytes -> ${sealed.ciphertext.length}-byte ciphertext (AES-256-GCM, v1)`);
    io.out(`encrypting the data key for ${dms.address} on ${CHAIN_NAMES[cfg.chainId]} ...`);
    const fhe = await run.fhevm();
    const { handle, inputProof } = await fhe.encryptDek(sealed.dek, dms.address, owner);
    wipe(sealed.dek);

    const opts = await txOpts(run, c, "create", { harm: "create a second switch for the same secret", check: `dms info ${owner} ${c.id}` });
    let tx;
    try {
      tx = await dms.createSwitch(
        { id: c.id, pingInterval: c.intervalSec, plaintextCommitment: sealed.commitment },
        bytesToHex(sealed.ciphertext),
        handle,
        inputProof,
        c.bountyWei,
        opts,
      );
    } catch (err) {
      // Created since the check above: most likely by an earlier `create` of this owner's that timed out.
      if (revertErrorName(err) !== "AlreadyExists") throw err;
      const [now, info] = await Promise.all([dms.latestTimestamp(), dms.info(owner, c.id)]);
      throw new UserFacingError(alreadyHave(c.id, info, now));
    }
    const ev = findEvent(tx, "SwitchCreated");
    const expiresAt = (ev?.args.timestamp ?? 0n) + c.intervalSec;
    io.out(`created switch ${c.id} for ${owner}`);
    io.out(`  switch key:   ${ev?.args.switchKey}`);
    io.out(`  key handle:   ${handle}`);
    io.out(`  commitment:   ${sealed.commitment}`);
    io.out(`  interval:     ${c.intervalSec}s (${fmtDuration(c.intervalSec)})`);
    io.out(`  bounty:       ${fmtEth(c.bountyWei)}`);
    io.out(`  deadline:     ${fmtTime(expiresAt)} — ping before then`);
    io.out(txLine("  tx", tx.hash, tx.receipt.gasUsed));
    return { switchKey: ev?.args.switchKey, owner, id: c.id, handle, commitment: sealed.commitment, expiresAt, txHash: tx.hash };
  } finally {
    wipe(sealed.dek);
  }
};

const ping: Handler<"ping"> = async (c, run) => {
  const { dms, io } = run;
  const owner = dms.signer;
  const info = await dms.info(owner, c.id);
  requireExists(info, owner, c.id);
  if (info.stateName !== "ALIVE") throw new UserFacingError(`cannot ping: ${explainState(info, await dms.latestTimestamp())}`);
  const tx = await dms.ping(c.id, await txOpts(run, c, "ping"));
  const ev = findEvent(tx, "Pinged");
  io.out(`pinged switch ${c.id}; next deadline ${fmtTime(ev?.args.expiresAt ?? 0n)}`);
  io.out(txLine("tx", tx.hash, tx.receipt.gasUsed));
  return { txHash: tx.hash, expiresAt: ev?.args.expiresAt };
};

const fundBounty: Handler<"fund-bounty"> = async (c, run) => {
  const { dms, io } = run;
  const info = await dms.info(c.owner, c.id);
  requireExists(info, c.owner, c.id);
  if (info.stateName !== "ALIVE") throw new UserFacingError(`cannot fund: ${explainState(info, await dms.latestTimestamp())}`);
  const tx = await dms.fundBounty(c.owner, c.id, c.amountWei, await txOpts(run, c, "fund-bounty", { harm: "fund the bounty twice", check: `dms info ${c.owner} ${c.id}` }));
  const ev = findEvent(tx, "BountyFunded");
  io.out(`funded ${fmtEth(c.amountWei)}; bounty is now ${fmtEth(ev?.args.newTotal ?? 0n)}`);
  io.out(txLine("tx", tx.hash, tx.receipt.gasUsed));
  return { txHash: tx.hash, newTotal: ev?.args.newTotal };
};

const cancel: Handler<"cancel"> = async (c, run) => {
  const { dms, io } = run;
  const owner = dms.signer;
  const info = await dms.info(owner, c.id);
  requireExists(info, owner, c.id);
  if (info.stateName !== "ALIVE") throw new UserFacingError(`cannot cancel: ${explainState(info, await dms.latestTimestamp())}`);
  const tx = await dms.cancel(c.id, await txOpts(run, c, "cancel"));
  const ev = findEvent(tx, "SwitchCancelled");
  io.out(`cancelled switch ${c.id}; refunded ${fmtEth(ev?.args.refund ?? 0n)}. The key will never be released.`);
  io.out(txLine("tx", tx.hash, tx.receipt.gasUsed));
  return { txHash: tx.hash, refund: ev?.args.refund };
};

const reclaim: Handler<"reclaim"> = async (c, run) => {
  const { dms, io } = run;
  const info = await dms.info(c.owner, c.id);
  requireExists(info, c.owner, c.id);
  // In reclaimContribution's order: AlreadyRevealed, NotRescuable, then NothingToReclaim (a revealed switch reads stake 0).
  if (info.stateName === "REVEALED") throw new UserFacingError("the switch was revealed; contributions went to the revealer");
  if (info.stateName !== "CANCELLED" && !info.rescuable) {
    throw new UserFacingError(
      `contributions are reclaimable after a cancel, or 30 days after going dark without a reveal (from ${fmtTime(info.expiresAt + 30n * 86_400n)})`,
    );
  }
  const stake = await dms.funderStake(c.owner, c.id, dms.signer);
  if (stake === 0n) throw new UserFacingError("you have no contribution on this switch to reclaim");
  const tx = await dms.reclaimContribution(c.owner, c.id, await txOpts(run, c, "reclaim"));
  const ev = findEvent(tx, "ContributionReclaimed");
  io.out(`reclaimed ${fmtEth(ev?.args.amount ?? stake)}`);
  io.out(txLine("tx", tx.hash, tx.receipt.gasUsed));
  return { txHash: tx.hash, amount: ev?.args.amount };
};

const rescue: Handler<"rescue"> = async (c, run) => {
  const { dms, io } = run;
  const owner = dms.signer;
  const info = await dms.info(owner, c.id);
  requireExists(info, owner, c.id);
  if (!info.rescuable) {
    throw new UserFacingError(
      `not rescuable: rescue opens 30 days after going dark with no reveal (from ${fmtTime(info.expiresAt + 30n * 86_400n)}); ` +
        explainState(info, await dms.latestTimestamp()),
    );
  }
  if (info.ownerStake === 0n) throw new UserFacingError("your escrow on this switch is already withdrawn");
  const tx = await dms.reclaimOwnerStake(c.id, await txOpts(run, c, "rescue"));
  const ev = findEvent(tx, "OwnerStakeReclaimed");
  io.out(`rescued ${fmtEth(ev?.args.amount ?? 0n)}. The switch stays active: a late reveal still lands.`);
  io.out(txLine("tx", tx.hash, tx.receipt.gasUsed));
  return { txHash: tx.hash, amount: ev?.args.amount };
};

const markDark: Handler<"mark-dark"> = async (c, run) => {
  const { dms, io } = run;
  const info = await dms.info(c.owner, c.id);
  requireExists(info, c.owner, c.id);
  if (info.stateName !== "DARK") {
    const hint = info.stateName === "DARK_MARKED" ? " — run `reveal` next" : "";
    throw new UserFacingError(`cannot mark dark: ${explainState(info, await dms.latestTimestamp())}${hint}`);
  }
  const tx = await dms.markDark(c.owner, c.id, await txOpts(run, c, "mark-dark"));
  const ev = findEvent(tx, "SwitchDarkMarked");
  io.out(`marked switch ${c.id} dark; the KMS will now decrypt key handle ${ev?.args.encKeyHandle} for anyone`);
  io.out(txLine("tx", tx.hash, tx.receipt.gasUsed));
  io.out(`next: dms reveal ${c.owner} ${c.id}`);
  return { txHash: tx.hash, handle: ev?.args.encKeyHandle };
};

const reveal: Handler<"reveal"> = async (c, run) => {
  const { dms, io } = run;
  const info = await dms.info(c.owner, c.id);
  requireExists(info, c.owner, c.id);
  if (info.stateName !== "DARK_MARKED") {
    const now = await dms.latestTimestamp();
    const hint =
      info.stateName === "DARK"
        ? ` — run \`dms mark-dark ${c.owner} ${c.id}\` first`
        : info.stateName === "REVEALED"
          ? ` — use \`dms read ${c.owner} ${c.id}\`${info.published ? "" : " or `dms publish`"}`
          : "";
    throw new UserFacingError(`cannot reveal: ${explainState(info, now)}${hint}`);
  }

  io.out(`requesting the public decryption of ${info.encKeyHandle} from the KMS ...`);
  const key = await fetchKey(run, info.encKeyHandle);
  const ct = await dms.ciphertext(c.owner, c.id);
  const check = await verifyKeyOpensCiphertext(ct, key.dek, info.plaintextCommitment);
  if (!check.ok) io.err(`WARNING: ${KEY_MISMATCH_WARNING}. Revealing anyway: the bounty is paid for the KMS-proven key.`);
  else if (!check.commitmentMatches) io.err("WARNING: the ciphertext decrypts but does not match the owner's commitment; it cannot be published.");

  // Claim the --out file before the irreversible revealKey: a name clash must fail now, not after the bounty is paid.
  let outHandle: FileHandle | undefined;
  try {
    outHandle = check.ok && c.out !== undefined ? await openOut(c.out) : undefined;
  } catch (err) {
    wipe(key.dek);
    throw err;
  }
  let tx;
  try {
    tx = await dms.revealKey(c.owner, c.id, key.dataKey, key.decryptionProof, await txOpts(run, c, "reveal"));
  } catch (err) {
    if (outHandle) {
      await outHandle.close();
      await unlink(c.out!).catch(() => undefined);
    }
    if (revertErrorName(err) === "AlreadyRevealed") {
      throw new UserFacingError(`${describeError(err)}. Use \`dms read ${c.owner} ${c.id}\` to get the plaintext.`);
    }
    throw err;
  } finally {
    wipe(key.dek);
  }
  const ev = findEvent(tx, "KeyRevealed");
  io.out(`revealed the key of switch ${c.id}; bounty paid to ${ev?.args.revealer}: ${fmtEth(ev?.args.bountyPaid ?? 0n)}`);
  io.out(txLine("tx", tx.hash, tx.receipt.gasUsed));

  const result: Record<string, unknown> = {
    txHash: tx.hash,
    bountyPaid: ev?.args.bountyPaid,
    dataKey: key.dataKey,
    keyOpensCiphertext: check.ok,
    commitmentMatches: check.ok ? check.commitmentMatches : false,
  };
  if (!check.ok) {
    if (c.publish) io.err("not publishing: the revealed key does not open the ciphertext, so there is no plaintext to publish");
    return result;
  }

  // The reveal is done and paid. A follow-up that fails (--out, --publish) does not undo it: the rest still runs,
  // and the command ends with exit code 3 (PartialSuccessError), saying how to recover.
  const failed: string[] = [];
  try {
    await emitPlaintext(run, check.opened, c.out, outHandle);
  } catch (err) {
    failed.push(`${describeError(err)}; recover the plaintext with \`dms read ${c.owner} ${c.id} --out <file>\``);
    result.outWriteFailed = true;
  }
  if (c.publish && !check.commitmentMatches) failed.push("it cannot be published: the plaintext does not match the on-chain commitment");
  else if (c.publish) {
    try {
      const ptx = await dms.publishPlaintext(c.owner, c.id, bytesToHex(check.opened.salt), bytesToHex(check.opened.plaintext), await txOpts(run, {}, "publish"));
      io.out(txLine("published plaintext on-chain", ptx.hash, ptx.receipt.gasUsed));
      result.publishTxHash = ptx.hash;
      result.published = true;
    } catch (err) {
      if (revertErrorName(err) === "AlreadyPublished") {
        // Lost the publish race (a watcher with --publish, say): the plaintext is on-chain, which is what was asked for.
        io.out("the plaintext was already published by someone else");
        result.published = true;
      } else {
        const why = err instanceof TxTimeoutError ? timeoutAdvice({ cmd: "publish", owner: c.owner, id: c.id }, err, dms.signer) : describeError(err);
        failed.push(`publishing failed: ${why}`);
      }
    }
  }
  result.plaintext = check.opened.plaintext;
  if (failed.length > 0) throw new PartialSuccessError(`revealed the key (${tx.hash}; bounty paid), but ${failed.join("; and ")}`, result);
  return result;
};

const read: Handler<"read"> = async (c, run) => {
  const { dms, io } = run;
  const info = await dms.info(c.owner, c.id);
  requireExists(info, c.owner, c.id);
  if (info.stateName !== "REVEALED") throw new UserFacingError(`nothing to read: ${explainState(info, await dms.latestTimestamp())}`);
  const { opened, commitmentMatches } = await openRevealed(run, c.owner, c.id, info);
  io.out(`switch ${c.id} of ${c.owner}: key revealed ${fmtTime(info.revealedAt)}`);
  io.out(`  AES-GCM tag:  verified (the revealed key opens the on-chain ciphertext)`);
  io.out(`  commitment:   ${commitmentMatches ? "verified" : "MISMATCH"} (${info.plaintextCommitment})`);
  io.out(`  published:    ${info.published ? "yes" : "no"}`);
  if (!commitmentMatches) io.err("WARNING: the decrypted plaintext does not match the owner's commitment; publishPlaintext would revert.");
  await emitPlaintext(run, opened, c.out);
  return { plaintext: opened.plaintext, salt: opened.salt, commitmentMatches, published: info.published };
};

const publish: Handler<"publish"> = async (c, run) => {
  const { dms, io } = run;
  const info = await dms.info(c.owner, c.id);
  requireExists(info, c.owner, c.id);
  if (info.stateName !== "REVEALED") throw new UserFacingError(`cannot publish: ${explainState(info, await dms.latestTimestamp())}`);
  if (info.published) throw new UserFacingError("the plaintext is already published");
  const { opened, commitmentMatches } = await openRevealed(run, c.owner, c.id, info);
  if (!commitmentMatches) throw new UserFacingError("the decrypted plaintext does not match the on-chain commitment; publishPlaintext would revert");
  const tx = await dms.publishPlaintext(c.owner, c.id, bytesToHex(opened.salt), bytesToHex(opened.plaintext), await txOpts(run, c, "publish"));
  io.out(`published ${opened.plaintext.length} plaintext bytes for switch ${c.id}`);
  io.out(txLine("tx", tx.hash, tx.receipt.gasUsed));
  return { txHash: tx.hash };
};

const info: Handler<"info"> = async (c, run) => {
  const { dms, io } = run;
  const [i, now, key] = await Promise.all([dms.info(c.owner, c.id), dms.latestTimestamp(), dms.switchKey(c.owner, c.id)]);
  const signer = run.dms.clients.account?.address;
  const myStake = signer && i.owner !== zeroAddress ? await dms.funderStake(c.owner, c.id, signer) : undefined;
  const data = {
    contract: dms.address,
    owner: c.owner,
    id: c.id,
    switchKey: key,
    state: i.stateName,
    stateCode: i.state,
    lastPing: i.lastPing,
    pingInterval: i.pingInterval,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    darkMarkedAt: i.darkMarkedAt,
    revealedAt: i.revealedAt,
    bountyWei: i.bounty,
    ownerStakeWei: i.ownerStake,
    ...(myStake !== undefined ? { yourFunderStakeWei: myStake } : {}),
    plaintextCommitment: i.plaintextCommitment,
    encKeyHandle: i.encKeyHandle,
    revealedKey: i.revealedKey,
    ciphertextLength: i.ciphertextLength,
    plaintextLength: i.ciphertextLength > 0n ? i.ciphertextLength - BigInt(CIPHERTEXT_OVERHEAD) : 0n,
    published: i.published,
    rescuable: i.rescuable,
    chainTime: now,
  };
  if (c.json) {
    io.out(toJson(data));
    return data;
  }
  if (i.owner === zeroAddress) {
    io.out(`no switch ${c.id} for owner ${c.owner} (state NONE)`);
    return data;
  }
  const rows: [string, string][] = [
    ["contract", dms.address],
    ["owner", c.owner],
    ["id", c.id.toString()],
    ["switch key", key],
    ["state", `${i.stateName} — ${explainState(i, now)}`],
    ["last ping", fmtTimeRel(i.lastPing, now)],
    ["ping interval", `${i.pingInterval}s (${fmtDuration(i.pingInterval)})`],
    ["created", fmtTimeRel(i.createdAt, now)],
    ["expires", fmtTimeRel(i.expiresAt, now)],
    ["dark-marked", fmtTimeRel(i.darkMarkedAt, now)],
    ["revealed", fmtTimeRel(i.revealedAt, now)],
    ["bounty", fmtEth(i.bounty)],
    ["owner stake", fmtEth(i.ownerStake)],
    ...(myStake !== undefined ? ([["your stake", fmtEth(myStake)]] as [string, string][]) : []),
    ["commitment", i.plaintextCommitment],
    ["key handle", i.encKeyHandle],
    ["revealed key", i.revealedKey === `0x${"0".repeat(64)}` ? "-" : i.revealedKey],
    ["ciphertext", `${i.ciphertextLength} bytes (${data.plaintextLength}-byte plaintext)`],
    ["published", i.published ? "yes" : "no"],
    ["rescuable", i.rescuable ? "yes" : `no${i.stateName === "DARK" || i.stateName === "DARK_MARKED" ? ` (from ${fmtTime(i.expiresAt + 30n * 86_400n)})` : ""}`],
    ["chain time", fmtTime(now)],
  ];
  for (const [k, v] of rows) io.out(`${k.padEnd(14)} ${v}`);
  return data;
};

const status: Handler<"status"> = async (c, run) => {
  const { dms, io, cfg } = run;
  const s = await dms.status();
  const signer = dms.clients.account?.address;
  const balance = signer ? await dms.publicClient.getBalance({ address: signer }) : undefined;
  const relayer =
    cfg.chainId === 31337
      ? "cleartext() (local forge-fhevm host; no relayer)"
      : `${cfg.relayerUrl ?? (cfg.chainId === 1 ? fheMainnet : fheSepolia).relayerUrl} (api key ${
          cfg.relayerApiKey ? "set" : cfg.chainId === 1 ? "MISSING" : "not needed: the Sepolia relayer is open"
        })`;
  const data = {
    chainId: cfg.chainId,
    chain: CHAIN_NAMES[cfg.chainId],
    ...s,
    ...(signer ? { signer, signerBalanceWei: balance } : {}),
    relayer,
  };
  if (c.json) {
    io.out(toJson(data));
    return data;
  }
  // oraclePrice() is the feed's raw answer, in the feed's own decimals (minBountyUsd always has 8).
  const ethUsd = s.feedDecimals !== null ? fmtUsd(s.oracle.price, s.feedDecimals) : undefined;
  const floor =
    s.minBountyUsd === 0n
      ? "disabled (minBountyUsd = 0)"
      : s.oracle.ok
        ? `${fmtEth(s.minBounty)} (${fmtUsd8(s.minBountyUsd)}${ethUsd ? ` at ETH = ${ethUsd}` : ""})`
        : `0 — oracle unusable, floor fails open (${fmtUsd8(s.minBountyUsd)} configured)`;
  const rows: [string, string][] = [
    ["chain", `${CHAIN_NAMES[cfg.chainId]} (${cfg.chainId})`],
    ["contract", s.address],
    ["admin", s.admin === zeroAddress ? "renounced" : s.admin],
    ["pending admin", s.pendingAdmin === zeroAddress ? "-" : s.pendingAdmin],
    ["min bounty", floor],
    ["price feed", s.ethUsdPriceFeed === zeroAddress ? "none" : `${s.ethUsdPriceFeed} (max age ${fmtDuration(s.maxPriceAge)})`],
    ["oracle price", !s.oracle.ok ? "unavailable" : (ethUsd ?? `${s.oracle.price} (raw feed answer; the feed's decimals are unknown)`)],
    ["ping interval", `${fmtDuration(s.constants.MIN_PING_INTERVAL)} .. ${fmtDuration(s.constants.MAX_PING_INTERVAL)}`],
    ["max plaintext", `${s.constants.MAX_PAYLOAD_SIZE} bytes (ciphertext ${s.constants.MAX_CIPHERTEXT_SIZE})`],
    ["rescue delay", fmtDuration(s.constants.RESCUE_DELAY)],
    ["relayer", relayer],
    ...(signer ? ([["signer", `${signer} (${formatEther(balance ?? 0n)} ETH)`]] as [string, string][]) : []),
  ];
  for (const [k, v] of rows) io.out(`${k.padEnd(14)} ${v}`);
  return data;
};

const HANDLERS: { [C in Command["cmd"]]?: Handler<C> } = {
  create,
  ping,
  "fund-bounty": fundBounty,
  cancel,
  reclaim,
  rescue,
  "mark-dark": markDark,
  reveal,
  read,
  publish,
  info,
  status,
};

/** Parse argv, run one command, return its structured result. Throws on any failure. */
export const runCli = async (argv: string[], ctx: CliContext): Promise<unknown> => {
  const command = parseCliArgs(argv);
  if (command.cmd === "help") {
    ctx.io.out(USAGE);
    return { help: true };
  }
  const cfg = parseConfig(ctx.env);
  const clients = createClients(cfg);
  const dms = new Dms(clients, cfg.dmsAddress);
  await dms.assertDeployment(cfg.chainId);

  let fhevm: Fhevm | undefined;
  const run: Run = {
    cfg,
    dms,
    io: ctx.io,
    readStdin: ctx.readStdin ?? readProcessStdin,
    fhevm: async () => (fhevm ??= ctx.fhevmFactory ? await ctx.fhevmFactory(cfg, dms) : await createFhevm(cfg, clients)),
    receiptTimeoutMs: ctx.receiptTimeoutMs,
  };
  try {
    const handler = HANDLERS[command.cmd] as Handler<typeof command.cmd>;
    return await handler(command as never, run);
  } catch (err) {
    if (err instanceof TxTimeoutError) throw new UserFacingError(timeoutAdvice(command, err, dms.signer));
    throw err;
  } finally {
    fhevm?.close();
  }
};

