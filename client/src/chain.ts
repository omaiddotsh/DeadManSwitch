// viem clients and typed wrappers around every DeadManSwitch function the
// client uses. Writes are simulated first (so custom errors decode before any
// gas is spent), then sent, then the receipt is checked. A receipt that
// reverted is explained by replaying the call at its block (TxRevertedError).

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  formatGwei,
  getContractError,
  hexToBytes,
  InsufficientFundsError,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  zeroAddress,
  BaseError,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getTransactionError } from "viem/utils";
import { foundry, mainnet, sepolia } from "viem/chains";
import { dmsAbi } from "./abi.js";
import { CHAIN_NAMES, type Config, type SupportedChainId } from "./config.js";
import {
  decodeRevertData,
  describeError,
  dmsAbiWithHostErrors,
  rawRevertData,
  TxReplacedError,
  TxRevertedError,
  TxTimeoutError,
  UserFacingError,
} from "./errors.js";
import { replacementFees } from "./watcherCore.js";

const feedDecimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

export const viemChainFor = (id: SupportedChainId): Chain => (id === 1 ? mainnet : id === 11155111 ? sepolia : foundry);

export interface Clients {
  chain: Chain;
  publicClient: PublicClient;
  /** Present when PRIVATE_KEY is set. */
  walletClient?: WalletClient;
  account?: PrivateKeyAccount;
}

export const createClients = (cfg: Pick<Config, "chainId" | "rpcUrl" | "privateKey">): Clients => {
  const chain = viemChainFor(cfg.chainId);
  const transport = http(cfg.rpcUrl, { retryCount: 3, timeout: 30_000 });
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  if (!cfg.privateKey) return { chain, publicClient };
  const account = privateKeyToAccount(cfg.privateKey);
  const walletClient = createWalletClient({ account, chain, transport });
  return { chain, publicClient, walletClient, account };
};

// ---------- State ---------- //

/** Mirrors DeadManSwitch.State. */
export const STATE_NAMES = ["NONE", "ALIVE", "DARK", "DARK_MARKED", "REVEALED", "CANCELLED"] as const;
export type StateName = (typeof STATE_NAMES)[number];

export const stateName = (n: number): StateName => {
  const s = STATE_NAMES[n];
  if (!s) throw new Error(`unknown switch state ${n}`);
  return s;
};

export interface SwitchInfo {
  owner: Address;
  state: number;
  stateName: StateName;
  lastPing: bigint;
  pingInterval: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  darkMarkedAt: bigint;
  revealedAt: bigint;
  bounty: bigint;
  ownerStake: bigint;
  plaintextCommitment: Hex;
  encKeyHandle: Hex;
  revealedKey: Hex;
  ciphertextLength: bigint;
  published: boolean;
  rescuable: boolean;
}

export interface ContractStatus {
  address: Address;
  admin: Address;
  pendingAdmin: Address;
  minBountyUsd: bigint;
  minBounty: bigint;
  /** The feed's answer as oraclePrice() returns it: unscaled, in the feed's own decimals. */
  oracle: { ok: boolean; price: bigint };
  ethUsdPriceFeed: Address;
  /** decimals() of ethUsdPriceFeed; null with no feed, or when the feed does not answer. */
  feedDecimals: number | null;
  maxPriceAge: bigint;
  constants: {
    MIN_PING_INTERVAL: bigint;
    MAX_PING_INTERVAL: bigint;
    MAX_PAYLOAD_SIZE: bigint;
    CIPHERTEXT_OVERHEAD: bigint;
    MAX_CIPHERTEXT_SIZE: bigint;
    RESCUE_DELAY: bigint;
    MAX_MIN_BOUNTY_USD: bigint;
  };
}

export interface CreateParams {
  id: bigint;
  pingInterval: bigint;
  plaintextCommitment: Hex;
}

export interface TxResult {
  hash: Hex;
  receipt: TransactionReceipt;
  /** DeadManSwitch events emitted by this transaction. */
  events: ReturnType<typeof parseEventLogs<typeof dmsAbi>>;
}

/** EIP-1559 fee caps passed explicitly to a transaction. */
export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** A broadcast (not yet mined) transaction. */
export interface SentTx {
  hash: Hex;
  nonce: number;
}

/** How the CLI sends one write: the nonce and fees (default: the next nonce at writeFees) and the receipt timeout. */
export interface WriteOpts {
  nonce?: number;
  fees?: Fees;
  /** Default: viem's 180 s. */
  timeoutMs?: number;
  /** Told when the write went out at other fees than asked (see write). */
  onNote?: (msg: string) => void;
}

export type WriteFunctionName =
  | "createSwitch"
  | "ping"
  | "fundBounty"
  | "cancel"
  | "reclaimContribution"
  | "reclaimOwnerStake"
  | "markDark"
  | "revealKey"
  | "publishPlaintext";

export class Dms {
  readonly address: Address;

  constructor(
    readonly clients: Clients,
    address: Address,
  ) {
    this.address = getAddress(address);
  }

  get publicClient(): PublicClient {
    return this.clients.publicClient;
  }

  /** The signer's address; throws when PRIVATE_KEY is not configured. */
  get signer(): Address {
    return this.requireSigner().account.address;
  }

  private requireSigner(): { walletClient: WalletClient; account: PrivateKeyAccount } {
    const { walletClient, account } = this.clients;
    if (!walletClient || !account) throw new UserFacingError("PRIVATE_KEY is required for this command (it sends a transaction)");
    return { walletClient, account };
  }

  /** Fail fast when RPC_URL points at a different chain than CHAIN_ID, or DMS_ADDRESS has no code. */
  async assertDeployment(expectedChainId: SupportedChainId): Promise<void> {
    const actual = await this.publicClient.getChainId();
    if (actual !== expectedChainId) {
      throw new UserFacingError(
        `RPC_URL serves chain ${actual} but CHAIN_ID is ${expectedChainId} (${CHAIN_NAMES[expectedChainId]}); fix your .env`,
      );
    }
    const code = await this.publicClient.getCode({ address: this.address });
    if (!code || code === "0x") throw new UserFacingError(`no contract deployed at DMS_ADDRESS ${this.address} on chain ${actual}`);
  }

  // ---------- Reads ---------- //

  private read<T>(functionName: string, args: readonly unknown[] = [], blockTag: "latest" | "finalized" = "latest"): Promise<T> {
    const at = blockTag === "latest" ? {} : { blockTag };
    return this.publicClient.readContract({ address: this.address, abi: dmsAbi, functionName, args, ...at } as never) as Promise<T>;
  }

  /** getSwitchInfo at the latest block, or at the "finalized" one (what no reorganisation can change any more). */
  async info(owner: Address, id: bigint, blockTag: "latest" | "finalized" = "latest"): Promise<SwitchInfo> {
    const raw = await this.read<Omit<SwitchInfo, "stateName">>("getSwitchInfo", [owner, id], blockTag);
    return { ...raw, stateName: stateName(raw.state) };
  }

  async state(owner: Address, id: bigint): Promise<StateName> {
    return stateName(await this.read<number>("getState", [owner, id]));
  }

  isAlive = (owner: Address, id: bigint) => this.read<boolean>("isAlive", [owner, id]);
  isDark = (owner: Address, id: bigint) => this.read<boolean>("isDark", [owner, id]);

  async ciphertext(owner: Address, id: bigint): Promise<Uint8Array> {
    return hexToBytes(await this.read<Hex>("getCiphertext", [owner, id]));
  }

  revealedKey = (owner: Address, id: bigint) => this.read<Hex>("getRevealedKey", [owner, id]);
  encKeyHandle = (owner: Address, id: bigint) => this.read<Hex>("getEncKeyHandle", [owner, id]);
  bounty = (owner: Address, id: bigint) => this.read<bigint>("getBounty", [owner, id]);
  ownerStake = (owner: Address, id: bigint) => this.read<bigint>("getOwnerStake", [owner, id]);
  funderStake = (owner: Address, id: bigint, funder: Address) => this.read<bigint>("getFunderStake", [owner, id, funder]);
  expirationTime = (owner: Address, id: bigint) => this.read<bigint>("expirationTime", [owner, id]);
  switchKey = (owner: Address, id: bigint) => this.read<Hex>("switchKey", [owner, id]);
  keyHandleUsed = (handle: Hex) => this.read<boolean>("keyHandleUsed", [handle]);
  minBounty = () => this.read<bigint>("minBounty");

  async oraclePrice(): Promise<{ ok: boolean; price: bigint }> {
    const [ok, price] = await this.read<readonly [boolean, bigint]>("oraclePrice");
    return { ok, price };
  }

  async status(): Promise<ContractStatus> {
    const [admin, pendingAdmin, minBountyUsd, minBounty, oracle, ethUsdPriceFeed, maxPriceAge] = await Promise.all([
      this.read<Address>("admin"),
      this.read<Address>("pendingAdmin"),
      this.read<bigint>("minBountyUsd"),
      this.minBounty(),
      this.oraclePrice(),
      this.read<Address>("ethUsdPriceFeed"),
      this.read<bigint>("maxPriceAge"),
    ]);
    const names = [
      "MIN_PING_INTERVAL",
      "MAX_PING_INTERVAL",
      "MAX_PAYLOAD_SIZE",
      "CIPHERTEXT_OVERHEAD",
      "MAX_CIPHERTEXT_SIZE",
      "RESCUE_DELAY",
      "MAX_MIN_BOUNTY_USD",
    ] as const;
    const values = await Promise.all(names.map((n) => this.read<bigint>(n)));
    const constants = Object.fromEntries(names.map((n, i) => [n, values[i]])) as ContractStatus["constants"];
    const feedDecimals = await this.feedDecimals(ethUsdPriceFeed);
    return { address: this.address, admin, pendingAdmin, minBountyUsd, minBounty, oracle, ethUsdPriceFeed, feedDecimals, maxPriceAge, constants };
  }

  /** decimals() of a price feed (the contract accepts up to 36); null for no feed, or one that does not answer. */
  private async feedDecimals(feed: Address): Promise<number | null> {
    if (feed === zeroAddress) return null;
    try {
      return await this.publicClient.readContract({ address: feed, abi: feedDecimalsAbi, functionName: "decimals" });
    } catch {
      return null;
    }
  }

  async latestTimestamp(): Promise<bigint> {
    return (await this.publicClient.getBlock({ blockTag: "latest" })).timestamp;
  }

  /** Conservative per-gas price for profitability checks (EIP-1559 maxFeePerGas, else gasPrice). */
  async gasPrice(): Promise<bigint> {
    try {
      const fees = await this.publicClient.estimateFeesPerGas();
      if (fees.maxFeePerGas) return fees.maxFeePerGas;
    } catch {
      /* fall through to legacy */
    }
    return this.publicClient.getGasPrice();
  }

  /** The latest block's base fee; undefined if the node reports none. */
  async latestBaseFee(): Promise<bigint | undefined> {
    return (await this.publicClient.getBlock({ blockTag: "latest" })).baseFeePerGas ?? undefined;
  }

  /** Current EIP-1559 fee estimate (all supported chains are EIP-1559). */
  async fees(): Promise<Fees> {
    const f = await this.publicClient.estimateFeesPerGas();
    return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  }

  blockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber({ cacheTime: 0 });
  }

  /** The number of the "finalized" block: no reorganisation changes it or anything below it any more. */
  async finalizedBlock(): Promise<bigint> {
    return (await this.publicClient.getBlock({ blockTag: "finalized" })).number;
  }

  /** The signer's transaction count at `latest` (mined) or `pending` (incl. the mempool). */
  async nonce(blockTag: "latest" | "pending" = "latest"): Promise<number> {
    return this.publicClient.getTransactionCount({ address: this.signer, blockTag });
  }

  /** Both counts: `pending` > `latest` while a transaction from this key is not mined yet. */
  async nonces(): Promise<{ latest: number; pending: number }> {
    const [latest, pending] = await Promise.all([this.nonce("latest"), this.nonce("pending")]);
    return { latest, pending };
  }

  /**
   * Fees for a CLI write: the node's suggested tip, and a max fee of twice the latest base fee plus that tip
   * (viem's default allows 1.2×). The base fee can rise 12.5% a block: a ping sent near its deadline should
   * not be priced out by a few full blocks. Only the base fee and the tip are paid.
   */
  async writeFees(): Promise<Fees> {
    const [block, tip] = await Promise.all([this.publicClient.getBlock({ blockTag: "latest" }), this.publicClient.estimateMaxPriorityFeePerGas()]);
    if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) return this.fees();
    return { maxFeePerGas: 2n * block.baseFeePerGas + tip, maxPriorityFeePerGas: tip };
  }

  /**
   * Nonce and fees to send a new call in place of `hash`, a transaction from this key that is not mined
   * yet (`--replace`): its nonce, and fees at least 12.5% above its own and at least writeFees.
   */
  async replacementFor(hash: Hex): Promise<{ nonce: number; fees: Fees }> {
    const signer = this.signer;
    let tx: Awaited<ReturnType<PublicClient["getTransaction"]>>;
    try {
      tx = await this.publicClient.getTransaction({ hash });
    } catch (err) {
      if (!(err instanceof TransactionNotFoundError)) throw err;
      throw new UserFacingError(`--replace: the node does not know ${hash} (dropped from its mempool?); if it is gone, run the command without --replace`);
    }
    if (getAddress(tx.from) !== signer) throw new UserFacingError(`--replace: ${hash} was not sent by your signer ${signer} (it is from ${tx.from})`);
    if (tx.blockNumber !== null) {
      throw new UserFacingError(`--replace: ${hash} was already mined in block ${tx.blockNumber}; nothing to replace (see where things stand with \`dms info\`)`);
    }
    if (tx.nonce < (await this.nonce("latest"))) throw new UserFacingError(`--replace: nonce ${tx.nonce} of ${hash} is already used by a mined transaction; nothing to replace`);
    const old = { maxFeePerGas: tx.maxFeePerGas ?? tx.gasPrice ?? 0n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n };
    const fees = replacementFees(old, await this.writeFees(), 0n);
    if (!fees) throw new Error("internal: no replacement fees without a cap");
    return { nonce: tx.nonce, fees };
  }

  // ---------- Writes ---------- //

  /**
   * Simulate, then broadcast without waiting. Explicit fees (and nonce) are
   * passed through, so a caller's gas-price cap is enforced at send time; an
   * explicit `gas` (the caller's own estimate) saves a second estimate.
   */
  async send(
    functionName: WriteFunctionName,
    args: readonly unknown[],
    opts: { value?: bigint; fees?: Fees; nonce?: number; gas?: bigint } = {},
  ): Promise<SentTx> {
    const { account } = this.requireSigner();
    await this.publicClient.simulateContract({
      address: this.address,
      abi: dmsAbiWithHostErrors,
      functionName,
      args,
      value: opts.value,
      account,
    } as never);
    const nonce = opts.nonce ?? (await this.publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }));
    const data = encodeFunctionData({ abi: dmsAbi, functionName, args } as never);
    try {
      const hash = await this.broadcast({ to: this.address, data, value: opts.value, nonce, gas: opts.gas, ...(opts.fees ?? {}) });
      return { hash, nonce };
    } catch (err) {
      // As writeContract does: a revert while preparing decodes against the contract ABI.
      throw getContractError(err as BaseError, { abi: dmsAbiWithHostErrors, address: this.address, args, functionName, sender: account.address });
    }
  }

  /**
   * Sign locally, then broadcast the raw transaction. Its hash is known before
   * the node answers, so when the request errors or times out although the
   * node accepted the transaction (or an upstream proxy or load balancer
   * retried it into "already known"), the hash is still returned: the caller
   * records and follows it instead of sending a second transaction behind an
   * untracked one.
   */
  private async broadcast(tx: { to?: Address; data?: Hex; value?: bigint; nonce: number; gas?: bigint } & Partial<Fees>): Promise<Hex> {
    const { walletClient, account } = this.requireSigner();
    const chain = this.clients.chain;
    let hash: Hex | undefined;
    try {
      const request = await walletClient.prepareTransactionRequest({ account, chain, ...tx } as never);
      const serialized = await account.signTransaction(request as never, { serializer: chain.serializers?.transaction });
      hash = keccak256(serialized);
      await walletClient.sendRawTransaction({ serializedTransaction: serialized });
      return hash;
    } catch (err) {
      if (hash !== undefined && (await this.knowsTx(hash).catch(() => false))) return hash;
      // As viem's sendTransaction does: name the node's refusal (insufficient funds, nonce too low, underpriced, ...).
      throw getTransactionError(err as BaseError, { ...tx, account, chain } as never);
    }
  }

  /**
   * Wait for a receipt (viem's default timeout is 180 s). Throws TxTimeoutError
   * when it is not mined in time, TxRevertedError when it reverted, and
   * TxReplacedError when another transaction from this key took its nonce.
   */
  async waitFor(functionName: string, hash: Hex, timeoutMs?: number, nonce?: number): Promise<TxResult> {
    let receipt: TransactionReceipt;
    let replaced: { reason: "cancelled" | "replaced" | "repriced"; transaction: { hash: Hex } } | undefined;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
        onReplaced: (r) => {
          replaced = r;
        },
      });
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) throw new TxTimeoutError(functionName, hash, timeoutMs ?? 180_000, nonce);
      throw err;
    }
    // viem follows a same-nonce replacement and returns *its* receipt; only a repriced copy of the same call is this call's outcome.
    if (replaced && replaced.reason !== "repriced") throw new TxReplacedError(functionName, hash, replaced.transaction.hash, replaced.reason);
    return this.settle(functionName, receipt);
  }

  /** The outcome of a transaction sent earlier: undefined while it has no receipt; throws TxRevertedError if it reverted. */
  async txOutcome(functionName: string, hash: Hex): Promise<TxResult | undefined> {
    let receipt: TransactionReceipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash });
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return undefined;
      throw err;
    }
    return this.settle(functionName, receipt);
  }

  private async settle(functionName: string, receipt: TransactionReceipt): Promise<TxResult> {
    if (receipt.status !== "success") throw await this.explainRevert(functionName, receipt);
    const events = parseEventLogs({ abi: dmsAbi, logs: receipt.logs.filter((l) => getAddress(l.address) === this.address) });
    return { hash: receipt.transactionHash, receipt, events };
  }

  /**
   * Decode why a mined transaction reverted: replay the same call (from, to,
   * data, value) with eth_call against the state of its block. That state
   * includes whatever made it fail (e.g. a competitor's markDark / revealKey
   * earlier in the same block), so the custom error is reproduced. A node
   * that no longer has that state (a full, non-archive node keeps about 128
   * blocks) fails the replay without a revert: then it is replayed against
   * the latest state instead, which for markDark / revealKey still shows the
   * race (switch states only move forward).
   */
  async explainRevert(functionName: string, receipt: TransactionReceipt): Promise<TxRevertedError> {
    const reverted = (decoded?: { errorName: string; args: readonly unknown[] }, note?: string) =>
      new TxRevertedError(functionName, receipt.transactionHash, receipt.blockNumber, receipt.gasUsed, decoded?.errorName, decoded?.args, note);
    let tx: Awaited<ReturnType<PublicClient["getTransaction"]>>;
    try {
      tx = await this.publicClient.getTransaction({ hash: receipt.transactionHash });
    } catch (err) {
      return reverted(undefined, `replay failed: ${describeError(err)}`);
    }
    /** The decoded revert, or `failed` when the call errored without revert data (no revert = neither). */
    const replay = async (blockNumber?: bigint): Promise<{ decoded?: ReturnType<typeof decodeRevertData>; failed?: unknown }> => {
      try {
        const at = blockNumber !== undefined ? { blockNumber } : {};
        await this.publicClient.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, ...at });
        return {};
      } catch (err) {
        const raw = rawRevertData(err);
        return raw ? { decoded: decodeRevertData(raw) } : { failed: err };
      }
    };
    const atBlock = await replay(receipt.blockNumber);
    if (atBlock.failed === undefined) return reverted(atBlock.decoded);
    const atLatest = await replay();
    const why = describeError(atBlock.failed);
    if (atLatest.failed !== undefined) return reverted(undefined, `replay failed: ${why}`);
    if (atLatest.decoded) return reverted(atLatest.decoded, `replayed against the latest block; replay at block ${receipt.blockNumber} failed: ${why}`);
    return reverted(undefined, `replay at block ${receipt.blockNumber} failed: ${why}; at the latest block the call no longer reverts`);
  }

  /** Whether the node still knows a transaction (pending or mined); false once it was dropped from the mempool. */
  async knowsTx(hash: Hex): Promise<boolean> {
    try {
      await this.publicClient.getTransaction({ hash });
      return true;
    } catch (err) {
      if (err instanceof TransactionNotFoundError) return false;
      throw err;
    }
  }

  /** Take `nonce` with a 0-value self-transfer (21k gas): replaces whatever is pending at that nonce. */
  async freeNonce(nonce: number, fees: Fees): Promise<Hex> {
    const { account } = this.requireSigner();
    return this.broadcast({ nonce, ...fees, to: account.address, value: 0n, gas: 21_000n });
  }

  /**
   * Replace a pending transaction: same nonce, higher fees. It is re-sent with
   * the same call data, unless that call would now revert (the state moved
   * on); then a 0-value self-transfer takes the nonce instead (21k gas rather
   * than a reverting call that also blocks every later transaction).
   */
  async replace(hash: Hex, nonce: number, fees: Fees): Promise<{ hash: Hex; cancelled: boolean; errorName?: string }> {
    const { account } = this.requireSigner();
    const tx = await this.publicClient.getTransaction({ hash });
    let errorName: string | undefined;
    try {
      await this.publicClient.call({ account: account.address, to: tx.to ?? undefined, data: tx.input, value: tx.value });
    } catch (err) {
      const raw = rawRevertData(err);
      if (!raw) throw err;
      errorName = decodeRevertData(raw)?.errorName ?? "unknown error";
    }
    if (errorName) return { hash: await this.freeNonce(nonce, fees), cancelled: true, errorName };
    const h = await this.broadcast({ nonce, ...fees, to: tx.to ?? undefined, data: tx.input, value: tx.value, gas: tx.gas });
    return { hash: h, cancelled: false };
  }

  /**
   * A CLI write: simulate, send (at writeFees unless `opts` says otherwise), wait for the receipt. The node
   * checks gas × max fee + value against the balance before it takes a transaction, so twice the base fee can
   * refuse a write that viem's usual max fee (1.2 × base fee + tip) fits: then it is sent once more at that,
   * and `onNote` says so.
   */
  private async write(functionName: WriteFunctionName, args: readonly unknown[], value?: bigint, opts: WriteOpts = {}): Promise<TxResult> {
    const fees = opts.fees ?? (await this.writeFees());
    let sent: SentTx;
    try {
      sent = await this.send(functionName, args, { value, fees, nonce: opts.nonce });
    } catch (err) {
      if (opts.fees || !(err instanceof BaseError && err.walk((e) => e instanceof InsufficientFundsError))) throw err;
      const usual = await this.fees();
      if (usual.maxFeePerGas >= fees.maxFeePerGas) throw err;
      opts.onNote?.(
        `the balance does not cover gas at a max fee of ${formatGwei(fees.maxFeePerGas)} gwei (2 × base fee + tip); sent at ${formatGwei(usual.maxFeePerGas)} gwei ` +
          "(1.2 × base fee + tip) instead, so a quick rise in the base fee can leave it pending",
      );
      sent = await this.send(functionName, args, { value, fees: usual, nonce: opts.nonce });
    }
    return this.waitFor(functionName, sent.hash, opts.timeoutMs, sent.nonce);
  }

  private estimate(functionName: WriteFunctionName, args: readonly unknown[], value?: bigint): Promise<bigint> {
    const { account } = this.requireSigner();
    return this.publicClient.estimateContractGas({
      address: this.address,
      abi: dmsAbiWithHostErrors,
      functionName,
      args,
      value,
      account,
    } as never);
  }

  createSwitch(p: CreateParams, ciphertext: Hex, encKeyHandle: Hex, inputProof: Hex, bountyWei: bigint, opts?: WriteOpts): Promise<TxResult> {
    return this.write("createSwitch", [p, ciphertext, encKeyHandle, inputProof], bountyWei, opts);
  }
  ping(id: bigint, opts?: WriteOpts): Promise<TxResult> {
    return this.write("ping", [id], undefined, opts);
  }
  fundBounty(owner: Address, id: bigint, amountWei: bigint, opts?: WriteOpts): Promise<TxResult> {
    return this.write("fundBounty", [owner, id], amountWei, opts);
  }
  cancel(id: bigint, opts?: WriteOpts): Promise<TxResult> {
    return this.write("cancel", [id], undefined, opts);
  }
  reclaimContribution(owner: Address, id: bigint, opts?: WriteOpts): Promise<TxResult> {
    return this.write("reclaimContribution", [owner, id], undefined, opts);
  }
  reclaimOwnerStake(id: bigint, opts?: WriteOpts): Promise<TxResult> {
    return this.write("reclaimOwnerStake", [id], undefined, opts);
  }
  markDark(owner: Address, id: bigint, opts?: WriteOpts): Promise<TxResult> {
    return this.write("markDark", [owner, id], undefined, opts);
  }
  revealKey(owner: Address, id: bigint, dataKey: Hex, decryptionProof: Hex, opts?: WriteOpts): Promise<TxResult> {
    return this.write("revealKey", [owner, id, dataKey, decryptionProof], undefined, opts);
  }
  publishPlaintext(owner: Address, id: bigint, salt: Hex, payload: Hex, opts?: WriteOpts): Promise<TxResult> {
    return this.write("publishPlaintext", [owner, id, salt, payload], undefined, opts);
  }

  estimateMarkDark = (owner: Address, id: bigint) => this.estimate("markDark", [owner, id]);
  estimateRevealKey = (owner: Address, id: bigint, dataKey: Hex, proof: Hex) =>
    this.estimate("revealKey", [owner, id, dataKey, proof]);
  estimatePublish = (owner: Address, id: bigint, salt: Hex, payload: Hex) =>
    this.estimate("publishPlaintext", [owner, id, salt, payload]);

  // ---------- Events ---------- //

  /**
   * The event of a switch's markDark / revealKey / publishPlaintext / cancel in [fromBlock, toBlock] (the contract
   * emits each at most once per switch): who sent it (SwitchDarkMarked.caller, KeyRevealed.revealer,
   * PlaintextPublished.publisher, SwitchCancelled.owner), in which transaction and block. Topic-filtered by the
   * switch key.
   */
  async actionLogs(kind: SwitchActionKind, owner: Address, id: bigint, fromBlock: bigint, toBlock: bigint): Promise<SwitchAction[]> {
    const at = { address: this.address, abi: dmsAbi, fromBlock, toBlock, strict: true } as const;
    const args = { switchKey: keccak256(encodePacked(["address", "uint256"], [owner, id])) };
    switch (kind) {
      case "markDark":
        return (await this.publicClient.getContractEvents({ ...at, eventName: "SwitchDarkMarked", args })).map((l) => ({
          actor: getAddress(l.args.caller),
          hash: l.transactionHash,
          blockNumber: l.blockNumber,
        }));
      case "revealKey":
        return (await this.publicClient.getContractEvents({ ...at, eventName: "KeyRevealed", args })).map((l) => ({
          actor: getAddress(l.args.revealer),
          hash: l.transactionHash,
          blockNumber: l.blockNumber,
        }));
      case "publishPlaintext":
        return (await this.publicClient.getContractEvents({ ...at, eventName: "PlaintextPublished", args })).map((l) => ({
          actor: getAddress(l.args.publisher),
          hash: l.transactionHash,
          blockNumber: l.blockNumber,
        }));
      case "cancel":
        return (await this.publicClient.getContractEvents({ ...at, eventName: "SwitchCancelled", args })).map((l) => ({
          actor: getAddress(l.args.owner),
          hash: l.transactionHash,
          blockNumber: l.blockNumber,
        }));
    }
  }

  /** SwitchCreated logs in [fromBlock, toBlock] (the caller chunks the range). */
  async switchCreatedLogs(fromBlock: bigint, toBlock: bigint): Promise<{ owner: Address; id: bigint; switchKey: Hex; blockNumber: bigint }[]> {
    const logs = await this.publicClient.getContractEvents({
      address: this.address,
      abi: dmsAbi,
      eventName: "SwitchCreated",
      fromBlock,
      toBlock,
      strict: true,
    });
    return logs.map((l) => ({
      owner: getAddress(l.args.owner),
      id: l.args.switchId,
      switchKey: l.args.switchKey,
      blockNumber: l.blockNumber,
    }));
  }
}

/** The actions that move a switch on, each recorded by one event (actionLogs). */
export type SwitchActionKind = "markDark" | "revealKey" | "publishPlaintext" | "cancel";

/** Who took a switch's markDark / revealKey / publish / cancel, as its event records it. */
export interface SwitchAction {
  actor: Address;
  hash: Hex;
  blockNumber: bigint;
}

/** Find the first event with this name in a TxResult. */
export const findEvent = <N extends TxResult["events"][number]["eventName"]>(
  tx: TxResult,
  eventName: N,
): Extract<TxResult["events"][number], { eventName: N }> | undefined =>
  tx.events.find((e) => e.eventName === eventName) as Extract<TxResult["events"][number], { eventName: N }> | undefined;
