// The client side of the cross-component specs: the `dms` CLI and the
// watcher (client/), run as real subprocesses of the built client
// (client/dist, `npm run build` in client/; scripts/browser-e2e.sh builds it
// when it is missing or older than client/src) against the same Anvil and
// DeadManSwitch as the app.
//
// Each process gets a clean environment (RPC_URL, CHAIN_ID=31337,
// DMS_ADDRESS and, for a writer, PRIVATE_KEY = an Anvil dev key) and runs in
// the test's own output directory, so neither client/.env nor a
// client/watcher.config.json can leak in. Every run (argv, exit code, time,
// stdout, stderr) is kept for the test's client-log.txt.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bytesToHex, getAddress, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { ACCOUNTS, CHAIN_ID, ROLES, type Role } from "./env";

/** client/ (override with E2E_CLIENT_DIR). */
export const CLIENT_DIR = process.env.E2E_CLIENT_DIR?.trim() || resolve(__dirname, "../../../client");

const MNEMONIC = "test test test test test test test test test test test junk";

/** Anvil dev account `index`'s private key (local only). */
export const devKey = (index: number): Hex =>
  bytesToHex(mnemonicToAccount(MNEMONIC, { addressIndex: index }).getHdKey().privateKey!);
export const devAddress = (index: number): Address => getAddress(mnemonicToAccount(MNEMONIC, { addressIndex: index }).address);

/** The watcher signs with anvil #4: no browser role uses it, so its transactions are its own. */
export const WATCHER_INDEX = 4;

/** Who runs a command: a browser role's key, the watcher's key, or nobody (read-only). */
export type CliActor = Role | "watcher" | "reader";

const keyIndex = (who: CliActor): number | null => (who === "reader" ? null : who === "watcher" ? WATCHER_INDEX : ROLES[who]);

export const cliAddress = (who: Exclude<CliActor, "reader">): Address => devAddress(keyIndex(who)!);

export interface CliRun {
  argv: string[];
  as: CliActor;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** `dms info --json` (bigints as decimal strings). */
export interface InfoJson {
  contract: string;
  owner: string;
  id: string;
  switchKey: string;
  state: "NONE" | "ALIVE" | "DARK" | "DARK_MARKED" | "REVEALED" | "CANCELLED";
  stateCode: number;
  lastPing: string;
  pingInterval: string;
  createdAt: string;
  expiresAt: string;
  darkMarkedAt: string;
  revealedAt: string;
  bountyWei: string;
  ownerStakeWei: string;
  yourFunderStakeWei?: string;
  plaintextCommitment: string;
  encKeyHandle: string;
  revealedKey: string;
  ciphertextLength: string;
  plaintextLength: string;
  published: boolean;
  rescuable: boolean;
  chainTime: string;
}

/** `dms status --json`. */
export interface StatusJson {
  chainId: number;
  chain: string;
  address: string;
  admin: string;
  pendingAdmin: string;
  minBountyUsd: string;
  minBounty: string;
  ethUsdPriceFeed: string;
  signer?: string;
  relayer: string;
}

let checked = false;

/** Fail with a clear message when client/dist is missing or older than client/src. */
const assertClientBuilt = (): void => {
  if (checked) return;
  const dist = join(CLIENT_DIR, "dist");
  const missing = ["index.js", "watcher.js"].filter((f) => !existsSync(join(dist, f)));
  if (missing.length) {
    throw new Error(`${dist} lacks ${missing.join(", ")}: run \`npm run build\` in ${CLIENT_DIR} (scripts/browser-e2e.sh does this)`);
  }
  if (!existsSync(join(CLIENT_DIR, "node_modules"))) throw new Error(`${CLIENT_DIR}/node_modules is missing: run \`npm ci\` there`);
  const built = statSync(join(dist, "index.js")).mtimeMs;
  const src = join(CLIENT_DIR, "src");
  const stale = readdirSync(src).filter((f) => f.endsWith(".ts") && statSync(join(src, f)).mtimeMs > built);
  if (stale.length) {
    throw new Error(`${dist} is older than ${stale.map((f) => `src/${f}`).join(", ")}: run \`npm run build\` in ${CLIENT_DIR}`);
  }
  checked = true;
};

export class Cli {
  readonly runs: CliRun[] = [];
  private readonly live = new Set<ChildProcess>();
  private sanityChecked = false;

  constructor(
    readonly rpcUrl: string,
    readonly dmsAddress: Address,
    /** Working directory of every process (the test's output directory). */
    readonly workDir: string,
  ) {}

  private env(who: CliActor): NodeJS.ProcessEnv {
    // A plain map (Next's types make NODE_ENV a required key of ProcessEnv; the client never reads it).
    const index = keyIndex(who);
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      RPC_URL: this.rpcUrl,
      CHAIN_ID: String(CHAIN_ID),
      DMS_ADDRESS: this.dmsAddress,
      // Set, even when empty, so dotenv never fills them in from a .env file.
      PRIVATE_KEY: index === null ? "" : devKey(index),
      ZAMA_RELAYER_API_KEY: "",
      ZAMA_RELAYER_URL: "",
      FROM_BLOCK: "",
      NO_COLOR: "1",
    } satisfies Record<string, string | undefined> as unknown as NodeJS.ProcessEnv;
  }

  private async spawnNode(script: string, args: string[], who: CliActor, timeoutMs: number): Promise<CliRun> {
    assertClientBuilt();
    if (!this.sanityChecked) {
      // The keys this module derives are the accounts the browser wallet uses.
      for (const [i, a] of ACCOUNTS.entries()) if (devAddress(i) !== a) throw new Error(`dev key ${i} is not ${a}`);
      this.sanityChecked = true;
    }
    await mkdir(this.workDir, { recursive: true });
    const started = Date.now();
    return new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [join(CLIENT_DIR, "dist", script), ...args], {
        cwd: this.workDir,
        env: this.env(who),
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.live.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (d) => (stdout += d));
      child.stderr!.on("data", (d) => (stderr += d));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        this.live.delete(child);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.live.delete(child);
        const run: CliRun = { argv: [script, ...args], as: who, code, signal, stdout, stderr, ms: Date.now() - started };
        this.runs.push(run);
        if (timedOut) reject(new Error(`${script} ${args.join(" ")} timed out after ${timeoutMs} ms\n${describeRun(run)}`));
        else resolveRun(run);
      });
    });
  }

  /** `dms <args>` as `who`; resolves with any exit code. */
  run(who: CliActor, args: string[], timeoutMs = 120_000): Promise<CliRun> {
    return this.spawnNode("index.js", args, who, timeoutMs);
  }

  /** `dms <args>` as `who`; throws, with its output, unless it exits 0. */
  async ok(who: CliActor, args: string[], timeoutMs = 120_000): Promise<CliRun> {
    const r = await this.run(who, args, timeoutMs);
    if (r.code !== 0) throw new Error(`dms ${args.join(" ")} [${who}] exited ${r.code ?? r.signal}\n${describeRun(r)}`);
    return r;
  }

  /** `dms info <owner> <id> --json`; read-only unless `who` is given (then it also reports that signer's stake). */
  async info(owner: Address, id: bigint, who: CliActor = "reader"): Promise<InfoJson> {
    const r = await this.ok(who, ["info", owner, id.toString(), "--json"]);
    return JSON.parse(r.stdout) as InfoJson;
  }

  /** `dms status --json`. */
  async status(who: CliActor = "reader"): Promise<StatusJson> {
    const r = await this.ok(who, ["status", "--json"]);
    return JSON.parse(r.stdout) as StatusJson;
  }

  /** The watcher (`dms-watcher`) with `args`, signing as anvil #4. */
  watcher(args: string[], timeoutMs = 240_000): Promise<CliRun> {
    return this.spawnNode("watcher.js", args, "watcher", timeoutMs);
  }

  /** A file in the working directory (a secret to create from, a watcher config). */
  async file(name: string, content: string | Uint8Array): Promise<string> {
    await mkdir(this.workDir, { recursive: true });
    const path = join(this.workDir, name);
    await writeFile(path, content, { mode: 0o600 });
    return path;
  }

  async read(path: string): Promise<Buffer> {
    return readFile(path);
  }

  /** A path in the working directory that does not exist yet (for --out). */
  path(name: string): string {
    return join(this.workDir, name);
  }

  /** Kill whatever is still running (a test that timed out mid-command). */
  stopAll(): void {
    for (const c of this.live) c.kill("SIGKILL");
    this.live.clear();
  }

  log(): string {
    return this.runs.map(describeRun).join("\n\n") + "\n";
  }
}

export const describeRun = (r: CliRun): string =>
  [
    `$ ${r.argv[0] === "watcher.js" ? "dms-watcher" : "dms"} ${r.argv.slice(1).join(" ")}   [as ${r.as}; exit ${r.code ?? r.signal}; ${r.ms} ms]`,
    r.stdout.trimEnd() ? `--- stdout\n${r.stdout.trimEnd()}` : "--- stdout (empty)",
    r.stderr.trimEnd() ? `--- stderr\n${r.stderr.trimEnd()}` : "--- stderr (empty)",
  ].join("\n");

/** A switch id above 2^64 (the app draws 64-bit ids): ids must survive every component as exact integers. */
export const bigSwitchId = (): bigint => (1n << 64n) + BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
