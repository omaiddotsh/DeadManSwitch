// Environment of a browser e2e run. scripts/browser-e2e.sh starts Anvil (with
// Zama's forge-fhevm mock host and a fresh DeadManSwitch), builds and starts
// the app with the matching NEXT_PUBLIC_* variables, and exports these.

import { getAddress, type Address } from "viem";

const required = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `${name} is not set. Run the browser e2e through scripts/browser-e2e.sh (it starts Anvil and the app and ` +
        "sets E2E_BASE_URL, E2E_RPC_URL and E2E_DMS_ADDRESS), or export them for a stack you started yourself.",
    );
  }
  return v;
};

export const e2eEnv = () => ({
  baseURL: process.env.E2E_BASE_URL?.trim() || "http://127.0.0.1:3100",
  rpcUrl: required("E2E_RPC_URL"),
  dmsAddress: getAddress(required("E2E_DMS_ADDRESS")),
});

/** The local chain (Anvil) the app is built for. */
export const CHAIN_ID = 31337;

/**
 * Anvil's default dev accounts (mnemonic "test test … junk"). Local only.
 * Anvil keeps them unlocked, so the test wallet forwards eth_sendTransaction
 * without signing.
 */
export const ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
] as const satisfies readonly Address[];

/** Who plays which part: the deployer is the contract admin. */
export const ROLES = { admin: 0, owner: 1, hunter: 2, funder: 3 } as const;
export type Role = keyof typeof ROLES;

export const addressOf = (role: Role): Address => ACCOUNTS[ROLES[role]];

/** RainbowKit's shortening of an address on its account button ("0x70…79C8"). */
export const rainbowKitAddress = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** How the app shows a party's address (owner, publisher): in full (components/ui/Address.tsx), since a shortened one can be matched by a vanity address. */
export const appAddress = (a: string): string => a;
