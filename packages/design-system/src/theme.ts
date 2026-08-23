/**
 * Typed mirror of the canonical `.claude/skills/palup-design-system/tokens.css`. Every value
 * here must be byte-identical to that file — `test/theme-tokens-consistency.test.ts` enforces
 * it. Do not hand-edit one without the other.
 */
export const theme = {
  color: {
    ink: "#16201B",
    ink2: "#3D4A43",
    ink3: "#677269",
    ink4: "#94A09A",
    paper: "#F6F7F3",
    surface: "#FFFFFF",
    surface2: "#FBFCF9",
    surface3: "#F0F2EC",
    line: "#E4E7DF",
    line2: "#EEF0EA",
    ever: "#0C4A3C",
    ever2: "#0E5A48",
    everSoft: "#E6F0EB",
    everTint: "#F1F6F3",
    coral: "#FF5C35",
    coralSoft: "#FFE9E2",
    gold: "#B8852A",
    goldSoft: "#FBF1DC",
    pos: "#0E8F5E",
    posSoft: "#E4F4EC",
    warn: "#C9810C",
    warnSoft: "#FBF0D9",
    dang: "#D33B2C",
    dangSoft: "#FBE7E4",
    info: "#2B66D9",
    infoSoft: "#E6EEFB",
    // On-tint ink for .note — text-info/warn/dang fail WCAG AA on their *-soft backgrounds;
    // these (from the mockup's own .note.info/.warn/.dang rules) clear AA. See tokens.css.
    noteInfoInk: "#1B4596",
    noteWarnInk: "#8A5A06",
    noteDangInk: "#9E261A",
  },
  radius: {
    sm: "8px",
    default: "12px",
    lg: "18px",
    xl: "26px",
  },
  shadow: {
    sm: "0 1px 2px rgba(22,32,27,.06),0 1px 1px rgba(22,32,27,.04)",
    default: "0 2px 8px rgba(22,32,27,.06),0 1px 2px rgba(22,32,27,.04)",
    lg: "0 18px 48px -12px rgba(22,32,27,.20),0 6px 16px -8px rgba(22,32,27,.12)",
  },
  font: {
    sans: '"Hanken Grotesk", system-ui, sans-serif',
    display: '"Schibsted Grotesk", system-ui, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, monospace',
  },
  sidebarWidth: "264px",
} as const;

export type Theme = typeof theme;
