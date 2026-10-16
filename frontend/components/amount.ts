// Parsing of typed amounts (ETH bounty, admin USD floor).

import { parseEther } from "viem";
import { parseUsd8 } from "@/lib/switch";

/**
 * Accept a decimal comma: "0,005" → "0.005". In comma-decimal regions the
 * iOS decimal keypad (inputmode="decimal") has a "," key and no ".". Only a
 * single comma with no dot is converted, so "1,000.5" stays invalid rather
 * than guessed at; fields that convert show what they read, since "1,000"
 * then means 1.
 */
export const normalizeDecimal = (s: string): string => {
  const t = s.trim();
  const comma = t.indexOf(",");
  return comma !== -1 && comma === t.lastIndexOf(",") && !t.includes(".") ? t.replace(",", ".") : t;
};

/** True when normalizeDecimal changed how `s` reads (worth echoing the parsed value). */
export const hasDecimalComma = (s: string): boolean => normalizeDecimal(s) !== s.trim();

/**
 * An ETH amount as typed: null when empty, undefined when it is not a valid
 * non-negative amount, otherwise wei.
 */
export const parseEthInput = (s: string): bigint | null | undefined => {
  const t = normalizeDecimal(s);
  if (t === "") return null;
  try {
    const v = parseEther(t);
    return v < 0n ? undefined : v;
  } catch { return undefined; }
};

/** A USD amount as typed, in the contract's 8 decimals. Throws on bad input. */
export const parseUsdInput = (s: string): bigint => parseUsd8(normalizeDecimal(s));
