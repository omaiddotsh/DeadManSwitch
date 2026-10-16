// Multicall batching of contract reads: one /hunt poll re-reads getSwitchInfo
// for every listed switch (one react-query interval per switch). On the first
// fetch the reads start in the same moment; on later polls a few ms apart,
// since react-query re-arms each switch's interval when its own result is
// processed (G6). Counted against a fake RPC that answers eth_call and
// Multicall3's aggregate3; nothing leaves the test.

import { describe, expect, it } from "vitest";
import {
  createPublicClient, custom, decodeFunctionData, encodeFunctionResult, multicall3Abi,
  type Chain, type Hex, type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { dmsAbi } from "./abi";
import { anvil } from "./contracts";
import { wagmiConfig } from "./wagmi";

const CONTRACT = "0x00000000000000000000000000000000000d3ad5" as const;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

/** getSwitchInfo(owner, id) → a live switch whose bounty is the id (so each answer is checkable). */
const answer = (data: Hex): Hex => {
  const { args } = decodeFunctionData({ abi: dmsAbi, data });
  const [owner, id] = args as readonly [`0x${string}`, bigint];
  return encodeFunctionResult({
    abi: dmsAbi, functionName: "getSwitchInfo",
    result: {
      owner, state: 1, lastPing: 1n, pingInterval: 60n, createdAt: 1n, expiresAt: 61n, darkMarkedAt: 0n, revealedAt: 0n,
      bounty: id, ownerStake: id, plaintextCommitment: ZERO32, encKeyHandle: ZERO32, revealedKey: ZERO32,
      ciphertextLength: 100n, published: false, rescuable: false,
    },
  } as never);
};

/** A client for `chain` with `batch`, whose RPC counts eth_calls (and Multicall3 sub-calls). */
const countingClient = (chain: Chain, batch: PublicClient["batch"]) => {
  const st = { ethCalls: 0, multicalls: 0 };
  const transport = custom({
    async request({ method, params }: { method: string; params: [{ to: Hex; data: Hex }, string] }) {
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      st.ethCalls++;
      const [{ to, data }] = params;
      const mc = chain.contracts?.multicall3?.address;
      if (mc && to.toLowerCase() === mc.toLowerCase()) {
        st.multicalls++;
        const { args } = decodeFunctionData({ abi: multicall3Abi, data });
        const calls = args[0] as readonly { target: Hex; callData: Hex }[];
        return encodeFunctionResult({
          abi: multicall3Abi, functionName: "aggregate3",
          result: calls.map((c) => ({ success: true, returnData: answer(c.callData) })),
        });
      }
      if (to.toLowerCase() !== CONTRACT.toLowerCase()) throw new Error(`eth_call to ${to}`);
      return answer(data);
    },
  });
  return { client: createPublicClient({ chain, transport, batch }) as PublicClient, st };
};

/**
 * One poll: `n` getSwitchInfo reads, each from its own timer task (a react-query interval each), read `i`
 * starting `delayMs(i)` ms in (default: all at the same moment).
 */
const poll = async (client: PublicClient, n: number, delayMs: (i: number) => number = () => 0) => {
  const reads = Array.from({ length: n }, (_, i) =>
    new Promise((r) => setTimeout(r, delayMs(i))).then(() => client.readContract({
      address: CONTRACT, abi: dmsAbi, functionName: "getSwitchInfo",
      args: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", BigInt(i + 1)],
    })));
  const infos = (await Promise.all(reads)) as { bounty: bigint }[];
  expect(infos.map((x) => x.bounty)).toEqual(Array.from({ length: n }, (_, i) => BigInt(i + 1)));
};

describe("multicall batching of contract reads", () => {
  const N = 100;
  const appBatch = () => wagmiConfig.getClient({ chainId: sepolia.id }).batch;

  it(`one /hunt poll of ${N} switches on Sepolia is a single eth_call with the app's client settings`, async () => {
    const unbatched = countingClient(sepolia, undefined);
    await poll(unbatched.client, N);
    expect(unbatched.st.ethCalls).toBe(N);
    // wagmi's default ({ multicall: true }, 1,024 calldata bytes per batch) packs 15 getSwitchInfo per eth_call.
    const wagmiDefault = countingClient(sepolia, { multicall: true });
    await poll(wagmiDefault.client, N);
    expect(wagmiDefault.st.ethCalls).toBe(7);
    const app = countingClient(sepolia, appBatch());
    await poll(app.client, N);
    expect(app.st.ethCalls).toBe(1);
    expect(app.st.multicalls).toBe(1);
  });

  it(`later polls too: ${N} reads whose 15 s timers drifted up to 8 ms apart are still a single eth_call`, async () => {
    const app = countingClient(sepolia, appBatch());
    await poll(app.client, N, (i) => i % 8);
    expect(app.st.ethCalls).toBe(1);
    expect(app.st.multicalls).toBe(1);
  });

  it("the Header's settings reads (7 views at once) are one eth_call", async () => {
    const app = countingClient(sepolia, appBatch());
    await poll(app.client, 7);
    expect(app.st.ethCalls).toBe(1);
  });

  it("local Anvil has no Multicall3: the same reads fall back to plain eth_calls and still succeed", async () => {
    expect(anvil.contracts?.multicall3).toBeUndefined();
    const local = countingClient(anvil, appBatch());
    await poll(local.client, 20);
    expect(local.st.ethCalls).toBe(20);
    expect(local.st.multicalls).toBe(0);
  });
});
