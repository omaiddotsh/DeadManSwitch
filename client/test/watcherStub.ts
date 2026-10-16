// In-memory stand-ins for the chain (WatcherDms) and the KMS (Fhevm), so the
// Watcher I/O class can be driven through races, stuck transactions and
// restarts without a node. The contract rules mirror DeadManSwitch's state
// machine for markDark / revealKey / publishPlaintext.

import {
  bytesToHex,
  ContractFunctionRevertedError,
  encodeErrorResult,
  getAddress,
  keccak256,
  parseEther,
  parseGwei,
  toHex,
  TransactionNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { dmsAbi } from "../src/abi.js";
import type { Fees, SentTx, SwitchActionKind, SwitchInfo, TxResult, WriteFunctionName } from "../src/chain.js";
import { STATE_NAMES, type StateName } from "../src/chain.js";
import { seal } from "../src/envelope.js";
import { TxRevertedError, TxTimeoutError } from "../src/errors.js";
import { FhevmError, type DecryptedDek, type Fhevm } from "../src/fhevm.js";
import type { WatcherDms } from "../src/watcher.js";

export const DMS: Address = getAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");
export const OWNER: Address = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
export const SELF: Address = getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
export const COMPETITOR: Address = getAddress("0x90F79bf6EB2c4f870365E785982E1f101E93b906");

interface StubSwitch {
  state: StateName;
  bounty: bigint;
  expiresAt: bigint;
  handle: Hex;
  ciphertext: Uint8Array;
  commitment: Hex;
  dek: Uint8Array;
  revealedKey: Hex;
  published: boolean;
}

interface PoolTx {
  hash: Hex;
  nonce: number;
  kind: WriteFunctionName | "cancel";
  args: readonly unknown[];
  fees?: Fees;
  /** Gas limit passed to send(), if any. */
  gas?: bigint;
}

interface Receipt {
  ok: boolean;
  kind: string;
  errorName?: string;
  block: bigint;
  gasUsed: bigint;
  events: { eventName: string; args: Record<string, unknown> }[];
}

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const key = (owner: Address, id: bigint) => `${owner.toLowerCase()}/${id}`;

/** What viem throws from simulateContract / estimateContractGas for a custom-error revert. */
export const simulatedRevert = (functionName: string, errorName: string) =>
  new ContractFunctionRevertedError({ abi: dmsAbi, data: encodeErrorResult({ abi: dmsAbi, errorName } as never), functionName });

/** A switch's markDark / revealKey / publish as its event records it (SwitchDarkMarked.caller, KeyRevealed.revealer, PlaintextPublished.publisher). */
interface Action {
  kind: SwitchActionKind;
  owner: Address;
  id: bigint;
  actor: Address;
  hash: Hex;
  block: bigint;
}

export class StubChain implements WatcherDms {
  readonly address = DMS;
  readonly signer = SELF;
  head = 100n;
  time = 10_000n;
  switches = new Map<string, StubSwitch>();
  logs: { owner: Address; id: bigint; blockNumber: bigint }[] = [];
  latestNonce = 0;
  pool: PoolTx[] = [];
  receipts = new Map<Hex, Receipt>();
  market: Fees = { maxFeePerGas: parseGwei("10"), maxPriorityFeePerGas: parseGwei("1") };
  /** Every eth_getLogs range asked for. */
  logCalls: [bigint, bigint][] = [];
  /** Every transaction we broadcast (incl. replacements), in order. */
  sent: PoolTx[] = [];
  /** The events of every markDark / revealKey / publish that took effect (ours and competitors'), in order. */
  actions: Action[] = [];
  /** waitFor() times out instead of mining (an underpriced tx). */
  stuck = false;
  /**
   * Set: mine() works like a real node. It includes our transactions in nonce
   * order only, each only while its max fee covers this base fee; the rest stay
   * in the pool (so an underpriced one holds up every later nonce).
   */
  baseFee?: bigint;
  /** Runs inside waitFor() just before our tx is mined: lets a test land a competitor first, in the same block. */
  beforeMine?: (tx: PoolTx) => void;
  /** Make a getLogs call fail. */
  failLogs?: (from: bigint, to: bigint, call: number) => Error | undefined;
  /** Set (holdFinality): what reads at the "finalized" block see, and that block's number. Unset: every block is final. */
  finalizedView?: Map<string, StubSwitch>;
  finalizedHead?: bigint;
  private seq = 0;

  /** Blocks from now on are not final: reads at "finalized" see the switches as they are now. */
  holdFinality(): void {
    this.finalizedView = new Map([...this.switches].map(([k, s]) => [k, { ...s }]));
    this.finalizedHead = this.head;
  }

  /** Every block so far is final. */
  finalizeAll(): void {
    this.finalizedView = undefined;
    this.finalizedHead = undefined;
  }

  async addSwitch(id: bigint, opts: { state?: StateName; bounty?: bigint; plaintext?: string; owner?: Address } = {}): Promise<{ plaintext: string }> {
    const owner = opts.owner ?? OWNER;
    const plaintext = opts.plaintext ?? `secret of switch ${id}`;
    const sealed = await seal(new TextEncoder().encode(plaintext));
    this.head += 1n;
    this.switches.set(key(owner, id), {
      state: opts.state ?? "DARK",
      bounty: opts.bounty ?? parseEther("0.01"),
      expiresAt: this.time - 1n,
      handle: keccak256(toHex(`handle-${key(owner, id)}`)),
      ciphertext: sealed.ciphertext,
      commitment: sealed.commitment,
      dek: sealed.dek,
      revealedKey: opts.state === "REVEALED" ? bytesToHex(sealed.dek) : ZERO32,
      published: false,
    });
    this.logs.push({ owner, id, blockNumber: this.head });
    return { plaintext };
  }

  sw(id: bigint, owner: Address = OWNER): StubSwitch {
    const s = this.switches.get(key(owner, id));
    if (!s) throw new Error(`no stub switch ${id}`);
    return s;
  }

  // ---------- contract rules ---------- //

  /** The custom error this call reverts with right now, if any. */
  private check(kind: WriteFunctionName, args: readonly unknown[]): string | undefined {
    const s = this.switches.get(key(args[0] as Address, args[1] as bigint));
    if (!s) return "DoesNotExist";
    switch (kind) {
      case "markDark":
        return s.state === "DARK" ? undefined : s.state === "DARK_MARKED" ? "AlreadyDarkMarked" : s.state === "ALIVE" ? "NotDark" : "NotActive";
      case "revealKey":
        if (s.state === "REVEALED") return "AlreadyRevealed";
        if (s.state !== "DARK_MARKED") return "NotDarkMarked";
        return (args[2] as Hex).toLowerCase() === bytesToHex(s.dek) ? undefined : "InvalidKMSSignatures";
      case "publishPlaintext":
        return s.state !== "REVEALED" ? "NotRevealed" : s.published ? "AlreadyPublished" : undefined;
      default:
        return "Unauthorized";
    }
  }

  /** Apply a call to the state (mined, by transaction `hash`); returns its revert error or its events. */
  apply(kind: WriteFunctionName | "cancel", args: readonly unknown[], from: Address, hash: Hex = keccak256(toHex(`other-${++this.seq}`))): Pick<Receipt, "ok" | "errorName" | "events"> {
    if (kind === "cancel") return { ok: true, events: [] };
    const err = this.check(kind, args);
    if (err) return { ok: false, errorName: err, events: [] };
    const s = this.sw(args[1] as bigint, args[0] as Address);
    if (kind === "markDark" || kind === "revealKey" || kind === "publishPlaintext") {
      this.actions.push({ kind, owner: args[0] as Address, id: args[1] as bigint, actor: from, hash, block: this.head });
    }
    if (kind === "markDark") {
      s.state = "DARK_MARKED";
      return { ok: true, events: [{ eventName: "SwitchDarkMarked", args: { encKeyHandle: s.handle } }] };
    }
    if (kind === "revealKey") {
      const paid = s.bounty;
      s.state = "REVEALED";
      s.revealedKey = args[2] as Hex;
      s.bounty = 0n;
      return { ok: true, events: [{ eventName: "KeyRevealed", args: { bountyPaid: paid, revealer: from } }] };
    }
    s.published = true;
    return { ok: true, events: [{ eventName: "PlaintextPublished", args: {} }] };
  }

  /** A competitor's transaction lands (directly, as if earlier in the block). */
  competitor(kind: WriteFunctionName, id: bigint): void {
    const s = this.sw(id);
    const args = kind === "revealKey" ? [OWNER, id, bytesToHex(s.dek), "0x01"] : [OWNER, id];
    const r = this.apply(kind, args, COMPETITOR);
    if (!r.ok) throw new Error(`competitor ${kind} reverted ${r.errorName}`);
  }

  /** Mine every pooled transaction (ours), highest tip first, one block (with `baseFee` set: see there). */
  mine(): void {
    this.head += 1n;
    this.time += 12n;
    const include = (tx: PoolTx) => {
      const r = this.apply(tx.kind, tx.args, SELF, tx.hash);
      this.receipts.set(tx.hash, { ...r, kind: tx.kind, block: this.head, gasUsed: r.ok ? 60_000n : 30_000n });
      this.latestNonce = Math.max(this.latestNonce, tx.nonce + 1);
    };
    if (this.baseFee !== undefined) {
      for (;;) {
        const tx = this.pool.find((p) => p.nonce === this.latestNonce);
        if (!tx || (tx.fees?.maxFeePerGas ?? 0n) < this.baseFee) return;
        this.pool = this.pool.filter((p) => p !== tx);
        include(tx);
      }
    }
    const txs = [...this.pool].sort((a, b) => Number((b.fees?.maxPriorityFeePerGas ?? 0n) - (a.fees?.maxPriorityFeePerGas ?? 0n)));
    this.pool = [];
    for (const tx of txs) include(tx);
  }

  /** Mine one particular broadcast (e.g. an original that a replacement was meant to supersede); the node drops the others with its nonce. */
  mineOnly(hash: Hex): void {
    const tx = this.sent.find((p) => p.hash === hash);
    if (!tx) throw new Error(`never sent ${hash}`);
    this.pool = this.pool.filter((p) => p.nonce !== tx.nonce);
    this.pool.push(tx);
    this.mine();
  }

  private settle(hash: Hex): TxResult {
    const r = this.receipts.get(hash)!;
    if (!r.ok) throw new TxRevertedError(r.kind, hash, r.block, r.gasUsed, r.errorName);
    return { hash, receipt: { gasUsed: r.gasUsed, status: "success", blockNumber: r.block } as never, events: r.events as never };
  }

  // ---------- WatcherDms ---------- //

  async blockNumber(): Promise<bigint> {
    return this.head;
  }

  async finalizedBlock(): Promise<bigint> {
    return this.finalizedHead ?? this.head;
  }

  async switchCreatedLogs(fromBlock: bigint, toBlock: bigint) {
    this.logCalls.push([fromBlock, toBlock]);
    const err = this.failLogs?.(fromBlock, toBlock, this.logCalls.length);
    if (err) throw err;
    return this.logs
      .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
      .map((l) => ({ ...l, switchKey: keccak256(toHex(key(l.owner, l.id))) }));
  }

  async latestTimestamp(): Promise<bigint> {
    return this.time;
  }

  async info(owner: Address, id: bigint, blockTag: "latest" | "finalized" = "latest"): Promise<SwitchInfo> {
    const s = (blockTag === "finalized" && this.finalizedView ? this.finalizedView : this.switches).get(key(owner, id));
    const state = s?.state ?? "NONE";
    return {
      owner: s ? owner : getAddress("0x0000000000000000000000000000000000000000"),
      state: STATE_NAMES.indexOf(state),
      stateName: state,
      lastPing: 0n,
      pingInterval: 60n,
      createdAt: 0n,
      expiresAt: s?.expiresAt ?? 0n,
      darkMarkedAt: 0n,
      revealedAt: 0n,
      bounty: s?.bounty ?? 0n,
      ownerStake: 0n,
      plaintextCommitment: s?.commitment ?? ZERO32,
      encKeyHandle: s?.handle ?? ZERO32,
      revealedKey: s?.revealedKey ?? ZERO32,
      ciphertextLength: BigInt(s?.ciphertext.length ?? 0),
      published: s?.published ?? false,
      rescuable: false,
    };
  }

  async ciphertext(owner: Address, id: bigint): Promise<Uint8Array> {
    return this.sw(id, owner).ciphertext;
  }

  async estimateMarkDark(owner: Address, id: bigint): Promise<bigint> {
    const err = this.check("markDark", [owner, id]);
    if (err) throw simulatedRevert("markDark", err);
    return 60_000n;
  }

  async estimateRevealKey(owner: Address, id: bigint, dataKey: Hex, proof: Hex): Promise<bigint> {
    const err = this.check("revealKey", [owner, id, dataKey, proof]);
    if (err) throw simulatedRevert("revealKey", err);
    return 150_000n;
  }

  async fees(): Promise<Fees> {
    return { ...this.market };
  }

  async latestBaseFee(): Promise<bigint | undefined> {
    return this.baseFee;
  }

  async send(functionName: WriteFunctionName, args: readonly unknown[], opts: { fees?: Fees; nonce?: number; gas?: bigint } = {}): Promise<SentTx> {
    const err = this.check(functionName, args);
    if (err) throw simulatedRevert(functionName, err);
    const tx: PoolTx = {
      hash: keccak256(toHex(`tx-${++this.seq}`)),
      nonce: opts.nonce ?? this.latestNonce + this.pool.length,
      kind: functionName,
      args,
      fees: opts.fees,
      ...(opts.gas !== undefined ? { gas: opts.gas } : {}),
    };
    this.pool.push(tx);
    this.sent.push(tx);
    return { hash: tx.hash, nonce: tx.nonce };
  }

  async waitFor(functionName: string, hash: Hex, timeoutMs?: number): Promise<TxResult> {
    if (this.stuck) throw new TxTimeoutError(functionName, hash, timeoutMs ?? 180_000);
    const tx = this.pool.find((p) => p.hash === hash);
    if (tx) {
      this.beforeMine?.(tx);
      this.mine();
    }
    if (!this.receipts.has(hash)) throw new TxTimeoutError(functionName, hash, timeoutMs ?? 180_000);
    return this.settle(hash);
  }

  async txOutcome(_functionName: string, hash: Hex): Promise<TxResult | undefined> {
    return this.receipts.has(hash) ? this.settle(hash) : undefined;
  }

  async replace(hash: Hex, nonce: number, fees: Fees): Promise<{ hash: Hex; cancelled: boolean; errorName?: string }> {
    const old = this.pool.find((p) => p.hash === hash);
    if (!old) throw new TransactionNotFoundError({ hash });
    const errorName = old.kind === "cancel" ? undefined : this.check(old.kind, old.args);
    const tx: PoolTx = {
      hash: keccak256(toHex(`tx-${++this.seq}`)),
      nonce,
      kind: errorName ? "cancel" : old.kind,
      args: errorName ? [] : old.args,
      fees,
    };
    this.pool = this.pool.filter((p) => p.hash !== hash).concat(tx);
    this.sent.push(tx);
    return { hash: tx.hash, cancelled: !!errorName, errorName };
  }

  async freeNonce(nonce: number, fees: Fees): Promise<Hex> {
    const tx: PoolTx = { hash: keccak256(toHex(`tx-${++this.seq}`)), nonce, kind: "cancel", args: [], fees };
    this.pool = this.pool.filter((p) => p.nonce !== nonce).concat(tx);
    this.sent.push(tx);
    return tx.hash;
  }

  async actionLogs(kind: Action["kind"], owner: Address, id: bigint, fromBlock: bigint, toBlock: bigint) {
    return this.actions
      .filter((a) => a.kind === kind && a.owner.toLowerCase() === owner.toLowerCase() && a.id === id && a.block >= fromBlock && a.block <= toBlock)
      .map((a) => ({ actor: a.actor, hash: a.hash, blockNumber: a.block }));
  }

  async knowsTx(hash: Hex): Promise<boolean> {
    return this.receipts.has(hash) || this.pool.some((p) => p.hash === hash);
  }

  async nonce(blockTag: "latest" | "pending" = "latest"): Promise<number> {
    return blockTag === "latest" ? this.latestNonce : this.latestNonce + this.pool.length;
  }
}

/** KMS stand-in: serves a switch's key once it is DARK_MARKED (or later). */
export class StubKms implements Fhevm {
  readonly chain = {} as Fhevm["chain"];
  calls = 0;
  /** Throw this instead of answering (e.g. a fatal 401). */
  failWith?: () => Error;
  /** Runs before answering: lets a test change the chain meanwhile. */
  onDecrypt?: (handle: Hex) => void;

  constructor(private readonly chain_: StubChain) {}

  async encryptDek(): Promise<never> {
    throw new Error("not used");
  }

  async publicDecryptDek(handle: Hex): Promise<DecryptedDek> {
    this.calls++;
    if (this.failWith) throw this.failWith();
    this.onDecrypt?.(handle);
    const s = [...this.chain_.switches.values()].find((x) => x.handle === handle);
    if (!s || s.state === "ALIVE" || s.state === "DARK" || s.state === "CANCELLED") throw new FhevmError(`public decryption of ${handle} refused or failed: not decryptable`);
    const dek = Uint8Array.from(s.dek);
    return { dek, dataKey: bytesToHex(s.dek), decryptionProof: "0x01" };
  }

  close(): void {}
}
