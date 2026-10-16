import { getDefaultConfig, getDefaultWallets } from "@rainbow-me/rainbowkit";
import { http, type Transport } from "viem";
import { RPC_BATCH, rpcUrlFor, supportedChains } from "./contracts";
import { inAppBrowserWallet } from "./injectedWallet";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || "demo";

const transports: Record<number, Transport> = Object.fromEntries(
  supportedChains.map((c) => [c.id, http(rpcUrlFor(c.id))]),
);

export const wagmiConfig = getDefaultConfig({
  appName: "DeadManSwitch",
  projectId,
  // RainbowKit's default list, after a phone wallet browser's own provider (lib/injectedWallet.ts).
  wallets: [{ groupName: "This browser", wallets: [inAppBrowserWallet] }, ...getDefaultWallets().wallets],
  chains: supportedChains,
  transports,
  batch: RPC_BATCH,
  ssr: true,
});
