import { describe, it, expect } from "vitest";
import { createBrain, MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY } from "../src/index.js";

// Brain hardening — two deterministic guardrails from docs/design/shopper-widget.md §4:
//   (1) Persona: roles = for-self / gift / B2B (→ ESCALATE). A business/bulk inquiry is routed to a
//       human instead of getting a consumer pitch.
//   (2) Contextual: "quiet-hours suppresses OUTBOUND" — inside the local quiet window we suppress an
//       email/SMS follow-up but still answer the shopper reactively (the reply is NEVER suppressed).
// Same wiring/style as brain-precedence.test.ts: one shared full brain + a decide(msg, signals) helper.
const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo");
const decide = (msg: string, signals: Record<string, unknown> = {}) => brain.decide(signals as never, msg);

// Signals that WOULD select a proactive consumer pitch on the clean sales path (cart has_items +
// balanced → cross_sell). Reused so the B2B tests carry a real would-be pitch the rung must suppress.
const WOULD_PITCH = { cart: "has_items", proactivityLevel: "balanced" } as const;

describe("brain hardening (1): B2B / bulk intent escalates to a human, never a consumer pitch (§4 Persona)", () => {
  it("routes a wholesale/bulk business inquiry to a person with no pitch", async () => {
    const d = await decide("do you offer wholesale pricing? I want to order in bulk for my business.", WOULD_PITCH);
    expect(d.escalateToHuman).toBe(true);
    expect(d.pitch).toBe("none");
    expect(d.flags).toEqual(expect.arrayContaining(["persona:b2b", "offer_human"]));
    expect(d.model).toBe("guardrail"); // diverted before the sales path → the consumer pitch was suppressed
    expect(d.reply.toLowerCase()).toMatch(/team|person|wholesale/); // honest hand-off, promises no price
  });

  it("detects B2B via a purchase-order phrasing too", async () => {
    const d = await decide("I'd like to place a purchase order for 200 units for my store.", WOULD_PITCH);
    expect(d.flags).toContain("persona:b2b");
    expect(d.escalateToHuman).toBe(true);
    expect(d.pitch).toBe("none");
  });

  it("FALSE-POSITIVE guard: a normal consumer question is NOT flagged B2B and still gets a pitch", async () => {
    const d = await decide("what's a good serum for oily skin?", WOULD_PITCH);
    expect(d.flags).not.toContain("persona:b2b");
    expect(d.escalateToHuman).toBe(false);
    expect(d.mode).toBe("sales");
    expect(d.pitch).not.toBe("none"); // the same signals still yield a normal consumer pitch
  });

  it("FALSE-POSITIVE guard: a bare pack-size question ('how many units are in the box') is NOT B2B", async () => {
    const d = await decide("how many units are in the box?", WOULD_PITCH);
    expect(d.flags).not.toContain("persona:b2b");
  });
});

describe("brain hardening (2): quiet-hours suppresses OUTBOUND only, never the reactive reply (§4 Contextual)", () => {
  // Replenishment persona + email consent = a would-be outbound follow-up (see the consent-gated
  // outbound path). localHour is the ONLY difference between suppressed and allowed below.
  const OUTBOUND_WANTED = { relationship: "replenishment_due", cart: "empty", proactivityLevel: "balanced", consent: { email: "in" } } as const;

  it("consent=in but localHour inside the quiet window (23:00) → outbound suppressed, reactive reply still produced", async () => {
    const d = await decide("hey, I'm back — anything new for me?", { ...OUTBOUND_WANTED, localHour: 23 });
    expect(d.outbound).toBe(false);
    expect(d.flags).toContain("outbound_suppressed_quiet_hours");
    expect(d.flags).not.toContain("outbound");
    // The reactive reply is NEVER suppressed — the shopper is still answered this turn.
    expect(d.mode).toBe("sales");
    expect(d.reply.length).toBeGreaterThan(0);
    expect(d.model).toBe("mock-1"); // reached the model → a real reactive reply, not a guardrail short-circuit
  });

  it("consent=in + a daytime localHour (14:00) → outbound allowed as before (no quiet-hours flag)", async () => {
    const d = await decide("hey, I'm back — anything new for me?", { ...OUTBOUND_WANTED, localHour: 14 });
    expect(d.outbound).toBe(true);
    expect(d.flags).toContain("outbound");
    expect(d.flags).not.toContain("outbound_suppressed_quiet_hours");
  });

  it("consent=in + NO localHour (clock unknown) → outbound allowed (quiet-hours not applied)", async () => {
    const d = await decide("hey, I'm back — anything new for me?", { ...OUTBOUND_WANTED });
    expect(d.outbound).toBe(true);
    expect(d.flags).toContain("outbound");
    expect(d.flags).not.toContain("outbound_suppressed_quiet_hours");
  });

  it("quiet-window boundaries: 07:00 is quiet, 08:00 is not", async () => {
    const early = await decide("hey, I'm back — anything new for me?", { ...OUTBOUND_WANTED, localHour: 7 });
    expect(early.flags).toContain("outbound_suppressed_quiet_hours");
    expect(early.outbound).toBe(false);
    const open = await decide("hey, I'm back — anything new for me?", { ...OUTBOUND_WANTED, localHour: 8 });
    expect(open.flags).toContain("outbound");
    expect(open.outbound).toBe(true);
  });
});
