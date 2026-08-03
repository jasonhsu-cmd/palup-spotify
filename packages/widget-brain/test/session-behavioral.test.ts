import { describe, it, expect } from "vitest";
import { createBrain, createSession, MockModelAdapter } from "../src/index.js";

// Shopper-disposition program PR-4 — cross-turn behavioral bookkeeping in session.ts (SessionState
// CONTROL COUNTERS only — pitchDeclined/repeatQuestionCount/rageCount — never a persona PROFILE; see
// brain-behavioral.test.ts for the flag-gated brain.ts contract this state feeds). Session.ts has no
// DISPOSITION_BEHAVIORAL flag of its own: it maintains the counters unconditionally; brain.ts is the
// sole gate that ever turns them into an observable decision change.
const behavioralBrain = (dispositionBehavioralEnabled = true) =>
  createBrain(new MockModelAdapter(), undefined, undefined, undefined, "shopper-demo", undefined, false, false, dispositionBehavioralEnabled);

describe("session: PR-4 behavioral cross-turn counters (flag DISPOSITION_BEHAVIORAL)", () => {
  it("pitch_declined arms a one-strike that suppresses the very NEXT proactive pitch, then disarms", async () => {
    const s = await createSession(behavioralBrain());
    // Turn 1 - a reactive turn where the shopper explicitly declines a pitch.
    await s.send("no thanks, not interested", { cart: "has_items", behavioral: ["pitch_declined"] });
    expect(s.state.pitchDeclined).toBe(true);

    // Turn 2 - the NEXT proactive (agent-initiated) attempt, no behavioral signal of its own this turn:
    // the carried one-strike alone must suppress it.
    const d2 = await s.send("", { cart: "has_items", proactiveTrigger: "exit_intent" });
    expect(d2.pitch).toBe("none");
    expect(d2.flags).toContain("disposition:one_strike");
    expect(s.state.pitchDeclined).toBe(false); // consumed - true one-strike

    // Turn 3 - another proactive attempt: no longer suppressed.
    const d3 = await s.send("", { cart: "has_items", proactiveTrigger: "exit_intent" });
    expect(d3.pitch).toBe("cart_recovery");
  });

  it("repeatQuestionCount is a running cross-turn tally, not a one-strike", async () => {
    const s = await createSession(behavioralBrain());
    await s.send("what's the return policy?", { cart: "has_items", behavioral: ["repeat_question"] });
    expect(s.state.repeatQuestionCount).toBe(1);
    await s.send("wait, what's the return policy again?", { cart: "has_items", behavioral: ["repeat_question"] });
    expect(s.state.repeatQuestionCount).toBe(2);
  });

  it("rageCount is a running cross-turn tally", async () => {
    const s = await createSession(behavioralBrain());
    await s.send("this is ridiculous", { cart: "has_items", behavioral: ["rage"] });
    expect(s.state.rageCount).toBe(1);
    await s.send("still ridiculous", { cart: "has_items", behavioral: ["rage"] });
    expect(s.state.rageCount).toBe(2);
  });

  it("INV-E: the one proactivity budget still holds unchanged with the flag ON and counters active", async () => {
    const s = await createSession(behavioralBrain(), { level: "balanced" });
    const sig = { mood: "neutral" as const, cart: "has_items" as const };
    const d1 = await s.send("tell me about the serum", sig);
    const d2 = await s.send("what about the moisturizer", sig);
    const d3 = await s.send("and the cleanser?", sig);
    expect(d1.pitch).not.toBe("none");
    expect(d2.pitch).not.toBe("none");
    expect(d3.pitch).toBe("none");
    expect(d3.flags).toContain("budget_capped");
  });

  describe("ships inert: flag OFF (default)", () => {
    it("counters are still maintained in SessionState, but never CONSUMED into a behavior change", async () => {
      const s = await createSession(behavioralBrain(false));
      await s.send("no thanks", { cart: "has_items", behavioral: ["pitch_declined"] });
      expect(s.state.pitchDeclined).toBe(true); // bookkeeping happens regardless of the brain's own flag
      const d2 = await s.send("", { cart: "has_items", proactiveTrigger: "exit_intent" });
      expect(d2.pitch).toBe("cart_recovery"); // never suppressed - the flag gate is in brain.ts
      expect(d2.flags).not.toContain("disposition:one_strike");
    });

    it("a session run with behavioral signals is byte-identical (decision-wise) to one without, flag OFF", async () => {
      const s1 = await createSession(behavioralBrain(false));
      const s2 = await createSession(behavioralBrain(false));
      const withBehavioral = await s1.send("tell me about the serum", { cart: "has_items", behavioral: ["rage", "repeat_question"] });
      const withoutBehavioral = await s2.send("tell me about the serum", { cart: "has_items" });
      expect(withBehavioral.pitch).toBe(withoutBehavioral.pitch);
      expect(withBehavioral.flags).toEqual(withoutBehavioral.flags);
      expect(withBehavioral.escalateToHuman).toBe(withoutBehavioral.escalateToHuman);
    });
  });

  it("no persona PROFILE is persisted on SessionState - only transient control counters", async () => {
    const s = await createSession(behavioralBrain());
    await s.send("tell me about the serum", { cart: "has_items", behavioral: ["dwell", "hesitation", "rage", "repeat_question"] });
    expect(typeof s.state.pitchDeclined).toBe("boolean");
    expect(typeof s.state.repeatQuestionCount).toBe("number");
    expect(typeof s.state.rageCount).toBe("number");
    // No nested profile/array of observed disposition axes/styles anywhere on the session state.
    const keys = Object.keys(s.state);
    expect(keys).not.toContain("personaProfile");
    expect(keys).not.toContain("dispositionProfile");
    expect(keys).not.toContain("sessionDisposition"); // PR-8, not this PR
    for (const [k, v] of Object.entries(s.state)) {
      if (k === "pitchDeclined" || k === "repeatQuestionCount" || k === "rageCount") continue;
      expect(Array.isArray(v) && v.some((x) => typeof x === "object" && x && "axis" in x)).toBe(false);
    }
  });
});
