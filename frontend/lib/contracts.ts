// Chains, deployments and explorer links.
//
// Supported: Ethereum mainnet (1), Sepolia (11155111), and a local Anvil
// (31337) only when NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1. Nothing else: the
// contract inherits ZamaEthereumConfig, which reverts on any other chain.
//
// Next.js inlines NEXT_PUBLIC_* variables only where it can see them
// statically, so every lookup below is spelled out per chain — a computed
// `process.env[...]` reads as undefined in the client bundle.

import { mainnet, sepolia } from "viem/chains";
import type { Chain } from "viem";
import { deploymentFor, previousDeploymentsFor, type Address } from "./deployments";

export type { Address };

export const MAINNET_ID = 1;
export const SEPOLIA_ID = 11155111;
export const ANVIL_ID = 31337;

export const LOCAL_CHAIN_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === "1";

const ENV_RPC: Record<number, string | undefined> = {
  [MAINNET_ID]: process.env.NEXT_PUBLIC_RPC_URL_1,
  [SEPOLIA_ID]: process.env.NEXT_PUBLIC_RPC_URL_11155111,
  [ANVIL_ID]: process.env.NEXT_PUBLIC_RPC_URL_31337,
};

export const anvil: Chain = {
  id: ANVIL_ID,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ENV_RPC[ANVIL_ID]?.trim() || "http://127.0.0.1:8545"] } },
  testnet: true,
};

/** Every chain this build may talk to, in display order. */
export const ALL_CHAINS: readonly Chain[] = LOCAL_CHAIN_ENABLED ? [mainnet, sepolia, anvil] : [mainnet, sepolia];

export const isSupportedChainId = (chainId: number | undefined | null): boolean =>
  !!chainId && ALL_CHAINS.some((c) => c.id === chainId);

// ---------- deployments ----------

const ENV_ADDRESS: Record<number, string | undefined> = {
  [MAINNET_ID]: process.env.NEXT_PUBLIC_CONTRACT_1,
  [SEPOLIA_ID]: process.env.NEXT_PUBLIC_CONTRACT_11155111,
  [ANVIL_ID]: process.env.NEXT_PUBLIC_CONTRACT_31337,
};

/**
 * The current DeadManSwitch deployment on a chain, the one new switches are
 * created on, or undefined (also for unsupported chains):
 * NEXT_PUBLIC_CONTRACT_<chainId>, else the address compiled in
 * (lib/deployments.ts HARDCODED_CONTRACTS). The relayer proxy resolves its
 * allowed contract with the same rule.
 */
export const contractFor = (chainId: number): Address | undefined => {
  if (!isSupportedChainId(chainId)) return undefined;
  return deploymentFor(chainId, ENV_ADDRESS[chainId]);
};

const ENV_PREVIOUS: Record<number, string | undefined> = {
  [MAINNET_ID]: process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_1,
  [SEPOLIA_ID]: process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111,
  [ANVIL_ID]: process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_31337,
};

/** A DeadManSwitch deployment this app knows on a chain. */
export interface Deployment {
  address: Address;
  /** Its deploy block: its SwitchCreated and PlaintextPublished scans start here. */
  fromBlock: bigint;
  /**
   * The one new switches are created on. The others are previous deployments,
   * kept so that their switches can still be found, pinged, cancelled, topped
   * up, released and reclaimed.
   */
  current: boolean;
}

const deploymentsMemo = new Map<number, readonly Deployment[]>();

/**
 * Every deployment of a chain, current first, then the previous ones
 * (NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>, `<address>:<deploy block>,…`,
 * then lib/deployments.json `previousContracts`). A chain whose current
 * deployment was removed keeps its previous ones: their switches must stay
 * reachable (an owner who cannot ping has the secret released); only creates
 * need a current deployment. Empty for an unsupported chain.
 */
export const deploymentsFor = (chainId: number): readonly Deployment[] => {
  const memo = deploymentsMemo.get(chainId);
  if (memo) return memo;
  const current = contractFor(chainId);
  const list: readonly Deployment[] = isSupportedChainId(chainId)
    ? [
      ...(current ? [{ address: current, fromBlock: fromBlockFor(chainId), current: true }] : []),
      ...previousDeploymentsFor(chainId, ENV_PREVIOUS[chainId], current).map((d) => ({ ...d, current: false })),
    ]
    : [];
  deploymentsMemo.set(chainId, list);
  return list;
};

/**
 * The deployment at `address` on `chainId` (any case), or undefined. A
 * contract this app does not know (a link or handle naming another address)
 * is never read from or written to.
 */
export const deploymentOf = (chainId: number, address: string | null | undefined): Deployment | undefined => {
  if (!address) return undefined;
  const a = address.toLowerCase();
  return deploymentsFor(chainId).find((d) => d.address.toLowerCase() === a);
};

/** `address` is a previous (not the current) deployment on `chainId`. */
export const isPreviousDeployment = (chainId: number, address: string | null | undefined): boolean =>
  deploymentOf(chainId, address)?.current === false;

/**
 * The chain has a deployment, current or previous. (Not via deploymentsFor:
 * supportedChains runs at module load, before fromBlockFor is defined.)
 */
export const hasDeployment = (chainId: number): boolean =>
  !!contractFor(chainId) || (isSupportedChainId(chainId) && previousDeploymentsFor(chainId, ENV_PREVIOUS[chainId], undefined).length > 0);

/**
 * Chains offered to wallets: the supported chains that have a deployment,
 * current or previous. When none is configured (fresh checkout) every
 * supported chain is listed so the app still renders; pages then show "not
 * deployed on this network".
 */
export const supportedChains: readonly [Chain, ...Chain[]] = (() => {
  const deployed = ALL_CHAINS.filter((c) => hasDeployment(c.id));
  const list = deployed.length ? deployed : ALL_CHAINS;
  return [list[0]!, ...list.slice(1)] as const;
})();

/**
 * First chain with a deployment, for anonymous (wallet-less) browsing, and its
 * current deployment (null when only previous ones are left: no creates).
 */
export const defaultReadChain = (): { id: number; address: Address | null } | null => {
  for (const c of supportedChains) {
    if (hasDeployment(c.id)) return { id: c.id, address: contractFor(c.id) ?? null };
  }
  return null;
};

export const chainById = (chainId: number): Chain | undefined => ALL_CHAINS.find((c) => c.id === chainId);

export const chainLabel = (chainId: number): string => chainById(chainId)?.name ?? `chain ${chainId}`;

/**
 * JSON-RPC URL for reads and for the FHE SDK's host-chain calls.
 * NEXT_PUBLIC_RPC_URL_<chainId> overrides the chain default. `next build`
 * requires it for every public chain with a deployment (next.config.js): the
 * defaults cap eth_getLogs spans (Sepolia's, sepolia.drpc.org's free plan, at
 * 101 blocks) or prune old logs, which makes the first switch scan take minutes.
 */
export const rpcUrlFor = (chainId: number): string | undefined => {
  const env = ENV_RPC[chainId]?.trim();
  if (env) return env;
  return chainById(chainId)?.rpcUrls.default.http[0];
};

/**
 * viem client batching for every read client. Concurrent contract reads (the
 * hunt / archive lists re-read getSwitchInfo for every switch) go out as
 * Multicall3 aggregate3 calls. viem's default batch is 1,024 calldata bytes,
 * 15 getSwitchInfo per eth_call; 8 KiB is ~120 (about 3M gas, far under node
 * eth_call gas caps). `wait`: react-query re-arms each switch's 15 s interval
 * when that switch's own result is processed, so after the first fetch the
 * reads of one poll start a few ms apart; with viem's default 0 ms window each
 * poll split into many small multicalls. A read waits at most this long for
 * others to join. Chains without Multicall3 in their viem definition (the
 * local Anvil) fall back to plain eth_calls.
 */
export const RPC_BATCH = { multicall: { batchSize: 8_192, wait: 32 } } as const;

// ---------- log scanning ----------

const ENV_FROM_BLOCK: Record<number, string | undefined> = {
  [MAINNET_ID]: process.env.NEXT_PUBLIC_FROM_BLOCK_1,
  [SEPOLIA_ID]: process.env.NEXT_PUBLIC_FROM_BLOCK_11155111,
  [ANVIL_ID]: process.env.NEXT_PUBLIC_FROM_BLOCK_31337,
};
const FROM_BLOCK_FALLBACK: Record<number, bigint> = {};

/**
 * First block of SwitchCreated scans. Set NEXT_PUBLIC_FROM_BLOCK_<chainId> to
 * the deploy block — without it the scan starts at 0 and issues thousands of
 * eth_getLogs calls on mainnet/Sepolia.
 */
export const fromBlockFor = (chainId: number): bigint => {
  const v = ENV_FROM_BLOCK[chainId]?.trim();
  if (v && /^\d+$/.test(v)) return BigInt(v);
  return FROM_BLOCK_FALLBACK[chainId] ?? 0n;
};

/** The deploy block of the deployment at `address` (deploymentsFor); fromBlockFor(chainId) for an address it does not list. */
export const fromBlockOf = (chainId: number, address: string): bigint =>
  deploymentOf(chainId, address)?.fromBlock ?? fromBlockFor(chainId);

const LOGS_RANGE_CAP_ENV = process.env.NEXT_PUBLIC_LOGS_RANGE_CAP?.trim();
const LOGS_RANGE_CAP_DEFAULT = 5_000n;
const LOGS_RANGE_CAP_OVERRIDES: Record<number, bigint> = { [ANVIL_ID]: 1_000_000n };

/** Max blocks per eth_getLogs call. NEXT_PUBLIC_LOGS_RANGE_CAP overrides the public-chain default. */
export const logsRangeCapFor = (chainId: number): bigint => {
  if (LOGS_RANGE_CAP_OVERRIDES[chainId]) return LOGS_RANGE_CAP_OVERRIDES[chainId]!;
  if (LOGS_RANGE_CAP_ENV && /^\d+$/.test(LOGS_RANGE_CAP_ENV) && BigInt(LOGS_RANGE_CAP_ENV) > 0n) {
    return BigInt(LOGS_RANGE_CAP_ENV);
  }
  return LOGS_RANGE_CAP_DEFAULT;
};

// ---------- explorers ----------

const EXPLORER: Record<number, string> = {
  [MAINNET_ID]: "https://etherscan.io",
  [SEPOLIA_ID]: "https://sepolia.etherscan.io",
};

/** Etherscan link for a transaction, or undefined on chains without an explorer (Anvil). */
export const explorerTx = (chainId: number, hash: string): string | undefined =>
  EXPLORER[chainId] ? `${EXPLORER[chainId]}/tx/${hash}` : undefined;

/** Etherscan link for an address, or undefined on chains without an explorer (Anvil). */
export const explorerAddress = (chainId: number, addr: string): string | undefined =>
  EXPLORER[chainId] ? `${EXPLORER[chainId]}/address/${addr}` : undefined;
