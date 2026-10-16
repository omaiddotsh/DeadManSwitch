// The test side of the chain: reads the tests check the UI against, and
// Anvil's clock (evm_increaseTime + evm_mine), which is how deadlines pass.

import { createTestClient, http, publicActions, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { dmsAbi } from "../../lib/abi";
import { toSwitchInfo, type RawSwitchInfo, type SwitchInfo } from "../../lib/switch";
import { CHAIN_ID } from "./env";

export class Chain {
  readonly client;

  constructor(
    readonly rpcUrl: string,
    readonly dms: Address,
  ) {
    if (foundry.id !== CHAIN_ID) throw new Error("viem's foundry chain is not 31337");
    this.client = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl), cacheTime: 0 }).extend(
      publicActions,
    );
  }

  /** Move the chain clock forward and mine a block at the new time. */
  async travel(seconds: number): Promise<bigint> {
    await this.client.increaseTime({ seconds });
    await this.client.mine({ blocks: 1 });
    return this.now();
  }

  /** Timestamp of the latest block. */
  async now(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: "latest" })).timestamp;
  }

  async switchInfo(owner: Address, id: bigint): Promise<SwitchInfo> {
    const raw = await this.client.readContract({ address: this.dms, abi: dmsAbi, functionName: "getSwitchInfo", args: [owner, id] });
    return toSwitchInfo(raw as unknown as RawSwitchInfo);
  }

  async funderStake(owner: Address, id: bigint, funder: Address): Promise<bigint> {
    return this.client.readContract({ address: this.dms, abi: dmsAbi, functionName: "getFunderStake", args: [owner, id, funder] });
  }

  async balance(address: Address): Promise<bigint> {
    return this.client.getBalance({ address });
  }

  /** Fee paid by a mined transaction. */
  async feeOf(hash: Hex): Promise<bigint> {
    const r = await this.client.getTransactionReceipt({ hash });
    return r.gasUsed * r.effectiveGasPrice;
  }

  async receipt(hash: Hex) {
    return this.client.getTransactionReceipt({ hash });
  }
}
