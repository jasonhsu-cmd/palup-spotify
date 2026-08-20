import { describe, it, expect } from "vitest";
import { genPairwiseCases } from "./gen-pairwise-cases.js";
import { runSingle } from "./run-single.js";

// Task 10 — pairwise generator (Slice B, spec §4/§6). genPairwiseCases() maps allPairs' rows over
// the 6 REAL §3 axes (relationship, mood, personaStyle, cart, groundingMode, proactivityLevel) into
// BehavioralCases with a light Tier-1 smoke bar. Written FIRST (red) per the ATDD loop before
// gen-pairwise-cases.ts exists.
describe("genPairwiseCases", () => {
  it("produces unique-id pairwise cases with family/severity/riskClass and a light expect", () => {
    const cases = genPairwiseCases();
    expect(cases.length).toBeGreaterThan(0);

    const ids = new Set<string>();
    for (const c of cases) {
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.family).toBe("pairwise");
      expect(c.severity).toBe("P2");
      expect(c.riskClass).toBe("routing");
      expect(typeof c.message).toBe("string");
      expect(c.turns).toBeUndefined();
      // No stub grounding / no throwOnGetContext in pairwise cases.
      expect(c.brain?.grounding).not.toBe("stub");
      expect(c.brain?.stub).toBeUndefined();
    }
  });

  it("covers every pair of values across the 6 axes at least once", () => {
    const cases = genPairwiseCases();
    const axes: Record<string, string[]> = {
      relationship: ["anonymous", "new", "repeat", "vip", "subscriber", "replenishment_due", "lapsed", "one_and_done"],
      mood: ["frustrated", "upset", "anxious", "confused", "skeptical", "neutral", "satisfied"],
      personaStyle: ["ready", "researcher", "deal_seeker", "needs_guidance"],
      cart: ["empty", "has_items", "high_value"],
      groundingMode: ["off", "general", "full"],
      proactivityLevel: ["cautious", "balanced", "confident"],
    };
    const names = Object.keys(axes);
    const rows = cases.map((c) => c.signals as Record<string, string>);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i]!;
        const b = names[j]!;
        for (const va of axes[a]!) {
          for (const vb of axes[b]!) {
            const covered = rows.some((r) => r[a] === va && r[b] === vb);
            expect(covered, `uncovered pair ${a}=${va} & ${b}=${vb}`).toBe(true);
          }
        }
      }
    }
    // Sanity: far fewer than the full cross product (8*7*4*3*3*3 = 6048).
    expect(cases.length).toBeLessThan(200);
  });

  it("every generated case loads and runs through runSingle without throwing", async () => {
    const cases = genPairwiseCases();
    for (const c of cases) {
      await expect(runSingle(c)).resolves.toBeDefined();
    }
  });
});
