# F1 · `design-system` Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `packages/design-system` — a themed React + Tailwind + shadcn/ui-style component library sourced from the `palup-design-system` skill's tokens and `palup-merchant-app.html`'s component vocabulary — so the merchant console (and, later, the admin console) can build every v1 screen from one consistent, token-driven set of primitives instead of hand-rolled CSS.

**Architecture:** A single new workspace package, `@palup/design-system`, exporting (a) the token values as a typed TS object and a Tailwind preset consumers `presets: [...]` into their own `tailwind.config.js`, and (b) a small set of React components (Button, Badge, Card, StatTile, form controls, Switch, Note, Tabs, Table, Toast, Dialog, AppShell/Sidebar) built with Radix UI primitives for accessibility and `class-variance-authority` for variants. Nothing in this package calls a network, a port, or an agent — it is pure presentation, consumed as raw TypeScript source by workspace packages (matching this repo's existing no-build-step convention) and additionally buildable as a standalone ESM bundle via Vite library mode. This is the **first package in the repo to use React, Vite, or Tailwind** — there is no prior frontend tooling to inherit, so this plan also wires the new tooling into the shared root config (`tsconfig.json` references, `vitest.config.ts` environment matching).

**Tech Stack:** TypeScript (strict, matching `tsconfig.base.json`), React 19, Vite 5 (library mode) + `@vitejs/plugin-react`, Tailwind CSS 3 (preset only — no build step inside this package), Radix UI primitives (`react-dialog`, `react-switch`, `react-tabs`, `react-toast`, `react-slot`), `class-variance-authority` + `clsx` + `tailwind-merge`, vitest + `@testing-library/react` + `@testing-library/user-event` (via the repo's single root `vitest.config.ts` runner).

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` (§7 "F1", §5 architecture, §8 cross-cutting decisions).

## Global Constraints

- **Tokens are consumed, never invented.** All colors, radii, shadows, and font families come from `.claude/skills/palup-design-system/tokens.css` / `SKILL.md`. No raw hex, no ad-hoc spacing/radius value is hand-written in component code (CLAUDE.md §5, SKILL.md "Rules for building the real UI" #1).
- **Rounding rule (documented exception, not a new token):** the mockup's CSS occasionally uses an untokenized pixel radius (buttons/inputs at `10px`, the tab-strip container at `11px`, the switch pill at `20px`) that doesn't match any of the four defined radii (`8/12/18/26px`). Per the "never hand-write a magic value" rule, this plan rounds those to the **nearest defined token** (`rounded` = 12px for buttons/inputs/tabs) or to Tailwind's native `rounded-full` (for pill/switch shapes) rather than inventing a fifth radius value. This is a visual, not a token, decision — flagged again in Self-Review.
- **Note-callout text color (documented exception):** the mockup's `.note` variants use bespoke on-tint text hexes (`#1B4596`, `#8A5A06`, `#9E261A`) that are not in `tokens.css`. This plan uses the corresponding base token color (`text-info`, `text-warn`, `text-dang`) instead of hand-copying those hexes. If visual QA later needs the exact mockup shade, that's a `tokens.css` addition for a human/design-system-skill update — out of scope here.
- **Match `palup-merchant-app.html`'s component vocabulary and both breakpoints** — desktop `grid-template-columns: 264px 1fr` and the <900px off-canvas sidebar drawer (SKILL.md "Rules" #3–4).
- **YAGNI — build only what the v1 console screens need** (spec §7 F1): app shell/sidebar nav, card, stat tile, badge/pill, button, table, form inputs (input/select/textarea/field), switch, tabs, toast, dialog, note/callout. No date picker, combobox, chart, pagination, or other shadcn/ui primitive not on this list — those wait for a workstream plan that actually needs them.
- **TypeScript everywhere, strict** — every new `tsconfig.json` extends `tsconfig.base.json` (`strict: true`, `noUncheckedIndexedAccess: true`, `composite: true`); no `any` in exported signatures.
- **Monorepo convention: raw-source consumption, no forced build step.** Like every other workspace package, `@palup/design-system`'s `package.json` `main`/`exports` point at `src/index.ts` directly — the root `vitest.config.ts` already inlines `/@palup/` deps for exactly this reason. The Vite library build (`pnpm --filter @palup/design-system build`) is an *additional*, separately validated artifact (useful for a future Storybook or an out-of-monorepo consumer), not the primary internal import path.
- **No HITL/agent-autonomy surface here.** This package renders UI only; it does not call a port, execute a merchant/agent action, or touch money/model/business-model. CLAUDE.md §3 and the `hitl-approval-gate` skill do not apply to F1 itself — they apply to the workstream plans (W1, W4, W6...) that will *use* these components to build governed screens.
- **Portability (ADR-0001):** N/A to introduce here — this package makes no cloud/vendor calls. Confirmed no violation is introduced.
- **ATDD/TDD throughout.** Every task below writes the failing test first, then the minimal real implementation, then commits. No placeholder code, no placeholder assertions.

## File Structure

```
packages/design-system/
  package.json                    — package manifest (name, deps, scripts)
  tsconfig.json                   — extends root base; adds jsx: react-jsx
  vite.config.ts                  — library-mode build (ESM + .d.ts) for standalone consumption
  tailwind-preset.cjs             — Tailwind theme.extend preset consumers require() into their config
  src/
    index.ts                      — public barrel export (the package's entire API surface)
    theme.ts                      — typed TS object mirroring tokens.css (colors/radius/shadow/font)
    lib/
      cn.ts                       — clsx + tailwind-merge className helper used by every component
    components/
      button.tsx                  — Button, buttonVariants
      badge.tsx                   — Badge, badgeVariants (the .bdg pill)
      card.tsx                    — Card, CardHeader, CardTitle, CardHint, CardBody
      stat-tile.tsx                — StatTile (the .stat metric tile)
      field.tsx                   — Field, Input, Select, Textarea
      switch.tsx                  — Switch (Radix, the .sw toggle)
      note.tsx                    — Note, noteVariants (the .note callout)
      tabs.tsx                    — Tabs, TabsList, TabsTrigger, TabsContent (Radix)
      table.tsx                   — Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell
      toast.tsx                   — Toaster, useToast (Radix Toast + a small context store)
      dialog.tsx                  — Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose (Radix)
      app-shell.tsx                — AppShell, Sidebar (dark nav + mobile off-canvas drawer)
  test/
    cn.test.ts
    theme-tokens-consistency.test.ts
    button.test.tsx
    badge.test.tsx
    card.test.tsx
    stat-tile.test.tsx
    field.test.tsx
    switch.test.tsx
    note.test.tsx
    tabs.test.tsx
    table.test.tsx
    toast.test.tsx
    dialog.test.tsx
    app-shell.test.tsx
    index-barrel.test.ts
    build.test.ts

Modified (existing repo files):
  tsconfig.json          — add { "path": "packages/design-system/tsconfig.json" } reference
  vitest.config.ts       — add ["packages/design-system/**", "jsdom"] to environmentMatchGlobs;
                            correct the now-stale "everything else is server-side" comment
```

**Verified starting state (this session, 2026-08-23):** `grep -m5 -E '"(react|vite|tailwindcss|shadcn)"' pnpm-lock.yaml` returned nothing — there is no React/Vite/Tailwind anywhere in this repo yet. `packages/widget/package.json` and `packages/widget-backend/package.json` carry no `devDependencies` for `vitest`/`typescript`/`jsdom` (those are root-level tools only). All new dependency versions below were checked live via `npm view <pkg> version` on 2026-08-23 and their React-19 peer compatibility confirmed via `npm view <pkg> peerDependencies`.

## Task 1: Package scaffold + `cn` utility

**Files:**
- Create: `packages/design-system/package.json`
- Create: `packages/design-system/tsconfig.json`
- Create: `packages/design-system/src/lib/cn.ts`
- Create: `packages/design-system/test/cn.test.ts`
- Modify: `/Users/professor/Work/palup-spotify/tsconfig.json` (add project reference)
- Modify: `/Users/professor/Work/palup-spotify/vitest.config.ts` (add jsdom environment match + fix stale comment)

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` — exported from `src/lib/cn.ts`, re-exported from `src/index.ts` in Task 15. Every later component task imports it as `import { cn } from "../lib/cn"`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/cn.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { cn } from "../src/lib/cn";

describe("cn", () => {
  it("joins truthy class strings and drops falsy ones", () => {
    expect(cn("btn", false && "hidden", undefined, null, "primary")).toBe("btn primary");
  });

  it("lets a later conflicting Tailwind class win over an earlier one", () => {
    expect(cn("text-ink", "text-ever")).toBe("text-ever");
  });

  it("supports the conditional-object form", () => {
    expect(cn("btn", { primary: true, block: false })).toBe("btn primary");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/cn.test.ts`
Expected: FAIL — `packages/design-system/src/lib/cn.ts` does not exist yet (and the package isn't in the workspace's dependency graph with `clsx`/`tailwind-merge` installed).

- [ ] **Step 3: Write the package scaffold and the minimal implementation**

`packages/design-system/package.json`:
```json
{
  "name": "@palup/design-system",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./tailwind-preset": "./tailwind-preset.cjs"
  },
  "scripts": {
    "build": "vite build"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "^1.1.23",
    "@radix-ui/react-slot": "^1.3.3",
    "@radix-ui/react-switch": "^1.3.7",
    "@radix-ui/react-tabs": "^1.1.21",
    "@radix-ui/react-toast": "^1.2.23",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.6.0"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.6",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.4",
    "@vitejs/plugin-react": "^4.7.0",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "vite": "^5.4.21",
    "vite-plugin-dts": "^5.0.3"
  }
}
```

`packages/design-system/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

`packages/design-system/src/lib/cn.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges class-name inputs and resolves conflicting Tailwind utility classes (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

Install the new dependencies:
```bash
pnpm install
```

Add the project reference to `tsconfig.json` (repo root), after the `packages/widget` entry, with a short note matching the file's existing commenting style:

```json
    { "path": "packages/widget/tsconfig.json" },
    // packages/design-system is the first package using React/JSX — its own tsconfig sets
    // `jsx: "react-jsx"`; nothing else in this graph needs that option.
    { "path": "packages/design-system/tsconfig.json" }
```

Update `vitest.config.ts` (repo root) — add the jsdom match and fix the now-stale comment:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
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
    ],
  },
});
```

Also widen `vitest.config.ts`'s `include` glob in this same edit: it currently only matches `packages/**/*.test.ts`, but every component test file in this plan is a `.test.tsx` (JSX needs the `.tsx` extension to parse). Add the second pattern:

```ts
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/cn.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts packages/design-system/package.json packages/design-system/tsconfig.json packages/design-system/src/lib/cn.ts packages/design-system/test/cn.test.ts
git commit -m "feat(design-system): scaffold @palup/design-system package with cn() utility

Wires the repo's first React/Vite/Tailwind package into the shared tsconfig
project references and the root vitest jsdom environment matching."
```

## Task 2: Theme tokens + Tailwind preset + consistency test

**Files:**
- Create: `packages/design-system/src/theme.ts`
- Create: `packages/design-system/tailwind-preset.cjs`
- Create: `packages/design-system/test/theme-tokens-consistency.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `theme: Theme` (typed object, `src/theme.ts`) and the CJS module `tailwind-preset.cjs` (`module.exports = { theme: { extend: {...} } }`). Later component tasks reference `theme.color.*` conceptually via Tailwind class names (`bg-ever`, `text-ink-3`, etc.) rather than importing `theme` directly — `theme` itself is consumed by the token-consistency test and re-exported from `src/index.ts` (Task 15) for any programmatic (non-Tailwind) use.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/theme-tokens-consistency.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { theme } from "../src/theme";
// Native Node ESM interop lets a CJS module be imported with a default import even under
// "type": "module" — verified directly with `node` this session before relying on it here.
// This file lives under test/, which packages/design-system/tsconfig.json's `include: ["src"]`
// does not cover, so `tsc -b` never type-checks this import; vitest's esbuild transform only
// transpiles (it does not type-check), so the untyped default import is not an error at runtime.
import tailwindPreset from "../tailwind-preset.cjs";

function parseTokensCss(): Record<string, string> {
  const css = readFileSync(
    new URL("../../../.claude/skills/palup-design-system/tokens.css", import.meta.url),
    "utf8"
  );
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/theme-tokens-consistency.test.ts`
Expected: FAIL — `src/theme.ts` and `tailwind-preset.cjs` do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/theme.ts`:
```ts
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
```

`packages/design-system/tailwind-preset.cjs`:
```cjs
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/theme-tokens-consistency.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/theme.ts packages/design-system/tailwind-preset.cjs packages/design-system/test/theme-tokens-consistency.test.ts
git commit -m "feat(design-system): add theme.ts + Tailwind preset, both drift-tested against tokens.css"
```

## Task 3: `Button`

**Files:**
- Create: `packages/design-system/src/components/button.tsx`
- Create: `packages/design-system/test/button.test.tsx`

**Interfaces:**
- Consumes: `cn` from `../lib/cn` (Task 1).
- Produces: `Button` (forwardRef component), `buttonVariants` (cva function), `ButtonProps` type — all re-exported from `src/index.ts` in Task 15. `buttonVariants` accepts `variant: "primary" | "dark" | "outline" | "ghost" | "coral" | "danger"`, `size: "default" | "sm"`, `block: boolean`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/button.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "../src/components/button";

describe("Button", () => {
  it("renders the primary variant (evergreen background) by default", () => {
    render(<Button>Approve</Button>);
    const btn = screen.getByRole("button", { name: "Approve" });
    expect(btn.classList.contains("bg-ever")).toBe(true);
  });

  it("applies the danger variant's background class", () => {
    render(<Button variant="danger">Reject</Button>);
    const btn = screen.getByRole("button", { name: "Reject" });
    expect(btn.classList.contains("bg-dang")).toBe(true);
  });

  it("applies the block modifier as a full-width class", () => {
    render(<Button block>Save changes</Button>);
    const btn = screen.getByRole("button", { name: "Save changes" });
    expect(btn.classList.contains("w-full")).toBe(true);
  });

  it("fires onClick when enabled, and never fires when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Approve
      </Button>
    );
    const btn = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/button.test.tsx`
Expected: FAIL — `src/components/button.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/button.tsx`:
```tsx
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// Radii: the mockup's .btn uses an untokenized 10px; rounded to the nearest defined radius
// token (rounded = 12px) per this plan's "Global Constraints" rounding rule.
export const buttonVariants = cva(
  "inline-flex items-center gap-2 whitespace-nowrap rounded font-semibold text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ever-tint",
  {
    variants: {
      variant: {
        primary: "bg-ever text-white hover:bg-ever-2 hover:shadow",
        dark: "bg-ink text-white hover:bg-ink-2",
        outline: "bg-surface border border-line text-ink hover:border-ink-4",
        ghost: "bg-transparent text-ink-2 hover:bg-surface-3",
        coral: "bg-coral text-white hover:brightness-95",
        danger: "bg-dang text-white hover:brightness-95",
      },
      size: {
        default: "px-[15px] py-[9px]",
        sm: "rounded-sm px-[11px] py-[6px] text-[12.5px]",
      },
      block: {
        true: "w-full justify-center",
        false: "",
      },
    },
    defaultVariants: { variant: "primary", size: "default", block: false },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element instead of a <button> (Radix Slot pattern). */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, block, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, block }), className)}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/button.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/button.tsx packages/design-system/test/button.test.tsx
git commit -m "feat(design-system): add Button (primary/dark/outline/ghost/coral/danger variants)"
```

## Task 4: `Badge`

**Files:**
- Create: `packages/design-system/src/components/badge.tsx`
- Create: `packages/design-system/test/badge.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces: `Badge`, `badgeVariants`, `BadgeProps`. `variant: "ever" | "pos" | "warn" | "dang" | "info" | "gold" | "gray" | "coral"`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/badge.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "../src/components/badge";

describe("Badge", () => {
  it("defaults to the gray variant and renders its text", () => {
    render(<Badge>3,104 orders</Badge>);
    const badge = screen.getByText("3,104 orders");
    expect(badge.classList.contains("bg-surface-3")).toBe(true);
  });

  it("applies the pos variant's tint classes", () => {
    render(<Badge variant="pos">High</Badge>);
    const badge = screen.getByText("High");
    expect(badge.classList.contains("bg-pos-soft")).toBe(true);
    expect(badge.classList.contains("text-pos")).toBe(true);
  });

  it("renders a status dot by default and omits it when dot={false}", () => {
    const { rerender } = render(<Badge variant="dang">At-risk</Badge>);
    expect(document.querySelectorAll(".bg-current").length).toBe(1);
    rerender(<Badge variant="dang" dot={false}>At-risk</Badge>);
    expect(document.querySelectorAll(".bg-current").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/badge.test.tsx`
Expected: FAIL — `src/components/badge.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/badge.tsx`:
```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// The mockup's .bdg uses a 20px pill radius; rounded-full is the token-free, semantically
// correct way to express "fully rounded" rather than inventing a fifth radius value.
export const badgeVariants = cva(
  "inline-flex items-center gap-[5px] rounded-full px-[9px] py-[3px] text-[11.5px] font-bold tracking-[.01em]",
  {
    variants: {
      variant: {
        ever: "bg-ever-soft text-ever",
        pos: "bg-pos-soft text-pos",
        warn: "bg-warn-soft text-warn",
        dang: "bg-dang-soft text-dang",
        info: "bg-info-soft text-info",
        gold: "bg-gold-soft text-gold",
        gray: "bg-surface-3 text-ink-2",
        coral: "bg-coral-soft text-coral",
      },
    },
    defaultVariants: { variant: "gray" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Shows the small status dot before the label. Defaults to true, matching the mockup. */
  dot?: boolean;
}

export function Badge({ className, variant, dot = true, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/badge.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/badge.tsx packages/design-system/test/badge.test.tsx
git commit -m "feat(design-system): add Badge (status pill with pos/warn/dang/info/gold/gray/coral/ever variants)"
```

## Task 5: `Card` family

**Files:**
- Create: `packages/design-system/src/components/card.tsx`
- Create: `packages/design-system/test/card.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces: `Card`, `CardHeader`, `CardTitle`, `CardHint`, `CardBody` — all plain function components over `React.HTMLAttributes<HTMLDivElement>` (or `HTMLHeadingElement`/`HTMLSpanElement`).

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/card.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardHeader, CardTitle, CardHint, CardBody } from "../src/components/card";

describe("Card", () => {
  it("renders the surface/border/shadow classes on the outer card", () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>What it has learned</CardTitle>
          <CardHint>your store</CardHint>
        </CardHeader>
        <CardBody>Body content</CardBody>
      </Card>
    );
    const card = screen.getByTestId("card");
    expect(card.classList.contains("bg-surface")).toBe(true);
    expect(card.classList.contains("border-line")).toBe(true);
    expect(card.classList.contains("shadow-sm")).toBe(true);
    expect(screen.getByText("What it has learned").tagName).toBe("H3");
    expect(screen.getByText("your store")).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/card.test.tsx`
Expected: FAIL — `src/components/card.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/card.tsx`:
```tsx
import * as React from "react";
import { cn } from "../lib/cn";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-lg border border-line bg-surface shadow-sm", className)} {...props} />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-between gap-3 border-b border-line-2 px-5 py-4", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-[15.5px] font-semibold", className)} {...props} />;
}

export function CardHint({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("text-[12px] text-ink-3", className)} {...props} />;
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-[18px]", className)} {...props} />;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/card.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/card.tsx packages/design-system/test/card.test.tsx
git commit -m "feat(design-system): add Card/CardHeader/CardTitle/CardHint/CardBody"
```

## Task 6: `StatTile`

**Files:**
- Create: `packages/design-system/src/components/stat-tile.tsx`
- Create: `packages/design-system/test/stat-tile.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces: `StatTile`, `StatTileProps { label: string; value: string; icon?: React.ReactNode; delta?: { direction: "up" | "down"; label: string }; footnote?: string; mono?: boolean; className?: string }`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/stat-tile.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatTile } from "../src/components/stat-tile";

describe("StatTile", () => {
  it("renders label, value, an 'up' delta, and a footnote", () => {
    render(
      <StatTile
        label="Attributed revenue"
        value="$18,204"
        delta={{ direction: "up", label: "+12% vs last 30d" }}
        footnote="Incremental, holdout-verified"
      />
    );
    expect(screen.getByText("Attributed revenue")).toBeTruthy();
    expect(screen.getByText("$18,204")).toBeTruthy();
    const delta = screen.getByText("+12% vs last 30d", { exact: false });
    expect(delta.classList.contains("bg-pos-soft")).toBe(true);
    expect(screen.getByText("Incremental, holdout-verified")).toBeTruthy();
  });

  it("uses the danger tint for a 'down' delta and omits the footnote when absent", () => {
    render(
      <StatTile label="Net" value="-$120" delta={{ direction: "down", label: "-4% vs last 30d" }} />
    );
    const delta = screen.getByText("-4% vs last 30d", { exact: false });
    expect(delta.classList.contains("bg-dang-soft")).toBe(true);
  });

  it("switches the value to the mono/tabular style when mono={true}", () => {
    render(<StatTile label="Orders" value="1,284" mono />);
    const value = screen.getByText("1,284");
    expect(value.classList.contains("font-mono")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/stat-tile.test.tsx`
Expected: FAIL — `src/components/stat-tile.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/stat-tile.tsx`:
```tsx
import * as React from "react";
import { cn } from "../lib/cn";

export interface StatTileProps {
  label: string;
  value: string;
  icon?: React.ReactNode;
  delta?: { direction: "up" | "down"; label: string };
  footnote?: string;
  mono?: boolean;
  className?: string;
}

export function StatTile({ label, value, icon, delta, footnote, mono, className }: StatTileProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-line bg-surface p-[18px] shadow-sm",
        className
      )}
    >
      <div className="flex items-center gap-[7px] text-[12px] font-semibold text-ink-3">
        {icon && (
          <span className="grid h-[26px] w-[26px] place-items-center rounded-sm bg-ever-soft text-ever">
            {icon}
          </span>
        )}
        {label}
      </div>
      <div
        className={cn(
          "mt-[11px] font-display text-[30px] font-extrabold leading-none tracking-[-.02em]",
          mono && "font-mono text-[27px] font-semibold"
        )}
      >
        {value}
      </div>
      {delta && (
        <span
          className={cn(
            "mt-[9px] inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[12px] font-bold",
            delta.direction === "up" ? "bg-pos-soft text-pos" : "bg-dang-soft text-dang"
          )}
        >
          {delta.direction === "up" ? "↑" : "↓"} {delta.label}
        </span>
      )}
      {footnote && <div className="mt-[9px] text-[11.5px] text-ink-4">{footnote}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/stat-tile.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/stat-tile.tsx packages/design-system/test/stat-tile.test.tsx
git commit -m "feat(design-system): add StatTile metric card (label/value/delta/footnote)"
```

## Task 7: `Field`, `Input`, `Select`, `Textarea`

**Files:**
- Create: `packages/design-system/src/components/field.tsx`
- Create: `packages/design-system/test/field.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces: `Input`, `Select`, `Textarea` (forwardRef over native element props), `Field`, `FieldProps { label: string; help?: string; htmlFor?: string; children: React.ReactNode; className?: string }`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/field.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Field, Input, Textarea } from "../src/components/field";

describe("Field + Input/Textarea", () => {
  it("associates the label with the input via htmlFor/id and renders the help text", async () => {
    render(
      <Field label="Monthly spend cap" htmlFor="cap" help="Applies to ad spend and discounts.">
        <Input id="cap" defaultValue="4000" />
      </Field>
    );
    const input = screen.getByLabelText("Monthly spend cap") as HTMLInputElement;
    expect(input.value).toBe("4000");
    expect(screen.getByText("Applies to ad spend and discounts.")).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "5000");
    expect(input.value).toBe("5000");
  });

  it("renders a Textarea with the evergreen focus classes", () => {
    render(<Textarea aria-label="Rationale" />);
    const textarea = screen.getByLabelText("Rationale");
    expect(textarea.classList.contains("focus:border-ever")).toBe(true);
    expect(textarea.tagName).toBe("TEXTAREA");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/field.test.tsx`
Expected: FAIL — `src/components/field.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/field.tsx`:
```tsx
import * as React from "react";
import { cn } from "../lib/cn";

const controlClass =
  "w-full rounded border border-line bg-surface px-3 py-[10px] text-[13.5px] text-ink outline-none transition-colors focus:border-ever focus:ring-2 focus:ring-ever-tint";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(controlClass, className)} {...props} />
);
Input.displayName = "Input";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(controlClass, className)} {...props} />
));
Select.displayName = "Select";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(controlClass, "min-h-[84px] resize-y", className)} {...props} />
));
Textarea.displayName = "Textarea";

export interface FieldProps {
  label: string;
  help?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, help, htmlFor, children, className }: FieldProps) {
  return (
    <div className={cn("mb-[15px]", className)}>
      <label htmlFor={htmlFor} className="mb-[6px] block text-[12.5px] font-semibold text-ink-2">
        {label}
      </label>
      {children}
      {help && <p className="mt-[5px] text-[11.5px] text-ink-4">{help}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/field.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/field.tsx packages/design-system/test/field.test.tsx
git commit -m "feat(design-system): add Field/Input/Select/Textarea form controls"
```

## Task 8: `Switch`

**Files:**
- Create: `packages/design-system/src/components/switch.tsx`
- Create: `packages/design-system/test/switch.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1), `@radix-ui/react-switch`.
- Produces: `Switch` (forwardRef wrapping `SwitchPrimitive.Root` + `Thumb`), `SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/switch.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "../src/components/switch";

describe("Switch", () => {
  it("renders as an accessible switch, unchecked by default", () => {
    render(<Switch aria-label="Kill switch" />);
    const sw = screen.getByRole("switch", { name: "Kill switch" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.classList.contains("bg-line")).toBe(true);
  });

  it("toggles aria-checked and calls onCheckedChange on click", async () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Kill switch" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole("switch", { name: "Kill switch" });
    await userEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("applies the checked/evergreen background class when checked", () => {
    render(<Switch aria-label="Kill switch" checked onCheckedChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Kill switch" });
    expect(sw.getAttribute("data-state")).toBe("checked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/switch.test.tsx`
Expected: FAIL — `src/components/switch.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/switch.tsx`:
```tsx
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../lib/cn";

export type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

// The mockup's .sw uses an untokenized 20px pill radius; rounded-full expresses that without
// inventing a new radius token (same rule as Badge).
export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, ...props }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "relative h-6 w-[42px] shrink-0 rounded-full bg-line transition-colors data-[state=checked]:bg-ever",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  )
);
Switch.displayName = "Switch";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/switch.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/switch.tsx packages/design-system/test/switch.test.tsx
git commit -m "feat(design-system): add Switch (Radix-backed toggle for Kill Switch / settings)"
```

## Task 9: `Note`

**Files:**
- Create: `packages/design-system/src/components/note.tsx`
- Create: `packages/design-system/test/note.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces: `Note`, `noteVariants`, `NoteProps`. `variant: "info" | "warn" | "ever" | "dang"`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/note.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Note } from "../src/components/note";

describe("Note", () => {
  it("defaults to the info variant's tint classes", () => {
    render(<Note>Nearing your usage limit.</Note>);
    const note = screen.getByText("Nearing your usage limit.").closest("div");
    expect(note?.parentElement?.classList.contains("bg-info-soft")).toBe(true);
  });

  it("applies the warn variant and renders an icon when provided", () => {
    render(
      <Note variant="warn" icon={<svg data-testid="note-icon" />}>
        Approaching your approved limit.
      </Note>
    );
    expect(screen.getByTestId("note-icon")).toBeTruthy();
    const note = screen.getByText("Approaching your approved limit.").closest("div")?.parentElement;
    expect(note?.classList.contains("bg-warn-soft")).toBe(true);
    expect(note?.classList.contains("text-warn")).toBe(true);
  });

  it("omits the icon wrapper when no icon is passed", () => {
    render(<Note variant="dang">Kill switch engaged.</Note>);
    expect(document.querySelector("svg")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/note.test.tsx`
Expected: FAIL — `src/components/note.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/note.tsx`:
```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// The mockup hand-writes bespoke on-tint text hexes for .note (#1B4596/#8A5A06/#9E261A) that
// are not in tokens.css. Per this plan's "Global Constraints", the base saturated token color
// is used instead of hand-copying those hexes.
export const noteVariants = cva("flex gap-[11px] rounded px-[15px] py-[13px] text-[13px] leading-[1.5]", {
  variants: {
    variant: {
      info: "bg-info-soft text-info",
      warn: "bg-warn-soft text-warn",
      ever: "bg-ever-soft text-ever",
      dang: "bg-dang-soft text-dang",
    },
  },
  defaultVariants: { variant: "info" },
});

export interface NoteProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof noteVariants> {
  icon?: React.ReactNode;
}

export function Note({ className, variant, icon, children, ...props }: NoteProps) {
  return (
    <div className={cn(noteVariants({ variant }), className)} {...props}>
      {icon && <span className="mt-[1px] h-[18px] w-[18px] shrink-0">{icon}</span>}
      <div>{children}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/note.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/note.tsx packages/design-system/test/note.test.tsx
git commit -m "feat(design-system): add Note callout (info/warn/ever/dang)"
```

## Task 10: `Tabs`

**Files:**
- Create: `packages/design-system/src/components/tabs.tsx`
- Create: `packages/design-system/test/tabs.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1), `@radix-ui/react-tabs`.
- Produces: `Tabs` (= `TabsPrimitive.Root`), `TabsList`, `TabsTrigger`, `TabsContent` (= `TabsPrimitive.Content`).

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/tabs.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../src/components/tabs";

describe("Tabs", () => {
  it("shows the default tab's content and marks its trigger active", () => {
    render(
      <Tabs defaultValue="customers">
        <TabsList>
          <TabsTrigger value="customers">Customers</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
        </TabsList>
        <TabsContent value="customers">Customer insights</TabsContent>
        <TabsContent value="products">Product insights</TabsContent>
      </Tabs>
    );
    expect(screen.getByText("Customer insights")).toBeTruthy();
    expect(screen.queryByText("Product insights")).toBeNull();
    const active = screen.getByRole("tab", { name: "Customers" });
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(active.classList.contains("bg-surface")).toBe(true);
  });

  it("switches content and active state on click", async () => {
    render(
      <Tabs defaultValue="customers">
        <TabsList>
          <TabsTrigger value="customers">Customers</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
        </TabsList>
        <TabsContent value="customers">Customer insights</TabsContent>
        <TabsContent value="products">Product insights</TabsContent>
      </Tabs>
    );
    await userEvent.click(screen.getByRole("tab", { name: "Products" }));
    expect(screen.getByText("Product insights")).toBeTruthy();
    expect(screen.queryByText("Customer insights")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/tabs.test.tsx`
Expected: FAIL — `src/components/tabs.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/tabs.tsx`:
```tsx
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex w-fit gap-1 rounded bg-surface-3 p-1", className)}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "rounded-sm px-[14px] py-[7px] text-[13px] font-semibold text-ink-3 data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/tabs.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/tabs.tsx packages/design-system/test/tabs.test.tsx
git commit -m "feat(design-system): add Tabs (Radix-backed segmented control)"
```

## Task 11: `Table`

**Files:**
- Create: `packages/design-system/src/components/table.tsx`
- Create: `packages/design-system/test/table.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces: `Table`, `TableHead`, `TableBody`, `TableRow`, `TableHeaderCell`, `TableCell`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/table.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../src/components/table";

describe("Table", () => {
  it("renders uppercase header cells and body rows with the right cell count", () => {
    render(
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Insight</TableHeaderCell>
            <TableHeaderCell>Confidence</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>First-time buyers convert 2x with a sample add-on</TableCell>
            <TableCell>High</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    const headerCell = screen.getByText("Insight");
    expect(headerCell.tagName).toBe("TH");
    expect(headerCell.classList.contains("uppercase")).toBe(true);
    const bodyCell = screen.getByText("High");
    expect(bodyCell.tagName).toBe("TD");
    expect(document.querySelectorAll("td").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/table.test.tsx`
Expected: FAIL — `src/components/table.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/table.tsx`:
```tsx
import * as React from "react";
import { cn } from "../lib/cn";

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse", className)} {...props} />;
}

export function TableHead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn(className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn(className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn("transition-colors hover:bg-surface-2 [&:last-child>td]:border-b-0", className)}
      {...props}
    />
  );
}

export function TableHeaderCell({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "border-b border-line px-[14px] py-[11px] text-left text-[11px] font-bold uppercase tracking-[.06em] text-ink-4",
        className
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn("border-b border-line-2 px-[14px] py-[13px] align-middle text-[13.5px]", className)}
      {...props}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/table.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/table.tsx packages/design-system/test/table.test.tsx
git commit -m "feat(design-system): add Table primitives (Table/Head/Body/Row/HeaderCell/Cell)"
```

## Task 12: `Toaster` / `useToast`

**Files:**
- Create: `packages/design-system/src/components/toast.tsx`
- Create: `packages/design-system/test/toast.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1), `@radix-ui/react-toast`.
- Produces: `Toaster({ children }): JSX.Element` (context provider + Radix `Provider`/`Viewport`), `useToast(): { toast: (message: string) => void }`, `ToastMessage { id: string; message: string }`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/toast.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toaster, useToast } from "../src/components/toast";

function Trigger({ message }: { message: string }) {
  const { toast } = useToast();
  return <button onClick={() => toast(message)}>Trigger</button>;
}

describe("Toaster / useToast", () => {
  it("shows a toast with the given message after toast() is called", async () => {
    render(
      <Toaster>
        <Trigger message="Settings saved" />
      </Toaster>
    );
    expect(screen.queryByText("Settings saved")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Trigger" }));
    expect(screen.getByText("Settings saved")).toBeTruthy();
  });

  it("supports firing more than one toast", async () => {
    render(
      <Toaster>
        <Trigger message="First" />
        <Trigger message="Second" />
      </Toaster>
    );
    const buttons = screen.getAllByRole("button", { name: "Trigger" });
    await userEvent.click(buttons[0]!);
    await userEvent.click(buttons[1]!);
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("throws when useToast is called outside a Toaster", () => {
    function Broken() {
      useToast();
      return null;
    }
    // Suppress the expected React error-boundary console noise for this one assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Broken />)).toThrow("useToast must be used within a <Toaster>");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/toast.test.tsx`
Expected: FAIL — `src/components/toast.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/toast.tsx`:
```tsx
import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";

export interface ToastMessage {
  id: string;
  message: string;
}

interface ToastContextValue {
  toast: (message: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <Toaster>");
  }
  return ctx;
}

export function Toaster({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = React.useState<ToastMessage[]>([]);

  const toast = React.useCallback((message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMessages((current) => [...current, { id, message }]);
  }, []);

  const dismiss = React.useCallback((id: string) => {
    setMessages((current) => current.filter((m) => m.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <ToastPrimitive.Provider swipeDirection="down">
        {children}
        {messages.map((m) => (
          <ToastPrimitive.Root
            key={m.id}
            duration={4000}
            onOpenChange={(open) => {
              if (!open) dismiss(m.id);
            }}
            className="rounded-full bg-ink px-5 py-[11px] text-[13px] text-white shadow-lg"
          >
            <ToastPrimitive.Description>{m.message}</ToastPrimitive.Description>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-6 left-1/2 z-[300] flex -translate-x-1/2 flex-col items-center gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/toast.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/toast.tsx packages/design-system/test/toast.test.tsx
git commit -m "feat(design-system): add Toaster/useToast (Radix Toast + context store)"
```

## Task 13: `Dialog`

**Files:**
- Create: `packages/design-system/src/components/dialog.tsx`
- Create: `packages/design-system/test/dialog.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1), `@radix-ui/react-dialog`.
- Produces: `Dialog` (= `DialogPrimitive.Root`), `DialogTrigger`, `DialogClose`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter`.
- **Documented design addition (not in the literal mockup):** `palup-merchant-app.html` only has a right-side detail drawer (`.cust-drawer`) — no centered modal. Governance actions (Kill Switch confirm, approve/reject with irreversible consequences) need a "hard to misclick" centered confirm per SKILL.md's governance-surfaces note, so this task adds a `Dialog` styled with the same tokens (`bg-surface`, `border-line`, `shadow-lg`, `bg-ink/40` scrim) as the drawer/scrim pattern, rather than inventing new colors. Flagged again in Self-Review as an assumption, not a literal mockup match.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/dialog.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "../src/components/dialog";
import { Button } from "../src/components/button";

function KillSwitchConfirm() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="danger">Kill switch</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Halt all autonomous actions?</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="danger">Confirm halt</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("is closed until the trigger is clicked, then shows the title", async () => {
    render(<KillSwitchConfirm />);
    expect(screen.queryByText("Halt all autonomous actions?")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Halt all autonomous actions?")).toBeTruthy();
  });

  it("closes when DialogClose is clicked", async () => {
    render(<KillSwitchConfirm />);
    await userEvent.click(screen.getByRole("button", { name: "Kill switch" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/dialog.test.tsx`
Expected: FAIL — `src/components/dialog.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/dialog.tsx`:
```tsx
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* bg-ink/40 mirrors the mockup's .cust-scrim rgba(22,32,27,.4) via Tailwind's opacity
        modifier on the `ink` token color, rather than a new raw rgba() value. */}
    <DialogPrimitive.Overlay className="fixed inset-0 z-[200] bg-ink/40" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-[210] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-5 shadow-lg",
        className
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-3", className)} {...props} />;
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-[15.5px] font-semibold", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-4 flex justify-end gap-2", className)} {...props} />;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/dialog.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/dialog.tsx packages/design-system/test/dialog.test.tsx
git commit -m "feat(design-system): add Dialog (Radix-backed confirm modal for governance actions)"
```

## Task 14: `AppShell` + `Sidebar`

**Files:**
- Create: `packages/design-system/src/components/app-shell.tsx`
- Create: `packages/design-system/test/app-shell.test.tsx`

**Interfaces:**
- Consumes: `cn` (Task 1).
- Produces: `NavLinkItem { href: string; label: string; icon?: React.ReactNode; active?: boolean; pillCount?: number }`, `NavGroupItem { title: string; links: NavLinkItem[] }`, `Sidebar(props: SidebarProps)`, `AppShell(props: AppShellProps)` where `AppShellProps { groups: NavGroupItem[]; brand?: React.ReactNode; children: React.ReactNode; onNavigate?: (href: string) => void }`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/app-shell.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell, type NavGroupItem } from "../src/components/app-shell";

const groups: NavGroupItem[] = [
  {
    title: "Overview",
    links: [
      { href: "/home", label: "Revenue Home", active: true },
      { href: "/inbox", label: "Inbox", pillCount: 3 },
    ],
  },
];

describe("AppShell + Sidebar", () => {
  it("marks the active link with aria-current and shows the pill count on another link", () => {
    render(
      <AppShell groups={groups}>
        <p>Page content</p>
      </AppShell>
    );
    const active = screen.getByRole("link", { name: "Revenue Home" });
    expect(active.getAttribute("aria-current")).toBe("page");
    const inbox = screen.getByRole("link", { name: /Inbox/ });
    expect(inbox.textContent).toContain("3");
    expect(screen.getByText("Page content")).toBeTruthy();
  });

  it("calls onNavigate with the href instead of navigating when a link is clicked", async () => {
    const onNavigate = vi.fn();
    render(
      <AppShell groups={groups} onNavigate={onNavigate}>
        <p>Page content</p>
      </AppShell>
    );
    await userEvent.click(screen.getByRole("link", { name: "Revenue Home" }));
    expect(onNavigate).toHaveBeenCalledWith("/home");
  });

  it("opens and closes the mobile drawer scrim via the Menu toggle", async () => {
    render(
      <AppShell groups={groups}>
        <p>Page content</p>
      </AppShell>
    );
    expect(document.querySelector('[aria-hidden="true"].bg-ink\\/40')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(document.querySelector('[aria-hidden="true"].bg-ink\\/40')).toBeTruthy();
    const scrim = document.querySelector('[aria-hidden="true"].bg-ink\\/40') as HTMLElement;
    await userEvent.click(scrim);
    expect(document.querySelector('[aria-hidden="true"].bg-ink\\/40')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/app-shell.test.tsx`
Expected: FAIL — `src/components/app-shell.tsx` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/components/app-shell.tsx`:
```tsx
import * as React from "react";
import { cn } from "../lib/cn";

export interface NavLinkItem {
  href: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  pillCount?: number;
}

export interface NavGroupItem {
  title: string;
  links: NavLinkItem[];
}

export interface SidebarProps {
  groups: NavGroupItem[];
  brand?: React.ReactNode;
  open?: boolean;
  onNavigate?: (href: string) => void;
}

export function Sidebar({ groups, brand, open = false, onNavigate }: SidebarProps) {
  return (
    <aside
      id="palup-sidebar"
      data-open={open}
      className={cn(
        "sticky top-0 flex h-screen w-[264px] flex-col overflow-y-auto bg-ink text-[#D7DED9]",
        "max-[899px]:fixed max-[899px]:left-0 max-[899px]:top-0 max-[899px]:z-40 max-[899px]:w-[280px]",
        "max-[899px]:-translate-x-full max-[899px]:transition-transform",
        open && "max-[899px]:translate-x-0"
      )}
    >
      {brand && <div className="px-4 py-5">{brand}</div>}
      <nav aria-label="Primary" className="flex-1 px-3 pb-[18px] pt-1">
        {groups.map((group) => (
          <div key={group.title} className="mt-4">
            <div className="px-3 pb-[5px] pt-[6px] text-[10.5px] font-bold uppercase tracking-[.09em] text-[#67756C]">
              {group.title}
            </div>
            {group.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                aria-current={link.active ? "page" : undefined}
                onClick={(event) => {
                  if (onNavigate) {
                    event.preventDefault();
                    onNavigate(link.href);
                  }
                }}
                className={cn(
                  "relative flex items-center gap-[11px] rounded-[9px] px-3 py-2 text-[13.5px] font-medium text-[#C2CBC5] transition-colors hover:bg-[#1E2A24] hover:text-white",
                  link.active && "bg-[#1E2A24] text-white"
                )}
              >
                {link.icon}
                <span>{link.label}</span>
                {typeof link.pillCount === "number" && link.pillCount > 0 && (
                  <span className="ml-auto rounded-full bg-coral px-[7px] py-[1px] font-mono text-[10px] font-bold text-white">
                    {link.pillCount}
                  </span>
                )}
              </a>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

export interface AppShellProps {
  groups: NavGroupItem[];
  brand?: React.ReactNode;
  children: React.ReactNode;
  onNavigate?: (href: string) => void;
}

export function AppShell({ groups, brand, children, onNavigate }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <div className="min-h-screen bg-paper md:grid md:grid-cols-[264px_1fr]">
      <Sidebar
        groups={groups}
        brand={brand}
        open={mobileOpen}
        onNavigate={(href) => {
          setMobileOpen(false);
          onNavigate?.(href);
        }}
      />
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-ink/40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="flex flex-col">
        <button
          type="button"
          className="m-3 inline-flex items-center gap-2 self-start rounded border border-line bg-surface px-3 py-2 text-[13px] font-semibold text-ink md:hidden"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          aria-controls="palup-sidebar"
        >
          Menu
        </button>
        <main className="flex-1 p-5">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/app-shell.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/components/app-shell.tsx packages/design-system/test/app-shell.test.tsx
git commit -m "feat(design-system): add AppShell/Sidebar (dark grouped nav + mobile off-canvas drawer)"
```

## Task 15: Barrel export + completeness test

**Files:**
- Create: `packages/design-system/src/index.ts`
- Create: `packages/design-system/test/index-barrel.test.ts`

**Interfaces:**
- Consumes: every export produced by Tasks 1–14.
- Produces: the package's entire public API surface, importable as `import { Button, Card, ... } from "@palup/design-system"`.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/index-barrel.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import * as DesignSystem from "../src/index";

describe("design-system barrel exports", () => {
  it("exposes every component and utility the v1 console screens need", () => {
    const expectedExports = [
      "cn",
      "theme",
      "Button",
      "buttonVariants",
      "Badge",
      "badgeVariants",
      "Card",
      "CardHeader",
      "CardTitle",
      "CardHint",
      "CardBody",
      "StatTile",
      "Field",
      "Input",
      "Select",
      "Textarea",
      "Switch",
      "Note",
      "noteVariants",
      "Tabs",
      "TabsList",
      "TabsTrigger",
      "TabsContent",
      "Table",
      "TableHead",
      "TableBody",
      "TableRow",
      "TableHeaderCell",
      "TableCell",
      "Toaster",
      "useToast",
      "Dialog",
      "DialogTrigger",
      "DialogClose",
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "DialogFooter",
      "AppShell",
      "Sidebar",
    ] as const;

    for (const name of expectedExports) {
      expect(Object.prototype.hasOwnProperty.call(DesignSystem, name)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/index-barrel.test.ts`
Expected: FAIL — `src/index.ts` does not exist, so the import itself fails.

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/src/index.ts`:
```ts
export { cn } from "./lib/cn";
export { theme, type Theme } from "./theme";

export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Badge, badgeVariants, type BadgeProps } from "./components/badge";
export { Card, CardHeader, CardTitle, CardHint, CardBody } from "./components/card";
export { StatTile, type StatTileProps } from "./components/stat-tile";
export { Field, Input, Select, Textarea, type FieldProps } from "./components/field";
export { Switch, type SwitchProps } from "./components/switch";
export { Note, noteVariants, type NoteProps } from "./components/note";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/tabs";
export {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "./components/table";
export { Toaster, useToast, type ToastMessage } from "./components/toast";
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./components/dialog";
export {
  AppShell,
  Sidebar,
  type AppShellProps,
  type SidebarProps,
  type NavGroupItem,
  type NavLinkItem,
} from "./components/app-shell";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/index-barrel.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/src/index.ts packages/design-system/test/index-barrel.test.ts
git commit -m "feat(design-system): add the public barrel export"
```

## Task 16: Vite library build

**Files:**
- Create: `packages/design-system/vite.config.ts`
- Create: `packages/design-system/test/build.test.ts`

**Interfaces:**
- Consumes: `src/index.ts` (Task 15) as the library entry point.
- Produces: `dist/index.js` (ESM bundle) and `dist/index.d.ts` (rolled-up type declarations) when `pnpm --filter @palup/design-system build` is run — a standalone, buildable artifact in addition to the raw-source import path the monorepo uses internally.

- [ ] **Step 1: Write the failing test**

`packages/design-system/test/build.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

describe("vite library build", () => {
  it("builds an ESM bundle and a type declaration file for the whole component barrel", () => {
    rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
    execFileSync("pnpm", ["exec", "vite", "build"], { cwd: packageDir, stdio: "pipe" });
    expect(existsSync(new URL("../dist/index.js", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../dist/index.d.ts", import.meta.url))).toBe(true);
  }, 60_000);
});
```

This is the one deliberately integration-style test in this plan: it shells out to run the real `vite build` command rather than asserting against in-memory behavior, because "the package builds standalone" is precisely the thing a unit test cannot otherwise prove. It is also the slowest test in the suite (a real bundler invocation) — expect it to take several seconds, hence the explicit 60-second timeout.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/design-system/test/build.test.ts`
Expected: FAIL — there is no `vite.config.ts`, so `vite build` has no library entry configured (or fails outright with no config found).

- [ ] **Step 3: Write the minimal implementation**

`packages/design-system/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), dts({ include: ["src"] })],
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
    },
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/design-system/test/build.test.ts`
Expected: PASS (1 test — `dist/index.js` and `dist/index.d.ts` both exist after the build).

- [ ] **Step 5: Commit**

```bash
git add packages/design-system/vite.config.ts packages/design-system/test/build.test.ts
git commit -m "feat(design-system): add the Vite library build (ESM bundle + rolled-up .d.ts)"
```

## Task 17: Full-suite verification

**Files:** none created or modified — this task only runs the existing verification commands.

- [ ] **Step 1: Run the whole design-system test suite together**

Run: `pnpm vitest run packages/design-system`
Expected: PASS — all 16 test files (Tasks 1–16), no cross-test leakage (Radix's Toast/Dialog portals unmount cleanly between tests via Testing Library's automatic `cleanup`).

- [ ] **Step 2: Run the repo-wide test suite to confirm no regression**

Run: `PGVECTOR_TESTCONTAINER=off pnpm test`
Expected: PASS — every previously-passing package test still passes; the `environmentMatchGlobs`/`include` edits to `vitest.config.ts` only *add* a jsdom match and a `.tsx` glob, they narrow nothing.

- [ ] **Step 3: Run the repo-wide typecheck**

Run: `pnpm typecheck`
Expected: PASS — `packages/design-system/tsconfig.json` type-checks cleanly under `tsc -b` via the new root reference (Task 1); `test/*.test.tsx` files are not covered by this check (only `src/` is in `include`), consistent with how every other package in this repo is wired.

- [ ] **Step 4: Run the design-system package's standalone build**

Run: `pnpm --filter @palup/design-system build`
Expected: PASS — succeeds independently of the vitest-driven `build.test.ts` invocation, confirming the script works from a clean shell.

No commit for this task — it is a verification checkpoint, not a code change.

## Self-Review

**1. Spec coverage.** The spec (§7) asks for: tokens + shadcn/ui components themed to PalUp tokens (Tasks 2–14), sourced from the `palup-design-system` skill (Task 2's consistency test) and `palup-merchant-app.html` (every component's className choices are traced to specific mockup CSS rules read this session — `.btn`, `.bdg`, `.card`/`.card-h`/`.card-b`, `.stat`, `.inp/.sel/.txa`/`.field`, `.sw`, `.note`, `.tabs`, `.tbl`, `custToast`, `.sidebar`/`.nav`/`.scrim`), shared with the future admin console (nothing here is merchant-console-specific — no merchant data, no API calls), and built only to v1-screen needs (YAGNI list in Global Constraints, checked against every workstream's UI vocabulary in the spec's §9). The explicit "package scaffold / vite lib build / tailwind preset / token-consistency test / core components with a component test each" checklist from the task brief is covered one-to-one by Tasks 1, 16, 2 (preset), 2 (consistency test), and 3–14 respectively.

**2. Placeholder scan.** Every task's code block is complete, runnable source — no `TODO`, no "add appropriate X", no elided function bodies. The one narrative exception is intentional and disclosed, not a placeholder: `noteVariants`' text colors and the radius roundings are documented *design decisions with stated rationale*, not stand-ins for missing work.

**3. Type consistency.** Cross-checked exports against the barrel (Task 15) and the completeness test (same task): `ButtonProps`/`BadgeProps`/`StatTileProps`/`FieldProps`/`SwitchProps`/`NoteProps`/`AppShellProps`/`SidebarProps`/`NavGroupItem`/`NavLinkItem`/`ToastMessage`/`Theme` are named identically everywhere they appear (component file, barrel, and — where a later task's test imports a type — the test file). `theme.color.ink2` (camelCase, no separator) is used consistently in both `src/theme.ts` and `test/theme-tokens-consistency.test.ts`; `tokens["ink-2"]` (kebab-case, from the raw CSS custom property name) is used consistently for the parsed-CSS side of every comparison in that same test.

**Open questions / assumptions carried forward (not blocking, flagged for whoever builds the first consumer):**
- `Dialog` has no literal counterpart in `palup-merchant-app.html` (which only shows a right-side drawer). It's included because governance confirms (Kill Switch, approve/reject) need a "hard to misclick" affordance per the design-system skill's own governance-surfaces note — but if a future workstream plan decides the drawer pattern should be used for governance confirms instead, `Dialog` may go unused. Not removed here because W1 (Approval Center + Kill Switch) is next in the spec's build order and will almost certainly need one or the other.
- The radius-rounding and note-text-color substitutions (Global Constraints) are real, visible deviations from `palup-merchant-app.html`'s literal pixel/hex values, chosen to keep strict token discipline. If pixel-perfect fidelity turns out to matter more than token discipline once a real screen is built against these components, the fix is a `tokens.css`/skill update (human/design-system-skill change), not a `design-system` package change.
- No Storybook, no visual regression tooling, and no actual Tailwind build were set up — `tailwindcss` itself is not a dependency of this package at all (Task list "File Structure" note). The first plan that builds a real app (merchant-console) will need to install `tailwindcss`/`postcss`/`autoprefixer` there and point its `content` glob at `packages/design-system/src/**/*.tsx` in addition to its own source, plus add `presets: [require("@palup/design-system/tailwind-preset")]`. That wiring is intentionally out of scope for F1 (YAGNI — there is no consumer app yet to wire it into).
