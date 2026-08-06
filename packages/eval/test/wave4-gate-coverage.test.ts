import { describe, it, expect } from "vitest";
import { createBrain, StaticGroundingAdapter } from "@palup/widget-brain";
import { CitingModelAdapter, tagsOfferedIn } from "../src/citing-model.js";
import { incumbent, wave4Candidate } from "../src/candidates.js";
import { runCandidate, evaluate } from "../src/run.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// `run.ts` keeps `cases` module-private, so read the same file it reads rather than exporting state
// purely for a test.
const cases = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "cases", "core.json"), "utf8"),
) as { id: string; floor: boolean; signals: Record<string, unknown> }[];

// THE DEFECT THIS CLOSES: the blocking gate was structurally blind to E2 and E4.
//
// Measured before this change, running the real gate against a brain with `productCitationsEnabled` and
// `cartLineItemsEnabled` ON:
//
//   incumbent : 69/69 blocked=false
//   E2+E4 on  : 69/69 blocked=false floorFails=[] regressions=[]
//   cases whose verdict changed: NONE
//   replies identical: true
//
// Green, and it saw nothing. NN#2 requires an eval gate to pass before promotion; a gate that cannot
// execute the code path is not evidence about it. Two independent causes, both confirmed:
//   * `cartItems` appeared in ZERO cases across every corpus file — E4's path never ran.
//   * No corpus reply contained a citation tag and `MockModelAdapter` never emits one — E2's
//     extract/resolve/strip path never ran.
//
// So this file's job is not "test E2 and E4" (their own suites do that). It is to prove the GATE can see
// them — that the coverage added here is not itself vacuous.

const CART = { tenantId: "demo", cart: "has_items" } as const;

describe("the citing double cites REAL tags, not constants it agreed on with the code", () => {
  it("cites a tag the prompt actually offered, and it resolves", async () => {
    const captured: string[] = [];
    const spy = new (class {
      inner = new CitingModelAdapter("cite");
      async complete(req: never) {
        const sys = (req as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "system");
        captured.push(sys?.content ?? "");
        return this.inner.complete(req as never);
      }
    })();

    const brain = createBrain(
      spy as never, new StaticGroundingAdapter(), undefined, undefined, undefined, undefined,
      false, false, false, false, undefined, false, undefined,
      /* productCitations */ true, /* cards */ false, /* cartItems */ false,
    );
    const d = await brain.decide(CART as never, "recommend a moisturizer for dry skin");

    const offered = tagsOfferedIn(captured[captured.length - 1] ?? "");
    expect(offered.length, "the prompt offered no citation tags — E2 minted none, so nothing is under test").toBeGreaterThan(0);
    // The whole point: the id came back because the double cited a nonce it was SHOWN.
    expect((d as { recommendedProducts?: string[] }).recommendedProducts?.length ?? 0).toBeGreaterThan(0);
    // And the shopper never sees the bookkeeping.
    expect(d.reply).not.toMatch(/\[P\d/);
  });

  it("a FORGED tag resolves to nothing and is stripped", async () => {
    const brain = createBrain(
      new CitingModelAdapter("forge") as never, new StaticGroundingAdapter(), undefined, undefined, undefined, undefined,
      false, false, false, false, undefined, false, undefined, true, false, false,
    );
    const d = await brain.decide(CART as never, "recommend a moisturizer for dry skin");
    expect((d as { recommendedProducts?: string[] }).recommendedProducts ?? []).toEqual([]);
    expect(d.reply).not.toMatch(/\[P\d/);
    expect(d.reply).not.toContain("deadbeef");
  });

  it("a SILENT reply under-reports rather than inventing — E2's documented lower bound", async () => {
    const brain = createBrain(
      new CitingModelAdapter("silent") as never, new StaticGroundingAdapter(), undefined, undefined, undefined, undefined,
      false, false, false, false, undefined, false, undefined, true, false, false,
    );
    const d = await brain.decide(CART as never, "recommend a moisturizer for dry skin");
    expect((d as { recommendedProducts?: string[] }).recommendedProducts ?? []).toEqual([]);
  });
});

describe("the corpus can now exercise E4 (cart line items)", () => {
  it("at least one case supplies cartItems — it supplied ZERO before", () => {
    const withItems = cases.filter((c) => Array.isArray((c.signals as { cartItems?: unknown }).cartItems));
    expect(withItems.length, "no corpus case supplies cartItems, so E4's path is unreachable by the gate").toBeGreaterThan(0);
  });

  it("those cases are FLOOR cases — an inert flag must not be able to weaken them", () => {
    const withItems = cases.filter((c) => Array.isArray((c.signals as { cartItems?: unknown }).cartItems));
    expect(withItems.every((c) => c.floor)).toBe(true);
  });
});

describe("the gate now EVALUATES the flag-on posture, and that evaluation is not vacuous", () => {
  it("the Wave 4 candidate exists and is held to the same floors as the incumbent", async () => {
    const results = await runCandidate(wave4Candidate);
    const g = evaluate(wave4Candidate, results);
    expect(g.floorFails, `flag-on posture breaks a floor: ${g.floorFails}`).toEqual([]);
    expect(g.blocked).toBe(false);
  });

  it("THE NON-VACUITY PROOF: the flag-on candidate is observably different from the incumbent", async () => {
    // Before this change the two were byte-identical, which is precisely why the gate proved nothing.
    // At least one decision must now carry a citation the incumbent does not.
    const [a, b] = await Promise.all([
      incumbent.brain.decide(CART as never, "recommend a moisturizer for dry skin"),
      wave4Candidate.brain.decide(CART as never, "recommend a moisturizer for dry skin"),
    ]);
    const cited = (x: unknown) => ((x as { recommendedProducts?: string[] }).recommendedProducts ?? []).length;
    expect(cited(a), "the incumbent should cite nothing — its flag is off").toBe(0);
    expect(cited(b), "the Wave 4 candidate cited nothing either — the coverage is still vacuous").toBeGreaterThan(0);
  });
});
