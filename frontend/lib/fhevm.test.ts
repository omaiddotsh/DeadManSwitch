import { describe, expect, it } from "vitest";
import { FhevmError, encryptDek, getFheKeyStatus, isFhevmChain, prefetchFheKey, publicDecryptDek } from "./fhevm";

const errCode = async (p: Promise<unknown>) => {
  try { await p; return undefined; } catch (e) { return e instanceof FhevmError ? e.code : `not FhevmError: ${String(e)}`; }
};

const handle = (chainId: number, type = 8) =>
  ("0x" + "cd".repeat(21) + "00" + chainId.toString(16).padStart(16, "0") + type.toString(16).padStart(2, "0") + "00") as `0x${string}`;

describe("fhevm (no SDK load)", () => {
  it("supports mainnet and Sepolia; Anvil only when NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1", () => {
    expect(isFhevmChain(1)).toBe(true);
    expect(isFhevmChain(11155111)).toBe(true);
    expect(isFhevmChain(31337)).toBe(process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN === "1");
    for (const c of [8453, 10, 42161, 137, 0]) expect(isFhevmChain(c)).toBe(false);
  });

  it("refuses unsupported chains before touching the SDK", async () => {
    const p = { contractAddress: "0x0000000000000000000000000000000000000001", userAddress: "0x0000000000000000000000000000000000000002", dek: new Uint8Array(32) } as const;
    expect(await errCode(encryptDek({ chainId: 8453, ...p }))).toBe("UNSUPPORTED_CHAIN");
    expect(await errCode(publicDecryptDek({ chainId: 137, handle: handle(137) }))).toBe("UNSUPPORTED_CHAIN");
  });

  it("relayer chains are browser-only (no window under SSR / Node)", async () => {
    const p = { contractAddress: "0x0000000000000000000000000000000000000001", userAddress: "0x0000000000000000000000000000000000000002", dek: new Uint8Array(32) } as const;
    expect(await errCode(encryptDek({ chainId: 11155111, ...p }))).toBe("NOT_BROWSER");
    expect(await errCode(publicDecryptDek({ chainId: 1, handle: handle(1) }))).toBe("NOT_BROWSER");
    await expect(prefetchFheKey(1)).resolves.toBeUndefined();
    expect(getFheKeyStatus(1).state).toBe("idle");
  });
});
