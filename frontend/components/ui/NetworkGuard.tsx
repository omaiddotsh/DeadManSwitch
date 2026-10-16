"use client";

import { useAccount, useSwitchChain } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  ALL_CHAINS, chainLabel, defaultReadChain, hasDeployment, isSupportedChainId, supportedChains,
} from "@/lib/contracts";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";

/** For a chain label at the start of a heading: chainLabel's fallback ("chain 8453") is written for mid-sentence. */
export const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Gate for views that read the deployment on the wallet's chain.
 *
 * Only Ethereum mainnet and Sepolia are supported (plus a local Anvil in dev
 * builds): the contract inherits ZamaEthereumConfig, and Zama's KMS serves
 * nothing else. Disconnected visitors fall through to the first deployed
 * chain so the hunt and archive views stay browsable without a wallet.
 *
 * Uses the wallet's raw chain id (useAccount), not useChainId: wagmi keeps the
 * latter on a configured chain, so a wallet on Base or on a chain without a
 * deployment would otherwise silently read some other network.
 */
export function NetworkGuard({
  children, requireWallet = false, walletReason,
}: {
  children: React.ReactNode;
  requireWallet?: boolean;
  /** Body text for the connect prompt. */
  walletReason?: string;
}) {
  const { isConnected, chainId: walletChainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  // A chain with only previous deployments counts: their switches must stay reachable (no creates there).
  const deployed = supportedChains.filter((c) => hasDeployment(c.id));

  const switchButtons =
    deployed.length === 0 ? (
      <span className="text-xs text-fg-muted">
        No deployment is configured. Set NEXT_PUBLIC_CONTRACT_1 or NEXT_PUBLIC_CONTRACT_11155111.
      </span>
    ) : (
      deployed.map((c) => (
        <button
          key={c.id}
          className="btn btn-sm"
          disabled={isPending}
          onClick={() => switchChain({ chainId: c.id })}
        >
          <Icon name="refresh" size={14} /> Switch to {c.name}
        </button>
      ))
    );

  if (requireWallet && !isConnected) {
    return (
      <EmptyState
        icon="wallet"
        title="Connect a wallet"
        body={walletReason ?? "This view shows switches owned by your address."}
        cta={
          <button className="btn btn-primary" onClick={() => openConnectModal?.()}>
            <Icon name="wallet" size={14} /> Connect wallet
          </button>
        }
      />
    );
  }

  if (isConnected) {
    if (!isSupportedChainId(walletChainId)) {
      return (
        <EmptyState
          icon="alert"
          title={`${walletChainId ? upperFirst(chainLabel(walletChainId)) : "This network"} is not supported`}
          body={
            `Dead Man's Switch runs only on ${ALL_CHAINS.map((c) => c.name).join(", ")}: ` +
            "the contract relies on Zama's fhEVM, which is deployed on those chains only."
          }
          cta={switchButtons}
        />
      );
    }
    if (!hasDeployment(walletChainId!)) {
      return (
        <EmptyState
          icon="alert"
          title={`Not deployed on ${chainLabel(walletChainId!)}`}
          body="Switch to a network where the contract exists."
          cta={switchButtons}
        />
      );
    }
  } else if (!defaultReadChain()) {
    return (
      <EmptyState
        icon="alert"
        title="No deployment configured"
        body="Set NEXT_PUBLIC_CONTRACT_<chainId> for Ethereum mainnet (1) or Sepolia (11155111) to enable read-only browsing."
      />
    );
  }

  return <>{children}</>;
}
