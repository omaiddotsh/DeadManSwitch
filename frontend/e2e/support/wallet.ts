// Test-side handle on the injected wallet of one page (window.__dmsE2EWallet).

import type { Page } from "@playwright/test";
import type { Address, Hex } from "viem";
import { ACCOUNTS, ROLES, type Role } from "./env";
import type { FailureMode, PromptMethod, WalletControlApi, WalletLogEntry, WalletSnapshot } from "./injected-wallet";

type Win = Window & { __dmsE2EWallet: WalletControlApi };

/** RainbowKit lists the wallet by this name. */
export const WALLET_NAME = "DMS Test Wallet";
export const WALLET_RDNS = "dev.deadmanswitch.e2e";

export class WalletHandle {
  constructor(private readonly page: Page) {}

  /** Select another dev account; the wallet emits accountsChanged when connected. */
  async use(role: Role): Promise<Address> {
    await this.page.evaluate((i) => (window as unknown as Win).__dmsE2EWallet.setAccount(i), ROLES[role]);
    return ACCOUNTS[ROLES[role]];
  }

  /** Report another chain (emits chainChanged). Sending only works on 31337. */
  async setChainId(chainId: number): Promise<void> {
    await this.page.evaluate((c) => (window as unknown as Win).__dmsE2EWallet.setChainId(c), chainId);
  }

  /** The next prompt (`method`, or any prompt) fails with 4001 "User rejected the request." */
  async rejectNext(method: PromptMethod | null): Promise<void> {
    await this.page.evaluate((m) => (window as unknown as Win).__dmsE2EWallet.rejectNext(m), method);
  }

  /** The next `method` request fails as `mode` (see FailureMode). */
  async failNext(method: PromptMethod | null, mode: FailureMode): Promise<void> {
    await this.page.evaluate(([m, f]) => (window as unknown as Win).__dmsE2EWallet.failNext(m, f), [method, mode] as const);
  }

  /** Hold the next `method` request (or any prompt) open until releaseHeld(): a wallet prompt the user has not answered. */
  async holdNext(method: PromptMethod | null): Promise<void> {
    await this.page.evaluate((m) => (window as unknown as Win).__dmsE2EWallet.holdNext(m), method);
  }

  /** Answer every held prompt (the request goes on as usual); returns how many were held. */
  async releaseHeld(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as Win).__dmsE2EWallet.releaseHeld());
  }

  /** Revoke this site's access (emits accountsChanged []), as disconnecting in the wallet does. */
  async disconnect(): Promise<void> {
    await this.page.evaluate(() => (window as unknown as Win).__dmsE2EWallet.disconnect());
  }

  async snapshot(): Promise<WalletSnapshot> {
    return this.page.evaluate(() => (window as unknown as Win).__dmsE2EWallet.snapshot());
  }

  async log(): Promise<WalletLogEntry[]> {
    return this.page.evaluate(() => (window as unknown as Win).__dmsE2EWallet.log());
  }

  /** Hashes of the transactions this page sent through the wallet (including lost responses), oldest first. */
  async sentHashes(): Promise<Hex[]> {
    return (await this.log())
      .filter((e) => e.method === "eth_sendTransaction" && (e.ok || e.broadcast) && e.hash)
      .map((e) => e.hash as Hex);
  }

  async lastSentHash(): Promise<Hex> {
    const all = await this.sentHashes();
    const h = all.at(-1);
    if (!h) throw new Error("the wallet has not sent any transaction");
    return h;
  }
}

/** A small data:image/svg+xml icon (RainbowKit lists EIP-6963 wallets only with a data:image icon). */
export const WALLET_ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="6" fill="#10b981"/><text x="16" y="21" font-size="12" text-anchor="middle" fill="#0a0a0c">E2E</text></svg>',
  ).toString("base64");
