import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@src": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    root: ".",
    // Hermetic env: provide the few config vars required at import time so the
    // suite doesn't depend on a developer `.env` (absent in CI). See tests/setup.ts.
    setupFiles: ["./tests/setup.ts"],
  },
});
