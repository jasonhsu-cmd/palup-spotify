import { describe, it, expect } from "vitest";
import { theme } from "../src/theme";

// WCAG 2.x relative luminance + contrast ratio (the standard formula), computed directly from
// the token hexes so a future edit to any of these colors is caught here, not by eyeballing.
function relativeLuminance(hex: string): number {
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const [lighter, darker] = lA >= lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_NORMAL_TEXT = 4.5;

describe("Note on-tint ink colors clear WCAG AA on their soft backgrounds", () => {
  it("note-info-ink on info-soft >= 4.5:1", () => {
    const ratio = contrastRatio(theme.color.noteInfoInk, theme.color.infoSoft);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("note-warn-ink on warn-soft >= 4.5:1", () => {
    const ratio = contrastRatio(theme.color.noteWarnInk, theme.color.warnSoft);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("note-dang-ink on dang-soft >= 4.5:1", () => {
    const ratio = contrastRatio(theme.color.noteDangInk, theme.color.dangSoft);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("the base ever token on ever-soft also clears AA (unchanged variant)", () => {
    const ratio = contrastRatio(theme.color.ever, theme.color.everSoft);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("documents that the ORIGINAL base-token substitution (pre-fix) failed AA — regression guard", () => {
    expect(contrastRatio(theme.color.info, theme.color.infoSoft)).toBeLessThan(AA_NORMAL_TEXT);
    expect(contrastRatio(theme.color.warn, theme.color.warnSoft)).toBeLessThan(AA_NORMAL_TEXT);
    expect(contrastRatio(theme.color.dang, theme.color.dangSoft)).toBeLessThan(AA_NORMAL_TEXT);
  });
});
