import type { SwitchInfo, SwitchState } from "@/lib/switch";

/**
 * List orders by what needs attention. Both read only the switch info, never
 * the clock, so a list is not re-sorted every second (the /hunt 1 Hz fix):
 * revealed and cancelled never change with time, and for the rest the
 * deadline already puts overdue switches first.
 */

const SETTLED: ReadonlySet<SwitchState> = new Set<SwitchState>(["revealed", "cancelled", "none"]);
const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** /hunt's "Deadline" sort: switches still in play by deadline (most overdue first), then settled ones. */
export const byDeadline = (a: SwitchInfo, b: SwitchInfo): number =>
  Number(SETTLED.has(a.state)) - Number(SETTLED.has(b.state)) || cmp(a.expiresAt, b.expiresAt);

/**
 * 0: not read yet (its skeleton or read error must be seen); 1: alive, to be
 * pinged; 2: dark, waiting for a release or the rescue; 3: settled.
 */
const ownerGroup = (info: SwitchInfo | null): number =>
  !info ? 0 : info.state === "alive" ? 1 : info.state === "dark" || info.state === "darkMarked" ? 2 : 3;

/**
 * The owner's dashboard: alive switches by soonest deadline (the next ping
 * due on top), then dark ones (longest dark first: their rescue opens first),
 * then revealed and cancelled ones, newest first as scanned. Stable.
 */
export const ownerOrder = <T extends { info: SwitchInfo | null }>(rows: readonly T[]): T[] =>
  rows
    .map((row, i) => ({ row, i, g: ownerGroup(row.info) }))
    .sort((x, y) =>
      x.g - y.g
      || (x.g === 1 || x.g === 2 ? cmp(x.row.info!.expiresAt, y.row.info!.expiresAt) : 0)
      || x.i - y.i)
    .map(({ row }) => row);
