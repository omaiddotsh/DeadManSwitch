import type { Config } from "tailwindcss";

/**
 * Tokens resolve to CSS custom properties declared in globals.css rather than
 * literal hex. Two reasons: status colours are referenced from hand-written CSS
 * (focus rings, scrollbars, selection) as well as from utilities, and the
 * surface scale needs a single home — the previous flat 8-colour palette had no
 * notion of elevation, so every panel, card and popover sat at the same depth.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Elevation scale, canvas (deepest) → overlay (highest).
        canvas:  "rgb(var(--canvas) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        raised:  "rgb(var(--raised) / <alpha-value>)",
        overlay: "rgb(var(--overlay) / <alpha-value>)",

        // Text.
        fg:          "rgb(var(--fg) / <alpha-value>)",
        "fg-muted":  "rgb(var(--fg-muted) / <alpha-value>)",
        "fg-subtle": "rgb(var(--fg-subtle) / <alpha-value>)",

        // Borders.
        line:          "rgb(var(--line) / <alpha-value>)",
        "line-strong": "rgb(var(--line-strong) / <alpha-value>)",

        // Semantic status, named for the switch lifecycle rather than for hue
        // so the meaning survives a palette change.
        alive: "rgb(var(--alive) / <alpha-value>)",
        gone:  "rgb(var(--gone) / <alpha-value>)",
        warn:  "rgb(var(--warn) / <alpha-value>)",
        info:  "rgb(var(--info) / <alpha-value>)",

        // Aliases kept for RainbowKit theming and third-party overrides.
        accent: "rgb(var(--alive) / <alpha-value>)",
        danger: "rgb(var(--gone) / <alpha-value>)",
      },
      fontFamily: {
        // Prose is sans. Mono is reserved for values read character by
        // character: addresses, hashes, ETH amounts, countdowns.
        sans: [
          "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI",
          "Roboto", "Helvetica Neue", "Arial", "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: {
        DEFAULT: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
      },
      boxShadow: {
        card: "0 1px 2px rgb(0 0 0 / 0.4)",
        lift: "0 8px 24px -8px rgb(0 0 0 / 0.6)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to:   { opacity: "1", transform: "none" },
        },
        // Toasts enter from below (they sit at the bottom of the viewport).
        "rise-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to:   { opacity: "1", transform: "none" },
        },
        "pulse-ring": {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0.45" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "rise-in": "rise-in 180ms ease-out",
        "pulse-ring": "pulse-ring 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};
export default config;
