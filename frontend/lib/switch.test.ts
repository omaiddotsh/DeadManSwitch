import { describe, expect, it } from "vitest";
import {
  CIPHERTEXT_OVERHEAD, ContractState, MAX_CIPHERTEXT_SIZE, fmtBigDecimal, fmtDuration, fmtEth, fmtUsd8, isRescuableAt,
  parseUsd8, randomSwitchId, stateFromCode, switchPath, switchStateFor, toSwitchInfo, usd8ToWei, type RawSwitchInfo,
} from "./switch";
import { getAddress, parseEther } from "viem";
import { dmsAbi } from "./abi";

const raw = (over: Partial<RawSwitchInfo> = {}): RawSwitchInfo => ({
  owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", state: ContractState.ALIVE,
  lastPing: 1000n, pingInterval: 60n, createdAt: 1000n, expiresAt: 1060n, darkMarkedAt: 0n, revealedAt: 0n,
  bounty: 1n, ownerStake: 1n, plaintextCommitment: "0x01", encKeyHandle: "0x02", revealedKey: "0x00",
  ciphertextLength: 100n, published: false, rescuable: false, ...over,
});

describe("switch model", () => {
  it("mirrors the contract enum and constants", () => {
    expect([0, 1, 2, 3, 4, 5].map((c) => stateFromCode(c))).toEqual(["none", "alive", "dark", "darkMarked", "revealed", "cancelled"]);
    expect(() => stateFromCode(6)).toThrow();
    expect(CIPHERTEXT_OVERHEAD).toBe(61);
    expect(MAX_CIPHERTEXT_SIZE).toBe(2109);
    const stateEnum = dmsAbi.find((e) => e.type === "function" && e.name === "getState");
    expect(stateEnum && "outputs" in stateEnum && stateEnum.outputs[0]?.internalType).toBe("enum DeadManSwitch.State");
  });

  it("refines ALIVE to DARK at chain time >= expiresAt, and rescue after 30 days", () => {
    const info = toSwitchInfo(raw());
    expect(info.exists).toBe(true);
    expect(switchStateFor(info, 1059n)).toBe("alive");
    expect(switchStateFor(info, 1060n)).toBe("dark");
    expect(switchStateFor(info, null)).toBe("alive");
    expect(isRescuableAt(info, 1060n + 30n * 86400n - 1n)).toBe(false);
    expect(isRescuableAt(info, 1060n + 30n * 86400n)).toBe(true);
    const none = toSwitchInfo(raw({ owner: "0x0000000000000000000000000000000000000000", state: 0 }));
    expect(none.exists).toBe(false);
    expect(isRescuableAt(none, 10n ** 12n)).toBe(false);
  });

  it("formats", () => {
    expect(fmtDuration(90061)).toBe("1d 1h 1m");
    expect(fmtDuration(-61)).toBe("-1m 1s");
    expect(fmtDuration(86400 * 30)).toBe("30d");
    expect(fmtDuration(3600)).toBe("1h");
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtBigDecimal(1_234_500_000_000_000_000n)).toBe("1.2345");
    expect(fmtUsd8(1_234_567_890_000n)).toBe("$12,345.67");
    expect(parseUsd8("10")).toBe(10n * 10n ** 8n);
    expect(parseUsd8("12.5")).toBe(1_250_000_000n);
    expect(() => parseUsd8("1e3")).toThrow();
    // $10 at $2,500/ETH = 0.004 ETH (feed with 8 decimals), as minBounty() computes it
    expect(usd8ToWei(10n * 10n ** 8n, 2500n * 10n ** 8n)).toBe(4_000_000_000_000_000n);
  });

  it("a minimum is shown rounded UP, so typing the shown minimum clears it", () => {
    // $10 at $2,534.12345678/ETH, as minBounty() computes it: 0.003946…  ETH.
    const min = usd8ToWei(10n * 10n ** 8n, 253_412_345_678n);
    expect(fmtEth(min, 6)).toBe("0.003946 ETH"); // truncated: below the floor
    const shown = fmtEth(min, 6, "up");
    expect(shown).toBe("0.003947 ETH");
    expect(parseEther(shown.replace(" ETH", "")) >= min).toBe(true);
    // Exact values are unchanged; rounding carries into the integer part.
    expect(fmtEth(4_000_000_000_000_000n, 6, "up")).toBe("0.004 ETH");
    expect(fmtBigDecimal(999_999_999_999_999_999n, 18, 4, "up")).toBe("1");
    expect(fmtBigDecimal(0n, 18, 4, "up")).toBe("0");
  });

  it("random ids are non-zero and distinct", () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomSwitchId()));
    expect(ids.size).toBe(100);
    expect(ids.has(0n)).toBe(false);
  });
});

// G15: a link without its contract resolved to whatever (owner, id) the current deployment holds after a
// redeploy: a different switch, whose ping or top-up the visitor then sent.
describe("switch links", () => {
  it("name the switch's deployment, checksummed whatever case the handle carries", () => {
    const owner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const contract = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
    expect(switchPath(11155111, { contractAddr: contract, owner, id: 42n }))
      .toBe(`/switch/11155111/${owner}/42?contract=${getAddress(contract)}`);
    expect(switchPath(1, { contractAddr: getAddress(contract), owner: owner.toLowerCase(), id: "7" }))
      .toBe(`/switch/1/${owner}/7?contract=${getAddress(contract)}`);
  });
});
