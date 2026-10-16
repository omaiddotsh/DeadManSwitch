// G14: the deployments of a chain. The current one takes creates; previous
// ones (NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>, plus a compiled-in history)
// stay known so their live switches can still be found, pinged, cancelled,
// topped up, released and reclaimed after a redeploy.

import { afterAll, describe, expect, it, vi } from "vitest";

const E = vi.hoisted(() => {
  const CUR = "0x00000000000000000000000000000000000C0FFe";
  const OLD = "0x00000000000000000000000000000000000a11ce";
  const OLDER = "0x0000000000000000000000000000000000000b0b";
  process.env.NEXT_PUBLIC_CONTRACT_11155111 = CUR;
  process.env.NEXT_PUBLIC_FROM_BLOCK_11155111 = "9000000";
  // Spaces, a duplicate (other case), the current address again and a typo: only OLD and OLDER are kept.
  process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111 =
    ` ${OLD}:8000000, ${OLDER}:7000000,${OLD.toUpperCase().replace("0X", "0x")}:1, ${CUR}:8500000, 0x12:5`;
  return { CUR, OLD, OLDER } as const;
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_CONTRACT_11155111;
  delete process.env.NEXT_PUBLIC_FROM_BLOCK_11155111;
  delete process.env.NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111;
});

const { SEPOLIA_ID, MAINNET_ID, contractFor, deploymentOf, deploymentsFor, fromBlockFor, fromBlockOf, isPreviousDeployment } =
  await import("./contracts");
const { compiledDeployments, parsePreviousContracts, previousDeploymentsFor } = await import("./deployments");
const { allowedContractFor } = await import("@/app/api/relayer/proxy");

describe("previous deployments: the env list and the compiled-in history", () => {
  it("parses comma-separated <address>:<deploy block> entries, and reports the others", () => {
    expect(parsePreviousContracts(undefined)).toEqual({ entries: [], invalid: [] });
    expect(parsePreviousContracts(" , ")).toEqual({ entries: [], invalid: [] });
    expect(parsePreviousContracts(`${E.OLD}:8000000 ,${E.OLDER}:0`)).toEqual({
      entries: [{ address: E.OLD, fromBlock: 8_000_000n }, { address: E.OLDER, fromBlock: 0n }],
      invalid: [],
    });
    expect(parsePreviousContracts(`${E.OLD}, ${E.OLD}:-1, ${E.OLD}:1e6, 0x12:5`).invalid).toEqual([E.OLD, `${E.OLD}:-1`, `${E.OLD}:1e6`, "0x12:5"]);
  });

  it("env entries first, then the compiled-in ones; never the current address, never twice", () => {
    const hardcoded = { [SEPOLIA_ID]: [{ address: E.OLDER, fromBlock: 6_000_000n }, { address: "0x0000000000000000000000000000000000000d0d" as const, fromBlock: 5n }] };
    expect(previousDeploymentsFor(SEPOLIA_ID, `${E.OLD}:8000000,${E.CUR}:1`, E.CUR, hardcoded)).toEqual([
      { address: E.OLD, fromBlock: 8_000_000n },
      { address: E.OLDER, fromBlock: 6_000_000n },
      { address: "0x0000000000000000000000000000000000000d0d", fromBlock: 5n },
    ]);
    expect(previousDeploymentsFor(MAINNET_ID, undefined, undefined, hardcoded)).toEqual([]);
  });
});

// The compiled-in tables live in lib/deployments.json, which next.config.js reads too (its
// build guard needs an RPC URL for a compiled-in deployment's chain, and refuses malformed entries).
describe("the deployments compiled into the app (lib/deployments.json)", () => {
  it("reads current addresses and previous <address>:<deploy block> entries per chain; ignores anything else", () => {
    expect(compiledDeployments({
      contracts: { "11155111": E.CUR, "1": "0x12" },
      previousContracts: { "11155111": [`${E.OLD}:8000000`, "junk"], "1": [] },
    })).toEqual({
      contracts: { [SEPOLIA_ID]: E.CUR },
      previous: { [SEPOLIA_ID]: [{ address: E.OLD, fromBlock: 8_000_000n }], [MAINNET_ID]: [] },
    });
    expect(compiledDeployments({})).toEqual({ contracts: {}, previous: {} });
  });
});

describe("deploymentsFor / deploymentOf", () => {
  it("the current deployment first (creates go there), then the previous ones, each with its own deploy block", () => {
    expect(contractFor(SEPOLIA_ID)).toBe(E.CUR);
    expect(deploymentsFor(SEPOLIA_ID)).toEqual([
      { address: E.CUR, fromBlock: 9_000_000n, current: true },
      { address: E.OLD, fromBlock: 8_000_000n, current: false },
      { address: E.OLDER, fromBlock: 7_000_000n, current: false },
    ]);
    expect(deploymentsFor(MAINNET_ID)).toEqual([]);
  });

  it("only a known deployment of that chain is found (any case): an unknown contract is never read from or written to", () => {
    expect(deploymentOf(SEPOLIA_ID, E.OLD.toLowerCase())).toMatchObject({ address: E.OLD, current: false });
    expect(deploymentOf(SEPOLIA_ID, E.CUR.toLowerCase())).toMatchObject({ address: E.CUR, current: true });
    expect(deploymentOf(SEPOLIA_ID, "0x000000000000000000000000000000000000dEaD")).toBeUndefined();
    expect(deploymentOf(MAINNET_ID, E.OLD)).toBeUndefined();
    expect(deploymentOf(SEPOLIA_ID, null)).toBeUndefined();
    expect(isPreviousDeployment(SEPOLIA_ID, E.OLD)).toBe(true);
    expect(isPreviousDeployment(SEPOLIA_ID, E.CUR)).toBe(false);
    expect(isPreviousDeployment(SEPOLIA_ID, "0x000000000000000000000000000000000000dEaD")).toBe(false);
  });

  it("a previous deployment's scans start at its own deploy block", () => {
    expect(fromBlockOf(SEPOLIA_ID, E.OLDER)).toBe(7_000_000n);
    expect(fromBlockOf(SEPOLIA_ID, E.CUR)).toBe(fromBlockFor(SEPOLIA_ID));
  });

  it("the relayer proxy still relays input proofs (creates) for the current deployment only", () => {
    expect(allowedContractFor(11155111, process.env)).toBe(E.CUR.toLowerCase());
  });
});
