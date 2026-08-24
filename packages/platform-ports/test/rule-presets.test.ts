import { describe, it, expect } from "vitest";
import {
  CONSERVATIVE_DAY1_PRESET, VERTICAL_PRESETS, listPresets, findPreset,
  clampToFloor, PALUP_FLOORS, type ProposalCategory,
} from "../src/index.js";

describe("rule presets", () => {
  it("Day-1 is the first listed preset and every preset has a stable id + non-empty label/description", () => {
    const all = listPresets();
    expect(all[0]).toBe(CONSERVATIVE_DAY1_PRESET);
    for (const p of all) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.label.trim()).not.toBe("");
      expect(p.description.trim()).not.toBe("");
    }
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length); // ids unique
  });

  it("findPreset resolves by id and returns undefined for an unknown id", () => {
    expect(findPreset(CONSERVATIVE_DAY1_PRESET.id)).toBe(CONSERVATIVE_DAY1_PRESET);
    expect(findPreset("nope")).toBeUndefined();
  });

  it("Day-1 is conservative-but-useful: NO money category auto-acts, spend/discount/refund stay OFF", () => {
    const e = CONSERVATIVE_DAY1_PRESET.envelope;
    expect(e.discount?.allowedAuto ?? false).toBe(false);
    expect(e.ad_spend?.allowedAuto ?? false).toBe(false);
    expect(e.refund?.allowedAuto ?? false).toBe(false);
  });

  it("NO preset exceeds any PalUp floor (clamp is a no-op ⇒ preset already ≤ floor)", () => {
    for (const p of listPresets()) {
      for (const cat of Object.keys(p.envelope) as ProposalCategory[]) {
        const env = p.envelope[cat]!;
        const clamped = clampToFloor(env, PALUP_FLOORS[cat]);
        if (env.maxPct !== undefined) expect(clamped.maxPct).toBe(env.maxPct);
        if (env.maxUsd !== undefined) expect(clamped.maxUsd).toBe(env.maxUsd);
        if (env.periodBudgetUsd !== undefined) expect(clamped.periodBudgetUsd).toBe(env.periodBudgetUsd);
        if (env.priceMatchMaxUsd !== undefined) expect(clamped.priceMatchMaxUsd).toBe(env.priceMatchMaxUsd);
        expect(clamped.allowedAuto).toBe(env.allowedAuto); // never widened
      }
    }
  });

  it("ships a skincare vertical preset (the primary staging vertical)", () => {
    expect(VERTICAL_PRESETS.some((p) => p.vertical === "skincare")).toBe(true);
  });
});
