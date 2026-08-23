import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard Vite + React app. Tailwind runs through PostCSS (tailwind.config.js's `presets`
// pulling in @palup/design-system's token mapping) — no plugin entry needed here for that.
export default defineConfig({
  plugins: [react()],
});
