import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Loading PMDco takes a few seconds; only the PMDco tests need it (PMDCO=1).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
