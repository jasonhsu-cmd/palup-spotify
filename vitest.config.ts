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
      // packages/merchant-console (React Testing Library, same as design-system above).
      ["packages/merchant-console/**", "jsdom"],
    ],
    // React Testing Library's auto-cleanup (packages/design-system) only registers itself
    // when a global `afterEach` exists (it does `typeof afterEach === "function"`, checked
    // directly against this repo's installed @testing-library/react this session) — without
    // this, render() output from one `it` leaks into the next in the same file. `globals: true`
    // is the standard fix; every existing test file still explicitly imports describe/it/expect
    // from "vitest", so this is additive and does not change their behavior.
    globals: true,
  },
});
