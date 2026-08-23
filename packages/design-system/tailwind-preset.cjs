/**
 * Tailwind preset mapping PalUp's design tokens into Tailwind's theme. Consumers add:
 *   presets: [require("@palup/design-system/tailwind-preset")]
 * to their own tailwind.config.js so utilities like `bg-ever`, `text-ink-3`, `rounded-lg`
 * resolve to PalUp's values (SKILL.md "How to use" #1-2).
 *
 * Kept as a literal object (not derived from src/theme.ts) so it loads as plain CommonJS
 * without a TS/ESM interop step in a consumer's Tailwind config. It must never drift from
 * theme.ts or tokens.css — test/theme-tokens-consistency.test.ts checks all three.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#16201B", 2: "#3D4A43", 3: "#677269", 4: "#94A09A" },
        paper: "#F6F7F3",
        surface: { DEFAULT: "#FFFFFF", 2: "#FBFCF9", 3: "#F0F2EC" },
        line: { DEFAULT: "#E4E7DF", 2: "#EEF0EA" },
        ever: { DEFAULT: "#0C4A3C", 2: "#0E5A48", soft: "#E6F0EB", tint: "#F1F6F3" },
        coral: { DEFAULT: "#FF5C35", soft: "#FFE9E2" },
        gold: { DEFAULT: "#B8852A", soft: "#FBF1DC" },
        pos: { DEFAULT: "#0E8F5E", soft: "#E4F4EC" },
        warn: { DEFAULT: "#C9810C", soft: "#FBF0D9" },
        dang: { DEFAULT: "#D33B2C", soft: "#FBE7E4" },
        info: { DEFAULT: "#2B66D9", soft: "#E6EEFB" },
      },
      borderRadius: { sm: "8px", DEFAULT: "12px", lg: "18px", xl: "26px" },
      fontFamily: {
        sans: ['"Hanken Grotesk"', "system-ui", "sans-serif"],
        display: ['"Schibsted Grotesk"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        sm: "0 1px 2px rgba(22,32,27,.06),0 1px 1px rgba(22,32,27,.04)",
        DEFAULT: "0 2px 8px rgba(22,32,27,.06),0 1px 2px rgba(22,32,27,.04)",
        lg: "0 18px 48px -12px rgba(22,32,27,.20),0 6px 16px -8px rgba(22,32,27,.12)",
      },
    },
  },
};
