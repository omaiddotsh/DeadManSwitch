// Data layer: every chain read goes through react-query (one request per
// distinct key, however many cards render it), every write through a small
// submit → wait-for-receipt → invalidate lifecycle, and the two FHE flows
// (create: seal + encrypt DEK; reveal: KMS public decrypt + verify) are
// wrapped in hooks with progress state.

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueries, useQueryClient, type QueryClient, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";
import {
  createPublicClient, encodeFunctionData, http, keccak256, parseEventLogs, toBytes,
  type ContractEventName, type Hex, type PublicClient, type TransactionReceipt,
} from "viem";
import { dmsAbi } from "./abi";
import {
  ANVIL_ID, RPC_BATCH, chainById, chainLabel, contractFor, defaultReadChain, deploymentOf, deploymentsFor, fromBlockOf,
  isSupportedChainId, logsRangeCapFor, rpcUrlFor,
  type Address, type Deployment,
} from "./contracts";
import {
  attemptKey, classifyAttempt, createAttemptStore, createdFor, deriveCreateView, dropAttempt, errorTitle, isInFlight,
  pollStep, recordCreated, runCreate, startNewSession, submitBlock,
  type AttemptObservation, type AttemptOutcome, type CreateAttempt, type CreateStage, type CreatedSwitch, type SubmitBlock,
} from "./createAttempt";
import { checkKey, seal, type KeyCheck } from "./envelope";
import { WouldRevertError, dmsWriteAbi, errMsg, isUserRejection, mayHaveBroadcast, revertErrorName, revertReason } from "./errors";
import {
  WriteDetachedError, WriteInFlightError, WriteUnconfirmedError, createPendingWriteStore, createWriteWatchers, isValueCarrying, writeKey,
  type PendingWrite, type PendingWriteStore, type WriteCall, type WriteFn, type WriteTarget,
} from "./pendingWrites";
import {
  createScanStore, findPublishedPlaintext, newestFirst, switchKeyOf, syncSwitchScan, type PublishedPlaintext, type ScanState,
} from "./switchScan";
import {
  FhevmError, encryptDek, getFheKeyStatus, publicDecryptDek, subscribeFheKeyStatus,
  type FheKeyStatus, type FhevmProgress,
} from "./fhevm";
import {
  ZERO_ADDRESS, ZERO_BYTES32, isTerminal, randomSwitchId, toSwitchInfo,
  type RawSwitchInfo, type SwitchHandle, type SwitchInfo, type SwitchState,
} from "./switch";

export { errMsg };
export type { AttemptOutcome, CreateAttempt, CreateStage, CreatedSwitch, SubmitBlock };

// ---------- query keys ----------

const lc = (a: string | null | undefined) => (a ? a.toLowerCase() : null);

/** Query-key factory. Invalidate `dmsKeys.switch(...)` to refresh everything about one switch. */
export const dmsKeys = {
  chain: (chainId: number) => ["dms", chainId] as const,
  contract: (chainId: number, contract: string | null | undefined) => ["dms", chainId, lc(contract)] as const,
  config: (chainId: number, contract: string | null | undefined) => [...dmsKeys.contract(chainId, contract), "config"] as const,
  switches: (chainId: number, contract: string | null | undefined) => [...dmsKeys.contract(chainId, contract), "switches"] as const,
  switch: (chainId: number, h: SwitchHandle) =>
    [...dmsKeys.contract(chainId, h.contractAddr), "switch", h.owner.toLowerCase(), h.id.toString()] as const,
  info: (chainId: number, h: SwitchHandle) => [...dmsKeys.switch(chainId, h), "info"] as const,
  ciphertext: (chainId: number, h: SwitchHandle) => [...dmsKeys.switch(chainId, h), "ciphertext"] as const,
  revealedKey: (chainId: number, h: SwitchHandle) => [...dmsKeys.switch(chainId, h), "revealedKey"] as const,
  revealedSecret: (chainId: number, h: SwitchHandle) => [...dmsKeys.switch(chainId, h), "revealedSecret"] as const,
  published: (chainId: number, h: SwitchHandle) => [...dmsKeys.switch(chainId, h), "published"] as const,
  funderStake: (chainId: number, h: SwitchHandle, funder: string) =>
    [...dmsKeys.switch(chainId, h), "funderStake", funder.toLowerCase()] as const,
  chainTime: (chainId: number) => ["chainTime", chainId] as const,
};

// ---------- chain / client selection ----------

export interface EffectiveChain {
  chainId: number;
  /** DeadManSwitch on that chain, or null (not deployed / unsupported chain). */
  address: Address | null;
  isConnected: boolean;
  /** One of 1 / 11155111 / (31337 when enabled). */
  isSupported: boolean;
}

/**
 * Pins every hook below it to one chain, whatever the wallet is connected to.
 * Used by the switch page, whose URL names the chain: without it a visitor
 * whose wallet (or default read chain) differs would read the route's
 * contract address through another chain's RPC. Writes still go through the
 * wallet, and wagmi refuses them while the wallet is on another chain.
 */
const ChainScopeContext = createContext<number | null>(null);
export const ChainScope = ChainScopeContext.Provider;

/**
 * The scoped chain (see ChainScope) if any; else the wallet chain when
 * connected; else the first deployed chain for read-only browsing.
 */
export const useEffectiveChain = (): EffectiveChain => {
  const { isConnected } = useAccount();
  const activeChainId = useChainId();
  const scoped = useContext(ChainScopeContext);
  return useMemo(() => {
    if (scoped !== null) {
      return {
        chainId: scoped,
        address: contractFor(scoped) ?? null,
        isConnected,
        isSupported: isSupportedChainId(scoped),
      };
    }
    if (isConnected) {
      return {
        chainId: activeChainId,
        address: contractFor(activeChainId) ?? null,
        isConnected,
        isSupported: isSupportedChainId(activeChainId),
      };
    }
    const def = defaultReadChain();
    return def
      ? { chainId: def.id, address: def.address, isConnected, isSupported: true }
      : { chainId: 0, address: null, isConnected, isSupported: false };
  }, [isConnected, activeChainId, scoped]);
};

/**
 * Read client for one chain: wagmi's when configured, else a plain viem client
 * on rpcUrlFor(chainId). Both hooks are called unconditionally so the hook
 * count never changes between renders.
 */
const usePublicClientFor = (chainId: number): PublicClient | null => {
  const wagmiClient = usePublicClient({ chainId: chainId || undefined });
  return useMemo<PublicClient | null>(() => {
    if (wagmiClient) return wagmiClient as unknown as PublicClient;
    const chain = chainId ? chainById(chainId) : undefined;
    if (!chain) return null;
    return createPublicClient({ chain, transport: http(rpcUrlFor(chainId)), batch: RPC_BATCH }) as PublicClient;
  }, [wagmiClient, chainId]);
};

/** Read client for the effective chain. */
export const useEffectivePublicClient = (): PublicClient | null => usePublicClientFor(useEffectiveChain().chainId);

export const useContractAddress = (): Address | null => useEffectiveChain().address;

export const useConnectedAccount = () => {
  const { address, isConnected } = useAccount();
  return { address, isConnected };
};

// ---------- chain clock ----------

// Clock second as an external store: render reads the snapshot instead of
// reading a clock (impure during render; react-hooks/purity).
let secondTimer: ReturnType<typeof setInterval> | null = null;
let wallSec = 0;
const secondListeners = new Set<() => void>();
/**
 * The clock the chain clock interpolates on: the wall clock. It keeps running
 * while the device sleeps (performance.now() does not, on many devices: after
 * an hour asleep the chain clock would be an hour behind until the next poll,
 * showing a switch that went dark meanwhile as alive). A step of the wall
 * clock is corrected at the next poll (nextChainClock, CLOCK_HOLD_SECONDS).
 */
export const chainClockMs = (): number => Date.now();
const readWallSec = () => Math.floor(chainClockMs() / 1000);
const subscribeSecondTicker = (l: () => void) => {
  secondListeners.add(l);
  if (!secondTimer) {
    wallSec = readWallSec();
    secondTimer = setInterval(() => {
      wallSec = readWallSec();
      for (const f of secondListeners) f();
    }, 1000);
  }
  return () => {
    secondListeners.delete(l);
    if (secondListeners.size === 0 && secondTimer) { clearInterval(secondTimer); secondTimer = null; }
  };
};
const getWallSec = () => wallSec;
const getServerWallSec = () => 0;

/** A block timestamp and the time it was read (chainClockMs): the chain clock's anchor. */
export interface ChainClock {
  timestamp: bigint;
  fetchedAtMs: number;
}

/**
 * How far behind the clock's estimate a newly read block may be and still be
 * taken for a late or missed slot (the anchor is kept): three slots. Further
 * behind, the estimate itself is wrong (the device clock stepped, the chain
 * stalled), and the clock re-anchors on the block.
 */
export const CLOCK_HOLD_SECONDS = 36n;

/** Chain time at wall second `wallSec`, interpolated from the anchor. */
export const chainNowSec = (c: ChainClock, wallSec: number): bigint =>
  c.timestamp + BigInt(Math.max(0, wallSec - Math.floor(c.fetchedAtMs / 1000)));

/**
 * The anchor after a poll read `blockTimestamp` at `nowMs`. A poll that still
 * sees an older block than the clock has already counted to (the next block
 * reaches the RPC a few seconds after its slot, or a slot was missed) keeps
 * the previous anchor: re-anchoring on it would turn the countdown back, and
 * a switch would flip from dark back to alive (with its Ping button) for a
 * slot. Interpolating from the earlier anchor stays at or below the next
 * block's timestamp, since slots tick with real time. A block more than
 * CLOCK_HOLD_SECONDS behind the estimate means the estimate is off: re-anchor.
 */
export const nextChainClock = (prev: ChainClock | undefined, blockTimestamp: bigint, nowMs: number): ChainClock => {
  if (prev) {
    const estimate = chainNowSec(prev, Math.floor(nowMs / 1000));
    if (blockTimestamp < estimate && estimate - blockTimestamp < CLOCK_HOLD_SECONDS) return prev;
  }
  return { timestamp: blockTimestamp, fetchedAtMs: nowMs };
};

/**
 * Latest block timestamp, shared by every consumer on the chain. Liveness
 * decisions use this, not Date.now(), so the UI agrees with the contract.
 * `nowSec` is interpolated between polls (anchored to the last block), and
 * never runs backwards (nextChainClock).
 */
export const useChainTime = () => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: dmsKeys.chainTime(chainId),
    enabled: !!client && !!chainId,
    refetchInterval: 12_000,
    staleTime: 6_000,
    queryFn: async (): Promise<ChainClock> => {
      const block = await client!.getBlock();
      return nextChainClock(queryClient.getQueryData<ChainClock>(dmsKeys.chainTime(chainId)), block.timestamp, chainClockMs());
    },
  });

  // Re-render once a second so countdowns tick (one shared timer for all consumers).
  const nowWall = useSyncExternalStore(subscribeSecondTicker, getWallSec, getServerWallSec);

  const nowSec = useMemo(() => {
    if (!query.data || nowWall === 0) return null;
    return chainNowSec(query.data, nowWall);
  }, [query.data, nowWall]);

  return { nowSec, blockTimestamp: query.data?.timestamp ?? null, isLoading: query.isLoading };
};

// ---------- contract config: admin, minBounty, oracle ----------

export interface ContractConfig {
  admin: Address;
  pendingAdmin: Address;
  /** Admin renounced: minBountyUsd is fixed forever. */
  adminRenounced: boolean;
  /** Configured floor, USD with 8 decimals. 0 = disabled. */
  minBountyUsd: bigint;
  /** Current floor in wei (0 when disabled OR when the oracle is unusable — fails open). */
  minBounty: bigint;
  ethUsdPriceFeed: Address;
  maxPriceAge: bigint;
  /** oraclePrice(): usable answer and raw value in feed decimals. */
  oracleOk: boolean;
  oraclePrice: bigint;
  feedDecimals: number | null;
  /** ETH/USD for display; null when the oracle is unusable or absent. */
  ethUsd: number | null;
  /** A floor is configured but the oracle is down, so minBounty() is 0 right now. */
  oracleDown: boolean;
}

const feedDecimalsAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/** All contract-level parameters in one query, refreshed every 30 s (oracle price moves). */
export const useContractConfig = (): UseQueryResult<ContractConfig> => {
  const { chainId } = useEffectiveChain();
  const contract = useContractAddress();
  const client = useEffectivePublicClient();
  return useQuery({
    queryKey: dmsKeys.config(chainId, contract),
    enabled: !!client && !!contract,
    staleTime: 20_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ContractConfig> => {
      const c = client!;
      const address = contract!;
      const [admin, pendingAdmin, minBountyUsd, minBounty, feed, maxPriceAge, oracle] = await Promise.all([
        c.readContract({ address, abi: dmsAbi, functionName: "admin" }),
        c.readContract({ address, abi: dmsAbi, functionName: "pendingAdmin" }),
        c.readContract({ address, abi: dmsAbi, functionName: "minBountyUsd" }),
        c.readContract({ address, abi: dmsAbi, functionName: "minBounty" }),
        c.readContract({ address, abi: dmsAbi, functionName: "ethUsdPriceFeed" }),
        c.readContract({ address, abi: dmsAbi, functionName: "maxPriceAge" }),
        c.readContract({ address, abi: dmsAbi, functionName: "oraclePrice" }),
      ]);
      const [oracleOk, oraclePrice] = oracle;
      let feedDecimals: number | null = null;
      if (feed.toLowerCase() !== ZERO_ADDRESS) {
        try {
          feedDecimals = Number(await c.readContract({ address: feed, abi: feedDecimalsAbi, functionName: "decimals" }));
        } catch { /* feed without code */ }
      }
      const ethUsd = oracleOk && feedDecimals !== null ? Number(oraclePrice) / 10 ** feedDecimals : null;
      return {
        admin, pendingAdmin, adminRenounced: admin.toLowerCase() === ZERO_ADDRESS,
        minBountyUsd, minBounty, ethUsdPriceFeed: feed, maxPriceAge,
        oracleOk, oraclePrice, feedDecimals, ethUsd,
        oracleDown: minBountyUsd > 0n && !oracleOk,
      };
    },
  });
};

/** Current minimum bounty in wei (null while loading). */
export const useMinBounty = (): { minBounty: bigint | null; minBountyUsd: bigint | null; oracleDown: boolean; isLoading: boolean } => {
  const { data, isLoading } = useContractConfig();
  return {
    minBounty: data?.minBounty ?? null,
    minBountyUsd: data?.minBountyUsd ?? null,
    oracleDown: data?.oracleDown ?? false,
    isLoading,
  };
};

export const useOraclePrice = (): { ok: boolean; price: bigint | null; decimals: number | null; ethUsd: number | null } => {
  const { data } = useContractConfig();
  return { ok: data?.oracleOk ?? false, price: data?.oraclePrice ?? null, decimals: data?.feedDecimals ?? null, ethUsd: data?.ethUsd ?? null };
};

export const useIsAdmin = (): boolean => {
  const { address } = useAccount();
  const { data } = useContractConfig();
  return !!address && !!data && address.toLowerCase() === data.admin.toLowerCase();
};

export const useIsPendingAdmin = (): boolean => {
  const { address } = useAccount();
  const { data } = useContractConfig();
  return !!address && !!data && address.toLowerCase() === data.pendingAdmin.toLowerCase();
};

// ---------- switch discovery (SwitchCreated logs) ----------

export { scanSwitchCreated, type SwitchListing } from "./switchScan";

/** The last scan per (chain, contract), shared by every list. */
const scanStore = createScanStore(
  () => (typeof window === "undefined" ? null : window.localStorage),
  (chainId) => chainId !== ANVIL_ID,
);

/** The scans of a chain's deployments, as one value that stays the same object while none of them changed (useQueries' combine). */
const combineScans = (rs: UseQueryResult<ScanState>[]) => ({
  scans: rs.map((r) => r.data),
  loading: rs.map((r) => r.isLoading),
  errors: rs.map((r) => r.error),
  refetchers: rs.map((r) => r.refetch),
});
/** -1 while hydrating (and on the server): the stored scan is read only after hydration, so both render the same markup. */
const getServerScanVersion = () => -1;

/**
 * All switches on the chain's deployments, current and previous (newest
 * first), optionally narrowed to one owner. Each item's `contractAddr` is its
 * deployment. One shared, incremental scan per (chain, contract)
 * (lib/switchScan.ts): a refetch scans only blocks since the last scan, plus
 * a reorg margin. Set NEXT_PUBLIC_FROM_BLOCK_<chainId> to the deploy block.
 *
 * While a scan has no result yet, `switches` holds what it found so far (and
 * the last visit's stored scan), and `loading` stays true until every scan
 * finished: a list shows found switches early, but says "none" only once it
 * knows. `progress` counts the blocks the running scans covered.
 */
export const useSwitches = (filterOwner?: Address | null) => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const deployments = useMemo(() => deploymentsFor(chainId), [chainId]);
  const contract = deployments.find((d) => d.current)?.address ?? null;

  const { scans, loading, errors, refetchers } = useQueries({
    queries: deployments.map((d) => ({
      queryKey: dmsKeys.switches(chainId, d.address),
      enabled: !!client && !!chainId,
      staleTime: 30_000,
      refetchInterval: 60_000,
      queryFn: (): Promise<ScanState> => syncSwitchScan(client!, {
        chainId, contract: d.address, fromBlock: d.fromBlock, rangeCap: logsRangeCapFor(chainId),
      }, scanStore),
    })),
    combine: combineScans,
  });
  const stored = useSyncExternalStore(scanStore.subscribe, scanStore.version, getServerScanVersion);

  const { switches, progress } = useMemo(() => {
    /** A scan with no result yet: what it found so far, or the last visit's. */
    const partial = (d: Deployment) => (stored >= 0 ? scanStore.get(chainId, d.address, d.fromBlock) : null);
    const all = newestFirst(deployments.flatMap((d, i) => (scans[i] ?? partial(d))?.items ?? []));
    const want = filterOwner?.toLowerCase();
    let done = 0n;
    let total = 0n;
    deployments.forEach((d, i) => {
      const run = loading[i] ? partial(d) : null;
      if (!run?.scanning) return;
      const { from, to } = run.scanning;
      total += to - from + 1n;
      if (run.scannedTo >= from) done += run.scannedTo - from + 1n;
    });
    return {
      switches: want ? all.filter((s) => s.owner.toLowerCase() === want) : all,
      progress: total > 0n ? { done, total } : null,
    };
  }, [chainId, deployments, scans, loading, stored, filterOwner]);
  const error = errors.find((e) => !!e);

  return {
    switches,
    loading: loading.some(Boolean),
    error: error ? errMsg(error) : null,
    /** Blocks scanned / to scan by the scans still running, or null. */
    progress,
    refetch: () => Promise.all(refetchers.map((r) => r())),
    chainId,
    /** The current deployment (creates go there). */
    contractAddress: contract,
  };
};

/** Switches created by `owner` (dashboard). Shares the scan with useSwitches. */
export const useOwnerSwitches = (owner: Address | null | undefined) => useSwitches(owner ?? ZERO_ADDRESS);

// ---------- per-switch reads ----------

/**
 * After a write of this tab is mined in block B, reads of its switch are made
 * at a block no older than B for READ_FLOOR_MS: a load-balanced RPC can answer
 * a "latest" read from a node behind the one that served the receipt, and the
 * page would offer the action just done again (markDark, revealKey, a
 * reclaim) or keep showing the old stake or deadline until the next poll.
 */
export const READ_FLOOR_MS = 2 * 60_000;
const readFloors = new Map<string, { block: bigint; until: number }>();
const floorKey = (chainId: number | undefined, h: SwitchHandle) =>
  `${chainId}:${h.contractAddr.toLowerCase()}:${h.owner.toLowerCase()}:${h.id}`;

/** Record that a write of switch `h` was mined in `block` (refreshAfterWrite does, from the receipt). */
export const noteWriteMined = (chainId: number, h: SwitchHandle, block: bigint): void => {
  const k = floorKey(chainId, h);
  const prev = readFloors.get(k);
  readFloors.set(k, { block: prev && prev.block > block ? prev.block : block, until: Date.now() + READ_FLOOR_MS });
};

/** The block a read of `h` must not be older than, if a write of it was mined lately. */
const readFloor = (client: PublicClient, h: SwitchHandle): bigint | undefined => {
  const k = floorKey(client.chain?.id, h);
  const f = readFloors.get(k);
  if (!f) return undefined;
  if (Date.now() > f.until) { readFloors.delete(k); return undefined; }
  return f.block;
};

/** The block to read `h` at: "latest", or max(head, floor) while a floor holds. */
const readBlockFor = async (client: PublicClient, h: SwitchHandle): Promise<bigint | undefined> => {
  const floor = readFloor(client, h);
  if (floor === undefined) return undefined;
  const head = await client.getBlockNumber({ cacheTime: 0 });
  return head > floor ? head : floor;
};

/** getSwitchInfo, at `blockNumber`, else at a block no older than a recent write's receipt (noteWriteMined), else latest. */
export const readSwitchInfo = async (client: PublicClient, h: SwitchHandle, blockNumber?: bigint): Promise<SwitchInfo> => {
  const raw = await client.readContract({
    address: h.contractAddr, abi: dmsAbi, functionName: "getSwitchInfo", args: [h.owner, h.id],
    blockNumber: blockNumber ?? await readBlockFor(client, h),
  });
  return toSwitchInfo(raw as unknown as RawSwitchInfo);
};

/** A funder's stake on `h`, read like readSwitchInfo (at a block no older than a recent write's receipt). */
export const readFunderStake = async (client: PublicClient, h: SwitchHandle, funder: Address): Promise<bigint> =>
  client.readContract({
    address: h.contractAddr, abi: dmsAbi, functionName: "getFunderStake", args: [h.owner, h.id, funder],
    blockNumber: await readBlockFor(client, h),
  });

/**
 * getSwitchInfo at a block no older than the head this RPC reports, nor than
 * `minBlock` (a receipt's block). A load-balanced RPC can answer a "latest"
 * read from a node behind the one that served the receipt; a read at an
 * explicit block number is answered as of that block, or fails.
 */
const readSwitchInfoFresh = async (client: PublicClient, h: SwitchHandle, minBlock?: bigint): Promise<SwitchInfo> => {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  return readSwitchInfo(client, h, minBlock !== undefined && minBlock > head ? minBlock : head);
};

/**
 * How often a switch's getSwitchInfo is re-read. A cancelled or revealed
 * switch can only see a funder reclaim (bounty) or a publish (published), so
 * the lists, which poll every switch ever created, re-read those every 5
 * minutes. A write in this page still refreshes it at once (invalidation).
 */
export const switchInfoPollMs = (info: SwitchInfo | undefined): number =>
  info && isTerminal(info.state) ? 5 * 60_000 : 15_000;

export const useSwitchInfo = (handle: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const query = useQuery({
    queryKey: handle ? dmsKeys.info(chainId, handle) : ["dms", "idle", "info"],
    enabled: !!client && !!handle,
    refetchInterval: (q) => switchInfoPollMs(q.state.data),
    staleTime: 8_000,
    queryFn: () => readSwitchInfo(client!, handle!),
  });
  return {
    info: query.data ?? null,
    error: query.error ? errMsg(query.error) : null,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
};

/** Batch variant for lists; shares cache entries with useSwitchInfo. */
export const useSwitchInfos = (handles: SwitchHandle[]) => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const results = useQueries({
    queries: handles.map((h) => ({
      queryKey: dmsKeys.info(chainId, h),
      enabled: !!client,
      refetchInterval: (q: { state: { data?: SwitchInfo } }) => switchInfoPollMs(q.state.data),
      staleTime: 8_000,
      queryFn: () => readSwitchInfo(client!, h),
    })),
  });
  return useMemo(
    () => handles.map((handle, i) => ({
      handle,
      info: results[i]?.data ?? null,
      isLoading: results[i]?.isLoading ?? true,
      // A failed read with no data must not read as "no such switch" in a list.
      error: results[i]?.error ? errMsg(results[i].error) : null,
      refetch: results[i]?.refetch,
    })),
    [handles, results],
  );
};

/**
 * Switch (`owner`, `id`) on every deployment of the chain, current first: what
 * a switch link that names no contract may mean. One row per deployment, with
 * its getSwitchInfo (shared with useSwitchInfo).
 */
export const useSwitchOnDeployments = (owner: Address, id: bigint) => {
  const { chainId } = useEffectiveChain();
  const deployments = useMemo(() => deploymentsFor(chainId), [chainId]);
  const handles = useMemo(() => deployments.map((d) => ({ contractAddr: d.address, owner, id })), [deployments, owner, id]);
  const rows = useSwitchInfos(handles);
  return useMemo(() => rows.map((r, i) => ({ ...r, deployment: deployments[i]! })), [rows, deployments]);
};

/** The stored v1 ciphertext (immutable once created). */
export const useCiphertext = (handle: SwitchHandle | null, enabled = true) => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  return useQuery({
    queryKey: handle ? dmsKeys.ciphertext(chainId, handle) : ["dms", "idle", "ciphertext"],
    enabled: !!client && !!handle && enabled,
    staleTime: Infinity,
    queryFn: () => client!.readContract({
      address: handle!.contractAddr, abi: dmsAbi, functionName: "getCiphertext", args: [handle!.owner, handle!.id],
    }),
  });
};

/** The DEK once revealed (zero bytes32 → null). */
export const useRevealedKey = (handle: SwitchHandle | null, enabled = true) => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  return useQuery({
    queryKey: handle ? dmsKeys.revealedKey(chainId, handle) : ["dms", "idle", "revealedKey"],
    enabled: !!client && !!handle && enabled,
    staleTime: 15_000,
    queryFn: async () => {
      const k = await client!.readContract({
        address: handle!.contractAddr, abi: dmsAbi, functionName: "getRevealedKey", args: [handle!.owner, handle!.id],
      });
      return k === ZERO_BYTES32 ? null : k;
    },
  });
};

/**
 * The query behind useFunderStake. Every change of a funder's stake (a
 * top-up or reclaim from the CLI, another tab or device) moves the switch's
 * bounty, or its state once revealed, so the switch's info is part of the
 * key: the stake is read again as soon as the info poll sees the switch move,
 * not up to a minute later next to a bounty that already did (a stale
 * "Reclaim" would send a transaction that can only revert). Meanwhile the
 * previous figure of the same funder stays shown, never another account's.
 * Also re-read every minute: windows are not refocused (refetchOnWindowFocus is off).
 */
export const funderStakeQuery = (
  client: PublicClient | null, chainId: number, handle: SwitchHandle | null, funder: Address | null | undefined, info: SwitchInfo | null,
) => {
  const own = handle && funder ? dmsKeys.funderStake(chainId, handle, funder) : null;
  const sameFunder = (key: QueryKey) => !!own && own.every((part, i) => key[i] === part);
  return {
    queryKey: own ? [...own, info ? `${info.stateCode}:${info.bounty}` : null] : ["dms", "idle", "funderStake"],
    enabled: !!client && !!own,
    staleTime: 15_000,
    refetchInterval: 60_000,
    placeholderData: (previous: bigint | undefined, previousQuery?: { queryKey: QueryKey }) =>
      previousQuery && sameFunder(previousQuery.queryKey) ? previous : undefined,
    queryFn: () => readFunderStake(client!, handle!, funder!),
  };
};

/** A funder's reclaimable contribution (0 once revealed), re-read whenever the switch moves (funderStakeQuery). */
export const useFunderStake = (handle: SwitchHandle | null, funder: Address | null | undefined) => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const { info } = useSwitchInfo(handle);
  return useQuery(funderStakeQuery(client, chainId, handle, funder, info));
};

/**
 * For a REVEALED switch: read ciphertext + revealed key from chain state and
 * decrypt locally. The result's plaintext is attacker-controlled — render it
 * only as text (envelope.toDisplayText). status "invalid-key" means the
 * KMS-verified key does not open the ciphertext: show `warning`.
 */
export const useRevealedSecret = (handle: SwitchHandle | null, info: SwitchInfo | null) => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const revealed = info?.state === "revealed" && info.revealedKey !== ZERO_BYTES32;
  return useQuery({
    queryKey: handle ? dmsKeys.revealedSecret(chainId, handle) : ["dms", "idle", "revealedSecret"],
    enabled: !!client && !!handle && !!info && revealed,
    staleTime: Infinity,
    queryFn: async (): Promise<KeyCheck> => {
      const ct = await client!.readContract({
        address: handle!.contractAddr, abi: dmsAbi, functionName: "getCiphertext", args: [handle!.owner, handle!.id],
      });
      return checkKey(info!.revealedKey, ct, info!.plaintextCommitment);
    },
  });
};

export type { PublishedPlaintext } from "./switchScan";

/**
 * The PlaintextPublished event for a switch (emitted, not stored), when
 * `info.published` (lib/switchScan.ts findPublishedPlaintext). The payload is
 * attacker-controlled bytes; the contract verified it against the commitment,
 * which says nothing about its content.
 */
export const usePublishedPlaintext = (handle: SwitchHandle | null, info: SwitchInfo | null) => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  return useQuery({
    queryKey: handle ? dmsKeys.published(chainId, handle) : ["dms", "idle", "published"],
    enabled: !!client && !!handle && !!info?.published,
    // Found: immutable. Not found although `published` (a node behind, pruned logs): look again every minute, not never.
    staleTime: (q) => (q.state.data ? Infinity : 60_000),
    refetchInterval: (q) => (q.state.data ? false : 60_000),
    queryFn: (): Promise<PublishedPlaintext | null> => findPublishedPlaintext(client!, {
      chainId, contract: handle!.contractAddr, owner: handle!.owner, id: handle!.id, revealedAt: info!.revealedAt,
      fromBlock: fromBlockOf(chainId, handle!.contractAddr), rangeCap: logsRangeCapFor(chainId),
    }),
  });
};

// ---------- FHE key download status ----------

/** Live status of the one-time ~50 MB FHE key download for a chain (badge / progress bar). */
export const useFheKeyStatus = (chainId: number): FheKeyStatus =>
  useSyncExternalStore(subscribeFheKeyStatus, () => getFheKeyStatus(chainId), () => getFheKeyStatus(chainId));

// ---------- writes ----------

export interface TxResult {
  hash: Hex;
  receipt: TransactionReceipt;
}

export interface WriteState {
  /** A write of this hook is on its way: in the wallet, or sent and not mined yet (also one sent before a reload). */
  pending: boolean;
  hash: Hex | null;
  error: string | null;
  /**
   * The pending write is a top-up whose wallet answered with an error after
   * it may have broadcast (no hash): show "check your wallet", and offer
   * dismissUnconfirmed once the user has.
   */
  unconfirmed: boolean;
  reset: () => void;
  /** The user checked the wallet: the unconfirmed top-up was not sent. Allows a new one. */
  dismissUnconfirmed: () => void;
  /**
   * The connected account is a contract account (a Safe): `hash` may be its wallet's id for the request
   * (a safeTxHash), not a transaction an explorer knows, and it may wait for other owners' signatures.
   */
  contractAccount: boolean;
}

/** How long a sent write keeps waiting for its receipt (the action stays pending meanwhile). */
export const WRITE_WAIT_MS = 30 * 60_000;
/** After this long without a receipt, a write also asks the node whether it still knows its tx. */
export const DROP_GRACE_MS = 2 * 60_000;
export const DROP_CHECK_EVERY_MS = 15_000;
/**
 * Unknown to the node with no receipt this many checks in a row: dropped.
 * With the grace period, about 5 minutes: as createAttempt's "vanished", long
 * enough for a private relay (MetaMask Smart Transactions, Flashbots Protect)
 * to include a tx public nodes cannot see.
 */
export const DROPPED_AFTER_CHECKS = 12;
/**
 * One viem receipt wait covers at most this long; a timeout or RPC error
 * starts another. viem's wait cannot be cancelled, so this also bounds how
 * long it polls on after a verdict or an abort (nothing new starts then).
 */
export const WAIT_SLICE_MS = 60_000;

/** The tx was not mined and the node no longer knows it: the action did not happen (or the app cannot see it). */
export class TxDroppedError extends Error {
  constructor(readonly hash: Hex, valueCarrying = false) {
    super(
      valueCarrying
        // A top-up the app's RPC cannot see may still be pending elsewhere (a private relay, a nonce gap, a
        // low fee): "send it again" could pay twice.
        ? `Transaction ${hash} has not been mined, and this app can't see it on the network any more. It may have been dropped, or it may still be pending where this app cannot see it (some wallets send privately). Check your wallet's activity before sending another top-up: if it is still pending there, wait for it.`
        : `Transaction ${hash} was not mined, and the network no longer knows it (dropped), so this action did not happen and you can send it again. If your wallet still lists it as pending (some wallets send privately), wait for it instead.`,
    );
    this.name = "TxDroppedError";
  }
}

/**
 * A sent write whose outcome this page cannot tell (still not mined after WRITE_WAIT_MS, replaced by a
 * transaction it could not read, a smart account's request not executed yet): it may still happen, so check
 * the wallet before sending it again.
 */
export class TxUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxUnconfirmedError";
  }
}

/**
 * A failed write that may still land (or already did): a top-up must not stay one click away from a second
 * one (FundAction clears its amount).
 */
export const outcomeUnknown = (e: unknown): boolean => e instanceof TxDroppedError || e instanceof TxUnconfirmedError;

/**
 * Account code that makes it a contract account (a Safe, a smart wallet): any code but an EIP-7702
 * delegation designator (0xef0100 ‖ address), whose account still sends its own transactions.
 */
export const isContractCode = (code: Hex | undefined): boolean =>
  !!code && code !== "0x" && !/^0xef0100/i.test(code);

/**
 * Why a mined transaction reverted: its call (from, to, data, value) replayed with eth_call on the state of
 * its block, which includes what made it fail (a competitor's markDark or revealKey earlier in that block);
 * else on the latest state (a node without that block's state; switch states only move forward).
 */
const revertedMessage = async (client: PublicClient, receipt: TransactionReceipt, hash: Hex): Promise<string> => {
  const plain = "Transaction reverted on-chain.";
  try {
    const tx = await client.getTransaction({ hash: receipt.transactionHash ?? hash });
    for (const blockNumber of [receipt.blockNumber, undefined]) {
      try {
        await client.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, blockNumber });
        return plain; // passes on that state: nothing to explain
      } catch (e) {
        const why = revertReason(e);
        if (why) return `Transaction reverted on-chain: ${why}`;
      }
    }
  } catch { /* the transaction could not be read */ }
  return plain;
};

const TICK = Symbol("tick");

/** A tx as a node returns it (the call as WriteCall: enough to tell a speed-up from another call). */
interface SeenTx extends WriteCall { from: Address; nonce: number }

/** Is `hash` mined, known (pending, with its call when the node returned it), or unknown to the node; "error" when the reads failed. */
const checkTx = async (client: PublicClient, hash: Hex): Promise<
  { kind: "known"; from: Address; nonce: number; call: WriteCall | null } | { kind: "mined" | "unknown" | "error" }
> => {
  const [tx, rc] = await Promise.allSettled([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  if (rc.status === "fulfilled") return { kind: "mined" };
  if (tx.status === "fulfilled") {
    const t = tx.value;
    const call = typeof t.input === "string" && typeof t.value === "bigint"
      ? { to: t.to ?? null, value: t.value, inputHash: keccak256(t.input) }
      : null;
    return { kind: "known", from: t.from, nonce: t.nonce, call };
  }
  const notFound = (e: unknown) => errorName(e) === "TransactionNotFoundError" || errorName(e) === "TransactionReceiptNotFoundError";
  return notFound(tx.reason) && notFound(rc.reason) ? { kind: "unknown" } : { kind: "error" };
};

/** A receipt read that can fail once on a busy RPC (right after a burst of block reads): a few tries, 2 s apart. */
const receiptWithRetries = async (client: PublicClient, hash: Hex, signal?: AbortSignal): Promise<TransactionReceipt | null> => {
  for (let i = 0; i < 3 && !signal?.aborted; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2_000));
    const rc = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (rc) return rc;
  }
  return null;
};

/** The first look at a sent tx (its sender, nonce and call), soon after the wallet returned the hash. */
const FIRST_LOOK_MS = 2_000;

/** The first receipt-wait slice is never shorter than this (a resumed write past its deadline still gets a look). */
const MIN_SLICE_MS = 15_000;
/** Blocks searched for the transaction that took a write's nonce (from the last block it was seen pending). */
export const REPLACEMENT_SCAN_BLOCKS = 64;

/**
 * The transaction that used (from, nonce), in the blocks after `afterBlock`
 * (at most REPLACEMENT_SCAN_BLOCKS), and how it relates to `original`, as
 * viem classifies a replacement: "own" is the write's own tx (mined after
 * all), "repriced" is the same call (to, value, calldata) at a higher fee, so
 * it is this write; "cancelled" is a 0-value self-send; anything else
 * "replaced". null when not found (or the reads failed).
 */
const findReplacement = async (
  client: PublicClient, original: SeenTx, afterBlock: bigint | null, own: Hex,
): Promise<{ hash: Hex; reason: "own" | "repriced" | "cancelled" | "replaced" } | null> => {
  let head: bigint;
  try { head = await client.getBlockNumber({ cacheTime: 0 }); } catch { return null; }
  // From the block after the last pending sighting (unknown after a reload: the last REPLACEMENT_SCAN_BLOCKS).
  const oldest = head - BigInt(REPLACEMENT_SCAN_BLOCKS) + 1n;
  const lo = afterBlock === null ? oldest : afterBlock < head ? afterBlock + 1n : head;
  const eq = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  for (let n = lo > oldest ? lo : oldest > 0n ? oldest : 0n; n <= head; n++) {
    try {
      const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
      const r = block.transactions.find((t) => eq(t.from, original.from) && t.nonce === original.nonce);
      if (!r) continue;
      const reason = eq(r.hash, own) ? "own"
        : eq(r.to, original.to) && r.value === original.value && keccak256(r.input) === original.inputHash ? "repriced"
        : eq(r.from, r.to) && r.value === 0n ? "cancelled" : "replaced";
      return { hash: r.hash, reason };
    } catch { /* a block the node cannot serve: look at the next one */ }
  }
  return null;
};

export interface WaitForWriteOptions {
  /** Abort: the wait ends with WriteDetachedError and starts nothing more (the page no longer shows the write). */
  signal?: AbortSignal;
  /**
   * When the wallet returned the hash (ms since the epoch): the deadline and
   * the drop grace count from here, across reloads. A time in the future
   * (a wrong clock, a tampered record) counts as now.
   */
  startedAt?: number;
  /** Sender and nonce already known (from an earlier look, persisted), and the call when known. */
  seen?: { from: Address; nonce: number; call?: WriteCall | null } | null;
  /** Called when a node returns the tx (sender, nonce, and the call when the node returned it). */
  onSeen?: (s: { from: Address; nonce: number; call: WriteCall | null }) => void;
  /** Wei sent: a value-carrying write's "dropped" verdict never says it is safe to send again. */
  value?: bigint;
  /**
   * The account that sent it. A contract account's wallet may answer a write with its own id for the
   * request rather than a transaction hash (a Safe returns its safeTxHash; with co-signers to wait for, or a
   * relayed execution, there is no transaction yet), which no node will ever know. Such a write is followed
   * through the wallet (walletTx) and never called dropped.
   */
  from?: Address | null;
  /** Ask the wallet what became of the request `hash` names (walletAnswerOf): null while it says nothing yet. */
  walletTx?: (hash: Hex) => Promise<WalletAnswer | null>;
  /**
   * The write (contract, function, switch). From a contract account, a mined success counts only if it shows
   * this write (didTheWrite), whichever way its hash came: the wallet's own (an owner's execTransaction), or
   * one the wallet named for its request. A Safe's outer transaction succeeds when its inner call
   * (safeTxGas > 0) reverted, and so does a 4337 bundle whose operation for this write reverted.
   */
  target?: WriteTarget;
}

/** What a wallet says became of a request it answered with its own id (EIP-5792 wallet_getCallsStatus). */
export interface WalletAnswer {
  /** The transaction that executed it, if the wallet names one. */
  hash: Hex | null;
  /** The wallet reports the calls failed (EIP-5792 status 400 and up, or a receipt with status 0x0). */
  failed: boolean;
}

/** keccak256("ExecutionFailure(bytes32,uint256)"): a Safe whose inner call failed in a transaction that did not. */
const SAFE_EXECUTION_FAILURE = keccak256(toBytes("ExecutionFailure(bytes32,uint256)"));

/**
 * The event each write emits, and which of its indexed fields name the switch (its key) and the sending
 * account (the funder, caller, revealer, …: msg.sender of the call, the contract account itself).
 */
const WRITE_EVENTS: Record<WriteFn, { eventName: ContractEventName<typeof dmsAbi>; switchKey: boolean; sender?: string }> = {
  ping: { eventName: "Pinged", switchKey: true },
  fundBounty: { eventName: "BountyFunded", switchKey: true, sender: "funder" },
  cancel: { eventName: "SwitchCancelled", switchKey: true, sender: "owner" },
  reclaimContribution: { eventName: "ContributionReclaimed", switchKey: true, sender: "funder" },
  reclaimOwnerStake: { eventName: "OwnerStakeReclaimed", switchKey: true, sender: "owner" },
  markDark: { eventName: "SwitchDarkMarked", switchKey: true, sender: "caller" },
  revealKey: { eventName: "KeyRevealed", switchKey: true, sender: "revealer" },
  publishPlaintext: { eventName: "PlaintextPublished", switchKey: true, sender: "publisher" },
  setMinBountyUsd: { eventName: "MinBountyUsdUpdated", switchKey: false },
  transferAdmin: { eventName: "AdminTransferStarted", switchKey: false, sender: "currentAdmin" },
  acceptAdmin: { eventName: "AdminTransferred", switchKey: false, sender: "newAdmin" },
  renounceAdmin: { eventName: "AdminTransferred", switchKey: false, sender: "previousAdmin" },
};

/**
 * The receipt shows this write: the event its function emits, logged by its contract, for its switch (the
 * key of owner and id) and, where the event names one, from the sending account; and no Safe
 * ExecutionFailure from that account. Any other log of the contract (another switch's ping in the same
 * bundle) does not count.
 */
const didTheWrite = (rc: TransactionReceipt, t: WriteTarget, sender: Address | null | undefined): boolean => {
  const eq = (a: unknown, b: string | null | undefined) => typeof a === "string" && !!b && a.toLowerCase() === b.toLowerCase();
  const logs = rc.logs ?? [];
  if (logs.some((l) => eq(l.address, sender) && l.topics?.[0]?.toLowerCase() === SAFE_EXECUTION_FAILURE)) return false;
  const spec = WRITE_EVENTS[t.fn];
  // encodePacked checks a mixed-case address's checksum; lowercase is the same address without one.
  const key = spec.switchKey && t.owner && t.id !== null ? switchKeyOf(t.owner.toLowerCase() as Address, t.id) : null;
  if (spec.switchKey && !key) return false;
  const events = parseEventLogs({ abi: dmsAbi, eventName: spec.eventName, logs: logs.filter((l) => eq(l.address, t.contract)) });
  return events.some((e) => {
    const args = e.args as Record<string, unknown>;
    return (!key || eq(args.switchKey, key)) && (!spec.sender || eq(args[spec.sender], sender));
  });
};

/**
 * Wait for a write's receipt; throw on revert. Once the wallet returned a
 * hash, a receipt-wait timeout or a failed RPC read says nothing about the
 * tx: reporting it as a failure re-enables the button, and a second ping or
 * top-up lands next to the first. So this keeps waiting, up to WRITE_WAIT_MS.
 *
 * - viem follows a replacement of the tx: only a speed-up ("repriced", same
 *   call) is this write; a cancel in the wallet or another tx at that nonce
 *   did not do it, whatever its receipt status says.
 * - A dropped tx never gets a receipt, and viem never says so. After
 *   DROP_GRACE_MS the node is asked every DROP_CHECK_EVERY_MS whether it still
 *   knows the tx; unknown DROPPED_AFTER_CHECKS times in a row, with no
 *   receipt, ends the wait with TxDroppedError, so the action is offered
 *   again. Unless another tx from the sender has used its nonce: viem sees a
 *   replacement only within a receipt wait that saw the tx pending, so one
 *   mined between two waits is looked up here (findReplacement) and judged
 *   as viem would: a speed-up is this write's receipt; anything else ends with
 *   an error that says to check first.
 * - Before any verdict, including the deadline, a receipt the wait got
 *   meanwhile, or this tx's own receipt, wins: the checks' reads can come from
 *   a node behind the one that served the receipt wait.
 */
export const waitForWrite = async (client: PublicClient, hash: Hex, opts: WaitForWriteOptions = {}): Promise<TransactionReceipt> => {
  const { signal } = opts;
  const start = Math.min(opts.startedAt ?? Date.now(), Date.now());
  const deadline = start + WRITE_WAIT_MS;
  const aborted = new Promise<typeof TICK>((resolve) => {
    if (signal?.aborted) resolve(TICK);
    else signal?.addEventListener("abort", () => resolve(TICK), { once: true });
  });
  const detachIfAborted = () => { if (signal?.aborted) throw new WriteDetachedError(); };
  // One long-lived receipt wait (viem detects a replacement only within one wait that saw the tx pending).
  const startWait = () => {
    const replaced: { reason?: string } = {};
    return client.waitForTransactionReceipt({
      hash, timeout: Math.max(MIN_SLICE_MS, Math.min(WAIT_SLICE_MS, deadline - Date.now())),
      onReplaced: (x) => { replaced.reason = x.reason; },
    }).then(
      (receipt) => ({ receipt, reason: replaced.reason }),
      (error: unknown) => ({ error }),
    );
  };
  type Outcome = Awaited<ReturnType<typeof startWait>>;
  const fromReceipt = async (r: { receipt: TransactionReceipt; reason?: string }): Promise<TransactionReceipt> => {
    if (r.reason && r.reason !== "repriced") {
      throw new Error("The transaction was cancelled or replaced in the wallet, so it did nothing.");
    }
    if (r.receipt.status !== "success") throw new Error(await revertedMessage(client, r.receipt, hash));
    return confirmed(r.receipt);
  };
  /**
   * A successful receipt from a contract account counts only if it shows this write (didTheWrite): its outer
   * transaction succeeds whatever the inner call did. When the account's code cannot be read, it is checked
   * all the same: an ordinary account's successful call always shows its write.
   */
  const confirmed = async (rc: TransactionReceipt): Promise<TransactionReceipt> => {
    if (!opts.target || !opts.from || (await viaContract()) === false) return rc;
    if (didTheWrite(rc, opts.target, opts.from)) return rc;
    throw new TxUnconfirmedError(
      `Transaction ${rc.transactionHash ?? hash} was mined, but it does not show this ${opts.target.fn} on the switch: your account is a contract account (a Safe, for example), and its inner call may have failed, or the transaction did something else. Check your wallet's activity before sending it again.`,
    );
  };
  /** A receipt the running wait already got, or this tx's own receipt (any node): it was mined. */
  const minedAfterAll = async (wait: Promise<Outcome>): Promise<TransactionReceipt | null> => {
    const done = await Promise.race([wait, Promise.resolve(TICK)]);
    if (done !== TICK && "receipt" in done) return fromReceipt(done);
    const own = await client.getTransactionReceipt({ hash }).catch(() => null);
    return own ? fromReceipt({ receipt: own }) : null;
  };
  /**
   * Whether the sender is a contract account (see `from`): asked once, when a node first does not know the
   * hash, and only with a wallet to ask. null while the read fails (asked again at the next check).
   */
  let contractAccount: boolean | null = opts.from && opts.walletTx ? null : false;
  const viaContract = async (): Promise<boolean | null> => {
    if (contractAccount !== null) return contractAccount;
    const code = await Promise.resolve().then(() => client.getCode({ address: opts.from! })).then((c) => c ?? "0x", () => null);
    if (code !== null) contractAccount = isContractCode(code);
    return contractAccount;
  };
  detachIfAborted();
  let wait = startWait();
  let unknown = 0;
  let seen: { from: Address; nonce: number } | null = opts.seen ? { from: opts.seen.from, nonce: opts.seen.nonce } : null;
  /** The tx as last seen pending, and the block then (where a replacement search starts). */
  let original: SeenTx | null = opts.seen?.call ? { ...opts.seen.call, from: opts.seen.from, nonce: opts.seen.nonce } : null;
  let pendingAt: bigint | null = null;
  // Early looks while the tx is surely pending, to learn its sender, nonce and call (what a replacement is judged
  // against): the first soon after the send, then every check interval until a node has returned it; then none
  // until the grace period ends.
  let looks = 0;
  for (;;) {
    const elapsed = Date.now() - start;
    const delay = elapsed >= DROP_GRACE_MS ? DROP_CHECK_EVERY_MS
      : seen ? DROP_GRACE_MS - elapsed
      : looks === 0 ? FIRST_LOOK_MS - elapsed : DROP_CHECK_EVERY_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<typeof TICK>((r) => { timer = setTimeout(() => r(TICK), Math.max(0, delay)); });
    const r = await Promise.race([wait, tick, aborted]);
    clearTimeout(timer);
    detachIfAborted();

    if (r !== TICK) {
      if ("receipt" in r) return fromReceipt(r);
      if (Date.now() >= deadline) {
        const mined = await minedAfterAll(wait);
        if (mined) return mined;
        throw new TxUnconfirmedError(contractAccount
          ? `Your account is a contract account (a Safe, for example), and ${hash} is its wallet's id for this request, not a transaction this page can look up. In ${WRITE_WAIT_MS / 60_000} minutes your wallet has not reported it executed: a Safe may still be waiting for its other owners to sign. Check the account's queue (in the Safe app) before sending this again.`
          : `Transaction ${hash} is still not confirmed after ${WRITE_WAIT_MS / 60_000} minutes. Check it in your wallet or on the explorer before sending it again.`);
      }
      // A slice timed out (wait again at once), or an RPC read failed (wait again after a pause): says nothing about the tx.
      const timedOut = errorName(r.error) === "WaitForTransactionReceiptTimeoutError";
      wait = new Promise((ok) => setTimeout(ok, timedOut ? 0 : 5_000))
        .then(() => (signal?.aborted ? { error: new WriteDetachedError() } : startWait()));
      continue;
    }

    const inGrace = Date.now() - start < DROP_GRACE_MS;
    if (inGrace && seen) continue;
    looks++;
    const c = await checkTx(client, hash);
    detachIfAborted();
    if (c.kind === "known") {
      if (c.call) original = { ...c.call, from: c.from, nonce: c.nonce };
      pendingAt = await Promise.resolve().then(() => client.getBlockNumber()).catch(() => pendingAt);
      seen = { from: c.from, nonce: c.nonce };
      opts.onSeen?.({ ...seen, call: c.call });
      unknown = 0;
      continue;
    }
    if (c.kind === "unknown") {
      const viaWallet = await viaContract();
      detachIfAborted();
      if (viaWallet === null) continue; // cannot tell what the sender is yet: no verdict from this check
      if (viaWallet) {
        // No node knows a smart account's request id: ask its wallet what became of it. Only the chain says it
        // succeeded: a failure the wallet reports, or a transaction that did not do this write, is never a
        // success, but the neutral "check your wallet".
        const answer = await opts.walletTx!(hash).catch(() => null);
        detachIfAborted();
        if (answer?.failed) {
          throw new TxUnconfirmedError(
            `Your wallet reports that request ${hash} failed when it was executed${answer.hash ? ` (transaction ${answer.hash})` : ""}, so this action most likely did not happen. Check your wallet's activity (for a Safe, its transaction history) before sending it again.`,
          );
        }
        const executed = answer?.hash;
        if (executed && executed.toLowerCase() !== hash.toLowerCase()) {
          return await confirmed(await waitForWrite(client, executed, { signal, startedAt: start, value: opts.value }));
        }
        continue; // not executed yet (a Safe waiting for its other owners): never "dropped"
      }
    }
    if (inGrace) continue; // too early to count a tx the node does not know yet
    if (c.kind === "mined") { unknown = 0; continue; } // the receipt wait reports it next
    if (c.kind === "error" || ++unknown < DROPPED_AFTER_CHECKS) continue;
    let replaced = false;
    if (seen) {
      const minedNonce = await client.getTransactionCount({ address: seen.from, blockTag: "latest" }).catch(() => null);
      if (minedNonce === null) { unknown--; continue; } // decide at the next check
      replaced = minedNonce > seen.nonce;
    }
    const mined = await minedAfterAll(wait);
    if (mined) return mined;
    detachIfAborted();
    if (replaced) {
      // Only the replacement's own receipt decides: a speed-up (or this tx after all) is this write's outcome,
      // and only a mined, different call "did nothing". Without that receipt, the user is told to check.
      const by = original ? await findReplacement(client, original, pendingAt, hash) : null;
      const rc = by ? await receiptWithRetries(client, by.hash, signal) : null;
      detachIfAborted();
      if (by && rc) {
        if (by.reason === "own") return fromReceipt({ receipt: rc });
        if (by.reason === "repriced") return fromReceipt({ receipt: rc, reason: "repriced" });
        throw new Error("The transaction was cancelled or replaced in the wallet, so it did nothing.");
      }
      throw new TxUnconfirmedError(
        `Transaction ${hash} was replaced: another transaction from your account used its nonce. Check your wallet or the explorer to see whether this action happened before sending it again.`,
      );
    }
    throw new TxDroppedError(hash, (opts.value ?? 0n) > 0n);
  }
};

/** How often a top-up recorded without a hash is checked, and how many checks with its nonce used and no stake count as "not sent". */
export const UNCONFIRMED_CHECK_MS = 10_000;
export const UNCONFIRMED_NONCE_CHECKS = 3;

/**
 * The transaction `w.from` sent at nonce `w.nonce`, if it is this top-up's
 * call (to w.contract, w.value, fundBounty(owner, id)) and mined successfully:
 * its receipt. Found by bisecting the account's mined nonce over the last
 * REPLACEMENT_SCAN_BLOCKS blocks, then reading the one block that holds it.
 * null when it is something else, or cannot be told (no nonce, older, reads failed).
 */
const topUpAtNonce = async (client: PublicClient, w: PendingWrite): Promise<TransactionReceipt | null> => {
  const from = w.from;
  const nonce = w.nonce;
  if (!from || nonce === null || w.owner === null || w.id === null) return null;
  const eq = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  try {
    const minedBy = async (b: bigint) => (await client.getTransactionCount({ address: from, blockNumber: b })) > nonce;
    const head = await client.getBlockNumber({ cacheTime: 0 });
    let lo = head >= BigInt(REPLACEMENT_SCAN_BLOCKS) ? head - BigInt(REPLACEMENT_SCAN_BLOCKS) : 0n;
    let hi = head;
    if (!(await minedBy(hi)) || (await minedBy(lo))) return null;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (await minedBy(mid)) hi = mid; else lo = mid;
    }
    const block = await client.getBlock({ blockNumber: hi, includeTransactions: true });
    const tx = block.transactions.find((t) => eq(t.from, from) && t.nonce === nonce);
    const call = encodeFunctionData({ abi: dmsAbi, functionName: "fundBounty", args: [w.owner, w.id] });
    if (!tx || !eq(tx.to, w.contract) || tx.value !== w.value || !eq(tx.input, call)) return null;
    const rc = await client.getTransactionReceipt({ hash: tx.hash });
    return rc.status === "success" ? rc : null;
  } catch {
    return null;
  }
};

/**
 * Follow a top-up recorded without a hash (the wallet errored after it may
 * have broadcast) until the switch shows it: the sender's stake grew by its
 * value. It resolves with the receipt of the sender's transaction at the
 * recorded nonce when that is this top-up's call (topUpAtNonce), else null:
 * the stake can also grow by a top-up of the same account from another tab,
 * device or the CLI. Ends with an error that says to check the wallet
 * when the sender's nonce was used and the stake did not grow on
 * UNCONFIRMED_NONCE_CHECKS checks in a row (another tx took that nonce, or
 * nothing was sent), or after WRITE_WAIT_MS; with WriteDetachedError on abort.
 * Without a stake baseline (its read failed before the send) neither "landed"
 * nor "not sent" can be told: the nonce alone would also move for this very
 * top-up, so it gives no verdict, and at the deadline says it could not tell.
 */
export const waitForUnconfirmedTopUp = async (client: PublicClient, w: PendingWrite, signal?: AbortSignal): Promise<TransactionReceipt | null> => {
  const deadline = Math.min(w.sentAt, Date.now()) + WRITE_WAIT_MS;
  let nonceUsed = 0;
  for (;;) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, UNCONFIRMED_CHECK_MS);
      signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (signal?.aborted) throw new WriteDetachedError();
    if (!w.from || w.owner === null || w.id === null) throw new Error("This top-up cannot be checked. Check your wallet's activity.");
    const [stake, nonce] = await Promise.all([
      w.stakeBefore === null ? null : readFunderStake(client, { contractAddr: w.contract, owner: w.owner, id: w.id }, w.from).catch(() => null),
      w.nonce === null ? null : client.getTransactionCount({ address: w.from, blockTag: "latest" }).catch(() => null),
    ]);
    if (signal?.aborted) throw new WriteDetachedError();
    if (stake !== null && w.stakeBefore !== null && stake >= w.stakeBefore + w.value) return await topUpAtNonce(client, w);
    nonceUsed = w.stakeBefore !== null && nonce !== null && w.nonce !== null && nonce > w.nonce ? nonceUsed + 1 : 0;
    if (nonceUsed >= UNCONFIRMED_NONCE_CHECKS) {
      throw new Error(
        `Your account's transaction at nonce ${w.nonce} was mined, but this top-up is not on the switch: it was not sent, or another transaction took its place. Check your wallet's activity before sending another.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(w.stakeBefore === null
        ? `This page could not tell whether the top-up whose wallet answer was lost was sent (it could not read your stake before sending). Check your wallet's activity before sending another.`
        : `The top-up whose wallet answer was lost has not shown up on the switch after ${WRITE_WAIT_MS / 60_000} minutes. Check your wallet's activity before sending another.`);
    }
  }
};

/**
 * Follows recorded writes to their outcome, one shared wait per write (a run
 * that sent it and every component showing it join the same one). The record
 * ends with the outcome, success or failure. By default the wait runs to its
 * outcome (the run that sent the write reports it); `resumed` marks a wait
 * started only to show a record (after a reload): that one is detached when
 * nothing shows it any more, and the record stays for the next page.
 */
export const createWriteFollower = (store: PendingWriteStore, watchers: ReturnType<typeof createWriteWatchers<TransactionReceipt | null>>) => {
  /**
   * Per record, the latest way to ask the wallet: each follow brings its caller's current one. A shared wait
   * outlives the render that started it (after a reload, one made while wagmi was still reconnecting, with no
   * usable connector), so it asks through whichever is newest at the time it asks.
   */
  const asks = new Map<string, NonNullable<WaitForWriteOptions["walletTx"]>>();
  return {
  follow: (
    client: PublicClient, w: PendingWrite, opts: { resumed?: boolean; walletTx?: WaitForWriteOptions["walletTx"] } = {},
  ): Promise<TransactionReceipt | null> => {
    const key = writeKey(w, w.from);
    if (opts.walletTx) asks.set(key, opts.walletTx);
    const ask = asks.get(key);
    const walletTx = ask ? (h: Hex) => (asks.get(key) ?? ask)(h) : undefined;
    return watchers.join(key, w.hash, async (signal) => {
      try {
        const r = w.hash
          ? await waitForWrite(client, w.hash, {
            signal, startedAt: w.sentAt, value: w.value, from: w.from, walletTx, target: w,
            seen: w.from && w.nonce !== null ? { from: w.from, nonce: w.nonce, call: w.call } : null,
            onSeen: (s) => store.update(key, w.hash, s.call ? { nonce: s.nonce, call: s.call } : { nonce: s.nonce }),
          })
          : await waitForUnconfirmedTopUp(client, w, signal);
        store.remove(key, w.hash);
        return r;
      } catch (e) {
        if (!(e instanceof WriteDetachedError)) store.remove(key, w.hash);
        throw e;
      }
    }, !opts.resumed);
  },
  stop: (w: PendingWrite) => { store.remove(writeKey(w, w.from), w.hash); watchers.stop(writeKey(w, w.from)); },
  };
};

/** What runWrite needs to record a write and refuse a duplicate (useTxRunner supplies it). */
export interface WriteTracking {
  store: PendingWriteStore;
  target: WriteTarget;
  value: bigint;
  /** The connected account (the sender, until a node returns the tx's own `from`). */
  from: Address | null;
  /** Before a value-carrying send: the sender's pending nonce and current stake, for a lost wallet answer. */
  before?: () => Promise<{ nonce: number | null; stakeBefore: bigint | null }>;
  /**
   * Follow a recorded write to its receipt (createWriteFollower: a run's own
   * wait goes on to its outcome whatever component showed it unmounts, so its
   * verdict, a front-run reveal's revert or a success, is always reported).
   */
  watch: (w: PendingWrite) => Promise<TransactionReceipt | null>;
}

/**
 * One write: send → receipt (waitForWrite) → `refresh` what it touched. A
 * failed write refreshes too, at once and without waiting: a markDark or
 * revealKey that lost the race (reverted, or refused at simulation with
 * AlreadyDarkMarked / AlreadyRevealed / NotActive …) means the switch moved
 * on, and the page should show that now rather than at the next poll. Only a
 * rejection in the wallet left the chain as it was.
 *
 * With `track`, the sent write is recorded (lib/pendingWrites.ts) until its
 * outcome: a second write with the same target is refused before the wallet
 * (WriteInFlightError), and a top-up whose wallet answered with an ambiguous
 * error is recorded without a hash (WriteUnconfirmedError) rather than
 * reported as failed. The record's send time is when the wallet answered, not
 * when it was asked.
 */
export const runWrite = async (
  send: () => Promise<Hex>,
  client: PublicClient | null,
  refresh: (receipt?: TransactionReceipt) => Promise<unknown>,
  /**
   * `hash`: the wallet returned it. `landed`: a top-up recorded without a hash (WriteUnconfirmedError) showed
   * up on the switch after all (its sender's stake grew by its value), reported late; `matched` when the
   * sender's transaction at the recorded nonce is this top-up's call, not one from another tab, device or the CLI.
   */
  on: { hash?: (h: Hex) => void; landed?: (how: { matched: boolean }) => void } = {},
  track?: WriteTracking,
): Promise<TxResult> => {
  const key = track ? writeKey(track.target, track.from) : null;
  if (track && key) {
    const inFlight = track.store.get(key);
    if (inFlight) throw new WriteInFlightError(inFlight);
  }
  const valueCarrying = !!track && isValueCarrying({ fn: track.target.fn, value: track.value });
  // Bounded like the dry run: a read RPC that does not answer must not hold the wallet prompt back.
  const none = { nonce: null, stakeBefore: null };
  const pre = valueCarrying && track?.before
    ? await within(Promise.resolve().then(() => track.before!()), DRY_RUN_TIMEOUT_MS).then((r) => (r.status === "ok" ? r.value : none))
    : none;
  let h: Hex;
  let receipt: TransactionReceipt;
  try {
    try {
      h = await send();
    } catch (e) {
      if (track && valueCarrying && mayHaveBroadcast(e)) {
        const w: PendingWrite = {
          ...track.target, hash: null, from: track.from, nonce: pre.nonce, value: track.value, sentAt: Date.now(),
          stakeBefore: pre.stakeBefore, call: null,
        };
        track.store.put(w);
        void track.watch(w).then((r) => on.landed?.({ matched: r !== null }), () => {});
        throw new WriteUnconfirmedError(w, e);
      }
      throw e;
    }
    on.hash?.(h);
    if (!client) throw new Error("no RPC client for this chain");
    if (track) {
      const w: PendingWrite = {
        ...track.target, hash: h, from: track.from, nonce: null, value: track.value, sentAt: Date.now(), stakeBefore: null, call: null,
      };
      track.store.put(w);
      let r: TransactionReceipt | null;
      try {
        r = await track.watch(w);
      } catch (e) {
        // Only when the record was ended by hand (stop): nothing is left to report.
        if (e instanceof WriteDetachedError) return await new Promise<never>(() => {});
        throw e;
      }
      if (!r) throw new Error("no receipt");
      receipt = r;
    } else {
      receipt = await waitForWrite(client, h);
    }
  } catch (e) {
    if (!isUserRejection(e)) void refresh().catch(() => {});
    throw e;
  }
  await refresh(receipt);
  // The mined transaction (a speed-up's, or the one that executed a smart account's request), for its explorer link.
  return { hash: receipt.transactionHash ?? h, receipt };
};

// ---------- in-flight writes of this tab ----------

const pendingWrites = createPendingWriteStore(() => (typeof window === "undefined" ? null : window.sessionStorage));
const writeWatchers = createWriteWatchers<TransactionReceipt | null>();
const writeFollower = createWriteFollower(pendingWrites, writeWatchers);
const getServerPendingWrite = () => null;

/** The queries a recorded write touched: its switch, or the contract settings. */
const queriesOf = (w: WriteTarget): QueryKey[] =>
  w.owner && w.id !== null
    ? [dmsKeys.switch(w.chainId, { contractAddr: w.contract, owner: w.owner, id: w.id })]
    : [dmsKeys.config(w.chainId, w.contract)];

/**
 * After a write's receipt: re-read what it touched, at a block no older than
 * the receipt's for its switch (noteWriteMined), so a lagging node does not
 * show the action as still to do.
 */
const refreshAfterWrite = (queryClient: QueryClient, target: WriteTarget | null, invalidate: QueryKey[], receipt?: TransactionReceipt) => {
  if (receipt && target?.owner && target.id !== null) {
    noteWriteMined(target.chainId, { contractAddr: target.contract, owner: target.owner, id: target.id }, receipt.blockNumber);
  }
  return Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
};

/** How long one question to the wallet may take (WalletConnect waits for ever while the wallet's app is closed). */
const WALLET_ASK_MS = 10_000;
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
});

/**
 * What a wallet's answer says became of a request: EIP-5792
 * wallet_getCallsStatus (any version: v2's numeric status, 400 and up being a
 * failure; v1's receipts), or an eth_getTransactionReceipt answer. `failed`
 * when the wallet reports the calls failed or a receipt has status 0x0. null
 * when it names no transaction and no failure (not executed yet).
 */
export const walletAnswerOf = (answer: unknown): WalletAnswer | null => {
  const isHash = (h: unknown): h is Hex => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
  const failedStatus = (st: unknown) => st === "0x0" || st === 0 || st === "reverted";
  if (typeof answer !== "object" || answer === null) return null;
  const { receipts, transactionHash, status } = answer as { receipts?: unknown; transactionHash?: unknown; status?: unknown };
  const list: unknown[] = Array.isArray(receipts) ? receipts : [];
  const inReceipts = list.map((r) => (r as { transactionHash?: unknown } | null)?.transactionHash).find(isHash);
  const hash = inReceipts ?? (isHash(transactionHash) ? transactionHash : null);
  const failed = (typeof status === "number" && status >= 400)
    || list.some((r) => failedStatus((r as { status?: unknown } | null)?.status))
    // An eth_getTransactionReceipt answer: its own status.
    || (!Array.isArray(receipts) && transactionHash !== undefined && failedStatus(status));
  if (failed) return { hash, failed: true };
  return hash ? { hash, failed: false } : null;
};

/** An EIP-1193 provider, what a wagmi connector's getProvider returns. */
type Eip1193 = { request: (args: { method: string; params?: readonly unknown[] }) => Promise<unknown> };
const isEip1193 = (p: unknown): p is Eip1193 => typeof (p as { request?: unknown } | null)?.request === "function";

/**
 * Submit → wait for receipt (throw on revert) → invalidate. Shared by every
 * write hook. `fn` and `handle` name the write this hook shows: given a
 * handle, a write of that switch sent before a reload (or by another
 * component) shows as pending, with its hash, and its wait resumes here.
 */
const useTxRunner = (fn: WriteFn | null, handle?: SwitchHandle | null) => {
  const queryClient = useQueryClient();
  const client = useEffectivePublicClient();
  const { chainId, address: contract } = useEffectiveChain();
  const { address: account, connector } = useAccount();
  /**
   * Ask the wallet which transaction executed a request it answered with an id no node knows (waitForWrite's
   * `walletTx`): EIP-5792 wallet_getCallsStatus, which a Safe keys by the safeTxHash it returned (and
   * WalletConnect forwards), else the wallet's own eth_getTransactionReceipt. Each question is bounded.
   */
  const walletTx = useCallback(async (id: Hex): Promise<WalletAnswer | null> => {
    // While wagmi reconnects after a reload, `connector` is its stored description, with no getProvider.
    const provider = typeof connector?.getProvider === "function"
      ? await withTimeout(Promise.resolve().then(() => connector.getProvider({ chainId })), WALLET_ASK_MS).catch(() => null)
      : null;
    if (!isEip1193(provider)) return null;
    const ask = (method: string) => withTimeout(provider.request({ method, params: [id] }), WALLET_ASK_MS).catch(() => null);
    return walletAnswerOf(await ask("wallet_getCallsStatus")) ?? walletAnswerOf(await ask("eth_getTransactionReceipt"));
  }, [connector, chainId]);
  /** The connected account is a contract account (for PendingTx's wording and link): one read per account and chain. */
  const { data: contractAccount } = useQuery({
    queryKey: ["dms", chainId, "accountCode", account?.toLowerCase() ?? null],
    enabled: !!client && !!account,
    staleTime: Infinity,
    queryFn: async () => isContractCode(await client!.getCode({ address: account! })),
  });
  const [pending, setPending] = useState(false);
  const [hash, setHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The write this hook last sent or was refused for (hooks used without a handle follow that one). */
  const [followed, setFollowed] = useState<string | null>(null);
  /** Hashes this hook's own runs sent: their run reports the outcome. */
  const ownHashes = useRef(new Set<string>());
  /** Records whose outcome this hook already reports (one handler each). */
  const handled = useRef(new Set<string>());

  // A switch's writes are recorded under its own deployment (G14): a pending ping of a previous
  // deployment's switch never blocks, nor shows on, the current deployment's switch with the same (owner, id).
  const shownContract = handle ? deploymentOf(chainId, handle.contractAddr)?.address : null;
  const shownKey = fn && shownContract && handle
    ? writeKey({ chainId, contract: shownContract, fn, owner: handle.owner, id: handle.id }, account ?? null)
    : null;
  const key = shownKey ?? followed;
  const entry = useSyncExternalStore(pendingWrites.subscribe, () => (key ? pendingWrites.get(key) : null), getServerPendingWrite);

  // Follow the shown write (after a reload, a remount, a refused duplicate, a lost wallet answer, or one
  // sent elsewhere in the tab): keep its wait running (joining the run's own, or resuming it), and show
  // its outcome and refresh the switch unless this hook's own run reports it. Unmounting lets go of it;
  // a run's own wait goes on regardless until the run has its outcome (createWriteWatchers pinned).
  const entryHash = entry ? entry.hash ?? "unconfirmed" : null;
  useEffect(() => {
    const w = key ? pendingWrites.get(key) : null;
    if (!key || !w || !client || w.chainId !== chainId) return;
    const release = writeWatchers.retain(key);
    const outcome = writeFollower.follow(client, w, { resumed: true, walletTx });
    const id = `${key}|${w.hash ?? "unconfirmed"}|${w.sentAt}`;
    if ((w.hash && ownHashes.current.has(w.hash.toLowerCase())) || handled.current.has(id)) {
      outcome.catch(() => {});
    } else {
      handled.current.add(id);
      outcome.then(
        (receipt) => { setError(null); void refreshAfterWrite(queryClient, w, queriesOf(w), receipt ?? undefined).catch(() => {}); },
        (e: unknown) => {
          if (e instanceof WriteDetachedError) { handled.current.delete(id); return; }
          setError(errMsg(e));
          void refreshAfterWrite(queryClient, w, queriesOf(w)).catch(() => {});
        },
      );
    }
    return release;
  }, [key, entryHash, client, chainId, queryClient, walletTx]);

  const run = useCallback(async (
    send: () => Promise<Hex>,
    invalidate: QueryKey[],
    target?: { fn?: WriteFn; h: SwitchHandle | null; value?: bigint },
    /** `landed`: a top-up whose wallet answer was lost showed up on the switch (runWrite). */
    opts?: { landed?: (how: { matched: boolean }) => void },
  ): Promise<TxResult> => {
    setPending(true);
    setError(null);
    setHash(null);
    const writeFn = target?.fn ?? fn;
    const writeContract = target?.h ? deploymentOf(chainId, target.h.contractAddr)?.address : contract;
    const t: WriteTarget | null = target && writeFn && writeContract
      ? { chainId, contract: writeContract, fn: writeFn, owner: target.h?.owner ?? null, id: target.h?.id ?? null }
      : null;
    const k = t ? writeKey(t, account ?? null) : null;
    if (k) setFollowed(k);
    const c = client;
    try {
      return await runWrite(
        send, c, (receipt) => refreshAfterWrite(queryClient, t, invalidate, receipt),
        // Before the record is stored, so the follow effect leaves this send's outcome to this run.
        { hash: (h) => { ownHashes.current.add(h.toLowerCase()); setHash(h); }, landed: opts?.landed },
        t && c ? {
          store: pendingWrites, target: t, value: target?.value ?? 0n, from: account ?? null,
          before: async () => {
            const [nonce, stake] = await Promise.allSettled([
              account ? c.getTransactionCount({ address: account, blockTag: "pending" }) : Promise.reject(new Error("no account")),
              account && target?.h ? readFunderStake(c, target.h, account) : Promise.reject(new Error("no switch")),
            ]);
            return {
              nonce: nonce.status === "fulfilled" ? nonce.value : null,
              stakeBefore: stake.status === "fulfilled" ? stake.value : null,
            };
          },
          watch: (w) => writeFollower.follow(c, w, { walletTx }),
        } : undefined,
      );
    } catch (e) {
      setError(errMsg(e));
      throw e;
    } finally {
      setPending(false);
    }
  }, [fn, client, queryClient, chainId, contract, account, walletTx]);

  const reset = useCallback(() => { setError(null); setHash(null); }, []);
  const dismissUnconfirmed = useCallback(() => {
    const w = key ? pendingWrites.get(key) : null;
    if (w && w.hash === null) writeFollower.stop(w);
    setError(null);
  }, [key]);
  return {
    run,
    state: {
      pending: pending || !!entry,
      hash: entry?.hash ?? hash,
      error,
      unconfirmed: !!entry && entry.hash === null,
      reset,
      dismissUnconfirmed,
      contractAccount: !!contractAccount,
    } satisfies WriteState,
  };
};

/**
 * Dry-run a write before the wallet prompt. wagmi hands eth_sendTransaction to
 * a JSON-RPC wallet (injected, WalletConnect) without simulating it, so a stale
 * button (another hunter marked or revealed first, a contribution reclaimed
 * elsewhere, a deadline passed) was signed and mined as a revert, paid for,
 * with no reason given. A revert in the dry run is thrown as is (decoded:
 * errMsg names it) and nothing reaches the wallet; runWrite then refreshes the
 * switch. A dry run that fails otherwise (the RPC rate-limits or is down) says
 * nothing about the write, and the wallet decides as before. So does a
 * revert that only time lifts (TIME_LIFTED_REVERTS): the dry run runs on the
 * latest block, up to a slot behind the clock the card offers the button by,
 * and the transaction is mined in a later block. So does a dry run with no
 * answer within DRY_RUN_TIMEOUT_MS. A refusal is a WouldRevertError (counted
 * as not sent). `simulate` is null when there is no client or account to
 * dry-run with.
 */
export const sendIfSimulated = async (simulate: (() => Promise<unknown>) | null, send: () => Promise<Hex>): Promise<Hex> => {
  if (simulate) {
    const r = await within(Promise.resolve().then(simulate), DRY_RUN_TIMEOUT_MS);
    // Only a revert that decodes to this contract's or Zama's host errors is a verdict. An RPC failure
    // (-32603 with or without data, "header not found", a revert with no data) says nothing about the write.
    if (r.status === "error") {
      const name = revertErrorName(r.error);
      if (name && !TIME_LIFTED_REVERTS.has(name)) throw new WouldRevertError(name, r.error);
    }
  }
  return send();
};

/**
 * The longest a read before the wallet prompt may take: the dry run (its read-floor lookup included), and
 * a top-up's nonce and stake reads. Past it, no verdict: the write goes to the wallet. A read RPC that
 * accepts requests and answers none (an overloaded public node) otherwise holds the prompt back for viem's
 * timeout times its retries, 41 s and more: past a deadline a ping was racing.
 */
export const DRY_RUN_TIMEOUT_MS = 2_000;

/** `p`'s outcome, or a timeout after `ms` (`p` is left to finish on its own). */
const within = <T>(p: Promise<T>, ms: number): Promise<
  { status: "ok"; value: T } | { status: "error"; error: unknown } | { status: "timeout" }
> => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ status: "timeout" }), ms);
  p.then(
    (value) => { clearTimeout(t); resolve({ status: "ok", value }); },
    (error: unknown) => { clearTimeout(t); resolve({ status: "error", error }); },
  );
});

/** Reverts the next block's later timestamp can lift: the deadline (markDark) or the rescue time (reclaims) has just passed. */
const TIME_LIFTED_REVERTS: ReadonlySet<string> = new Set(["NotDark", "NotRescuable"]);

/**
 * Raw contract writes on the effective chain: each returns the tx hash as soon
 * as the wallet submits (no receipt wait). Each but createSwitch (whose create
 * flow re-checks the chain itself), ping and cancel (which race the deadline)
 * is dry-run first (sendIfSimulated, at most DRY_RUN_TIMEOUT_MS), and each is
 * sent from the connected account only: an account switched in between fails
 * in wagmi before signing. Use with lib/useTx (toasts) or use the lifecycle
 * hooks below.
 */
export const useDmsActions = () => {
  const { writeContractAsync } = useWriteContract();
  const { chainId, address } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const { address: account } = useAccount();

  return useMemo(() => {
    const need = (): Address => {
      if (!address) throw new Error("DeadManSwitch is not deployed on this network.");
      return address;
    };
    // dmsWriteAbi: a revert from Zama's host contracts (paused, deny-listed, a rejected proof) decodes too.
    const base = () => ({ address: need(), abi: dmsWriteAbi, chainId });
    /**
     * A switch's writes go to its own deployment, current or previous (G14). A contract this app does not
     * know (lib/contracts.ts deploymentOf) is refused before the wallet.
     */
    const deploymentOfSwitch = (h: SwitchHandle): Address => {
      const d = deploymentOf(chainId, h.contractAddr);
      if (!d) throw new Error(`${h.contractAddr} is not a DeadManSwitch deployment this app knows on ${chainLabel(chainId)}.`);
      return d.address;
    };
    /** The current deployment, or a switch's own. */
    const target = (h?: SwitchHandle) => ({ address: h ? deploymentOfSwitch(h) : need(), abi: dmsWriteAbi });
    /**
     * The dry run, as the connected account, at the block the page reads switch `at` at (no older
     * than a recent write's receipt, readBlockFor): what its card shows.
     */
    const dryRun = (
      at: SwitchHandle | null,
      simulate: (c: PublicClient, from: Address, blockNumber: bigint | undefined) => Promise<unknown>,
    ): (() => Promise<unknown>) | null =>
      client && account
        ? async () => simulate(client, account, at ? await readBlockFor(client, at) : undefined)
        : null;
    return {
      createSwitch: (p: {
        id: bigint; pingInterval: bigint; plaintextCommitment: Hex;
        ciphertext: Hex; encKey: Hex; inputProof: Hex; value: bigint;
      }) => writeContractAsync({
        ...base(), functionName: "createSwitch",
        args: [{ id: p.id, pingInterval: p.pingInterval, plaintextCommitment: p.plaintextCommitment }, p.ciphertext, p.encKey, p.inputProof],
        value: p.value,
      }),
      // Ping and cancel go to the wallet at once (no dry run): they race the deadline, and on a phone the
      // wallet's deep link should open within the click's own gesture. What a dry run would catch there (mostly a
      // passed deadline) the replay of the mined revert names.
      ping: (h: SwitchHandle) => {
        const call = { ...target(h), functionName: "ping", args: [h.id] } as const;
        return writeContractAsync({ ...call, chainId, account });
      },
      fundBounty: (h: SwitchHandle, value: bigint) => {
        const call = { ...target(h), functionName: "fundBounty", args: [h.owner, h.id], value } as const;
        return sendIfSimulated(
          dryRun(h, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      cancel: (h: SwitchHandle) => {
        const call = { ...target(h), functionName: "cancel", args: [h.id] } as const;
        return writeContractAsync({ ...call, chainId, account });
      },
      reclaimContribution: (h: SwitchHandle) => {
        const call = { ...target(h), functionName: "reclaimContribution", args: [h.owner, h.id] } as const;
        return sendIfSimulated(
          dryRun(h, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      /** Owner-side rescue after RESCUE_DELAY. */
      reclaimOwnerStake: (h: SwitchHandle) => {
        const call = { ...target(h), functionName: "reclaimOwnerStake", args: [h.id] } as const;
        return sendIfSimulated(
          dryRun(account ? { ...h, owner: account } : null, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      markDark: (h: SwitchHandle) => {
        const call = { ...target(h), functionName: "markDark", args: [h.owner, h.id] } as const;
        return sendIfSimulated(
          dryRun(h, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      revealKey: (h: SwitchHandle, dataKey: Hex, decryptionProof: Hex) => {
        const call = { ...target(h), functionName: "revealKey", args: [h.owner, h.id, dataKey, decryptionProof] } as const;
        return sendIfSimulated(
          dryRun(h, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      publishPlaintext: (h: SwitchHandle, salt: Hex, payload: Hex) => {
        const call = { ...target(h), functionName: "publishPlaintext", args: [h.owner, h.id, salt, payload] } as const;
        return sendIfSimulated(
          dryRun(h, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      setMinBountyUsd: (usd8: bigint) => {
        const call = { ...target(), functionName: "setMinBountyUsd", args: [usd8] } as const;
        return sendIfSimulated(
          dryRun(null, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      transferAdmin: (newAdmin: Address) => {
        const call = { ...target(), functionName: "transferAdmin", args: [newAdmin] } as const;
        return sendIfSimulated(
          dryRun(null, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      acceptAdmin: () => {
        const call = { ...target(), functionName: "acceptAdmin" } as const;
        return sendIfSimulated(
          dryRun(null, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
      renounceAdmin: () => {
        const call = { ...target(), functionName: "renounceAdmin" } as const;
        return sendIfSimulated(
          dryRun(null, (c, from, blockNumber) => c.simulateContract({ ...call, account: from, blockNumber })),
          () => writeContractAsync({ ...call, chainId, account }),
        );
      },
    };
  }, [writeContractAsync, chainId, address, client, account]);
};

/**
 * The write hooks below take the switch they show (optional): with it, a
 * write of that switch sent before a reload, or by another component in the
 * tab, shows as pending (with its hash) and its wait resumes. Without it, the
 * hook shows only what it sent itself. Either way a second write of the same
 * function on the same switch is refused while the first is unconfirmed.
 */

/**
 * The deadline a pending ping or cancel must be mined before (null when the
 * switch is unknown or finished), for PendingTx's "speed it up" hint. Read
 * from the switch's cached info: no extra request.
 */
const useDeadline = (handle: SwitchHandle | null | undefined): bigint | null => {
  const { info } = useSwitchInfo(handle ?? null);
  return info && info.exists && !isTerminal(info.state) ? info.expiresAt : null;
};

/** Owner: ping (extend the deadline). */
export const usePing = (handle?: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner("ping", handle);
  const deadline = useDeadline(handle);
  const write = useCallback((h: SwitchHandle) =>
    run(() => actions.ping(h), [dmsKeys.switch(chainId, h)], { h }), [run, actions, chainId]);
  return { write, ...state, deadline };
};

/** Anyone: top up the bounty of a live switch. */
export const useFundBounty = (handle?: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner("fundBounty", handle);
  /**
   * `landed`: called if the wallet's answer was lost and the top-up shows up on the switch later (a success);
   * `matched` when the account's transaction at the recorded nonce is this top-up (runWrite).
   */
  const write = useCallback((h: SwitchHandle, valueWei: bigint, opts?: { landed?: (how: { matched: boolean }) => void }) =>
    run(() => actions.fundBounty(h, valueWei), [dmsKeys.switch(chainId, h)], { h, value: valueWei }, opts), [run, actions, chainId]);
  return { write, ...state };
};

/** Owner, while alive: cancel forever and refund the owner's own escrow. */
export const useCancelSwitch = (handle?: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner("cancel", handle);
  const deadline = useDeadline(handle);
  const write = useCallback((h: SwitchHandle) =>
    run(() => actions.cancel(h), [dmsKeys.switch(chainId, h)], { h }), [run, actions, chainId]);
  return { write, ...state, deadline };
};

/** Funder: reclaim own contribution after a cancel, or on a rescuable switch. */
export const useReclaimContribution = (handle?: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner("reclaimContribution", handle);
  const write = useCallback((h: SwitchHandle) =>
    run(() => actions.reclaimContribution(h), [dmsKeys.switch(chainId, h)], { h }), [run, actions, chainId]);
  return { write, ...state };
};

/** Owner: rescue own escrow from a switch stuck RESCUE_DELAY past dark (reclaimOwnerStake). */
export const useRescueOwnerStake = (handle?: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner("reclaimOwnerStake", handle);
  const write = useCallback((h: SwitchHandle) =>
    run(() => actions.reclaimOwnerStake(h), [dmsKeys.switch(chainId, h)], { h }), [run, actions, chainId]);
  return { write, ...state };
};

/** Anyone, once dark: ask the KMS to make the key publicly decryptable. Irreversible. */
export const useMarkDark = (handle?: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner("markDark", handle);
  const write = useCallback((h: SwitchHandle) =>
    run(() => actions.markDark(h), [dmsKeys.switch(chainId, h)], { h }), [run, actions, chainId]);
  return { write, ...state };
};

/** Anyone, once dark-marked: submit the KMS-decrypted key + proof, collect the bounty. Resolves to { hash, receipt }. */
export const useRevealKey = (handle?: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner("revealKey", handle);
  const write = useCallback((h: SwitchHandle, dataKey: Hex, decryptionProof: Hex) =>
    run(() => actions.revealKey(h, dataKey, decryptionProof), [dmsKeys.switch(chainId, h)], { h }),
  [run, actions, chainId]);
  return { write, ...state };
};

/** Anyone, once revealed: post the plaintext on-chain (commitment-checked). Optional. */
export const usePublishPlaintext = (handle?: SwitchHandle | null) => {
  const { chainId } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner("publishPlaintext", handle);
  const write = useCallback((h: SwitchHandle, salt: Hex, payload: Hex) =>
    run(() => actions.publishPlaintext(h, salt, payload), [dmsKeys.switch(chainId, h)], { h }),
  [run, actions, chainId]);
  return { write, ...state };
};

/** Admin: setMinBountyUsd / transferAdmin / acceptAdmin / renounceAdmin (shared state). */
export const useAdminActions = () => {
  const { chainId, address } = useEffectiveChain();
  const actions = useDmsActions();
  const { run, state } = useTxRunner(null);
  const inv = useMemo(() => [dmsKeys.config(chainId, address)], [chainId, address]);
  return {
    setMinBountyUsd: useCallback((usd8: bigint) => run(() => actions.setMinBountyUsd(usd8), inv, { fn: "setMinBountyUsd", h: null }), [run, actions, inv]),
    transferAdmin: useCallback((a: Address) => run(() => actions.transferAdmin(a), inv, { fn: "transferAdmin", h: null }), [run, actions, inv]),
    acceptAdmin: useCallback(() => run(() => actions.acceptAdmin(), inv, { fn: "acceptAdmin", h: null }), [run, actions, inv]),
    renounceAdmin: useCallback(() => run(() => actions.renounceAdmin(), inv, { fn: "renounceAdmin", h: null }), [run, actions, inv]),
    ...state,
  };
};

// ---------- flow: create a switch ----------
//
// Idempotent across retries (lib/createAttempt.ts): one switch id per form
// session, an on-chain check before every reseal, and once a tx hash exists
// the result is polled rather than reported as a failure.

export interface CreateSwitchInput {
  /** The secret: UTF-8 text or raw bytes (≤ MAX_PAYLOAD_SIZE bytes). */
  secret: string | Uint8Array;
  /** Seconds, MIN_PING_INTERVAL..MAX_PING_INTERVAL. */
  pingInterval: bigint | number;
  /** Owner escrow in wei (≥ minBounty). */
  bountyWei: bigint;
  signal?: AbortSignal;
}

/**
 * The form session's attempt (mirrored to sessionStorage once it reached the
 * wallet) and the last finished create (createAttempt.ts recordCreated).
 */
const attemptStore = createAttemptStore(() => (typeof window === "undefined" ? null : window.sessionStorage));
const getServerAttempt = () => null;
const getServerCreated = () => null;

const errorName = (e: unknown) => (e as { name?: string } | null)?.name;

/** One poll of an attempt: the switch at (owner, id), and the receipt / mempool status of its tx. Never throws. */
export const observeAttempt = async (
  client: PublicClient,
  a: CreateAttempt,
  unknownPollsBefore: number,
): Promise<{ obs: AttemptObservation; info: SwitchInfo | null }> => {
  const handle: SwitchHandle = { contractAddr: a.contract, owner: a.owner, id: a.id };
  const [infoR, receiptR] = await Promise.allSettled([
    readSwitchInfo(client, handle),
    a.hash ? client.getTransactionReceipt({ hash: a.hash }) : Promise.resolve(null),
  ]);
  let info = infoR.status === "fulfilled" ? infoR.value : null;
  // A reverted receipt does not show that there is no switch: an earlier send
  // of this id may have created it (this one then reverts AlreadyExists), and
  // the state read may have hit a node behind the one that served the
  // receipt. Confirm at a block no older than the receipt's before "reverted".
  if (info && !info.exists && receiptR.status === "fulfilled" && receiptR.value?.status === "reverted") {
    info = await readSwitchInfoFresh(client, handle, receiptR.value.blockNumber).catch(() => null);
  }
  let receipt: AttemptObservation["receipt"] = null;
  if (a.hash) {
    if (receiptR.status === "fulfilled") receipt = receiptR.value ? receiptR.value.status : "none";
    else receipt = errorName(receiptR.reason) === "TransactionReceiptNotFoundError" ? "none" : "error";
  }
  let txKnown: boolean | null = null;
  if (a.hash && receipt === "none" && info && !info.exists) {
    try {
      await client.getTransaction({ hash: a.hash });
      txKnown = true;
    } catch (e) {
      txKnown = errorName(e) === "TransactionNotFoundError" ? false : null;
    }
  }
  return {
    obs: {
      state: info ? info.stateCode : null,
      receipt,
      txKnown,
      unknownPolls: txKnown === false ? unknownPollsBefore + 1 : 0,
    },
    info,
  };
};

/** What the attempt poll keeps across restarts ("Check now", a resend rejected in the wallet). */
export interface AttemptPollMemory {
  /** Consecutive polls in which the node did not know the hash, so a restart does not reset the wait for "vanished". */
  unseen: { key: string; polls: number };
  /** The hash known to have reverted (the create run or a poll saw it), and its polls since (pollStep). */
  reverted: { key: string; polls: number } | null;
}

export const newAttemptPollMemory = (): AttemptPollMemory => ({ unseen: { key: "", polls: 0 }, reverted: null });

/** "Check again": a reverted hash gets its full series of re-checks back. */
export const restartRechecks = (mem: AttemptPollMemory): void => {
  if (mem.reverted) mem.reverted = { ...mem.reverted, polls: 0 };
};

/**
 * Poll `a` now, then as pollStep says: `landed` when its switch appears,
 * else `show` with what to display. Returns the stop function. `mem` is
 * only written while not stopped.
 */
export const pollAttempt = (
  client: PublicClient,
  a: CreateAttempt,
  mem: AttemptPollMemory,
  on: { landed: (info: SwitchInfo) => void; show: (o: AttemptOutcome) => void },
): (() => void) => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const k = attemptKey(a);
  const tick = async () => {
    const before = mem.unseen.key === k ? mem.unseen.polls : 0;
    const { obs, info } = await observeAttempt(client, a, before);
    if (stopped) return;
    mem.unseen = { key: k, polls: obs.unknownPolls };
    const o = classifyAttempt(a, obs);
    if (o === "landed" && info) {
      on.landed(info);
      return;
    }
    const step = pollStep(o, mem.reverted?.key === k ? mem.reverted.polls : null);
    if (step.reverted !== null) mem.reverted = { key: k, polls: step.reverted };
    on.show(step.show);
    if (step.next !== null) timer = setTimeout(() => void tick(), step.next);
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
};

/** The attempt's switch, read at a block no older than its tx's receipt (when it has one) or the RPC's head. */
export const readAttemptFresh = async (client: PublicClient, a: CreateAttempt): Promise<SwitchInfo> => {
  const receipt = a.hash ? await client.getTransactionReceipt({ hash: a.hash }).catch(() => null) : null;
  return readSwitchInfoFresh(client, { contractAddr: a.contract, owner: a.owner, id: a.id }, receipt?.blockNumber);
};

/**
 * seal (AES-GCM in the browser) → encryptDek (FHE, relayer input proof) →
 * createSwitch → receipt. `fhe` carries the FHE progress (including the
 * one-time key download bytes). The plaintext and DEK never leave the browser
 * in clear; the DEK buffer is zeroed afterwards.
 *
 * Retries reuse the attempt's switch id and check the chain first, so this
 * can never leave two switches holding the same secret. `stage` is
 * "unconfirmed" while a sent tx's outcome is unknown: the hook polls it
 * (also after a reload) and moves to "done" when the switch appears, or to
 * "error" (retry allowed, same id) once the tx reverted or vanished.
 */
export const useCreateSwitch = () => {
  const { address: account } = useAccount();
  const { chainId, address: contract } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const attempt = useSyncExternalStore(attemptStore.subscribe, attemptStore.get, getServerAttempt);
  const attemptClient = usePublicClientFor(attempt?.chainId ?? chainId);
  const [stage, setStage] = useState<CreateStage>("idle");
  const [fhe, setFhe] = useState<FhevmProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // In the store, not in this component: a create mining while the form is unmounted still lands here.
  // Shown only to the account and network that created it (F4); kept stored for when they come back.
  const created = createdFor(
    useSyncExternalStore(attemptStore.subscribe, attemptStore.created, getServerCreated),
    account && contract ? { chainId, contract, owner: account } : null,
  );
  const [poll, setPoll] = useState<{ key: string; outcome: AttemptOutcome; at: number } | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  /** The stage the last create() run failed in (for the progress list). */
  const [failedAt, setFailedAt] = useState<CreateStage | null>(null);
  const runStage = useRef<CreateStage>("idle");
  const busy = useRef(false);
  /** forgetAttempt's re-check of the switch: running (error null), or why it failed. */
  const [dropCheck, setDropCheck] = useState<{ key: string; error: string | null } | null>(null);
  const dropping = useRef(false);
  /** The poll's memory across restarts: unseen polls, and a hash known to have reverted. */
  const pollMem = useRef<AttemptPollMemory>(newAttemptPollMemory());

  const enter = useCallback((s: CreateStage) => { runStage.current = s; setStage(s); }, []);

  const key = attempt ? attemptKey(attempt) : null;
  const outcome = poll && poll.key === key ? poll.outcome : null;
  const inFlight = isInFlight(stage);

  const succeed = useCallback((
    a: CreateAttempt, s: { pingInterval: bigint; state: SwitchState }, hash: Hex | null, adopted: boolean,
  ): CreatedSwitch => {
    const c = recordCreated(attemptStore, a, s, hash, adopted);
    setStage("done");
    setError(null);
    void queryClient.invalidateQueries({ queryKey: dmsKeys.switches(a.chainId, a.contract) });
    return c;
  }, [queryClient]);

  // Watch an attempt that reached the wallet while no create() is running:
  // after a receipt timeout, an ambiguous wallet error, or a reload.
  const shouldPoll = !!attempt?.submitted && !inFlight && !created && !!attemptClient;
  useEffect(() => {
    if (!shouldPoll || !attempt || !attemptClient) return;
    const k = attemptKey(attempt);
    return pollAttempt(attemptClient, attempt, pollMem.current, {
      landed: (info) => { succeed(attempt, info, attempt.hash, true); },
      show: (o) => setPoll({ key: k, outcome: o, at: Date.now() }),
    });
  }, [shouldPoll, attempt, attemptClient, succeed, pollNonce]);

  const create = useCallback(async (input: CreateSwitchInput): Promise<CreatedSwitch | null> => {
    if (busy.current) throw new Error("a create is already in progress");
    busy.current = true;
    runStage.current = "sealing";
    setError(null); setFhe(null); attemptStore.setCreated(null); setFailedAt(null);
    const deks: Uint8Array[] = [];
    try {
      if (!account) throw new Error("Connect a wallet first.");
      if (!contract || !client) throw new Error("DeadManSwitch is not deployed on this network.");
      const c = client;
      // Block of the mined tx, once its receipt is in: the read after a revert
      // must not come from a node behind it (readSwitchInfoFresh).
      let minedIn: bigint | undefined;
      const r = await runCreate({
        ctx: { chainId, contract, owner: account },
        store: attemptStore,
        outcome,
        freshId: randomSwitchId,
        readSwitch: (owner, id) => minedIn === undefined
          ? readSwitchInfo(c, { contractAddr: contract, owner, id })
          : readSwitchInfoFresh(c, { contractAddr: contract, owner, id }, minedIn),
        readMinBounty: () => c.readContract({ address: contract, abi: dmsAbi, functionName: "minBounty" }),
        prepare: async () => {
          const plaintext = typeof input.secret === "string" ? new TextEncoder().encode(input.secret) : input.secret;
          const sealed = await seal(plaintext);
          deks.push(sealed.dek);
          enter("encrypting-key");
          const { handle, inputProof } = await encryptDek({
            chainId, contractAddress: contract, userAddress: account, dek: sealed.dek, onProgress: setFhe, signal: input.signal,
          });
          sealed.dek.fill(0);
          return { commitment: sealed.commitment, ciphertext: sealed.ciphertextHex, encKey: handle, inputProof };
        },
        // `account` pinned to the attempt's owner: the input proof is bound to it, so an
        // account switched in the wallet during the FHE step is refused before signing
        // (mayHaveBroadcast) instead of sending a createSwitch that can only revert.
        send: (a, p, pingInterval, value) => writeContractAsync({
          address: contract, abi: dmsWriteAbi, chainId, account: a.owner, functionName: "createSwitch",
          args: [{ id: a.id, pingInterval, plaintextCommitment: p.commitment }, p.ciphertext, p.encKey, p.inputProof],
          value,
        }),
        waitForReceipt: async (hash) => {
          // viem follows a replacement of the tx. Only a speed-up ("repriced",
          // same call) can have created the switch; a cancel or another tx
          // with that nonce did not, whatever its receipt status says.
          const replaced: { reason?: string } = {};
          const receipt = await c.waitForTransactionReceipt({ hash, onReplaced: (x) => { replaced.reason = x.reason; } });
          minedIn = receipt.blockNumber;
          return replaced.reason && replaced.reason !== "repriced" ? "reverted" : receipt.status;
        },
        onStage: enter,
        signal: input.signal,
      }, { pingInterval: BigInt(input.pingInterval), bountyWei: input.bountyWei });

      if (r.kind === "created") return succeed(r.attempt, r, r.hash, r.adopted);
      // Unconfirmed: the stored attempt now carries the hash, so the view
      // shows "unconfirmed" and the poll takes over. Reverted: record the
      // outcome so the view offers a retry with the same id.
      if (r.kind === "reverted") {
        const k = attemptKey(r.attempt);
        pollMem.current.reverted = { key: k, polls: 0 };
        setPoll({ key: k, outcome: "reverted", at: Date.now() });
      }
      setStage("unconfirmed");
      return null;
    } catch (e) {
      setFailedAt(runStage.current);
      setStage("error");
      setError(e instanceof FhevmError ? e.message : errMsg(e));
      throw e;
    } finally {
      for (const d of deks) d.fill(0);
      busy.current = false;
    }
  }, [account, chainId, contract, client, outcome, writeContractAsync, succeed, enter]);

  const createdClient = usePublicClientFor(created?.chainId ?? chainId);
  /** startOver's re-read of the created switch: running (error null), or why it failed. */
  const [startOverCheck, setStartOverCheck] = useState<{ error: string | null } | null>(null);

  /**
   * After a success: back to an empty form (a new form session, so a new id). The switch is read again at
   * the head first (startNewSession): a reorg can hide a create reported after one confirmation, and its
   * transaction then waits to be mined again. If it is missing, its attempt (same id and hash) is followed
   * as unconfirmed instead, so the same secret cannot go into a second switch meanwhile. If the read fails,
   * nothing changes.
   */
  const startOver = useCallback(async () => {
    const c = attemptStore.created();
    if (!c) { setStage("idle"); setFhe(null); setError(null); return; }
    if (!createdClient) {
      setStartOverCheck({ error: `This page cannot reach that network to check that switch #${c.id} is still there, so the form was not reset. Try again.` });
      return;
    }
    setStartOverCheck({ error: null });
    try {
      const r = await startNewSession(attemptStore, (x) => readSwitchInfoFresh(createdClient, { contractAddr: x.contract, owner: x.owner, id: x.id }));
      setStartOverCheck(null);
      if (r.kind !== "changed") { setStage("idle"); setFhe(null); setError(null); }
    } catch (e) {
      setStartOverCheck({ error: `Could not check that switch #${c.id} is still on-chain (${errMsg(e)}), so the form was not reset. Try again.` });
    }
  }, [createdClient]);

  /**
   * Drop an attempt that reached the wallet from another account or network,
   * so that this account can start a new switch. Only after the owner
   * confirmed a warning. Re-reads the switch first (dropAttempt): if it
   * exists, it is shown as created and nothing is dropped; if the reads
   * fail, nothing is dropped either.
   */
  const forgetAttempt = useCallback(async () => {
    const a = attemptStore.get();
    if (!a || dropping.current) return;
    const k = attemptKey(a);
    if (a.submitted && !attemptClient) {
      setDropCheck({ key: k, error: `This page cannot reach that network to check whether switch #${a.id} exists, so nothing was dropped.` });
      return;
    }
    dropping.current = true;
    setDropCheck({ key: k, error: null });
    try {
      const r = await dropAttempt(attemptStore, (x) => readAttemptFresh(attemptClient!, x));
      setDropCheck(null);
      if (r.kind === "landed") succeed(r.attempt, r.snapshot, r.attempt.hash, true);
      else if (r.kind === "dropped") { setStage("idle"); setError(null); }
      else if (r.kind === "awaiting-wallet") {
        setDropCheck({
          key: k,
          error: `Your wallet still has an open request from this page to create switch #${r.attempt.id}, so nothing was dropped: approving it later would create a switch this page no longer tracks. Reject it in the wallet (or approve it and wait), then try again. If the wallet shows no open request, reload the page.`,
        });
      }
    } catch (e) {
      setDropCheck({
        key: k,
        error: `Could not check whether switch #${a.id} exists (${errMsg(e)}), so nothing was dropped. Try again.`,
      });
    } finally {
      dropping.current = false;
    }
  }, [attemptClient, succeed]);

  /**
   * Re-check the attempt now instead of at the next poll. For a reverted
   * hash, also restarts its re-checks (they stop after a few minutes).
   */
  const checkNow = useCallback(() => {
    restartRechecks(pollMem.current);
    setPollNonce((n) => n + 1);
  }, []);

  const view = deriveCreateView({ local: stage, localError: error, attempt, outcome, created: !!created });
  const block = account && contract && !inFlight
    ? submitBlock(attempt, { chainId, contract, owner: account }, outcome)
    : null;

  return {
    create, startOver, forgetAttempt, checkNow,
    stage: view.stage,
    error: view.error,
    /** Heading for `error`. */
    errorTitle: errorTitle(attempt, outcome),
    /**
     * Where the last create() run failed, while its error is shown; null when
     * the error is a sent tx's polled outcome (reverted / vanished).
     */
    failedAt: view.stage === "error" && stage === "error" ? failedAt : null,
    fhe,
    hash: attempt?.hash ?? created?.hash ?? null,
    attempt,
    outcome,
    lastCheckedAt: poll && poll.key === key ? poll.at : null,
    created,
    /** forgetAttempt is re-checking the chain for the attempt's switch. */
    rechecking: !!dropCheck && dropCheck.key === key && dropCheck.error === null,
    /** Why forgetAttempt's re-check failed (nothing was dropped). */
    recheckError: dropCheck && dropCheck.key === key ? dropCheck.error : null,
    /** startOver is re-reading the created switch ("Create another" should wait). */
    startingOver: !!startOverCheck && startOverCheck.error === null,
    /** Why startOver's re-read failed (the card stays). */
    startOverError: startOverCheck?.error ?? null,
    /** Why the current account may not submit now (show that instead of the form), or null. */
    block,
    pending: inFlight,
  };
};

// ---------- flow: fetch the key from the KMS (hunter) ----------

export type KmsKeyStage = "idle" | "decrypting" | "waiting-retry" | "verifying" | "done" | "error";

/**
 * Failures of a KMS key fetch worth retrying with backoff: the KMS has not released the key yet, or Zama's
 * relayer is down or overloaded for now (RELAYER_ERROR: a gateway 5xx, an outage the proxy reported). The
 * watcher retries both too.
 */
export const isRetryableKmsError = (e: unknown): e is FhevmError =>
  e instanceof FhevmError && (e.code === "NOT_DECRYPTABLE_YET" || e.code === "RELAYER_ERROR");

export interface KmsKeyResult {
  /** For revealKey(owner, id, dataKey, decryptionProof). */
  dataKey: Hex;
  decryptionProof: Hex;
  /**
   * Local verification against the on-chain ciphertext. status "invalid-key"
   * → show check.warning and do NOT present the reveal as a success; the
   * contract will still accept revealKey (the proof is valid) and pay out.
   */
  check: KeyCheck;
}

/**
 * After markDark: ask the KMS for the switch's key (one handle), retrying while
 * it is "not decryptable yet" (markDark just mined / KMS catching up), then
 * verify the key opens the ciphertext.
 */
export const useKmsKey = () => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const [stage, setStage] = useState<KmsKeyStage>("idle");
  const [progress, setProgress] = useState<FhevmProgress | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<KmsKeyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Why the fetch is waiting to retry: the KMS has not released the key yet, or the relayer is unavailable. */
  const [retryReason, setRetryReason] = useState<"not-decryptable-yet" | "relayer-unavailable" | null>(null);

  const fetchKey = useCallback(async (
    h: SwitchHandle,
    info: SwitchInfo,
    opts: { signal?: AbortSignal; maxAttempts?: number } = {},
  ): Promise<KmsKeyResult> => {
    setError(null); setResult(null); setAttempt(0); setRetryReason(null);
    try {
      if (!client) throw new Error("no RPC client for this chain");
      const maxAttempts = opts.maxAttempts ?? 20;
      let dec;
      for (let i = 1; ; i++) {
        setAttempt(i);
        setStage("decrypting");
        try {
          dec = await publicDecryptDek({ chainId, handle: info.encKeyHandle, onProgress: setProgress, signal: opts.signal });
          break;
        } catch (e) {
          if (!isRetryableKmsError(e) || i >= maxAttempts) throw e;
          setRetryReason(e.code === "RELAYER_ERROR" ? "relayer-unavailable" : "not-decryptable-yet");
          setStage("waiting-retry");
          const wait = Math.min(30_000, 3_000 * i);
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => { clearTimeout(t); reject(new FhevmError("ABORTED", "cancelled")); };
            const t = setTimeout(() => { opts.signal?.removeEventListener("abort", onAbort); resolve(); }, wait);
            if (opts.signal?.aborted) onAbort();
            else opts.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }
      }
      setStage("verifying");
      const ct = await client.readContract({
        address: h.contractAddr, abi: dmsAbi, functionName: "getCiphertext", args: [h.owner, h.id],
      });
      const check = await checkKey(dec.dekBytes, ct, info.plaintextCommitment);
      const r = { dataKey: dec.dataKey, decryptionProof: dec.decryptionProof, check };
      setResult(r);
      setStage("done");
      return r;
    } catch (e) {
      setStage("error");
      setError(e instanceof FhevmError ? e.message : errMsg(e));
      throw e;
    }
  }, [chainId, client]);

  const reset = useCallback(() => { setStage("idle"); setProgress(null); setResult(null); setError(null); setAttempt(0); setRetryReason(null); }, []);
  return {
    fetchKey, stage, progress, attempt, result, error, reset, pending: stage === "decrypting" || stage === "waiting-retry" || stage === "verifying",
    /** While stage is "waiting-retry": what it is waiting for (RevealPanel words its line by it). */
    retryReason: stage === "waiting-retry" ? retryReason : null,
  };
};
