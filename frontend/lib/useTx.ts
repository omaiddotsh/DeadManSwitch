// Write-transaction lifecycle with toasts: submit → toast → wait for receipt →
// fail on revert → invalidate the queries the transaction changed.
//
// Pair with useDmsActions() from ./hooks, e.g.
//   const { run } = useTx(); const actions = useDmsActions();
//   run("Pinging…", "Pinged", () => actions.ping(id), { invalidate: [dmsKeys.switch(chainId, h)] });

"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useChainId, usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import { explorerTx } from "./contracts";
import { errMsg, isUserRejection } from "./errors";
import { waitForWrite } from "./hooks";
import { useToast } from "@/components/ui/Toast";

export const useTx = () => {
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (
    label: string,
    successMessage: string,
    send: () => Promise<`0x${string}`>,
    opts?: { invalidate?: readonly (readonly unknown[])[]; onDone?: () => void },
  ): Promise<boolean> => {
    setPending(label);
    setError(null);
    try {
      const hash = await send();
      toast.info(`${label} — submitted`);
      // Not a failure on a receipt timeout, nor a success for a cancel in the wallet (waitForWrite).
      if (publicClient) await waitForWrite(publicClient as unknown as PublicClient, hash);
      toast.success(successMessage, { href: explorerTx(chainId, hash) });
      // Refetch only what this write touched, after it is actually mined.
      for (const key of opts?.invalidate ?? []) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      opts?.onDone?.();
      return true;
    } catch (e) {
      // A lost race (revert, or a state error at simulation) means the switch moved on: show it now.
      if (!isUserRejection(e)) for (const key of opts?.invalidate ?? []) void queryClient.invalidateQueries({ queryKey: key });
      const msg = errMsg(e);
      setError(msg);
      toast.error(msg);
      return false;
    } finally {
      setPending(null);
    }
  }, [chainId, publicClient, queryClient, toast]);

  return { run, pending, error, clearError: () => setError(null) };
};
