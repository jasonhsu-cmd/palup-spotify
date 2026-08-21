import { describe, it, expect } from "vitest";
import { deriveThemeVars, resolveTheme, resolveThemeConfig, contrast, themeStyleBlock, DEFAULT_THEME } from "../src/widget-theme.js";

// WS10 — the contrast-safety proof. deriveThemeVars must yield AA-clean CSS variables for ANY brand color,
// including deliberately hostile ones, so a merchant's brand can never break the widget's WCAG 2.2 AA a11y.
type Rgb = [number, number, number];
function rgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const LIGHT: Rgb = [255, 255, 255];
const DARK: Rgb = [0x14, 0x19, 0x24];

describe("deriveThemeVars — AA across a hostile brand matrix", () => {
  for (const brand of ["#ffff00", "#ffffff", "#000000", "#808080", "#4f46e5", "#a44a34", "#0000ff"]) {
    it(`${brand}: ink≥4.5 on fill, text≥4.5 on light panel, textDark≥4.5 on dark panel`, () => {
      const v = deriveThemeVars(brand);
      expect(v.brand).toMatch(/^#[0-9a-f]{6}$/);
      expect(["#ffffff", "#000000"]).toContain(v.brandInk);
      expect(contrast(rgb(v.brandInk), rgb(v.brand))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(v.brandText), LIGHT)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(v.brandTextDark), DARK)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("a malformed brand hex falls back to the default indigo (never throws, never unsafe)", () => {
    for (const bad of ["not-a-hex", "#fff", "#12345", "rgb(1,2,3)", ""]) {
      const v = deriveThemeVars(bad);
      expect(contrast(rgb(v.brandInk), rgb(v.brand))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the brand fill unchanged when its natural ink already clears AA (e.g. indigo → white)", () => {
    expect(deriveThemeVars("#4f46e5").brand).toBe("#4f46e5");
    expect(deriveThemeVars("#4f46e5").brandInk).toBe("#ffffff");
  });
});

describe("resolveTheme / resolveThemeConfig", () => {
  it("returns the curated terracotta COLOUR for palup-skincare-jason; the brand NAME comes from the fallback, not a hardcoded literal", () => {
    // Pillar 5 (auto-brand) — the curated map holds COLOUR only; the brand name is no longer hardcoded per
    // tenant. Without a fallback the name is undefined; the merchant's real (cached) shop name flows in as
    // `fallbackBrandName` (wired by resolveThemeFor / the /embed/panel brandNameForShop resolver).
    const noName = resolveTheme("palup-skincare-jason");
    expect(noName.brandName).toBeUndefined();
    expect(noName.brand).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(rgb(noName.brandInk), rgb(noName.brand))).toBeGreaterThanOrEqual(4.5);

    const withName = resolveTheme("palup-skincare-jason", "Auria");
    expect(withName.brandName).toBe("Auria"); // the real shop name flows through as fallbackBrandName
    expect(withName.brand).toBe(noName.brand); // colour is unchanged (still the curated terracotta)
  });

  it("falls back to the default evergreen config + the grounding brandName for an unknown tenant", () => {
    expect(resolveThemeConfig("no-such-tenant")).toBe(DEFAULT_THEME);
    const t = resolveTheme("no-such-tenant", "Northwind Coffee");
    expect(t.brandName).toBe("Northwind Coffee");
    expect(t.brand).toBe("#0c4a3c");
  });

  it("does not carry a logoUrl unless it is an https Shopify-CDN URL", () => {
    // no curated config sets a logo today → undefined
    expect(resolveTheme("palup-skincare-jason").logoUrl).toBeUndefined();
  });
});

describe("themeStyleBlock — safe injection", () => {
  it("emits a :root override for both colour schemes with only validated hex", () => {
    const block = themeStyleBlock(resolveTheme("palup-skincare-jason"));
    expect(block).toContain('id="palup-theme"');
    expect(block).toMatch(/--brand:#[0-9a-f]{6}/i);
    expect(block).toMatch(/--brand-ink:#[0-9a-f]{6}/i);
    expect(block).toContain("prefers-color-scheme: dark");
    // the dark override is opt-out-able so a panel pinned to data-theme="light" keeps the light brand
    // text (brandTextDark is tuned for the dark panel and would under-contrast on the light one).
    expect(block).toContain(':root:not([data-theme="light"])');
    expect(block).toContain("window.PALUP");
  });

  it("escapes a brand name containing </script> so it cannot break out of the injected <script>", () => {
    const block = themeStyleBlock({
      brand: "#4f46e5",
      brandInk: "#ffffff",
      brandText: "#4f46e5",
      brandTextDark: "#818cf8",
      brandName: "Evil</script><img src=x onerror=alert(1)>",
    });
    expect(block).not.toContain("</script><img");
    expect(block).toContain("\\u003c"); // the '<' is escaped in the JSON payload
  });
});
