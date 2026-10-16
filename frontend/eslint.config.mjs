// ESLint 9 flat config. `npm run lint` runs ESLint directly with
// eslint-config-next's flat presets: Next 16 removed `next lint`, and
// `next build` no longer lints. Run `npm run lint` before a release.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**", "node_modules/**", "out/**", "next-env.d.ts", "tsconfig.tsbuildinfo",
      // Browser e2e artifacts (Playwright's HTML report bundles the trace viewer's JS).
      "test-results/**", "playwright-report/**", "blob-report/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // `_`-prefixed parameters/variables are intentionally unused (stubs, destructuring).
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];

export default config;
