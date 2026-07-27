import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    // Workspace packages ship raw .ts (no build step); inline them so Vitest transforms them.
    server: { deps: { inline: [/@palup\//] } },
  },
});
