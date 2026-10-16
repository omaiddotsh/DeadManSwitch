import type { Wallet } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";

/**
 * A phone's wallet browser (Rabby, OKX, Trust, Coinbase, Zerion, Phantom…).
 *
 * On a phone RainbowKit's connect modal lists only its own connectors: no
 * EIP-6963 wallet, and no window.ethereum unless it passes as MetaMask or
 * Rainbow. Inside such a browser the user then saw only deep links to other
 * apps and WalletConnect. This adds RainbowKit's "Browser Wallet" there, and
 * only there: on a desktop the same wallet is already listed under
 * "Installed" (EIP-6963).
 */

interface NavigatorLike { userAgent: string; platform?: string; maxTouchPoints?: number }

/** RainbowKit's own test for its phone layout (isMobile: Android, iPhone/iPod, iPad, iPadOS posing as a Mac). */
const isMobileNavigator = (nav: NavigatorLike): boolean =>
  /android/i.test(nav.userAgent)
  || /iPhone|iPod|iPad/.test(nav.userAgent)
  || (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);

/** Whether to list "Browser Wallet": a phone or tablet whose browser injects a provider. */
export const showInAppBrowserWallet = (nav: NavigatorLike | undefined, provider: unknown): boolean =>
  !!nav && !!provider && isMobileNavigator(nav);

/** RainbowKit's injectedWallet, hidden unless showInAppBrowserWallet (decided once, when the config is built). */
export const inAppBrowserWallet = (): Wallet => ({
  ...injectedWallet(),
  hidden: () => {
    if (typeof window === "undefined") return true;
    const w: { ethereum?: unknown } = window;
    return !showInAppBrowserWallet(window.navigator, w.ethereum);
  },
});
