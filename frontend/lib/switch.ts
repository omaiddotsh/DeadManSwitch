// Switch constants, state model and formatting helpers. Pure: no React, no
// wagmi, no SDK — safe to import from anywhere (server components, tests).
//
// Mirrors contracts/src/DeadManSwitch.sol. The contract derives a lifecycle
// `State` from (status, darkMarked, lastPing + pingInterval vs block.timestamp);
// `getSwitchInfo` returns it evaluated at the block the read ran against.

import { getAddress } from "viem";

// ---------- contract constants (keep in sync with DeadManSwitch.sol) ----------

/** MIN_PING_INTERVAL / MAX_PING_INTERVAL, seconds. */
export const MIN_PING_INTERVAL = 60;
export const MAX_PING_INTERVAL = 365 * 86400;

/** MAX_PAYLOAD_SIZE: plaintext cap in BYTES (UTF-8), excluding the 32-byte salt. */
export const MAX_PAYLOAD_SIZE = 2048;

/** Ciphertext v1 layout pieces. */
export const ENVELOPE_VERSION = 0x01;
export const DEK_BYTES = 32;
export const NONCE_BYTES = 12;
export const SALT_BYTES = 32;
export const TAG_BYTES = 16;

/** CIPHERTEXT_OVERHEAD: version (1) + nonce (12) + salt (32) + GCM tag (16). */
export const CIPHERTEXT_OVERHEAD = 1 + NONCE_BYTES + SALT_BYTES + TAG_BYTES; // 61
/** MAX_CIPHERTEXT_SIZE = MAX_PAYLOAD_SIZE + CIPHERTEXT_OVERHEAD. */
export const MAX_CIPHERTEXT_SIZE = MAX_PAYLOAD_SIZE + CIPHERTEXT_OVERHEAD; // 2109

/**
 * RESCUE_DELAY: how long after going dark a still-unrevealed switch's
 * depositors may recover their own principal (`reclaimOwnerStake` /
 * `reclaimContribution`). The switch stays ACTIVE, so a late reveal still lands.
 */
export const RESCUE_DELAY = 30 * 86400;

/**
 * Under this much chain time before the deadline, a ping, cancel or top-up
 * sent now may be mined after it and revert (Expired) while still costing
 * gas: three 12 s slots (the interpolated chain time can lag a slot, the tx
 * lands in the next slot at the earliest, one more covers a missed slot).
 */
export const LATE_TX_RISK_SECONDS = 3n * 12n;

/** MAX_MIN_BOUNTY_USD: upper bound of the admin-settable floor ($10,000, 8 decimals). */
export const MAX_MIN_BOUNTY_USD = 10_000n * 10n ** 8n;
/** minBountyUsd / oracle answers carry 8 decimals (Chainlink ETH/USD). */
export const USD_DECIMALS = 8;

// ---------- state ----------

/** The contract's `State` enum, numerically. */
export enum ContractState {
  NONE = 0,
  ALIVE = 1,
  DARK = 2,
  DARK_MARKED = 3,
  REVEALED = 4,
  CANCELLED = 5,
}

/**
 * none       — no switch at (owner, id)
 * alive      — owner pinged within the interval; the encrypted key is sealed
 * dark       — deadline passed; anyone may call markDark
 * darkMarked — markDark called: the KMS will now publicly decrypt the key;
 *              anyone may fetch it and call revealKey to claim the bounty
 * revealed   — key on-chain forever; anyone can decrypt the ciphertext
 * cancelled  — owner aborted while alive; the key is never decryptable
 */
export type SwitchState = "none" | "alive" | "dark" | "darkMarked" | "revealed" | "cancelled";

const STATE_BY_CODE: Record<number, SwitchState> = {
  [ContractState.NONE]: "none",
  [ContractState.ALIVE]: "alive",
  [ContractState.DARK]: "dark",
  [ContractState.DARK_MARKED]: "darkMarked",
  [ContractState.REVEALED]: "revealed",
  [ContractState.CANCELLED]: "cancelled",
};

export const stateFromCode = (code: number | bigint): SwitchState => {
  const s = STATE_BY_CODE[Number(code)];
  if (!s) throw new Error(`unknown contract State ${String(code)}`);
  return s;
};

export const STATE_LABEL: Record<SwitchState, string> = {
  none: "Not found",
  alive: "Alive",
  dark: "Dark",
  darkMarked: "Key release requested",
  revealed: "Revealed",
  cancelled: "Cancelled",
};

/** One-line explanations for tooltips / badges. */
export const STATE_DESCRIPTION: Record<SwitchState, string> = {
  none: "No switch exists for this owner and id.",
  alive: "The owner is pinging. The key stays sealed by Zama's threshold network.",
  dark: "The owner missed the deadline. Anyone can ask the contract to release the key.",
  darkMarked: "The contract has asked Zama's KMS to decrypt the key. Anyone can fetch it and claim the bounty.",
  revealed: "The key is on-chain. Anyone can decrypt the secret from chain state alone.",
  cancelled: "The owner cancelled while alive. The key will never be released.",
};

/** Terminal states accept no further lifecycle transition. */
export const isTerminal = (s: SwitchState): boolean => s === "revealed" || s === "cancelled";

/** The owner may still ping / cancel; funders may still fund. */
export const isLive = (s: SwitchState): boolean => s === "alive";

/** Past the deadline on an ACTIVE switch (marked or not). Mirrors `isDark()`. */
export const isDarkState = (s: SwitchState): boolean => s === "dark" || s === "darkMarked";

// ---------- switch info ----------

/**
 * A switch: its deployment (the chain's current one or a previous one,
 * lib/contracts.ts deploymentsFor) and its (owner, id) there. The same
 * (owner, id) on two deployments are two different switches.
 */
export interface SwitchHandle {
  contractAddr: `0x${string}`;
  owner: `0x${string}`;
  id: bigint;
}

/** `getSwitchInfo(owner, id)`, normalised. */
export interface SwitchInfo {
  owner: `0x${string}`;
  exists: boolean;
  /** State as evaluated by the contract at the block the read ran against. */
  state: SwitchState;
  stateCode: ContractState;
  lastPing: bigint;
  pingInterval: bigint;
  createdAt: bigint;
  /** lastPing + pingInterval. The switch is dark from this timestamp on (>=). */
  expiresAt: bigint;
  darkMarkedAt: bigint;
  revealedAt: bigint;
  /** Whole pot: owner escrow + funder contributions (0 once revealed). */
  bounty: bigint;
  ownerStake: bigint;
  plaintextCommitment: `0x${string}`;
  /** FHE handle of the encrypted DEK. */
  encKeyHandle: `0x${string}`;
  /** The DEK once revealed; zero bytes32 before. */
  revealedKey: `0x${string}`;
  ciphertextLength: bigint;
  /** publishPlaintext already called (the plaintext is in a PlaintextPublished event). */
  published: boolean;
  /** RESCUE_DELAY has passed since going dark without a reveal. */
  rescuable: boolean;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** The struct as viem decodes it from `getSwitchInfo`. */
export interface RawSwitchInfo {
  owner: `0x${string}`;
  state: number;
  lastPing: bigint;
  pingInterval: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  darkMarkedAt: bigint;
  revealedAt: bigint;
  bounty: bigint;
  ownerStake: bigint;
  plaintextCommitment: `0x${string}`;
  encKeyHandle: `0x${string}`;
  revealedKey: `0x${string}`;
  ciphertextLength: bigint;
  published: boolean;
  rescuable: boolean;
}

export const toSwitchInfo = (raw: RawSwitchInfo): SwitchInfo => {
  const stateCode = Number(raw.state) as ContractState;
  return {
    owner: raw.owner,
    exists: raw.owner.toLowerCase() !== ZERO_ADDRESS,
    state: stateFromCode(stateCode),
    stateCode,
    lastPing: BigInt(raw.lastPing),
    pingInterval: BigInt(raw.pingInterval),
    createdAt: BigInt(raw.createdAt),
    expiresAt: BigInt(raw.expiresAt),
    darkMarkedAt: BigInt(raw.darkMarkedAt),
    revealedAt: BigInt(raw.revealedAt),
    bounty: BigInt(raw.bounty),
    ownerStake: BigInt(raw.ownerStake),
    plaintextCommitment: raw.plaintextCommitment,
    encKeyHandle: raw.encKeyHandle,
    revealedKey: raw.revealedKey,
    ciphertextLength: BigInt(raw.ciphertextLength),
    published: raw.published,
    rescuable: raw.rescuable,
  };
};

/**
 * The state at chain time `nowSec`, refining the contract's answer between
 * polls: an ALIVE switch whose deadline has since passed reads as DARK, and
 * an ACTIVE switch RESCUE_DELAY past the deadline as rescuable.
 *
 * @param nowSec seconds since epoch — pass the chain's (interpolated) block
 *        timestamp from `useChainTime`, not the browser clock. A skewed local
 *        clock would otherwise offer a markDark that reverts NotDark.
 */
export const switchStateFor = (info: SwitchInfo, nowSec: bigint | null | undefined): SwitchState => {
  if (nowSec == null) return info.state;
  if (info.state === "alive" && nowSec >= info.expiresAt) return "dark";
  return info.state;
};

/** Rescue (reclaimOwnerStake / reclaimContribution on an ACTIVE switch) is open at `nowSec`. */
export const isRescuableAt = (info: SwitchInfo, nowSec: bigint | null | undefined): boolean => {
  if (info.rescuable) return true;
  if (nowSec == null) return false;
  const active = info.state === "alive" || info.state === "dark" || info.state === "darkMarked";
  return info.exists && active && nowSec >= info.expiresAt + BigInt(RESCUE_DELAY);
};

/** Seconds until the deadline (negative once dark). */
export const secondsLeft = (info: SwitchInfo, nowSec: bigint): bigint => info.expiresAt - nowSec;

/**
 * Link to a switch's page. It names the switch's deployment (`?contract=`):
 * after a redeploy, a link without it would resolve on the new contract,
 * where the same (owner, id) can be another switch. The page still opens a
 * link without one (app/switch/[chainId]/[owner]/[id]/page.tsx).
 */
export const switchPath = (chainId: number, h: { contractAddr: string; owner: string; id: bigint | string }): string =>
  `/switch/${chainId}/${getAddress(h.owner)}/${h.id.toString()}?contract=${getAddress(h.contractAddr)}`;

/** A fresh random switch id (non-zero uint64-range bigint; ids only need to be unique per owner). */
export const randomSwitchId = (): bigint => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v === 0n ? 1n : v;
};

// ---------- formatting ----------

export const fmtDuration = (sec: bigint | number): string => {
  let s = Number(sec);
  if (!isFinite(s)) return "—";
  const neg = s < 0;
  s = Math.abs(Math.trunc(s));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);    s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  // "30d", not "30d 0s"; a bare "0s" only when nothing else is left.
  if (s || parts.length === 0) parts.push(`${s}s`);
  return (neg ? "-" : "") + parts.slice(0, 3).join(" ");
};

/** Date + time. A 30-day interval rendered as a bare clock time is useless. */
export const fmtDateTime = (unixSec: bigint | number): string =>
  new Date(Number(unixSec) * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

export const fmtAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Shortened bytes32 (handles, commitments, keys). */
export const fmtBytes32 = (h: string): string => `${h.slice(0, 10)}…${h.slice(-8)}`;

/**
 * Fixed-point bigint → decimal string, truncated (not rounded) to `precision`.
 * `round: "up"` rounds away from zero instead: use it for a minimum (the
 * bounty floor), which a truncated display would understate.
 */
export const fmtBigDecimal = (value: bigint, decimals = 18, precision = 4, round: "down" | "up" = "down"): string => {
  const neg = value < 0n;
  let abs = neg ? -value : value;
  if (round === "up" && precision < decimals) {
    const unit = 10n ** BigInt(decimals - precision);
    if (abs % unit !== 0n) abs += unit - (abs % unit);
  }
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).slice(0, precision).replace(/0+$/, "");
  return `${neg ? "-" : ""}${frac ? `${whole}.${frac}` : whole}`;
};

/** wei → "0.0123 ETH" (truncated; `round: "up"` for a minimum). */
export const fmtEth = (wei: bigint, precision = 4, round: "down" | "up" = "down"): string =>
  `${fmtBigDecimal(wei, 18, precision, round)} ETH`;

/** USD with 8 decimals (minBountyUsd, oracle price) → "$1,234.56". */
export const fmtUsd8 = (usd8: bigint): string => {
  const cents = usd8 / 10n ** 6n; // 8 → 2 decimals, truncated
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${frac}`;
};

/** Parse "12.5" (USD) into the contract's 8-decimal integer. Throws on bad input. */
export const parseUsd8 = (s: string): bigint => {
  const m = /^\s*(\d+)(?:\.(\d{0,8}))?\s*$/.exec(s);
  if (!m) throw new Error("enter a USD amount like 10 or 12.50");
  return BigInt(m[1]) * 10n ** 8n + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
};

/** ETH value of `usd8` at oracle `price8` (both 8 decimals), in wei. Mirrors `minBounty()`. */
export const usd8ToWei = (usd8: bigint, price8: bigint): bigint =>
  price8 > 0n ? (usd8 * 10n ** 18n) / price8 : 0n;

// ---------- limits / input helpers ----------

export const INTERVAL_PRESETS: { label: string; seconds: number }[] = [
  { label: "1 minute (testing)", seconds: 60 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 86400 * 7 },
  { label: "30 days", seconds: 86400 * 30 },
  { label: "90 days", seconds: 86400 * 90 },
  { label: "1 year", seconds: 86400 * 365 },
];

export const isValidInterval = (seconds: number | bigint): boolean => {
  const s = Number(seconds);
  return Number.isInteger(s) && s >= MIN_PING_INTERVAL && s <= MAX_PING_INTERVAL;
};

/**
 * Plaintext size in BYTES, not characters: the on-chain cap applies to UTF-8
 * bytes, so a character budget would wave through a page of emoji and then
 * fail at sealing time.
 */
export const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/** Ciphertext size the contract will store for a plaintext of `plaintextBytes`. */
export const ciphertextSizeFor = (plaintextBytes: number): number => plaintextBytes + CIPHERTEXT_OVERHEAD;
