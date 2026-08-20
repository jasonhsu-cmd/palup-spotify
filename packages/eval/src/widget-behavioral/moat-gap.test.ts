import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "./load.js";
import { makeBrain } from "./brain-factory.js";
import type { BehavioralCase } from "./schema.js";

// Gap-closure — the "moat-gap" observation family.
//
// The spec's moat-gap bucket names six Signals fields that are DECLARED on the type
// (widget-brain/src/types.ts:474-480: device, entry, sessionRecency, csat, hasComplaintHistory,
// hasReturnHistory) but never READ anywhere in the decision logic — confirmed by grep across
// widget-brain/src/brain.ts, support.ts, and safety.ts (zero occurrences of `signals.<field>` or a
// bare reference to any of the six field names outside types.ts and its own test). Each of the six
// cases below (family "moat-gap", cases/widget-behavioral.json) sets one such signal alongside an
// ordinary sales message.
//
// These are OBSERVATIONS, not defects: nothing in the harness's static `expect` block can prove a
// NEGATIVE ("the agent never looked at this") on its own — a `mustNot` on a speculative flag name
// only shows that flag is absent, which is trivially true for a flag nothing ever emits. The test
// below proves the stronger, actually-meaningful claim directly: re-running the SAME message with
// the signal stripped out produces a BYTE-IDENTICAL `Decision` (mode, pitch, escalation, flags,
// reply, everything) to running it with the signal present. That is the real content of "the moat is
// unexploited" — not merely that one flag is missing, but that the signal changes nothing at all.
describe("widget-behavioral moat-gap family — inert signals produce identical decisions", () => {
  const casesPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cases", "widget-behavioral.json");
  const allCases = loadCases(casesPath) as BehavioralCase[];
  const moatGapCases = allCases.filter((c) => c.family === "moat-gap");

  it("the moat-gap family is present and covers all six declared-but-inert signals", () => {
    const keys = new Set(moatGapCases.flatMap((c) => Object.keys(c.signals)));
    for (const k of ["device", "entry", "sessionRecency", "csat", "hasComplaintHistory", "hasReturnHistory"]) {
      expect(keys.has(k), `no moat-gap case sets signal "${k}"`).toBe(true);
    }
  });

  it("each moat-gap case's decision is identical with the inert signal present vs. stripped", async () => {
    expect(moatGapCases.length).toBeGreaterThan(0);
    for (const c of moatGapCases) {
      if (c.message === undefined) throw new Error(`moat-gap case ${c.id} must be single-turn`);
      const withSignal = await makeBrain(c.brain).decide(c.signals as never, c.message);

      const stripped: Record<string, unknown> = { ...c.signals };
      for (const k of ["device", "entry", "sessionRecency", "csat", "hasComplaintHistory", "hasReturnHistory"]) {
        delete stripped[k];
      }
      const withoutSignal = await makeBrain(c.brain).decide(stripped as never, c.message);

      expect(withSignal, `case ${c.id}: decision changed when the moat-gap signal was removed`).toEqual(withoutSignal);
    }
  });
});
