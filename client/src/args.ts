// Pure CLI argument parsing and validation. No I/O; unit-tested in test/args.test.ts.

import { getAddress, isAddress, isHex, parseEther, type Address, type Hex } from "viem";
import { UsageError } from "./errors.js";

export const MIN_PING_INTERVAL = 60n;
export const MAX_PING_INTERVAL = 365n * 24n * 3600n;
const UINT256_MAX = (1n << 256n) - 1n;

export type PlaintextSource = { kind: "arg"; text: string } | { kind: "file"; path: string };

/** What a write does about an earlier transaction from the same key that is not mined yet. */
export interface TxFlags {
  /** --replace: send this call at that transaction's nonce, with higher fees, in its place. */
  replace?: Hex;
  /** --queue: send it after that transaction anyway (create and fund-bounty refuse otherwise). */
  queue?: boolean;
}

export type Command =
  | { cmd: "help" }
  | ({ cmd: "create"; id: bigint; intervalSec: bigint; bountyWei: bigint; source: PlaintextSource } & TxFlags)
  | ({ cmd: "ping"; id: bigint } & TxFlags)
  | ({ cmd: "fund-bounty"; owner: Address; id: bigint; amountWei: bigint } & TxFlags)
  | ({ cmd: "cancel"; id: bigint } & TxFlags)
  | ({ cmd: "reclaim"; owner: Address; id: bigint } & TxFlags)
  | ({ cmd: "rescue"; id: bigint } & TxFlags)
  | ({ cmd: "mark-dark"; owner: Address; id: bigint } & TxFlags)
  | ({ cmd: "reveal"; owner: Address; id: bigint; publish: boolean; out?: string } & TxFlags)
  | { cmd: "read"; owner: Address; id: bigint; out?: string }
  | ({ cmd: "publish"; owner: Address; id: bigint } & TxFlags)
  | { cmd: "info"; owner: Address; id: bigint; json: boolean }
  | { cmd: "status"; json: boolean };

export const USAGE = `DeadManSwitch CLI (Zama fhEVM) — public release only

Usage: dms <command> [args] [flags]

Owner
  create <id> <intervalSec> <bountyEth> <plaintext>    create a switch (secret given inline)
  create <id> <intervalSec> <bountyEth> --file <path>  ... or read the secret from a file ('-' = stdin)
  ping <id>                                           prove you are alive; resets the deadline
  cancel <id>                                         disable forever (only while alive); refunds your escrow
  rescue <id>                                         recover your escrow 30 days after dark with no reveal

Anyone
  fund-bounty <owner> <id> <amountEth>                add to the bounty of a live switch
                                                      (locked while the owner keeps pinging; see reclaim)
  reclaim <owner> <id>                                take back your contribution (after cancel / rescue window)
  mark-dark <owner> <id>                              owner missed the deadline: ask the KMS to release the key
  reveal <owner> <id> [--publish] [--out <file>]      fetch the key + KMS proof, claim the bounty, decrypt
  read <owner> <id> [--out <file>]                    decrypt a revealed switch from chain state alone
  publish <owner> <id>                                post the plaintext on-chain (commitment-checked)
  info <owner> <id> [--json]                          every field of a switch
  status [--json]                                     contract config: min bounty, oracle, admin

Flags
  --file <path>     create: read the secret from a file ('-' reads stdin); max 2048 bytes
  --out <file>      reveal/read: write the raw plaintext bytes to <file> (mode 0600) instead of printing
  --publish         reveal: also publish the plaintext on-chain
  --json            info/status: machine-readable output
  --replace <hash>  any write: send it in place of your transaction <hash> that is not mined yet
                    (same nonce, fees at least 12.5% higher), e.g. after a ping that timed out
  --queue           create/fund-bounty: send even though a transaction from your key is not mined
                    yet (refused otherwise: if it is the same command, both may be mined)
  -h, --help        this help

Environment (.env): PRIVATE_KEY, RPC_URL, CHAIN_ID (1 | 11155111 | 31337), DMS_ADDRESS,
                    ZAMA_RELAYER_API_KEY (mainnet; optional on Sepolia), ZAMA_RELAYER_URL (optional)

Revealed plaintext is untrusted data: it is printed with control characters escaped.
Use --out to get the exact bytes.

Exit codes: 0 done; 1 failed; 2 usage error; 3 reveal: the key was revealed and the bounty paid,
but writing --out or publishing failed (the message says how to recover).`;

export const parseId = (raw: string | undefined, what = "id"): bigint => {
  if (raw === undefined) throw new UsageError(`missing <${what}>`);
  let v: bigint;
  try {
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(raw)) throw new Error();
    v = BigInt(raw);
  } catch {
    throw new UsageError(`<${what}> must be a positive integer, got "${raw}"`);
  }
  if (v === 0n) throw new UsageError(`<${what}> must be non-zero`);
  if (v > UINT256_MAX) throw new UsageError(`<${what}> does not fit in uint256`);
  return v;
};

export const parseInterval = (raw: string | undefined): bigint => {
  if (raw === undefined) throw new UsageError("missing <intervalSec>");
  if (!/^\d+$/.test(raw)) throw new UsageError(`<intervalSec> must be a whole number of seconds, got "${raw}"`);
  const v = BigInt(raw);
  if (v < MIN_PING_INTERVAL || v > MAX_PING_INTERVAL) {
    throw new UsageError(`<intervalSec> must be between ${MIN_PING_INTERVAL} (1 minute) and ${MAX_PING_INTERVAL} (365 days), got ${raw}`);
  }
  return v;
};

export const parseEth = (raw: string | undefined, what: string, opts: { allowZero: boolean }): bigint => {
  if (raw === undefined) throw new UsageError(`missing <${what}>`);
  if (!/^\d+(\.\d{1,18})?$|^\.\d{1,18}$/.test(raw)) throw new UsageError(`<${what}> must be an ETH amount like 0.05, got "${raw}"`);
  const v = parseEther(raw.startsWith(".") ? `0${raw}` : raw);
  if (!opts.allowZero && v === 0n) throw new UsageError(`<${what}> must be greater than zero`);
  return v;
};

export const parseOwner = (raw: string | undefined): Address => {
  if (raw === undefined) throw new UsageError("missing <owner>");
  if (!isAddress(raw, { strict: false })) throw new UsageError(`<owner> must be an address, got "${raw}"`);
  return getAddress(raw);
};

interface Flags {
  file?: string;
  out?: string;
  publish: boolean;
  json: boolean;
  replace?: Hex;
  queue: boolean;
  help: boolean;
}

/** Flags every write takes. */
const TX: (keyof Flags)[] = ["replace", "queue"];

const FLAG_ALLOWED: Record<string, (keyof Flags)[]> = {
  create: ["file", ...TX],
  ping: TX,
  "fund-bounty": TX,
  cancel: TX,
  reclaim: TX,
  rescue: TX,
  "mark-dark": TX,
  reveal: ["publish", "out", ...TX],
  read: ["out"],
  publish: TX,
  info: ["json"],
  status: ["json"],
};

const splitFlags = (argv: string[]): { positional: string[]; flags: Flags; seen: Set<keyof Flags> } => {
  const positional: string[] = [];
  const flags: Flags = { publish: false, json: false, queue: false, help: false };
  const seen = new Set<keyof Flags>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const takeValue = (name: string): string => {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith("--") && v !== "-")) throw new UsageError(`${name} needs a value`);
      i++;
      return v;
    };
    // An empty path (an unset shell variable) must not silently mean "no file".
    const takePath = (name: string): string => {
      const v = takeValue(name);
      if (v === "") throw new UsageError(`${name} needs a non-empty path`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--file":
        flags.file = takePath(a);
        seen.add("file");
        break;
      case "--out":
        flags.out = takePath(a);
        seen.add("out");
        break;
      case "--publish":
        flags.publish = true;
        seen.add("publish");
        break;
      case "--json":
        flags.json = true;
        seen.add("json");
        break;
      case "--replace": {
        const v = takeValue(a);
        if (!isHex(v, { strict: true }) || v.length !== 66) throw new UsageError(`--replace needs the hash of your pending transaction (0x and 64 hex digits), got "${v}"`);
        flags.replace = v;
        seen.add("replace");
        break;
      }
      case "--queue":
        flags.queue = true;
        seen.add("queue");
        break;
      default:
        if (a.startsWith("--")) throw new UsageError(`unknown flag ${a}`);
        positional.push(a);
    }
  }
  return { positional, flags, seen };
};

const arity = (cmd: string, positional: string[], n: number, names: string): void => {
  if (positional.length < n) throw new UsageError(`${cmd}: missing arguments — usage: dms ${cmd} ${names}`);
  if (positional.length > n) throw new UsageError(`${cmd}: too many arguments — usage: dms ${cmd} ${names}`);
};

/** Parse argv (without node/script) into a validated Command. Throws UsageError. */
export const parseCliArgs = (argv: string[]): Command => {
  if (argv.length === 0) return { cmd: "help" };
  const [cmd, ...rest] = argv;
  if (cmd === "help" || cmd === "-h" || cmd === "--help") return { cmd: "help" };
  const { positional: p, flags, seen } = splitFlags(rest);
  if (flags.help) return { cmd: "help" };

  const allowed = FLAG_ALLOWED[cmd] ?? [];
  for (const f of seen) if (!allowed.includes(f)) throw new UsageError(`${cmd} does not take --${f}`);
  if (flags.replace && flags.queue) throw new UsageError("--replace and --queue do not go together: replace the pending transaction, or queue behind it");
  // Only when given: commands without them stay as they were.
  const tx: TxFlags = { ...(flags.replace ? { replace: flags.replace } : {}), ...(flags.queue ? { queue: true } : {}) };

  switch (cmd) {
    case "create": {
      const names = "<id> <intervalSec> <bountyEth> (<plaintext> | --file <path>)";
      if (flags.file !== undefined) {
        arity(cmd, p, 3, names);
      } else {
        if (p.length < 4) throw new UsageError(`create: missing arguments — usage: dms create ${names}`);
        if (p.length > 4) throw new UsageError(`create: too many arguments — quote the plaintext ("...") or use --file`);
      }
      const id = parseId(p[0]);
      const intervalSec = parseInterval(p[1]);
      const bountyWei = parseEth(p[2], "bountyEth", { allowZero: true });
      let source: PlaintextSource;
      if (flags.file !== undefined) {
        source = { kind: "file", path: flags.file };
      } else {
        if (p[3] === "") throw new UsageError("plaintext must not be empty");
        source = { kind: "arg", text: p[3] };
      }
      return { cmd, id, intervalSec, bountyWei, source, ...tx };
    }
    case "ping":
    case "cancel":
    case "rescue":
      arity(cmd, p, 1, "<id>");
      return { cmd, id: parseId(p[0]), ...tx };
    case "fund-bounty":
      arity(cmd, p, 3, "<owner> <id> <amountEth>");
      return { cmd, owner: parseOwner(p[0]), id: parseId(p[1]), amountWei: parseEth(p[2], "amountEth", { allowZero: false }), ...tx };
    case "reclaim":
    case "mark-dark":
    case "publish":
      arity(cmd, p, 2, "<owner> <id>");
      return { cmd, owner: parseOwner(p[0]), id: parseId(p[1]), ...tx };
    case "reveal":
      arity(cmd, p, 2, "<owner> <id> [--publish] [--out <file>]");
      return { cmd, owner: parseOwner(p[0]), id: parseId(p[1]), publish: flags.publish, out: flags.out, ...tx };
    case "read":
      arity(cmd, p, 2, "<owner> <id> [--out <file>]");
      return { cmd, owner: parseOwner(p[0]), id: parseId(p[1]), out: flags.out };
    case "info":
      arity(cmd, p, 2, "<owner> <id> [--json]");
      return { cmd, owner: parseOwner(p[0]), id: parseId(p[1]), json: flags.json };
    case "status":
      arity(cmd, p, 0, "[--json]");
      return { cmd, json: flags.json };
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
};
