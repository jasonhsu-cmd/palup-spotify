import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
    // Workspace packages ship raw .ts (no build step); inline them so Vitest transforms them.
    server: { deps: { inline: [/@palup\//] } },
    // packages/widget needs a real DOM (shadow root, iframe, postMessage); packages/design-system
    // needs one too (React Testing Library renders into jsdom). Everything else in this repo is
    // server-side and relies on the default "node" environment below. This is the actual
    // mechanism the single root runner honors (there's no vitest workspace, so a package-local
    // vitest.config.ts would be dead config the root run never loads).
    environmentMatchGlobs: [
      ["packages/widget/**", "jsdom"],
      ["packages/design-system/**", "jsdom"],
    ],
  },
});
