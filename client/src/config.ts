// Environment configuration. Parsing is a pure function of an env map so it can
// be unit-tested and so the e2e runner can build per-actor configs in-process.
//
//   PRIVATE_KEY           signer key (0x + 64 hex). Optional for read-only commands (empty or a bare 0x = unset).
//   RPC_URL               JSON-RPC endpoint of the host chain.
//   CHAIN_ID              1 (Ethereum mainnet) | 11155111 (Sepolia) | 31337 (local Anvil + forge-fhevm).
//   DMS_ADDRESS           the deployed DeadManSwitch.
//   ZAMA_RELAYER_API_KEY  Zama relayer API key; required on 1 for encrypt / public decrypt (Sepolia's relayer is open).
//   ZAMA_RELAYER_URL      optional relayer URL override (default: the SDK chain preset's).
//   FROM_BLOCK            first block the watcher scans for SwitchCreated (the deploy block).

import { getAddress, isAddress, type Address, type Hex } from "viem";

export const SUPPORTED_CHAIN_IDS = [1, 11155111, 31337] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export const CHAIN_NAMES: Record<SupportedChainId, string> = {
  1: "Ethereum mainnet",
  11155111: "Sepolia",
  31337: "local Anvil (forge-fhevm)",
};

export interface Config {
  privateKey?: Hex;
  rpcUrl: string;
  chainId: SupportedChainId;
  dmsAddress: Address;
  relayerApiKey?: string;
  relayerUrl?: string;
  fromBlock: bigint;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Env = Record<string, string | undefined>;

const trimmed = (env: Env, k: string): string | undefined => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};

export const isSupportedChainId = (n: number): n is SupportedChainId =>
  (SUPPORTED_CHAIN_IDS as readonly number[]).includes(n);

export const parseChainId = (raw: string | undefined): SupportedChainId => {
  if (!raw) throw new ConfigError("CHAIN_ID is required (1 = Ethereum mainnet, 11155111 = Sepolia, 31337 = local Anvil)");
  if (!/^\d+$/.test(raw)) throw new ConfigError(`CHAIN_ID must be a decimal integer, got "${raw}"`);
  const n = Number(raw);
  if (!isSupportedChainId(n)) {
    throw new ConfigError(
      `CHAIN_ID ${raw} is not supported. DeadManSwitch runs only where Zama's fhEVM host is deployed: ` +
        `1 (Ethereum mainnet), 11155111 (Sepolia), 31337 (local Anvil with forge-fhevm).`,
    );
  }
  return n;
};

export const parsePrivateKey = (raw: string | undefined): Hex | undefined => {
  // A bare "0x" is the placeholder an older .env.example shipped: treat it as unset, like an empty value.
  if (!raw || raw.toLowerCase() === "0x") return undefined;
  const v = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new ConfigError("PRIVATE_KEY must be 32 bytes of hex (0x + 64 hex chars)");
  return v as Hex;
};

export const parseAddress = (name: string, raw: string | undefined): Address => {
  if (!raw) throw new ConfigError(`${name} is required`);
  if (!isAddress(raw, { strict: false })) throw new ConfigError(`${name} is not a valid address: "${raw}"`);
  return getAddress(raw);
};

export const parseFromBlock = (raw: string | undefined): bigint => {
  if (!raw) return 0n;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`FROM_BLOCK must be a non-negative integer, got "${raw}"`);
  return BigInt(raw);
};

export const parseUrl = (name: string, raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: "${raw}"`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError(`${name} must be http(s), got ${u.protocol}`);
  return raw;
};

/** Parse and validate the environment. Throws ConfigError with an actionable message. */
export const parseConfig = (env: Env): Config => {
  const chainId = parseChainId(trimmed(env, "CHAIN_ID"));
  const rpcUrl = parseUrl("RPC_URL", trimmed(env, "RPC_URL"));
  if (!rpcUrl) throw new ConfigError("RPC_URL is required (e.g. http://127.0.0.1:8545 for local Anvil)");
  return {
    privateKey: parsePrivateKey(trimmed(env, "PRIVATE_KEY")),
    rpcUrl,
    chainId,
    dmsAddress: parseAddress("DMS_ADDRESS", trimmed(env, "DMS_ADDRESS")),
    relayerApiKey: trimmed(env, "ZAMA_RELAYER_API_KEY"),
    relayerUrl: parseUrl("ZAMA_RELAYER_URL", trimmed(env, "ZAMA_RELAYER_URL")),
    fromBlock: parseFromBlock(trimmed(env, "FROM_BLOCK")),
  };
};
