// Inline SVG icon set.
//
// Replaces the emoji the UI previously used as its icon system. Emoji render
// as a different glyph per operating system, can't inherit colour, sit on an
// unpredictable baseline, and are announced verbatim by screen readers
// ("clock face two o'clock") in the middle of a sentence.
//
// Every icon is stroke-based on a 24-grid and inherits `currentColor`, so a
// single size/colour class on the parent styles it. Icons are decorative by
// default (aria-hidden); pass a `title` when the icon is the only label.

import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "shield" | "clock" | "lock" | "unlock" | "key" | "target" | "archive"
  | "plus" | "check" | "alert" | "info" | "copy" | "external" | "link"
  | "heart" | "eye" | "ban" | "coins" | "chevronLeft" | "chevronRight"
  | "settings" | "wallet" | "flame" | "book" | "download" | "refresh" | "text"
  | "x" | "cpu";

const PATHS: Record<IconName, ReactElement> = {
  shield: <path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.5-2" /></>,
  key: <><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v4M15 12v3" /></>,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6L9 17l-5-5" />,
  alert: <><path d="M12 3l9 16H3l9-16z" /><path d="M12 9v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h9" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>,
  heart: <path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z" />,
  eye: <><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="3" /></>,
  ban: <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>,
  coins: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></>,
  wallet: <><path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2" /><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M16 13h2" /></>,
  flame: <path d="M12 21c3.3 0 6-2.5 6-5.6 0-3.9-4-5.4-3.4-9.4C12 7 9 9.3 9 12c-1 0-2-1-2.3-2C5.6 11.4 6 13 6 15.4 6 18.5 8.7 21 12 21z" />,
  book: <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z" /><path d="M4 19a2 2 0 0 1 2-2h13" /></>,
  download: <><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" /></>,
  text: <><path d="M5 6V4h14v2" /><path d="M12 4v16" /><path d="M9 20h6" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
};

interface Props extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
  /** Accessible name. Omit for decorative icons that sit beside real text. */
  title?: string;
}

export function Icon({ name, size = 16, title, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

/**
 * Icon in a tinted circle, for step markers and empty states. `tone` maps to
 * the semantic status tokens rather than raw colours.
 */
export function IconBadge({
  name, tone = "neutral", size = 44,
}: { name: IconName; tone?: "alive" | "gone" | "warn" | "info" | "neutral"; size?: number }) {
  const tones: Record<string, string> = {
    alive:   "border-alive/35 bg-alive/10 text-alive",
    gone:    "border-gone/35 bg-gone/10 text-gone",
    warn:    "border-warn/35 bg-warn/10 text-warn",
    info:    "border-info/35 bg-info/10 text-info",
    neutral: "border-line-strong bg-raised text-fg-muted",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full border ${tones[tone]}`}
      style={{ width: size, height: size }}
    >
      <Icon name={name} size={Math.round(size * 0.45)} />
    </span>
  );
}
