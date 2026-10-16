"use client";

import { useCallback } from "react";
import type { Hex } from "viem";
import { explorerTx } from "@/lib/contracts";
import { errMsg, isUserRejection } from "@/lib/errors";
import { useEffectiveChain } from "@/lib/hooks";
import { useToast } from "./Toast";

/**
 * Wraps a lib write hook (`usePing().write`, …, which wait for the receipt and
 * throw on revert) with toasts. Resolves to the result, or null on failure;
 * never throws, so call sites stay a single line. `success` may be built
 * from the result (e.g. an amount read from the receipt's events).
 */
export function useTxToast() {
  const toast = useToast();
  const { chainId } = useEffectiveChain();
  return useCallback(
    async <T extends { hash: Hex }>(send: () => Promise<T>, success: string | ((r: T) => string)): Promise<T | null> => {
      try {
        const r = await send();
        toast.success(typeof success === "function" ? success(r) : success, { href: explorerTx(chainId, r.hash) });
        return r;
      } catch (e) {
        if (isUserRejection(e)) toast.info("Request rejected in the wallet.");
        else toast.error(errMsg(e));
        return null;
      }
    },
    [toast, chainId],
  );
}
