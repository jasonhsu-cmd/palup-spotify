import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { theme } from "../src/theme";
// Native Node ESM interop lets a CJS module be imported with a default import even under
// "type": "module" — verified directly with `node` this session before relying on it here.
// This file lives under test/, which packages/design-system/tsconfig.json's `include: ["src"]`
// does not cover, so `tsc -b` never type-checks this import; vitest's esbuild transform only
// transpiles (it does not type-check), so the untyped default import is not an error at runtime.
import tailwindPreset from "../tailwind-preset.cjs";

function parseTokensCss(): Record<string, string> {
  // Deliberately NOT `new URL(relative, import.meta.url)`: this package's vitest environment
  // is jsdom (root vitest.config.ts environmentMatchGlobs), and jsdom's global `URL` resolves
  // the two-arg form against its own document base (http://localhost:3000/) instead of the
  // file: base passed in, throwing "The URL must be of scheme file" on readFileSync — verified
  // directly this session. `fileURLToPath` + `node:path` sidestep the global URL entirely.
  const testDir = dirname(fileURLToPath(import.meta.url));
  const cssPath = resolve(testDir, "../../../.claude/skills/palup-design-system/tokens.css");
  const css = readFileSync(cssPath, "utf8");
  const vars: Record<string, string> = {};
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    const [, name, value] = match;
    if (name) vars[name] = value.trim();
  }
  return vars;
}

describe("design tokens stay identical to the canonical tokens.css", () => {
  const tokens = parseTokensCss();

  it("parsed at least the expected number of custom properties from tokens.css", () => {
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(24);
  });

  it("theme.ts colors match tokens.css exactly", () => {
    expect(theme.color.ink).toBe(tokens["ink"]);
    expect(theme.color.ink2).toBe(tokens["ink-2"]);
    expect(theme.color.ink3).toBe(tokens["ink-3"]);
    expect(theme.color.ink4).toBe(tokens["ink-4"]);
    expect(theme.color.paper).toBe(tokens["paper"]);
    expect(theme.color.surface).toBe(tokens["surface"]);
    expect(theme.color.surface2).toBe(tokens["surface-2"]);
    expect(theme.color.surface3).toBe(tokens["surface-3"]);
    expect(theme.color.line).toBe(tokens["line"]);
    expect(theme.color.line2).toBe(tokens["line-2"]);
    expect(theme.color.ever).toBe(tokens["ever"]);
    expect(theme.color.ever2).toBe(tokens["ever-2"]);
    expect(theme.color.everSoft).toBe(tokens["ever-soft"]);
    expect(theme.color.everTint).toBe(tokens["ever-tint"]);
    expect(theme.color.coral).toBe(tokens["coral"]);
    expect(theme.color.coralSoft).toBe(tokens["coral-soft"]);
    expect(theme.color.gold).toBe(tokens["gold"]);
    expect(theme.color.goldSoft).toBe(tokens["gold-soft"]);
    expect(theme.color.pos).toBe(tokens["pos"]);
    expect(theme.color.posSoft).toBe(tokens["pos-soft"]);
    expect(theme.color.warn).toBe(tokens["warn"]);
    expect(theme.color.warnSoft).toBe(tokens["warn-soft"]);
    expect(theme.color.dang).toBe(tokens["dang"]);
    expect(theme.color.dangSoft).toBe(tokens["dang-soft"]);
    expect(theme.color.info).toBe(tokens["info"]);
    expect(theme.color.infoSoft).toBe(tokens["info-soft"]);
  });

  it("theme.ts radius/shadow/sidebar-width match tokens.css exactly", () => {
    expect(theme.radius.sm).toBe(tokens["r-sm"]);
    expect(theme.radius.default).toBe(tokens["r"]);
    expect(theme.radius.lg).toBe(tokens["r-lg"]);
    expect(theme.radius.xl).toBe(tokens["r-xl"]);
    expect(theme.shadow.sm).toBe(tokens["sh-sm"]);
    expect(theme.shadow.default).toBe(tokens["sh"]);
    expect(theme.shadow.lg).toBe(tokens["sh-lg"]);
    expect(theme.sidebarWidth).toBe(tokens["sidebar-w"]);
  });

  it("tailwind-preset.cjs colors match tokens.css exactly", () => {
    const c = tailwindPreset.theme.extend.colors;
    expect(c.ink.DEFAULT).toBe(tokens["ink"]);
    expect(c.ink["2"]).toBe(tokens["ink-2"]);
    expect(c.ink["3"]).toBe(tokens["ink-3"]);
    expect(c.ink["4"]).toBe(tokens["ink-4"]);
    expect(c.paper).toBe(tokens["paper"]);
    expect(c.surface.DEFAULT).toBe(tokens["surface"]);
    expect(c.surface["2"]).toBe(tokens["surface-2"]);
    expect(c.surface["3"]).toBe(tokens["surface-3"]);
    expect(c.line.DEFAULT).toBe(tokens["line"]);
    expect(c.line["2"]).toBe(tokens["line-2"]);
    expect(c.ever.DEFAULT).toBe(tokens["ever"]);
    expect(c.ever["2"]).toBe(tokens["ever-2"]);
    expect(c.ever.soft).toBe(tokens["ever-soft"]);
    expect(c.ever.tint).toBe(tokens["ever-tint"]);
    expect(c.coral.DEFAULT).toBe(tokens["coral"]);
    expect(c.coral.soft).toBe(tokens["coral-soft"]);
    expect(c.gold.DEFAULT).toBe(tokens["gold"]);
    expect(c.gold.soft).toBe(tokens["gold-soft"]);
    expect(c.pos.DEFAULT).toBe(tokens["pos"]);
    expect(c.pos.soft).toBe(tokens["pos-soft"]);
    expect(c.warn.DEFAULT).toBe(tokens["warn"]);
    expect(c.warn.soft).toBe(tokens["warn-soft"]);
    expect(c.dang.DEFAULT).toBe(tokens["dang"]);
    expect(c.dang.soft).toBe(tokens["dang-soft"]);
    expect(c.info.DEFAULT).toBe(tokens["info"]);
    expect(c.info.soft).toBe(tokens["info-soft"]);
  });

  it("tailwind-preset.cjs radius/shadow match tokens.css exactly", () => {
    const r = tailwindPreset.theme.extend.borderRadius;
    expect(r.sm).toBe(tokens["r-sm"]);
    expect(r.DEFAULT).toBe(tokens["r"]);
    expect(r.lg).toBe(tokens["r-lg"]);
    expect(r.xl).toBe(tokens["r-xl"]);
    const s = tailwindPreset.theme.extend.boxShadow;
    expect(s.sm).toBe(tokens["sh-sm"]);
    expect(s.DEFAULT).toBe(tokens["sh"]);
    expect(s.lg).toBe(tokens["sh-lg"]);
  });
});
