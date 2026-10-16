// Small formatting helpers for CLI and watcher output.

import { formatEther } from "viem";

export const fmtEth = (wei: bigint): string => `${formatEther(wei)} ETH`;

export const fmtDuration = (secondsIn: bigint | number): string => {
  let s = Number(secondsIn < 0 ? -secondsIn : secondsIn);
  const parts: string[] = [];
  const units: [string, number][] = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ];
  for (const [u, n] of units) {
    if (s >= n) {
      parts.push(`${Math.floor(s / n)}${u}`);
      s %= n;
    }
  }
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.slice(0, 3).join(" ");
};

export const fmtTime = (unix: bigint): string => (unix === 0n ? "-" : new Date(Number(unix) * 1000).toISOString());

/** "2026-10-11T10:00:00.000Z (in 1h 2m)" relative to chain time. */
export const fmtTimeRel = (unix: bigint, now: bigint): string => {
  if (unix === 0n) return "-";
  const d = unix - now;
  return `${fmtTime(unix)} (${d >= 0n ? `in ${fmtDuration(d)}` : `${fmtDuration(-d)} ago`})`;
};

/** USD with `decimals` decimals → "$12.34" (cents truncated). */
export const fmtUsd = (v: bigint, decimals: number): string => {
  const cents = decimals >= 2 ? v / 10n ** BigInt(decimals - 2) : v * 10n ** BigInt(2 - decimals);
  return `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

/** USD with 8 decimals (minBountyUsd, by the contract's definition) → "$12.34". */
export const fmtUsd8 = (v: bigint): string => fmtUsd(v, 8);

/** JSON.stringify that renders bigints as decimal strings. */
export const toJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? `0x${Buffer.from(x).toString("hex")}` : x), 2);
