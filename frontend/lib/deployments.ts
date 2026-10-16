// The DeadManSwitch deployments on each chain: one rule, used by the browser
// bundle (lib/contracts.ts contractFor, deploymentsFor) and by the relayer
// proxy (app/api/relayer/proxy.ts, which relays input proofs only for the
// current contract). No browser-only or Next-only imports, so the server can
// use it.
//
// A chain has one current deployment, the only one new switches are created
// on, and any number of previous ones. A redeploy must never drop the old
// address: its switches are immutable and live on, and an owner who cannot
// find a switch to ping it has its secret released. List the old address as a
// previous deployment until every switch on it is revealed or cancelled.
//
// Deployments compiled into the app live in lib/deployments.json, which
// next.config.js reads too: `next build` then requires an RPC URL for their
// chains, and refuses a malformed entry, as it does for the env variables.

import compiled from "./deployments.json";

export type Address = `0x${string}`;

/** An earlier deployment on a chain: its switches stay usable (ping, cancel, top-up, release, reclaim); creates go to the current one. */
export interface PreviousDeployment {
  address: Address;
  /** Its deploy block: where its SwitchCreated scan starts. */
  fromBlock: bigint;
}

export const validAddress = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? (v.trim() as Address) : undefined;

/** The env override (NEXT_PUBLIC_CONTRACT_<chainId>) when it is a valid address, else the compiled-in one. */
export const deploymentFor = (
  chainId: number,
  envValue: string | undefined,
  hardcoded: Readonly<Record<number, Address | undefined>> = HARDCODED_CONTRACTS,
): Address | undefined => validAddress(envValue) ?? hardcoded[chainId];

const PREVIOUS_ENTRY_RE = /^(0x[0-9a-fA-F]{40}):(\d{1,20})$/;

/**
 * NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>: comma-separated
 * `<address>:<deploy block>` entries. `invalid` lists the entries that are not
 * (`next build` refuses them: next.config.js); they are ignored here.
 */
export const parsePreviousContracts = (v: string | undefined): { entries: PreviousDeployment[]; invalid: string[] } => {
  const entries: PreviousDeployment[] = [];
  const invalid: string[] = [];
  for (const part of (v ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    const m = PREVIOUS_ENTRY_RE.exec(s);
    if (m) entries.push({ address: m[1] as Address, fromBlock: BigInt(m[2]!) });
    else invalid.push(s);
  }
  return { entries, invalid };
};

/** lib/deployments.json: `contracts` by chain id, `previousContracts` by chain id as `<address>:<deploy block>` entries. */
export interface CompiledDeploymentsJson {
  contracts?: Record<string, string>;
  previousContracts?: Record<string, string[]>;
}

/** The typed tables of lib/deployments.json; entries that do not parse are left out (`next build` refuses them). */
export const compiledDeployments = (raw: CompiledDeploymentsJson): {
  contracts: Record<number, Address | undefined>;
  previous: Record<number, readonly PreviousDeployment[] | undefined>;
} => {
  const contracts: Record<number, Address | undefined> = {};
  for (const [id, v] of Object.entries(raw.contracts ?? {})) {
    const a = validAddress(v);
    if (a) contracts[Number(id)] = a;
  }
  const previous: Record<number, readonly PreviousDeployment[] | undefined> = {};
  for (const [id, v] of Object.entries(raw.previousContracts ?? {})) previous[Number(id)] = parsePreviousContracts(v.join(",")).entries;
  return { contracts, previous };
};

const COMPILED = compiledDeployments(compiled as CompiledDeploymentsJson);

/**
 * Addresses compiled into the app (lib/deployments.json `contracts`), used
 * when NEXT_PUBLIC_CONTRACT_<chainId> is not set. Fill in after deploying; the
 * browser and the proxy both read this.
 */
export const HARDCODED_CONTRACTS: Readonly<Record<number, Address | undefined>> = COMPILED.contracts;

/**
 * Earlier deployments compiled into the app (lib/deployments.json
 * `previousContracts`), per chain, newest first. After a redeploy, move the
 * old address and its deploy block there (or into
 * NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>).
 */
export const HARDCODED_PREVIOUS_CONTRACTS: Readonly<Record<number, readonly PreviousDeployment[] | undefined>> = COMPILED.previous;

/**
 * The previous deployments of a chain: the env entries, then the compiled-in
 * ones; without the current address, and each address once (first wins).
 */
export const previousDeploymentsFor = (
  chainId: number,
  envValue: string | undefined,
  current: Address | undefined,
  hardcoded: Readonly<Record<number, readonly PreviousDeployment[] | undefined>> = HARDCODED_PREVIOUS_CONTRACTS,
): PreviousDeployment[] => {
  const seen = new Set<string>(current ? [current.toLowerCase()] : []);
  const out: PreviousDeployment[] = [];
  for (const d of [...parsePreviousContracts(envValue).entries, ...(hardcoded[chainId] ?? [])]) {
    const k = d.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
};
