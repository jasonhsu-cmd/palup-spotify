import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySupportIntent, SUPPORT_INTENTS } from "@palup/widget-brain";
import { loadCases } from "./load.js";
import { genPairwiseCases } from "./gen-pairwise-cases.js";
import { makeBrain } from "./brain-factory.js";
import type { BehavioralCase } from "./schema.js";

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

// Gap-closure — full enum coverage for PersonaRole (3), SafetyClass (8), and SupportIntent (17).
//
// Unlike Relationship/Mood/PersonaStyle above, none of these three is a `signals` key the coverage
// test can just scan for — they are all DERIVED from the free-text `message` by the brain's own
// classifiers (classifySupportIntent, classifySafety, the B2B keyword/personaRole rung). A case's
// `covers` field (schema.ts) is the AUTHOR'S DECLARATION of which value a case was written to
// exercise; every test below independently RE-DERIVES the value (via the real classifier or a live
// `brain.decide()` call, exactly mirroring main.ts's own case-construction) so a `covers` annotation
// can never be aspirational — an annotation that doesn't actually hold is a failing test, not a
// silently-trusted comment.
describe("widget-behavioral corpus coverage — PersonaRole / SafetyClass / SupportIntent (via `covers`)", () => {
  const casesPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cases", "widget-behavioral.json");
  const cases = [...loadCases(casesPath), ...genPairwiseCases()] as BehavioralCase[];

  const coveredValues = (key: "supportIntent" | "safetyClass" | "personaRole"): Set<string> =>
    new Set(cases.map((c) => c.covers?.[key]).filter((v): v is string => v != null));

  // PersonaRole — 3 values (widget-brain/src/types.ts:57). All three are reachable and already
  // exercised by the hand-authored persona-role family (t9-persona-*); no exclusions.
  const PERSONA_ROLES = ["for_self", "gift", "b2b"];

  it("exercises every PersonaRole value via a covers-annotated case", () => {
    const covered = coveredValues("personaRole");
    for (const role of PERSONA_ROLES) {
      expect(covered.has(role), `PersonaRole "${role}" not exercised by any covers-annotated case`).toBe(true);
    }
  });

  // SafetyClass — 8 values (widget-brain/src/types.ts:26-34). All eight are reachable and already
  // exercised by the hand-authored safety family (t8-safety-*); no exclusions.
  const SAFETY_CLASSES = ["none", "product_safety", "medical", "distress", "regulated_claim", "legal", "injection", "abuse"];

  it("exercises every SafetyClass value via a covers-annotated case", () => {
    const covered = coveredValues("safetyClass");
    for (const cls of SAFETY_CLASSES) {
      expect(covered.has(cls), `SafetyClass "${cls}" not exercised by any covers-annotated case`).toBe(true);
    }
  });

  it("every covers.safetyClass annotation is honest: a live brain.decide() actually returns that class", async () => {
    for (const c of cases) {
      const want = c.covers?.safetyClass;
      if (!want || c.message === undefined) continue;
      const brain = makeBrain(c.brain);
      const decision = await brain.decide(c.signals as never, c.message);
      expect(decision.safetyClass, `case ${c.id}: covers.safetyClass="${want}"`).toBe(want);
    }
  });

  // SupportIntent — 17 values (widget-brain/src/support.ts SUPPORT_INTENTS). ONE value is
  // documented-excluded rather than covered:
  //
  //   "ingredients" — structurally UNREACHABLE via classifySupportIntent (support.ts:122-159): the
  //   function has no branch that returns it. This is deliberate (F7, support.ts:154-158 comment): a
  //   non-allergy ingredient question is meant to fall through to "general" and then route to the
  //   GROUNDED SALES path (the model answers from the catalog ingredient list), never to support mode.
  //   Verified empirically here (not asserted from memory): classifySupportIntent("What ingredients
  //   are in the daily moisturizer?") === "general". Faking a covers.supportIntent:"ingredients" case
  //   would assert a false positive for a value the agent can never actually be driven to — the
  //   honesty constraint this test enforces instead is that EVERY other value must be reachable, and
  //   this one value must NOT be claimed as reachable.
  const EXCLUDED_SUPPORT_INTENTS: ReadonlySet<string> = new Set(["ingredients"]);

  it("classifySupportIntent never actually produces an excluded (documented-unreachable) intent", () => {
    // Pins the exclusion itself: if a future change to classifySupportIntent makes "ingredients"
    // reachable, this fails loudly instead of leaving a stale exclusion in the allowlist above.
    expect(classifySupportIntent("What ingredients are in the daily moisturizer?")).toBe("general");
    expect(classifySupportIntent("Does the moisturizer have fragrance in it?")).toBe("general");
  });

  it("exercises every non-excluded SupportIntent value via a covers-annotated case", () => {
    const covered = coveredValues("supportIntent");
    for (const intent of SUPPORT_INTENTS) {
      if (EXCLUDED_SUPPORT_INTENTS.has(intent)) continue;
      expect(covered.has(intent), `SupportIntent "${intent}" not exercised by any covers-annotated case`).toBe(true);
    }
  });

  it("every covers.supportIntent annotation is honest: classifySupportIntent agrees with the declared intent", () => {
    for (const c of cases) {
      const want = c.covers?.supportIntent;
      if (!want || c.message === undefined) continue;
      expect(classifySupportIntent(c.message), `case ${c.id}: covers.supportIntent="${want}"`).toBe(want);
    }
  });

  it("every covers.supportIntent-annotated case actually routes the turn to support mode", async () => {
    for (const c of cases) {
      const want = c.covers?.supportIntent;
      if (!want || c.message === undefined) continue;
      const brain = makeBrain(c.brain);
      const decision = await brain.decide(c.signals as never, c.message);
      expect(decision.mode, `case ${c.id}: covers.supportIntent="${want}"`).toBe("support");
    }
  });
});
