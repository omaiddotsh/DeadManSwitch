"use client";

// Gas estimates for UI hints. Exact figures come from the wallet (and from
// eth_estimateGas wherever a call can already be simulated); these are for the
// moments before that, e.g. sizing a bounty before anything is encrypted.
//
// Calibrated on a local Anvil + forge-fhevm host (1 mock coprocessor signer,
// 1 mock KMS signer), measured 2026-10-11:
//   createSwitch: 384,701 gas at 62 ciphertext bytes … 1,854,855 at 2,109,
//                 fits 339k + 22,100 per 32-byte storage word + 27 per byte
//                 to within ~500 gas across the range.
//   ping 28.8k · fundBounty 56.9k · cancel 39.4k · markDark 80.6k
//   revealKey 149.8k (99-byte proof) · publishPlaintext 34k + ~36 per byte
// Mainnet/Sepolia verify several coprocessor and KMS threshold signatures
// (one ecrecover + signer check each, larger proofs) and read the Chainlink
// feed, so the non-local figures below add a margin. Re-measure on Sepolia.

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { ANVIL_ID } from "@/lib/contracts";
import { dmsWriteAbi } from "@/lib/errors";
import { useEffectiveChain, useEffectivePublicClient } from "@/lib/hooks";

const CREATE_BASE = 339_000n;
const CREATE_PER_WORD = 22_100n;
const CREATE_PER_BYTE = 27n;
/** Coprocessor signature checks + Chainlink read on public chains. */
const CREATE_PUBLIC_MARGIN = 80_000n;

/** Estimated createSwitch gas for a ciphertext of `ciphertextBytes`. */
export const estimateCreateGas = (ciphertextBytes: number, chainId: number): bigint => {
  const bytes = BigInt(Math.max(0, ciphertextBytes));
  const words = (bytes + 31n) / 32n;
  const local = CREATE_BASE + CREATE_PER_WORD * words + CREATE_PER_BYTE * bytes;
  return chainId === ANVIL_ID ? local : local + CREATE_PUBLIC_MARGIN;
};

/** revealKey: dominated by FHE.checkSignatures over the KMS threshold signatures. */
export const estimateRevealGas = (chainId: number): bigint => (chainId === ANVIL_ID ? 150_000n : 250_000n);

/** markDark: makePubliclyDecryptable on the host ACL. */
export const estimateMarkDarkGas = (chainId: number): bigint => (chainId === ANVIL_ID ? 81_000n : 100_000n);

/** publishPlaintext: commitment check + the payload as event data. */
export const estimatePublishGas = (plaintextBytes: number): bigint => 34_000n + 36n * BigInt(Math.max(0, plaintextBytes));

/** Current gas price on the effective chain (refreshed every 30 s); null while unknown. */
export const useGasPrice = (): bigint | null => {
  const { chainId } = useEffectiveChain();
  const client = useEffectivePublicClient();
  const q = useQuery({
    queryKey: ["gasPrice", chainId],
    enabled: !!client && !!chainId,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: 0,
    queryFn: () => client!.getGasPrice(),
  });
  return q.data ?? null;
};

/** gas × price, or null when the price is unknown. */
export const gasCost = (gas: bigint | null | undefined, price: bigint | null): bigint | null =>
  gas != null && price != null ? gas * price : null;

/**
 * eth_estimateGas for a DeadManSwitch call that can already be simulated
 * (markDark once dark, revealKey with a fetched proof, publishPlaintext with
 * the decrypted salt + payload). Null while unavailable or if the call would
 * revert; callers fall back to the static estimates above.
 */
export const useCallGas = (
  call: {
    /** The switch's deployment (a previous one's switches are estimated there); default the current one. */
    contract?: `0x${string}`;
    functionName: "markDark" | "revealKey" | "publishPlaintext";
    args: readonly unknown[];
  } | null,
): bigint | null => {
  const { chainId, address: current } = useEffectiveChain();
  const address = call?.contract ?? current;
  const client = useEffectivePublicClient();
  const { address: account } = useAccount();
  const q = useQuery({
    queryKey: ["callGas", chainId, address, account ?? null, call?.functionName ?? null,
      call ? call.args.map((a) => (typeof a === "bigint" ? a.toString() : a)) : null],
    enabled: !!client && !!address && !!call,
    staleTime: 30_000,
    retry: 0,
    queryFn: () =>
      client!.estimateContractGas({
        address: address!,
        // As the writes: a revert from Zama's host contracts (paused ACL, deny-list, bad proof) decodes too.
        abi: dmsWriteAbi,
        functionName: call!.functionName,
        args: call!.args as never,
        account,
      } as never),
  });
  return q.data ?? null;
};
