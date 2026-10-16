// Baseline security headers for every route. None of them restricts scripts,
// workers, wasm or network requests, so they cannot break hydration, the FHE SDK
// or the wallets. A full CSP (script-src, connect-src, …) is not set here: every
// page is prerendered and hydrates from inline scripts, so a working policy
// needs per-request nonces or hashes. Browsers ignore HSTS on plain http, so localhost is unaffected.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // The app uses no next/image. Unoptimized images also switch off the
  // /_next/image optimizer endpoint, which nothing here needs.
  images: { unoptimized: true },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Relayer proxy responses are per-request and must never be cached by a CDN.
        source: "/api/relayer/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },

  // Zama SDK notes (@zama-fhe/sdk 3.6.0 → @fhevm/sdk 0.13.2):
  //  - No `experiments.asyncWebAssembly` is needed: the SDK ships its TFHE/KMS
  //    WASM as base64 JS modules and compiles them at runtime, so webpack never
  //    sees a .wasm import. They load as lazy chunks (~1.7 MB each) on first use.
  //  - The encrypt worker is spawned with `new Worker(new URL("./encrypt.worker.js",
  //    import.meta.url), { type: "module" })`; webpack 5 recognises that and emits
  //    it as its own chunk (static/chunks/zama-fhe-encrypt.*.js, a classic worker
  //    that importScripts its 4.8 MB body). No extra config.
  //  - WASM threads would need cross-origin isolation (COOP/COEP), which breaks
  //    wallet popups; without it the SDK runs TFHE single-threaded.
  // Next 16 builds with Turbopack by default, which ignores this function and
  // refuses to build while it is set: package.json runs `next build --webpack`
  // and `next dev --webpack`.
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      // MetaMask SDK (via RainbowKit) references React Native storage in web builds.
      "@react-native-async-storage/async-storage": false,
      // lib/fhevm.ts imports the Zama SDK only through dynamic import() inside
      // browser-only functions. Alias it away on the server so SSR bundles never
      // contain the WASM payloads or the encrypt worker.
      ...(isServer ? { "@zama-fhe/sdk": false, "@fhevm/sdk": false } : {}),
    };
    // WalletConnect (via RainbowKit) optionally requires these Node-only modules.
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

// ---------- deployment variables, checked by `next build` ----------

/** lib/deployments.json: the deployments compiled into the app (lib/deployments.ts reads it too). */
async function compiledDeployments() {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return JSON.parse(await readFile(join(__dirname, "lib", "deployments.json"), "utf8"));
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** An entry of NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId> (lib/deployments.ts parsePreviousContracts). */
const PREVIOUS_ENTRY_RE = /^0x[0-9a-fA-F]{40}:\d{1,20}$/;

/**
 * What `next build` refuses in the deployment variables. They are inlined into
 * the bundle at build time, so a mistake ships:
 *  - a public chain (1, 11155111) with a deployment, current or previous, and
 *    no NEXT_PUBLIC_RPC_URL_<chainId>. viem's default RPC would serve its
 *    reads and switch scans, and the defaults cap eth_getLogs spans (Sepolia's,
 *    sepolia.drpc.org's free plan, at 101 blocks) or prune old logs: a first
 *    visit to /dashboard, /hunt or /archive scanned for minutes. ALLOW_PUBLIC_RPC=1
 *    accepts the default RPC anyway (a throwaway build).
 *  - a NEXT_PUBLIC_CONTRACT_<chainId> that is set but is not an address (the
 *    chain was silently hidden).
 *  - a NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId> entry that is not
 *    `<address>:<deploy block>`: that deployment, and its live switches, would
 *    be ignored.
 * The deployments compiled into the app (lib/deployments.json, `compiled`)
 * count as much as the env ones, and their entries are checked the same way.
 */
function deploymentEnvProblems(env, compiled = {}) {
  const val = (k) => (env[k] ?? "").trim();
  const problems = [];
  for (const id of ["1", "11155111", "31337"]) {
    const contract = val(`NEXT_PUBLIC_CONTRACT_${id}`);
    if (contract && !ADDRESS_RE.test(contract)) {
      problems.push(`NEXT_PUBLIC_CONTRACT_${id} is set but is not an address ("${contract}").`);
    }
    const compiledContract = String((compiled.contracts ?? {})[id] ?? "").trim();
    if (compiledContract && !ADDRESS_RE.test(compiledContract)) {
      problems.push(`lib/deployments.json contracts["${id}"] is not an address ("${compiledContract}").`);
    }
    const previous = val(`NEXT_PUBLIC_PREVIOUS_CONTRACTS_${id}`).split(",").map((e) => e.trim()).filter(Boolean);
    const bad = previous.filter((e) => !PREVIOUS_ENTRY_RE.test(e));
    if (bad.length) {
      problems.push(
        `NEXT_PUBLIC_PREVIOUS_CONTRACTS_${id} has entries that are not <address>:<deploy block> (${bad.map((e) => `"${e}"`).join(", ")}); separate entries with commas.`,
      );
    }
    const compiledPrevious = [...((compiled.previousContracts ?? {})[id] ?? [])].map((e) => String(e).trim());
    const badCompiled = compiledPrevious.filter((e) => !PREVIOUS_ENTRY_RE.test(e));
    if (badCompiled.length) {
      problems.push(
        `lib/deployments.json previousContracts["${id}"] has entries that are not <address>:<deploy block> (${badCompiled.map((e) => `"${e}"`).join(", ")}).`,
      );
    }
    const deployed = contract || compiledContract || previous.length || compiledPrevious.length;
    if (id !== "31337" && deployed && !val(`NEXT_PUBLIC_RPC_URL_${id}`) && val("ALLOW_PUBLIC_RPC") !== "1") {
      problems.push(
        `NEXT_PUBLIC_RPC_URL_${id} is required when chain ${id} has a deployment: the public default caps or prunes eth_getLogs, ` +
          "and switch discovery then takes minutes. Use a provider URL whose eth_getLogs accepts NEXT_PUBLIC_LOGS_RANGE_CAP " +
          "(default 5000) blocks per call back to the deploy block (set ALLOW_PUBLIC_RPC=1 to build with the default anyway).",
      );
    }
  }
  return problems;
}

/** next/constants PHASE_PRODUCTION_BUILD. */
const PHASE_PRODUCTION_BUILD = "phase-production-build";

/** Next calls this with its phase; `next build` stops on deploymentEnvProblems. */
async function nextConfigFor(phase) {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const problems = deploymentEnvProblems(process.env, await compiledDeployments());
    if (problems.length) throw new Error(`Deployment variables:\n- ${problems.join("\n- ")}`);
  }
  return nextConfig;
}

module.exports = nextConfigFor;
module.exports.deploymentEnvProblems = deploymentEnvProblems;
module.exports.compiledDeployments = compiledDeployments;
