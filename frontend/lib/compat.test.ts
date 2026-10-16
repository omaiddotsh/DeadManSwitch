// Browser support: every page's layout imports lib/hooks (via the header),
// which imports lib/envelope. A regex or API an older engine lacks, evaluated
// at module load, breaks every page there. Safari/iOS before 16.4 has no regex
// lookbehind, and AbortSignal.timeout needs Safari 16.0.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A RegExp that throws on lookbehind, like JavaScriptCore before Safari 16.4. */
const stubOldRegExp = () => {
  const Real = RegExp;
  const Old = function (this: unknown, p: string | RegExp, f?: string) {
    const src = typeof p === "string" ? p : p.source;
    if (/\(\?<[=!]/.test(src)) throw new SyntaxError("Invalid regular expression: invalid group specifier name");
    return new Real(p, f);
  } as unknown as RegExpConstructor;
  Object.setPrototypeOf(Old, Real);
  (Old as unknown as { prototype: unknown }).prototype = Real.prototype;
  vi.stubGlobal("RegExp", Old);
};

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("old WebKit (no regex lookbehind)", () => {
  it("lib/envelope and lib/hooks load, and the plaintext view still escapes hidden text", async () => {
    stubOldRegExp();
    vi.resetModules();
    const envelope = await import("./envelope");
    await expect(import("./hooks")).resolves.toBeDefined();
    const smuggled = "OK" + String.fromCodePoint(0xe0100 + 40, 0xfe01);
    const d = envelope.toDisplayText(new TextEncoder().encode(smuggled));
    expect(d.hadInvisibleChars).toBe(true);
    expect(d.text).toBe("OK\\u{e0128}\\u{fe01}");
  });
});

/** Browser code: everything under lib/, components/ and app/ except the server-only API routes and tests. */
const browserSources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (!p.endsWith(join("app", "api"))) walk(p);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$|\.testutil\.ts$/.test(name)) {
        out.push(p);
      }
    }
  };
  for (const d of ["lib", "components", "app"]) walk(join(ROOT, d));
  return out;
};

describe("browser code uses nothing newer than Safari 15.4", () => {
  // Engine features no transpiler can add, and APIs Next 14 does not polyfill.
  const NEWER: [RegExp, string][] = [
    [/\(\?<[=!]/, "regex lookbehind (Safari 16.4)"],
    [/AbortSignal\.(timeout|any)\b/, "AbortSignal.timeout / any (Safari 16.0 / 17.4)"],
    [/Promise\.withResolvers\b/, "Promise.withResolvers (Safari 17.4)"],
    [/\.(toSorted|toReversed|toSpliced)\(/, "change-array-by-copy (Safari 16.0)"],
    [/\b(Object|Map)\.groupBy\b/, "groupBy (Safari 17.4)"],
    [/Array\.fromAsync\b/, "Array.fromAsync (Safari 16.4)"],
    [/\.isWellFormed\(/, "String.isWellFormed (Safari 16.4)"],
  ];
  it("no source file uses them", () => {
    const hits: string[] = [];
    for (const f of browserSources()) {
      const src = readFileSync(f, "utf8");
      for (const [re, what] of NEWER) if (re.test(src)) hits.push(`${f.slice(ROOT.length)}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});
