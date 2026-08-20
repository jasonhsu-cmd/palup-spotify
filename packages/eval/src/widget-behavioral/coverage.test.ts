import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "./load.js";
import { genPairwiseCases } from "./gen-pairwise-cases.js";

// Task 11 — Layer-1 coverage self-check. Runs on vitest (same runner-discovery override as
// load.test.ts / corpus.test.ts — the brief's illustrative node:test/tsx snippet does not match how
// this package's suite actually executes).
//
// This asserts the corpus exercises every Layer-1-reachable enum value the spec (§3) lists, over the
// UNION of the hand-authored JSON corpus AND the runtime-generated pairwise slice (Task 10) — exactly
// mirroring how main.ts assembles its case list (`[...loadCases(casesPath), ...genPairwiseCases()]`).
// Coverage may come from either source: a value only reachable via the all-pairs grid still counts.
describe("widget-behavioral corpus coverage", () => {
  const casesPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cases", "widget-behavioral.json");

  it("exercises every Relationship, Mood, and PersonaStyle value the spec lists (JSON ∪ pairwise)", () => {
    const cases = [...loadCases(casesPath), ...genPairwiseCases()];
    const seen = (k: string) =>
      new Set(cases.map((c) => (c.signals as Record<string, unknown>)[k]).filter((v) => v != null));

    const relationship = seen("relationship");
    const mood = seen("mood");
    const personaStyle = seen("personaStyle");

    // Relationship — 8 values (widget-brain/src/types.ts).
    for (const v of [
      "anonymous", "new", "repeat", "vip", "subscriber", "replenishment_due", "lapsed", "one_and_done",
    ]) {
      expect(relationship.has(v), `relationship "${v}" not exercised by any case`).toBe(true);
    }

    // Mood — 7 values.
    for (const v of ["frustrated", "upset", "anxious", "confused", "skeptical", "neutral", "satisfied"]) {
      expect(mood.has(v), `mood "${v}" not exercised by any case`).toBe(true);
    }

    // PersonaStyle — 4 values. Not in the brief's Step-1 snippet, but straightforward to add per the
    // task instructions, and already exercised by both the hand-authored corpus and the pairwise grid.
    for (const v of ["ready", "researcher", "deal_seeker", "needs_guidance"]) {
      expect(personaStyle.has(v), `personaStyle "${v}" not exercised by any case`).toBe(true);
    }
  });
});
