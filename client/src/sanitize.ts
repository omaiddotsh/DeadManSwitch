// Revealed plaintext is attacker-controlled: whoever created the switch chose
// its bytes. Printing it raw lets it drive the terminal (ANSI/OSC escapes can
// rewrite earlier output, set the window title, plant hyperlinks, or on some
// terminals write to the clipboard), and bidi/zero-width characters can make
// text read differently from what it is. Everything printed goes through here;
// raw bytes only ever go to a file the user asked for (--out).

/**
 * Characters that are replaced by a visible escape:
 *  - C0 controls except TAB and LF (includes ESC, BEL, BS, CR)
 *  - DEL and the C1 controls U+0080–U+009F (U+009B is a one-byte CSI)
 *  - bidi embeddings/overrides/isolates and marks (Trojan Source)
 *  - zero-width and invisible formatting characters, line/paragraph separators,
 *    and every other format character (\p{Cf}: soft hyphen, U+180E, U+206A–206F,
 *    the tag characters U+E0000–E007F that can carry hidden text)
 *  - variation selectors (U+FE00–FE0F, U+E0100–E01EF, the Mongolian U+180B–180F),
 *    which render as nothing and can carry hidden text one byte per selector, except
 *    one that is ordinary text after its base character (see isOrdinarySelector)
 *  - the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), which also render as nothing
 */
const UNSAFE_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0100, 0xe01ef],
];
const cpEscape = (n: number) => `\\u{${n.toString(16)}}`;
const UNSAFE = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => (a === b ? cpEscape(a) : `${cpEscape(a)}-${cpEscape(b)}`)).join("")}\\p{Cf}]`, "gu");
const EMOJI = /\p{Emoji}/u;
const IDEOGRAPH = /\p{Ideographic}/u;
const MONGOLIAN_LETTER = /(?=\p{L})\p{Script=Mongolian}/u;

/**
 * A variation selector that is ordinary text, kept as the web app's sanitiser (frontend/lib/envelope.ts) keeps it:
 * one presentation selector (U+FE0E / U+FE0F) after an emoji character (a red heart, the "1" of a keycap), one
 * ideographic selector (U+E0100–E01EF) after a CJK ideograph (the variants of Japanese names), one Mongolian
 * selector (U+180B–180F) after a Mongolian letter. Anywhere else, a second one included, a selector draws nothing
 * and is escaped.
 */
const isOrdinarySelector = (ch: string, offset: number, text: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0;
  const prev = [...text.slice(Math.max(0, offset - 2), offset)].pop();
  if (prev === undefined) return false;
  if (cp === 0xfe0e || cp === 0xfe0f) return EMOJI.test(prev);
  if (cp >= 0xe0100 && cp <= 0xe01ef) return IDEOGRAPH.test(prev);
  if (cp >= 0x180b && cp <= 0x180f) return MONGOLIAN_LETTER.test(prev);
  return false;
};

const escapeChar = (ch: string): string => {
  const cp = ch.codePointAt(0)!;
  if (cp === 0x0d) return "\\r";
  if (cp <= 0xff) return `\\x${cp.toString(16).padStart(2, "0")}`;
  return `\\u{${cp.toString(16)}}`;
};

/** Make untrusted text safe to write to a terminal. Keeps TAB and LF. */
export const sanitizeForTerminal = (text: string): string =>
  text.replace(UNSAFE, (ch: string, offset: number, whole: string) => (isOrdinarySelector(ch, offset, whole) ? ch : escapeChar(ch)));

/** True when the text contains anything sanitizeForTerminal would rewrite. */
export const hasUnsafeChars = (text: string): boolean => sanitizeForTerminal(text) !== text;

export interface RenderedPlaintext {
  /** Terminal-safe rendering. */
  text: string;
  /** Not valid UTF-8: `text` is a hex dump. */
  binary: boolean;
  /** Something was escaped. */
  escaped: boolean;
}

/** Render plaintext bytes for a terminal: sanitized UTF-8, or hex when not UTF-8. */
export const renderPlaintext = (bytes: Uint8Array): RenderedPlaintext => {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { text: `0x${Buffer.from(bytes).toString("hex")}`, binary: true, escaped: false };
  }
  const text = sanitizeForTerminal(decoded);
  return { text, binary: false, escaped: text !== decoded };
};
