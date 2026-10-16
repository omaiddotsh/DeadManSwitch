// Fail fast, with a clear message, when the stack the tests need is not up:
// Anvil on chain 31337 with a DeadManSwitch at E2E_DMS_ADDRESS, and the app
// built for that address.

import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { dmsAbi } from "../lib/abi";
import { CHAIN_ID, e2eEnv } from "./support/env";

export default async function globalSetup(): Promise<void> {
  const env = e2eEnv();
  const client = createPublicClient({ chain: foundry, transport: http(env.rpcUrl) });

  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (e) {
    throw new Error(`Anvil is not reachable at ${env.rpcUrl} (${String(e)}). Start the stack with scripts/browser-e2e.sh.`);
  }
  if (chainId !== CHAIN_ID) throw new Error(`${env.rpcUrl} is chain ${chainId}, expected ${CHAIN_ID}`);

  const code = await client.getCode({ address: env.dmsAddress });
  if (!code || code === "0x") throw new Error(`no contract at E2E_DMS_ADDRESS ${env.dmsAddress} on ${env.rpcUrl}`);
  // A DeadManSwitch: its admin() answers.
  await client.readContract({ address: env.dmsAddress, abi: dmsAbi, functionName: "admin" });

  let res: Response;
  try {
    res = await fetch(`${env.baseURL}/dashboard`);
  } catch (e) {
    throw new Error(`the app is not reachable at ${env.baseURL} (${String(e)}). Start the stack with scripts/browser-e2e.sh.`);
  }
  if (!res.ok) throw new Error(`${env.baseURL}/dashboard answered HTTP ${res.status}`);
}
