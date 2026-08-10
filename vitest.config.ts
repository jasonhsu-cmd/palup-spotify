import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    // Workspace packages ship raw .ts (no build step); inline them so Vitest transforms them.
    server: { deps: { inline: [/@palup\//] } },
    // packages/widget needs a real DOM (shadow root, iframe, postMessage) — everything else
    // in this repo is server-side and relies on the default "node" environment below. This is
    // the actual mechanism the single root runner honors (there's no vitest workspace, so a
    // package-local vitest.config.ts under packages/widget would be dead config the root run
    // never loads). Package-wide, so future packages/widget/**/*.test.ts files get jsdom by
    // default without each one needing its own per-file pragma.
    environmentMatchGlobs: [["packages/widget/**", "jsdom"]],
  },
});
