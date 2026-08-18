// WS10 — merchant-brand theming for the shopper widget, contrast-safe by construction.
//
// A merchant's brand colour can be anything, but the widget's text/fills MUST still clear WCAG 2.2 AA
// (the widget's a11y suite measures real contrast and would fail otherwise). So the brand is NEVER applied
// raw: `deriveThemeVars` computes, from a single brand hex, a set of CSS-variable values that are each
// proven ≥ 4.5:1 (text) / adjusted-fill against their ACTUAL backdrops — the light panel (#ffffff), the dark
// panel (#141924), and the brand fill itself. Brand is applied only where contrast is controlled (header
// fill, user bubble, primary buttons, launcher, text/focus accents); the safety bubble, handoff teal, muted
// body text and the PalUp mark stay on the fixed token set (a signal/attribution, not a brand surface).
//
// The values are operator-CURATED (a static per-tenant map), so no merchant free-text colour is trusted and
// no schema migration is needed. Shopify Shop.brand / a registry column are a documented follow-on behind
// the same `resolveTheme` seam. This module is scanned by shopper-promise-guard, so it stays claim-free.

export interface ThemeConfig {
  /** The merchant's primary brand colour as #rrggbb. */
  brand: string;
  /** Header brand name; falls back to the grounding brandName, then a generic. */
  brandName?: string;
  /** Optional https logo URL (Shopify-CDN host); monogram fallback when absent/invalid. */
  logoUrl?: string;
}

export interface ThemeVars {
  /** The brand fill (kept as close to the input as contrast allows). */
  brand: string;
  /** Text/icon colour ON the brand fill (#ffffff or #000000), ≥ 4.5:1. */
  brandInk: string;
  /** Brand-as-text/focus-ring on the LIGHT panel (#ffffff), ≥ 4.5:1. */
  brandText: string;
  /** Brand-as-text/focus-ring on the DARK panel (#141924), ≥ 4.5:1. */
  brandTextDark: string;
}

export interface ResolvedTheme extends ThemeVars {
  brandName?: string;
  logoUrl?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;
const LIGHT_PANEL: Rgb = [255, 255, 255];
const DARK_PANEL: Rgb = [0x14, 0x19, 0x24];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const AA = 4.5;

type Rgb = [number, number, number];

/** Today's widget indigo — the safe default when a tenant has no curated theme or a config is malformed. */
export const DEFAULT_THEME: ThemeConfig = { brand: "#4f46e5" };

// Curated per-tenant themes. The staging demo tenant matches the sample storefront's terracotta so the
// widget reads as native to the Auria store. (This map is the v1 source; Shop.brand is a later enrichment.)
const THEME_CONFIGS: Record<string, ThemeConfig> = {
  "palup-skincare-jason": { brand: "#a44a34", brandName: "Auria" },
  demo: { brand: "#a44a34", brandName: "Auria" },
};

function hexToRgb(hex: string): Rgb | null {
  if (!HEX.test(hex)) return null;
  const h = hex.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
// WCAG relative luminance (same formula as the a11y suite's measureContrast).
function relLum([r, g, b]: Rgb): number {
  return [r, g, b]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i]!, 0);
}
export function contrast(a: Rgb, b: Rgb): number {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function darken([r, g, b]: Rgb, f = 0.88): Rgb {
  return [r * f, g * f, b * f];
}
function lighten([r, g, b]: Rgb, f = 0.14): Rgb {
  return [r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f];
}

/**
 * Derive contrast-safe CSS-variable values from one brand hex. Every returned value is guaranteed AA
 * against its real backdrop (or falls back to a token that is). A malformed hex falls back to the default
 * indigo before derivation, so this never throws and never emits an unsafe colour.
 */
export function deriveThemeVars(brandHex: string): ThemeVars {
  const rgb = hexToRgb(brandHex) ?? hexToRgb(DEFAULT_THEME.brand)!;

  // Ink on the brand fill: prefer whichever of white/black has more contrast; if it still misses AA (a
  // mid-tone brand), adjust the FILL toward the opposite of the ink until the ink clears AA.
  const ink: Rgb = contrast(WHITE, rgb) >= contrast(BLACK, rgb) ? WHITE : BLACK;
  let fill = rgb;
  for (let i = 0; i < 24 && contrast(ink, fill) < AA; i++) {
    fill = ink === WHITE ? darken(fill) : lighten(fill);
  }

  // Brand-as-text on the light panel: darken the brand until it clears AA on white.
  let text = rgb;
  for (let i = 0; i < 30 && contrast(text, LIGHT_PANEL) < AA; i++) text = darken(text);

  // Brand-as-text on the dark panel: lighten the brand until it clears AA on #141924.
  let textDark = rgb;
  for (let i = 0; i < 30 && contrast(textDark, DARK_PANEL) < AA; i++) textDark = lighten(textDark);

  return { brand: rgbToHex(fill), brandInk: rgbToHex(ink), brandText: rgbToHex(text), brandTextDark: rgbToHex(textDark) };
}

function safeLogoUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const ok = host === "cdn.shopify.com" || host.endsWith(".shopifycdn.net") || host.endsWith(".myshopify.com");
  return parsed.protocol === "https:" && ok ? url : undefined;
}

/**
 * Render the FOUC-free theme injection for the panel HTML's `<!--PALUP_THEME-->` marker: a `<style>` that
 * overrides the widget's brand CSS variables (in both colour schemes) + a `<script>` that carries the brand
 * name/logo for the header. The colour values are validated hex (safe in CSS); the name/logo travel as
 * JSON with `<` escaped to `<` so a merchant brand name containing `</script>` can never break out.
 */
export function themeStyleBlock(theme: ResolvedTheme): string {
  const style =
    `<style id="palup-theme">:root{--brand:${theme.brand};--brand-ink:${theme.brandInk};--brand-glow:${theme.brandText};}` +
    `@media (prefers-color-scheme: dark){:root{--brand:${theme.brand};--brand-ink:${theme.brandInk};--brand-glow:${theme.brandTextDark};}}</style>`;
  const meta = JSON.stringify({ brandName: theme.brandName, logoUrl: theme.logoUrl }).replace(/</g, "\\u003c");
  const script = `<script>window.PALUP=Object.assign(window.PALUP||{},{theme:${meta}});</script>`;
  return style + script;
}

/** The curated theme config for a tenant (or the default). */
export function resolveThemeConfig(tenantId: string): ThemeConfig {
  return (tenantId && Object.hasOwn(THEME_CONFIGS, tenantId) && THEME_CONFIGS[tenantId]) || DEFAULT_THEME;
}

/**
 * Resolve a tenant's full applied theme: contrast-safe vars + brand name (config, else the grounding
 * brandName, else undefined) + a validated logo URL. Pure — a plain map lookup, safe to call per request.
 */
export function resolveTheme(tenantId: string, fallbackBrandName?: string): ResolvedTheme {
  const cfg = resolveThemeConfig(tenantId);
  return {
    ...deriveThemeVars(cfg.brand),
    brandName: cfg.brandName ?? (fallbackBrandName || undefined),
    logoUrl: safeLogoUrl(cfg.logoUrl),
  };
}
