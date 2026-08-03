import { describe, it, expect } from "vitest";
import { createBrain, createSession, createMemorySessionStore, MockModelAdapter, DEFAULT_POLICY } from "../src/index.js";

// Shopper-disposition program PR-8 — SessionState.sessionDisposition: a TRANSIENT, STYLE-ONLY, in-session
// fallback for when durable cross-visit memory (widget-memory) is off or the shopper hasn't consented.
// session.ts maintains it UNCONDITIONALLY (no flag of its own, mirrors PR-4's counters); brain.ts is the
// sole gate that ever turns it into an observable voice change (dispositionStyleEnabled).

const brainWithPersonaStyle = () =>
  createBrain(new MockModelAdapter(), undefined, DEFAULT_POLICY, undefined, "shopper-demo", undefined, false, true);
const brainWithoutPersonaStyle = () => createBrain(new MockModelAdapter());

describe("session.ts — sessionDisposition capture (PR-8)", () => {
  it("a supplied signals.personaStyle this turn is captured as an 'observed' style disposition", async () => {
    const s = await createSession(brainWithPersonaStyle());
    await s.send("tell me about the serum", { personaStyle: "researcher", cart: "empty" });
    expect(s.state.sessionDisposition).toEqual([{ axis: "style", value: "researcher", provenance: "observed", confidence: 1 }]);
  });

  it("STICKY: a LATER turn with no personaStyle still carries the earlier observed style forward (unlike mood, which is cleared every turn)", async () => {
    const s = await createSession(brainWithPersonaStyle());
    await s.send("tell me about the serum", { personaStyle: "researcher", cart: "empty" });
    await s.send("what about the moisturizer?", { cart: "empty" }); // no personaStyle this turn
    expect(s.state.sessionDisposition).toEqual([{ axis: "style", value: "researcher", provenance: "observed", confidence: 1 }]);
  });

  it("a later turn with a DIFFERENT personaStyle REPLACES the prior one — last-observed wins, never accumulates a history", async () => {
    const s = await createSession(brainWithPersonaStyle());
    await s.send("tell me about the serum", { personaStyle: "researcher", cart: "empty" });
    await s.send("what's on sale?", { personaStyle: "deal_seeker", cart: "empty" });
    expect(s.state.sessionDisposition).toEqual([{ axis: "style", value: "deal_seeker", provenance: "observed", confidence: 1 }]);
  });

  it("a session that NEVER observes a personaStyle never gains the sessionDisposition key at all", async () => {
    const s = await createSession(brainWithPersonaStyle());
    await s.send("tell me about the serum", { cart: "empty" });
    await s.send("what about returns?", { cart: "empty" });
    expect(Object.keys(s.state)).not.toContain("sessionDisposition");
    expect(s.state.sessionDisposition).toBeUndefined();
  });

  it("persists across a restored session (the store round-trip carries it forward, like every other SessionState field)", async () => {
    const store = createMemorySessionStore();
    const s1 = await createSession(brainWithPersonaStyle(), { sessionId: "disp-1", store });
    await s1.send("tell me about the serum", { personaStyle: "needs_guidance", cart: "empty" });

    const s2 = await createSession(brainWithPersonaStyle(), { sessionId: "disp-1", store });
    expect(s2.state.sessionDisposition).toEqual([{ axis: "style", value: "needs_guidance", provenance: "observed", confidence: 1 }]);
  });

  it("a FRESH session (new sessionId / no store) never carries a prior session's disposition — dies with the session", async () => {
    const store = createMemorySessionStore();
    const s1 = await createSession(brainWithPersonaStyle(), { sessionId: "disp-a", store });
    await s1.send("tell me about the serum", { personaStyle: "researcher", cart: "empty" });

    const freshInMemory = await createSession(brainWithPersonaStyle()); // no store at all — a brand new guest session
    expect(freshInMemory.state.sessionDisposition).toBeUndefined();

    const s2 = await createSession(brainWithPersonaStyle(), { sessionId: "disp-b", store }); // different sessionId, same store
    expect(s2.state.sessionDisposition).toBeUndefined();
  });
});

describe("brain.ts — sessionDisposition as a STYLE-ONLY fallback (PR-8)", () => {
  it("consumes the carried sessionDisposition on a LATER turn that supplies no personaStyle of its own, applying the SAME whitelisted PERSONA_STYLE_DIRECTIVE text", async () => {
    const s = await createSession(brainWithPersonaStyle());
    await s.send("what actives are in this?", { personaStyle: "researcher", cart: "empty" });
    const d2 = await s.send("tell me more", { cart: "empty", proactivityLevel: "balanced" }); // no personaStyle this turn
    expect(d2.flags).toContain("persona:researcher");
  });

  it("a turn's OWN supplied personaStyle always outranks the carried session fallback", async () => {
    const s = await createSession(brainWithPersonaStyle());
    await s.send("what actives are in this?", { personaStyle: "researcher", cart: "empty" });
    const d2 = await s.send("what's on sale?", { personaStyle: "deal_seeker", cart: "empty" });
    expect(d2.flags).toContain("persona:deal_seeker");
    expect(d2.flags).not.toContain("persona:researcher");
  });

  it("flag OFF (dispositionStyleEnabled default false): sessionDisposition is tracked but never consumed — byte-identical to before PR-8", async () => {
    const s = await createSession(brainWithoutPersonaStyle());
    const d1 = await s.send("what actives are in this?", { personaStyle: "researcher", cart: "empty" });
    const d2 = await s.send("tell me more", { cart: "empty", proactivityLevel: "balanced" });
    expect(d1.flags.some((f) => f.startsWith("persona:"))).toBe(false);
    expect(d2.flags.some((f) => f.startsWith("persona:"))).toBe(false);
  });

  it("FAIRNESS (carried condition 3): sessionDisposition steers voice only — selectPitch's output is byte-identical whether or not the fallback style directive applies", async () => {
    const withFallback = await createSession(brainWithPersonaStyle());
    await withFallback.send("what actives are in this?", { personaStyle: "researcher", cart: "has_items" });
    const dWith = await withFallback.send("tell me more", { cart: "has_items", proactivityLevel: "balanced" });

    const withoutFallback = await createSession(brainWithPersonaStyle());
    await withoutFallback.send("hi", { cart: "has_items" });
    const dWithout = await withoutFallback.send("tell me more", { cart: "has_items", proactivityLevel: "balanced" });

    expect(dWith.flags).toContain("persona:researcher"); // sanity: the fallback really did fire
    expect(dWith.pitch).toBe(dWithout.pitch);
    expect(dWith.outbound).toBe(dWithout.outbound);
    expect(dWith.reply).not.toMatch(/%|discount|coupon|promo/i);
  });

  it("never touches selectPitch — a buy signal still forces pitch=none regardless of the fallback style directive", async () => {
    const s = await createSession(brainWithPersonaStyle());
    await s.send("what actives are in this?", { personaStyle: "researcher", cart: "has_items" });
    const d2 = await s.send("I'll take it, checkout?", { cart: "has_items" });
    expect(d2.pitch).toBe("none");
    expect(d2.flags).toContain("buy_signal");
  });
});
