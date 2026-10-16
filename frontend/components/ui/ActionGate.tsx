"use client";

import type { ReactNode } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { chainLabel } from "@/lib/contracts";
import { useEffectiveChain } from "@/lib/hooks";
import { Icon } from "./Icon";
import { Spinner } from "./Loading";

/**
 * Gate for anything that sends a transaction. Reads never need a wallet, so
 * every view renders without one; only the action area asks to connect, and
 * to switch networks when the wallet sits on a different chain than the one
 * being viewed (e.g. a Sepolia switch link opened with a mainnet wallet).
 */
export function ActionGate({
  children, what = "act on this switch", compact = false,
}: {
  children: ReactNode;
  /** Completes "Connect a wallet to …". */
  what?: string;
  compact?: boolean;
}) {
  const { isConnected, chainId: walletChainId } = useAccount();
  const { chainId } = useEffectiveChain();
  const { openConnectModal } = useConnectModal();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) {
    return (
      <div className={compact ? "flex flex-wrap items-center gap-2" : "flex flex-wrap items-center gap-3"}>
        <button type="button" className="btn btn-sm" onClick={() => openConnectModal?.()}>
          <Icon name="wallet" size={14} /> Connect wallet
        </button>
        <span className="text-xs text-fg-muted">to {what}.</span>
      </div>
    );
  }

  if (walletChainId !== chainId) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-sm"
          disabled={isPending}
          onClick={() => switchChain({ chainId })}
        >
          {isPending ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}
          Switch wallet to {chainLabel(chainId)}
        </button>
        <span className="text-xs text-fg-muted">
          Your wallet is on {walletChainId ? chainLabel(walletChainId) : "another network"}.
        </span>
      </div>
    );
  }

  return <>{children}</>;
}
