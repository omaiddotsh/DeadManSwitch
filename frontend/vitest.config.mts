import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The automatic JSX runtime, as Next uses (tsconfig's jsx: "react-jsx", which Next 16 requires).
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "components/**/*.test.{ts,tsx}"],
    // The local fhEVM integration test needs a running Anvil + host stack; it
    // skips itself unless DMS_LOCAL_RPC and DMS_LOCAL_CONTRACT are set.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
