import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import compiledJson from "./deployments.json";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
type Config = { images?: { unoptimized?: boolean }; headers: () => Promise<HeaderRule[]> };
/** lib/deployments.json: the deployments compiled into the app. */
type Compiled = { contracts?: Record<string, string>; previousContracts?: Record<string, string[]> };
type ConfigModule = ((phase: string) => Promise<Config>) & {
  deploymentEnvProblems: (env: Record<string, string | undefined>, compiled?: Compiled) => string[];
  compiledDeployments: () => Promise<Compiled>;
};

// next.config.js is CommonJS, and exports an async function of Next's phase.
const load = createRequire(import.meta.url);
const configModule = load("../next.config.js") as ConfigModule;
const nextConfig = await configModule("phase-development-server");

async function headersFor(source: string): Promise<Record<string, string>> {
  const rule = (await nextConfig.headers()).find((r) => r.source === source);
  expect(rule, `header rule for ${source}`).toBeDefined();
  return Object.fromEntries(rule!.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

function directives(csp: string): Map<string, string> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...rest] = d.split(/\s+/);
        return [name.toLowerCase(), rest.join(" ")] as const;
      }),
  );
}

describe("next.config.js security headers", () => {
  it("sends HSTS and the baseline headers on every route", async () => {
    const h = await headersFor("/:path*");
    expect(h["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["x-frame-options"]).toBe("DENY");
  });

  it("turns off device and tracking APIs the app never uses", async () => {
    const pp = (await headersFor("/:path*"))["permissions-policy"];
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "serial", "hid", "bluetooth", "browsing-topics"]) {
      expect(pp, feature).toContain(`${feature}=()`);
    }
    // The copy buttons need the clipboard.
    expect(pp).not.toContain("clipboard");
  });

  it("sets only CSP directives that cannot break scripts, workers, wasm or network calls", async () => {
    const csp = directives((await headersFor("/:path*"))["content-security-policy"]);
    expect(Object.fromEntries(csp)).toEqual({
      "frame-ancestors": "'none'",
      "object-src": "'none'",
      "base-uri": "'none'",
      "form-action": "'self'",
    });
    // Prerendered pages hydrate from inline scripts and the FHE SDK needs wasm,
    // blob workers and its key bucket: none of these may be restricted here.
    for (const d of ["default-src", "script-src", "script-src-elem", "worker-src", "connect-src", "child-src", "style-src", "img-src"]) {
      expect(csp.has(d), d).toBe(false);
    }
  });

  it("keeps relayer proxy responses out of caches", async () => {
    expect((await headersFor("/api/relayer/:path*"))["cache-control"]).toBe("no-store");
  });

  it("disables the unused image optimizer (/_next/image)", () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});

// G5: without NEXT_PUBLIC_RPC_URL_<id>, viem's default RPC is used. Sepolia's (sepolia.drpc.org, free plan)
// rejects eth_getLogs spans over 101 blocks, so a first visit to /hunt, /archive or /dashboard scanned for
// minutes (14 at a month since the deploy). `next build` refuses such a configuration.
describe("next.config.js: the deployment variables a production build requires", () => {
  const OK = "0x00000000000000000000000000000000000d3ad5";
  const OLD = "0x00000000000000000000000000000000000a11ce";
  const problems = (env: Record<string, string | undefined>, compiled?: Compiled) => configModule.deploymentEnvProblems(env, compiled);

  it("a chain with a contract needs its own RPC URL", () => {
    expect(problems({ NEXT_PUBLIC_CONTRACT_11155111: OK })).toEqual([
      expect.stringContaining("NEXT_PUBLIC_RPC_URL_11155111"),
    ]);
    expect(problems({ NEXT_PUBLIC_CONTRACT_1: OK, NEXT_PUBLIC_RPC_URL_1: "  " })).toEqual([
      expect.stringContaining("NEXT_PUBLIC_RPC_URL_1 "),
    ]);
    expect(problems({ NEXT_PUBLIC_CONTRACT_11155111: OK, NEXT_PUBLIC_RPC_URL_11155111: "https://eth-sepolia.example/v2/k" })).toEqual([]);
  });

  it("previous deployments count as a contract, and must read <address>:<deploy block>", () => {
    expect(problems({ NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111: `${OLD}:7000000` })).toEqual([
      expect.stringContaining("NEXT_PUBLIC_RPC_URL_11155111"),
    ]);
    const rpc = { NEXT_PUBLIC_RPC_URL_11155111: "https://eth-sepolia.example/v2/k" };
    expect(problems({ ...rpc, NEXT_PUBLIC_CONTRACT_11155111: OK, NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111: ` ${OLD}:7000000 , ${OK.replace("d3ad5", "beef5")}:6900000` })).toEqual([]);
    for (const bad of [OLD, `${OLD}:`, `${OLD}:12abc`, `${OLD.slice(0, 20)}:7000000`, `${OLD}:7000000;${OLD}:1`]) {
      expect(problems({ ...rpc, NEXT_PUBLIC_CONTRACT_11155111: OK, NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111: bad }), bad).toEqual([
        expect.stringContaining("NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111"),
      ]);
    }
    // The local chain has its own RPC default; its list is still checked.
    expect(problems({ NEXT_PUBLIC_CONTRACT_31337: OK, NEXT_PUBLIC_PREVIOUS_CONTRACTS_31337: `${OLD}:0` })).toEqual([]);
    expect(problems({ NEXT_PUBLIC_PREVIOUS_CONTRACTS_31337: "0x12" })).toEqual([expect.stringContaining("NEXT_PUBLIC_PREVIOUS_CONTRACTS_31337")]);
  });

  it("a contract variable that is set must be an address (a typo hid the chain silently)", () => {
    expect(problems({ NEXT_PUBLIC_CONTRACT_11155111: "0xd3ad5", NEXT_PUBLIC_RPC_URL_11155111: "https://x.example" })).toEqual([
      expect.stringContaining("NEXT_PUBLIC_CONTRACT_11155111"),
    ]);
  });

  // An address compiled into the app (lib/deployments.json, read by lib/deployments.ts) is a
  // deployment as much as an env one: its chain needs an RPC URL too, and a malformed entry must not ship.
  it("deployments compiled into the app (lib/deployments.json) count too", () => {
    const rpc = { NEXT_PUBLIC_RPC_URL_11155111: "https://eth-sepolia.example/v2/k" };
    expect(problems({}, { contracts: { "11155111": OK } })).toEqual([expect.stringContaining("NEXT_PUBLIC_RPC_URL_11155111")]);
    expect(problems({}, { previousContracts: { "1": [`${OLD}:7000000`] } })).toEqual([expect.stringContaining("NEXT_PUBLIC_RPC_URL_1 ")]);
    expect(problems(rpc, { contracts: { "11155111": OK }, previousContracts: { "11155111": [`${OLD}:7000000`] } })).toEqual([]);
    expect(problems(rpc, { contracts: { "11155111": "0xd3ad5" } })).toEqual([expect.stringContaining("lib/deployments.json")]);
    expect(problems(rpc, { previousContracts: { "11155111": [OLD] } })).toEqual([expect.stringContaining("lib/deployments.json")]);
    // As shipped (nothing compiled in), a build without contracts needs nothing.
    expect(problems({}, compiledJson)).toEqual([]);
  });

  it("`next build` reads lib/deployments.json, the file lib/deployments.ts compiles in", async () => {
    expect(await configModule.compiledDeployments()).toEqual(compiledJson);
  });

  it("CI and the browser e2e (no public contract) build as before; ALLOW_PUBLIC_RPC=1 accepts the default RPC", () => {
    expect(problems({})).toEqual([]);
    expect(problems({ NEXT_PUBLIC_CONTRACT_1: "", NEXT_PUBLIC_CONTRACT_11155111: "", NEXT_PUBLIC_CONTRACT_31337: OK })).toEqual([]);
    expect(problems({ NEXT_PUBLIC_CONTRACT_11155111: OK, ALLOW_PUBLIC_RPC: "1" })).toEqual([]);
  });

  it("`next build` throws on a problem; `next dev` and `next start` do not", async () => {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_") || k === "ALLOW_PUBLIC_RPC") delete process.env[k];
      process.env.NEXT_PUBLIC_CONTRACT_11155111 = OK;
      await expect(configModule("phase-production-build")).rejects.toThrow(/NEXT_PUBLIC_RPC_URL_11155111/);
      expect((await configModule("phase-development-server")).images?.unoptimized).toBe(true);
      expect((await configModule("phase-production-server")).images?.unoptimized).toBe(true);
      process.env.NEXT_PUBLIC_RPC_URL_11155111 = "https://eth-sepolia.example/v2/k";
      expect((await configModule("phase-production-build")).images?.unoptimized).toBe(true);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
