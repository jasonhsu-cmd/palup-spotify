/** @type {import('tailwindcss').Config} */
// F1's tokens are the ONLY source of colors/spacing/type here (palup-design-system skill, rule 3:
// never hand-write a hex or magic spacing value) — `presets` pulls in
// `@palup/design-system/tailwind-preset`'s `theme.extend`. `content` also scans the design-system
// package's own source so its components' classNames (e.g. Sidebar's `bg-ink`, `text-surface/75`)
// aren't purged when this app's build tree-shakes unused utilities.
module.exports = {
  presets: [require("@palup/design-system/tailwind-preset")],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../design-system/src/**/*.{ts,tsx}"],
};
