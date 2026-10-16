// A JSON-RPC node (fakeNode) that is just chain enough for `dms` write commands driven through real viem
// clients: it answers DeadManSwitch views from a table, simulates writes (optionally reverting with a custom
// error), takes signed raw transactions, mines them at once (or leaves them pending) and serves receipts.

import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, getAbiItem, keccak256, parseGwei, parseTransaction, toHex, type AbiFunction, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dmsAbi } from "../src/abi.js";
import type { Fhevm } from "../src/fhevm.js";
import { fakeNode, rpcError } from "./fakeNode.js";
import { DMS } from "./watcherStub.js";

export const SIGNER_KEY = `0x${"33".repeat(32)}` as const;
export const SIGNER: Address = privateKeyToAccount(SIGNER_KEY).address;

export interface SentRaw {
  hash: Hex;
  nonce: number;
  functionName: string;
  value: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** A transaction the node knows (eth_getTransactionByHash), e.g. one an earlier run left pending. */
export interface KnownTx {
  hash: Hex;
  from: Address;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  blockNumber?: bigint;
}

export interface ChainSim {
  url: string;
  /** The signer's mined (`latest`) and mempool-inclusive (`pending`) transaction counts. */
  nonces: { latest: number; pending: number };
  baseFee: bigint;
  tip: bigint;
  /** DeadManSwitch views: function name → result, or a function of the call count. */
  reads: Record<string, unknown>;
  /** Writes whose simulation reverts with this custom error. */
  reverts: Record<string, string>;
  /** Mine every broadcast at once (false: it stays pending, no receipt). */
  mines: boolean;
  /** The signer's balance: like geth, a transaction (or gas estimate) whose gas × max fee + value exceeds it is refused. */
  balance: bigint;
  /** Answers eth_getTransactionCount instead of `nonces` (say, from backends at different heights). */
  nonceAnswer?: (tag: "latest" | "pending") => number;
  sent: SentRaw[];
  known: Map<Hex, KnownTx>;
}

const BLOCK = 1_000n;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

const txJson = (t: KnownTx) => ({
  hash: t.hash,
  from: t.from,
  to: DMS,
  input: "0x",
  value: "0x0",
  nonce: toHex(t.nonce),
  gas: "0x30d40",
  maxFeePerGas: toHex(t.maxFeePerGas),
  maxPriorityFeePerGas: toHex(t.maxPriorityFeePerGas),
  type: "0x2",
  blockHash: t.blockNumber !== undefined ? ZERO32.replace(/0$/, "1") : null,
  blockNumber: t.blockNumber !== undefined ? toHex(t.blockNumber) : null,
  transactionIndex: t.blockNumber !== undefined ? "0x0" : null,
  chainId: "0x7a69",
  v: "0x0",
  r: "0x1",
  s: "0x1",
  yParity: "0x0",
  accessList: [],
});

/** Start a chain-31337 node; `init` overrides the defaults (nonces 5/5, base fee 10 gwei, tip 1 gwei, mining on). */
export const chainSim = async (init: Partial<Omit<ChainSim, "url" | "sent" | "known">> = {}): Promise<ChainSim> => {
  const sim: ChainSim = {
    url: "",
    nonces: { latest: 5, pending: 5 },
    baseFee: parseGwei("10"),
    tip: parseGwei("1"),
    reads: {},
    reverts: {},
    mines: true,
    balance: 10n ** 20n,
    sent: [],
    known: new Map(),
    ...init,
  };
  const receipts = new Map<Hex, Record<string, unknown>>();
  const block = (n: bigint) => ({
    number: toHex(n),
    hash: keccak256(toHex(`block-${n}`)),
    parentHash: keccak256(toHex(`block-${n - 1n}`)),
    timestamp: toHex(1_700_000_000n + n * 12n),
    baseFeePerGas: toHex(sim.baseFee),
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    miner: DMS,
    difficulty: "0x0",
    extraData: "0x",
    logsBloom: `0x${"00".repeat(256)}`,
    nonce: "0x0000000000000000",
    sha3Uncles: ZERO32,
    size: "0x100",
    stateRoot: ZERO32,
    transactionsRoot: ZERO32,
    receiptsRoot: ZERO32,
    mixHash: ZERO32,
    totalDifficulty: "0x0",
    transactions: [],
    uncles: [],
  });
  /** geth's up-front check: gas × max fee + value must fit the balance. */
  const affordable = (gas: bigint, maxFeePerGas: bigint | undefined, value: bigint | undefined) => {
    if (gas * (maxFeePerGas ?? 0n) + (value ?? 0n) > sim.balance) {
      throw rpcError(-32000, `insufficient funds for gas * price + value: balance ${sim.balance}, tx cost ${gas * (maxFeePerGas ?? 0n) + (value ?? 0n)}`);
    }
  };
  const revertData = (functionName: string) => {
    const errorName = sim.reverts[functionName];
    return errorName ? encodeErrorResult({ abi: dmsAbi, errorName } as never) : undefined;
  };
  sim.url = await fakeNode((method, params) => {
    switch (method) {
      case "eth_chainId":
        return toHex(31337);
      case "eth_getCode":
        return "0x6000";
      case "eth_getBalance":
        return toHex(sim.balance);
      case "eth_blockNumber":
        return toHex(BLOCK);
      case "eth_getBlockByNumber":
        return block(BLOCK);
      case "eth_maxPriorityFeePerGas":
        return toHex(sim.tip);
      case "eth_getTransactionCount": {
        const tag = params[1] === "pending" ? "pending" : "latest";
        return toHex(sim.nonceAnswer?.(tag) ?? sim.nonces[tag]);
      }
      case "eth_call":
      case "eth_estimateGas": {
        const { data, maxFeePerGas, value } = params[0] as { data: Hex; maxFeePerGas?: Hex; value?: Hex };
        const { functionName } = decodeFunctionData({ abi: dmsAbi, data });
        const reverted = revertData(functionName);
        if (reverted) throw Object.assign(rpcError(3, "execution reverted"), { data: reverted });
        if (method === "eth_estimateGas") {
          affordable(0x30d40n, maxFeePerGas !== undefined ? BigInt(maxFeePerGas) : undefined, value !== undefined ? BigInt(value) : undefined);
          return "0x30d40";
        }
        if (!(functionName in sim.reads)) {
          // a write's simulation: zero values for whatever it returns (createSwitch: its switch key)
          const fn = getAbiItem({ abi: dmsAbi, name: functionName } as never) as AbiFunction | undefined;
          return `0x${"00".repeat(32 * (fn?.outputs.length ?? 0))}`;
        }
        const r = sim.reads[functionName];
        return encodeFunctionResult({ abi: dmsAbi, functionName, result: typeof r === "function" ? r() : r } as never);
      }
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw);
        affordable(tx.gas ?? 0n, tx.maxFeePerGas, tx.value);
        const hash = keccak256(raw);
        const { functionName } = decodeFunctionData({ abi: dmsAbi, data: tx.data ?? "0x" });
        const nonce = tx.nonce ?? 0;
        sim.sent.push({ hash, nonce, functionName, value: tx.value ?? 0n, maxFeePerGas: tx.maxFeePerGas ?? 0n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n });
        const known: KnownTx = { hash, from: SIGNER, nonce, maxFeePerGas: tx.maxFeePerGas ?? 0n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n };
        sim.nonces.pending = Math.max(sim.nonces.pending, nonce + 1);
        if (sim.mines) {
          known.blockNumber = BLOCK;
          sim.nonces.latest = Math.max(sim.nonces.latest, nonce + 1);
          receipts.set(hash, {
            transactionHash: hash,
            transactionIndex: "0x0",
            blockHash: keccak256(toHex(`block-${BLOCK}`)),
            blockNumber: toHex(BLOCK),
            from: SIGNER,
            to: DMS,
            cumulativeGasUsed: "0x30d40",
            gasUsed: "0x30d40",
            effectiveGasPrice: toHex(sim.baseFee + sim.tip),
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            type: "0x2",
            contractAddress: null,
          });
        }
        sim.known.set(hash, known);
        return hash;
      }
      case "eth_getTransactionReceipt":
        return receipts.get(params[0] as Hex) ?? null;
      case "eth_getTransactionByHash": {
        const t = sim.known.get(params[0] as Hex);
        return t ? txJson(t) : null;
      }
      default:
        throw rpcError(-32601, `unexpected ${method}`);
    }
  });
  return sim;
};

/** KMS / FHE stand-in for `create` (a fixed handle) and `reveal` (serves `dek`). */
export const fheStub = (dek?: Uint8Array) => async (): Promise<Fhevm> => ({
  chain: {} as Fhevm["chain"],
  encryptDek: async () => ({ handle: `0x${"ab".repeat(32)}`, inputProof: "0x01" }),
  publicDecryptDek: async () => {
    if (!dek) throw new Error("no key");
    return { dek: Uint8Array.from(dek), dataKey: toHex(dek), decryptionProof: "0x01" };
  },
  close: () => undefined,
});
