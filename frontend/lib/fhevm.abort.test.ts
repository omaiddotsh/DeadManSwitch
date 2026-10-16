// A cancel (or leaving the page) during the last part of the FHE step must
// still stop the create before its wallet prompt. The SDK honours the abort
// signal only on the relayer round trip: the coprocessor-signature check that
// follows (an InputVerifier read on the host chain) ignores it, so encrypt
// resolves normally after the caller aborted. SDK modules are mocked.

import { afterEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN = "1";
  return { abortDuringCall: null as AbortController | null };
});

const handleFor = (chainId: number) => `0x${"ab".repeat(21)}00${chainId.toString(16).padStart(16, "0")}0800` as const;

/** The SDK call answers 50 ms after it was asked, whatever its signal says; the caller aborts 10 ms in. */
const lateAnswer = async <T>(value: T): Promise<T> => {
  setTimeout(() => st.abortDuringCall?.abort(), 10);
  await new Promise((r) => setTimeout(r, 50));
  return value;
};

vi.mock("@zama-fhe/sdk", () => ({
  cleartext: () => ({}),
  createConfig: (c: unknown) => c,
  memoryStorage: {},
  ZamaSDK: class {
    async encrypt() { return lateAnswer({ encryptedValues: [handleFor(31337)], inputProof: "0x01" }); }
    decryption = {
      decryptPublicValues: async () => lateAnswer({
        abiEncodedClearValues: `0x${"07".repeat(32)}`, clearValues: {}, decryptionProof: "0x0102",
      }),
    };
    terminate() {}
  },
}));
vi.mock("@zama-fhe/sdk/chains", () => ({ anvil: {}, mainnet: {}, sepolia: {} }));
vi.mock("@zama-fhe/sdk/viem", () => ({ ViemProvider: class {} }));

afterEach(() => { st.abortDuringCall = null; });

describe("G18: an abort that arrives while the SDK finishes a call it no longer cancels", () => {
  it("encryptDek: cancelled (ABORTED), not a handle and proof the create would send to the wallet", async () => {
    const { encryptDek } = await import("./fhevm");
    const ac = new AbortController();
    st.abortDuringCall = ac;
    const r = await encryptDek({
      chainId: 31337, signal: ac.signal, dek: new Uint8Array(32).fill(7),
      contractAddress: "0x00000000000000000000000000000000000d3ad5", userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    }).catch((e: unknown) => e);
    expect(ac.signal.aborted).toBe(true);
    expect(r).toMatchObject({ name: "FhevmError", code: "ABORTED" });
  });

  it("publicDecryptDek: cancelled too", async () => {
    const { publicDecryptDek } = await import("./fhevm");
    const ac = new AbortController();
    st.abortDuringCall = ac;
    const r = await publicDecryptDek({ chainId: 31337, handle: handleFor(31337), signal: ac.signal }).catch((e: unknown) => e);
    expect(r).toMatchObject({ name: "FhevmError", code: "ABORTED" });
  });

  it("control: without an abort the same calls succeed", async () => {
    const { encryptDek } = await import("./fhevm");
    await expect(encryptDek({
      chainId: 31337, dek: new Uint8Array(32).fill(7),
      contractAddress: "0x00000000000000000000000000000000000d3ad5", userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    })).resolves.toMatchObject({ handle: handleFor(31337).toLowerCase(), inputProof: "0x01" });
  });
});
