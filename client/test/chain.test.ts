// Dms.explainRevert against a fake public client: how a reverted receipt is
// explained when the node can, or can no longer, replay the call at its block.

import { BaseError, encodeErrorResult, keccak256, RawContractError, toHex, TransactionNotFoundError, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { describe, expect, it } from "vitest";
import { dmsAbi } from "../src/abi.js";
import { createClients, Dms } from "../src/chain.js";
import { describeError, TxReplacedError } from "../src/errors.js";
import { fakeNode, rpcError } from "./fakeNode.js";
import { DMS, SELF } from "./watcherStub.js";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const receipt = { transactionHash: HASH, blockNumber: 1_000n, gasUsed: 30_000n, status: "reverted", logs: [] } as unknown as TransactionReceipt;

const revertWith = (errorName: string) => new RawContractError({ data: encodeErrorResult({ abi: dmsAbi, errorName } as never) });
const pruned = () => new BaseError("missing trie node 0x1234 (path ) state is not available");

/** A Dms whose eth_call answers with `call(blockNumber)` (undefined = latest). */
const dmsReplaying = (call: (blockNumber: bigint | undefined) => unknown) => {
  const calls: (bigint | undefined)[] = [];
  const publicClient = {
    getTransaction: async () => ({ from: SELF, to: DMS, input: "0x1234", value: 0n }),
    call: async (a: { blockNumber?: bigint }) => {
      calls.push(a.blockNumber);
      const r = call(a.blockNumber);
      if (r instanceof Error) throw r;
      return { data: undefined };
    },
  };
  return { dms: new Dms({ chain: foundry, publicClient } as never, DMS), calls };
};

describe("Dms.explainRevert", () => {
  it("decodes the custom error by replaying the call at the transaction's block", async () => {
    const { dms, calls } = dmsReplaying(() => revertWith("AlreadyRevealed"));
    const err = await dms.explainRevert("revealKey", receipt);
    expect(err.errorName).toBe("AlreadyRevealed");
    expect(calls).toEqual([1_000n]);
  });

  it("replays against the latest state when the node no longer has the block's state (non-archive node)", async () => {
    const { dms, calls } = dmsReplaying((b) => (b !== undefined ? pruned() : revertWith("AlreadyRevealed")));
    const err = await dms.explainRevert("revealKey", receipt);
    expect(err.errorName).toBe("AlreadyRevealed");
    expect(calls).toEqual([1_000n, undefined]);
    expect(err.message).toMatch(/AlreadyRevealed.*replayed against the latest block; replay at block 1000 failed: missing trie node/);
  });

  it("says that the replay failed, rather than 'could not be reproduced', when no state can be read", async () => {
    const { dms } = dmsReplaying(() => pruned());
    const err = await dms.explainRevert("revealKey", receipt);
    expect(err.errorName).toBeUndefined();
    expect(err.message).toMatch(/could not be reproduced \(replay failed: missing trie node/);
  });

  it("keeps the old explanation when the replay at the block does not revert", async () => {
    const { dms, calls } = dmsReplaying(() => undefined);
    const err = await dms.explainRevert("markDark", receipt);
    expect(err.errorName).toBeUndefined();
    expect(calls).toEqual([1_000n]);
    expect(err.message).toMatch(/could not be reproduced \(out of gas, or state changed again since\)/);
  });
});

describe("Dms.waitFor", () => {
  const H2 = `0x${"cd".repeat(32)}` as Hex;
  /** A node on which `HASH`'s nonce was taken by H2: viem's waitForTransactionReceipt follows it and returns H2's receipt. */
  const dmsReplacedBy = (reason: "cancelled" | "replaced" | "repriced") => {
    const publicClient = {
      waitForTransactionReceipt: async ({ onReplaced }: { onReplaced?: (r: unknown) => void }) => {
        const r = { transactionHash: H2, status: "success", logs: [], blockNumber: 5n, gasUsed: 21_000n };
        onReplaced?.({ reason, replacedTransaction: { hash: HASH }, transaction: { hash: H2 }, transactionReceipt: r });
        return r;
      },
    };
    return new Dms({ chain: foundry, publicClient } as never, DMS);
  };

  it("does not report a transaction whose nonce another transaction took (cancelled in a wallet) as its own success", async () => {
    for (const reason of ["cancelled", "replaced"] as const) {
      const err = await dmsReplacedBy(reason).waitFor("ping", HASH).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TxReplacedError);
      expect((err as Error).message).toMatch(new RegExp(`ping transaction ${HASH} was ${reason} by ${H2} .*the call did not run`));
    }
  });

  it("a repriced replacement (same call, higher fees) is the call's own outcome", async () => {
    expect((await dmsReplacedBy("repriced").waitFor("ping", HASH)).hash).toBe(H2);
  });
});

describe("Dms.knowsTx / freeNonce", () => {
  it("knowsTx is false once the node has dropped the transaction, and passes other RPC errors on", async () => {
    let answer: () => unknown = () => ({ hash: HASH });
    const publicClient = {
      getTransaction: async ({ hash }: { hash: Hex }) => {
        const r = answer();
        if (r === undefined) throw new TransactionNotFoundError({ hash }); // what viem throws for a null result
        if (r instanceof Error) throw r;
        return r;
      },
    };
    const dms = new Dms({ chain: foundry, publicClient } as never, DMS);
    expect(await dms.knowsTx(HASH)).toBe(true);
    answer = () => undefined;
    expect(await dms.knowsTx(HASH)).toBe(false);
    answer = () => new BaseError("HTTP request failed. Status: 502");
    await expect(dms.knowsTx(HASH)).rejects.toThrow(/502/);
  });

  it("freeNonce sends a 0-value, 21k-gas self-transfer at the given nonce and fees", async () => {
    const { dms, known, prepared, account } = signingNode(() => "ok");
    const fees = { maxFeePerGas: 13n, maxPriorityFeePerGas: 2n };
    const hash = await dms.freeNonce(7, fees);
    expect(known.has(hash)).toBe(true);
    expect(prepared).toEqual([expect.objectContaining({ to: account.address, value: 0n, gas: 21_000n, nonce: 7, ...fees })]);
  });
});

/**
 * A node that signs nothing itself: the Dms signs locally and broadcasts raw. `answer` decides what
 * eth_sendRawTransaction does: accept, accept but lose the answer (a gateway timeout that viem retries
 * into "already known"), or reject.
 */
const signingNode = (answer: () => "ok" | "lost" | Error) => {
  const known = new Set<Hex>();
  const prepared: Record<string, unknown>[] = [];
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const publicClient = {
    simulateContract: async () => ({ request: {} }),
    getTransactionCount: async () => 7,
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (!known.has(hash)) throw new TransactionNotFoundError({ hash });
      return { hash };
    },
  };
  const walletClient = {
    prepareTransactionRequest: async (r: Record<string, unknown>) => {
      prepared.push(r);
      return { ...r, chainId: foundry.id, type: "eip1559", gas: r.gas ?? 50_000n };
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      const a = answer();
      if (a instanceof Error) throw a;
      known.add(keccak256(serializedTransaction));
      if (a === "lost") throw new BaseError("already known");
      return keccak256(serializedTransaction);
    },
  };
  return { dms: new Dms({ chain: foundry, publicClient, walletClient, account } as never, DMS), known, prepared, account };
};

describe("Dms.send", () => {
  const fees = { maxFeePerGas: 13n, maxPriorityFeePerGas: 2n };

  it("returns the hash of a transaction the node accepted even when its answer was lost, so the caller records it", async () => {
    const { dms, known, prepared } = signingNode(() => "lost");
    const sent = await dms.send("ping", [1n], { fees, gas: 31_000n });
    expect(sent.nonce).toBe(7);
    expect(known.has(sent.hash)).toBe(true);
    // the caller's gas estimate is used as is: no second eth_estimateGas
    expect(prepared).toEqual([expect.objectContaining({ to: DMS, nonce: 7, gas: 31_000n, ...fees })]);
  });

  it("fails with the node's error when the node does not have the transaction", async () => {
    const { dms } = signingNode(() => new BaseError("insufficient funds for gas * price + value"));
    await expect(dms.send("ping", [1n], { fees })).rejects.toThrow(/insufficient funds/);
  });
});

describe("Dms.send / freeNonce through viem against a JSON-RPC node", () => {
  const fees = { maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  /** A node whose eth_sendRawTransaction rejects the transaction with `reject`, or keeps it and answers "already known" (`lost`). */
  const nodeAnswering = (send: { reject: Error } | "lost") => {
    const kept = new Set<string>();
    return fakeNode((method, params) => {
      switch (method) {
        case "eth_chainId":
          return toHex(31337);
        case "eth_call":
          return "0x";
        case "eth_getTransactionCount":
          return toHex(7);
        case "eth_sendRawTransaction":
          if (send !== "lost") throw send.reject;
          kept.add(keccak256(params[0] as Hex));
          throw rpcError(-32000, "already known");
        case "eth_getTransactionByHash": {
          const hash = params[0] as Hex;
          if (!kept.has(hash)) return null;
          return {
            hash,
            from: SELF,
            to: DMS,
            input: "0x",
            value: "0x0",
            nonce: "0x7",
            gas: "0xea60",
            maxFeePerGas: "0x1",
            maxPriorityFeePerGas: "0x1",
            type: "0x2",
            blockHash: null,
            blockNumber: null,
            transactionIndex: null,
            chainId: "0x7a69",
            v: "0x0",
            r: "0x1",
            s: "0x1",
            yParity: "0x0",
            accessList: [],
          };
        }
        default:
          throw rpcError(-32601, `unexpected ${method}`);
      }
    });
  };
  const dmsOn = (url: string) => new Dms(createClients({ chainId: 31337, rpcUrl: url, privateKey: `0x${"11".repeat(32)}` }), DMS);

  it("names the node's rejection as viem's sendTransaction did (geth -32000 insufficient funds, nonce too low), not 'Missing or invalid parameters'", async () => {
    const poor = dmsOn(await nodeAnswering({ reject: rpcError(-32000, "insufficient funds for gas * price + value: balance 0, tx cost 93000000000000") }));
    const funds = "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.";
    expect(describeError(await poor.send("markDark", [SELF, 1n], { fees, gas: 60_000n }).catch((e: unknown) => e))).toBe(funds);
    expect(describeError(await poor.freeNonce(7, fees).catch((e: unknown) => e))).toBe(funds);
    const behind = dmsOn(await nodeAnswering({ reject: rpcError(-32000, "nonce too low: next nonce 8, tx nonce 7") }));
    expect(describeError(await behind.send("markDark", [SELF, 1n], { fees, gas: 60_000n }).catch((e: unknown) => e))).toMatch(
      /Nonce provided for the transaction \(7\) is lower than the current nonce of the account/,
    );
  });

  it("still returns the hash when the node has the transaction although its answer was an error", async () => {
    const sent = await dmsOn(await nodeAnswering("lost")).send("markDark", [SELF, 1n], { fees, gas: 60_000n });
    expect(sent).toEqual({ hash: expect.stringMatching(/^0x[0-9a-f]{64}$/), nonce: 7 });
  });
});
