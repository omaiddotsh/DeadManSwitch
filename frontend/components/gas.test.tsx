// useCallGas estimates with the same ABI as the writes (lib/errors.ts
// dmsWriteAbi), so a revert from Zama's host contracts decodes at estimate
// time too. react-query is stubbed to hand back the query options, whose
// queryFn then runs against a fake client.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({
  options: [] as { queryFn: () => Promise<unknown> }[],
  calls: [] as { abi: readonly { type: string; name?: string }[]; functionName: string }[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryFn: () => Promise<unknown> }) => { m.options.push(o); return { data: undefined }; },
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }) }));
vi.mock("@/lib/hooks", () => ({
  useEffectiveChain: () => ({ chainId: 11155111, address: "0x00000000000000000000000000000000000d3ad5" }),
  useEffectivePublicClient: () => ({
    estimateContractGas: async (p: (typeof m.calls)[number]) => { m.calls.push(p); return 100_000n; },
  }),
}));

const { useCallGas } = await import("./gas");
const { dmsWriteAbi } = await import("@/lib/errors");

function Probe() {
  useCallGas({ functionName: "markDark", args: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 7n] });
  return null;
}

describe("useCallGas", () => {
  it("estimates against dmsWriteAbi: a host revert (e.g. EnforcedPause from a paused ACL) decodes", async () => {
    renderToStaticMarkup(<Probe />);
    expect(m.options).toHaveLength(1);
    await m.options[0].queryFn();
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].functionName).toBe("markDark");
    expect(m.calls[0].abi).toBe(dmsWriteAbi);
    expect(m.calls[0].abi.some((e) => e.type === "error" && e.name === "EnforcedPause")).toBe(true);
  });
});
