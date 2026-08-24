import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard Vite + React app. Tailwind runs through PostCSS (tailwind.config.js's `presets`
// pulling in @palup/design-system's token mapping) — no plugin entry needed here for that.
export default defineConfig({
  plugins: [react()],
  build: {
    // `package.json`'s `build` script is `tsc -b && vite build` — `tsc -b`'s own `outDir` (tsconfig.json)
    // is the default `dist/`. Vite's own default `build.outDir` is ALSO `dist/` (relative to this
    // package's root, where `index.html` lives) — the two would collide and clobber each other's output.
    // `merchant-backend/src/server.ts` serves the real SPA bundle (`index.html` + hashed `assets/*`) from
    // this dir, so it needs its own name distinct from the plain-JS `tsc` output.
    outDir: "dist-web",
  },
});
