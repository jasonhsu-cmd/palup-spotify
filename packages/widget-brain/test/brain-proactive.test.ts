import { describe, it, expect } from "vitest";
import {
  createBrain,
  createSession,
  MockModelAdapter,
  StaticGroundingAdapter,
  MockCommerceAdapter,
  DEFAULT_POLICY,
} from "../src/index.js";

// ITEM (widget in-progress): exit-intent as a value-aligned, CAPPED proactive moment (docs/design/
// shopper-widget.md §4 Behavioral exit-intent; §5 Timing "proactive = signal-triggered at a value-aligned
// moment, capped ... never mid-complaint/safety or 'just browsing'"). RESTRAINT IS THE FEATURE. A
// proactive trigger is AGENT-INITIATED (empty shopper turn + signals.proactiveTrigger), NEVER a shopper
// message: it runs ONLY on the CLEAN sales path (every higher rung wins first), may surface AT MOST a
// single cart_recovery pitch under the ONE INV-E budget, and NEVER overrides a brake. Same wiring/style
// as brain-precedence.test.ts: one shared full brain + a decide(msg, signals) helper.
const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo");
const decide = (msg: string, signals: Record<string, unknown> = {}) => brain.decide(signals as never, msg);

// An exit-intent trigger with a neutral mood; callers layer on cart / brakes.
const EXIT = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ proactiveTrigger: "exit_intent", mood: "neutral", ...extra });

describe("proactive exit-intent (§5) — value-aligned + capped", () => {
  it("exit-intent + an unrecovered cart + budget available → a single cart_recovery pitch, labeled proactive", async () => {
    const d = await decide("", EXIT({ cart: "has_items", proactivityLevel: "balanced" }));
    expect(d.mode).toBe("sales");
    expect(d.pitch).toBe("cart_recovery"); // the value-aligned exit-intent pitch (allowed at every level, §5)
    expect(d.pitch).not.toBe("cross_sell"); // NOT the level's default cart pitch — exit-intent is a recovery moment
    expect(d.flags).toContain("proactive:exit_intent"); // clearly labeled as agent-initiated proactive
    expect(d.flags).toContain("pitch:cart_recovery");
    expect(d.outbound).toBe(false); // in-session nudge, not a consent-gated email/SMS follow-up
    expect(d.reply.length).toBeGreaterThan(0); // a real, surfaced nudge
  });

  it("a high_value cart also qualifies as an unrecovered cart", async () => {
    const d = await decide("", EXIT({ cart: "high_value", proactivityLevel: "balanced" }));
    expect(d.pitch).toBe("cart_recovery");
    expect(d.flags).toContain("proactive:exit_intent");
  });

  it("NO cart / 'just browsing' → quiet: pitch none, EMPTY reply (never nag)", async () => {
    for (const cart of ["empty", undefined]) {
      const d = await decide("", EXIT({ cart }));
      expect(d.pitch, String(cart)).toBe("none");
      expect(d.reply, String(cart)).toBe(""); // nothing is surfaced — the client renders no message
      expect(d.flags, String(cart)).toContain("no_cart");
      expect(d.flags, String(cart)).toContain("proactive:exit_intent"); // still audited as a (suppressed) proactive moment
      expect(d.flags, String(cart)).not.toContain("pitch:cart_recovery");
    }
  });

  it("a proactive nudge never invents a discount (price/discount = HITL): the reply-integrity backstop catches it", async () => {
    const b = createBrain({ complete: async () => ({ text: "Come back now for 30% off your cart!", model: "spy" }) }, new StaticGroundingAdapter());
    const d = await b.decide({ tenantId: "demo", ...EXIT({ cart: "has_items" }) } as never, "");
    expect(d.flags).toContain("reply_integrity:ungrounded_discount");
    expect(d.escalateToHuman).toBe(true);
    expect(d.pitch).toBe("none"); // the invented-discount nudge is never served
    expect(d.reply).not.toContain("30%");
  });
});

describe("proactive exit-intent NEVER overrides a brake (§6A precedence ladder)", () => {
  it("safety latched + exit-intent + cart → mode safety, pitch none (INV-A latch wins over the proactive moment)", async () => {
    const d = await decide("", EXIT({ cart: "has_items", safetyLatched: true }));
    expect(d.mode).toBe("safety");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("no_pitch");
    expect(d.flags).not.toContain("pitch:cart_recovery");
  });

  it("open support issue + exit-intent + cart → mode support, pitch none (INV-B suppresses sales)", async () => {
    const d = await decide("", EXIT({ cart: "has_items", openIssues: ["order_1042_late"] }));
    expect(d.mode).toBe("support");
    expect(d.pitch).toBe("none");
    expect(d.flags).not.toContain("pitch:cart_recovery");
  });

  it("operator kill + exit-intent + cart → halts, hands to a human, no pitch, no autonomous action", async () => {
    const d = await decide("", EXIT({ cart: "has_items", kill: true }));
    expect(d.flags).toContain("kill_switch");
    expect(d.pitch).toBe("none");
    expect(d.escalateToHuman).toBe(true);
    expect(d.model).toBe("guardrail"); // short-circuits at the top → the proactive branch never runs
  });

  it("negative mood + exit-intent + cart → mood brake, pitch none, EMPTY reply (serve-and-brake asymmetry)", async () => {
    const d = await decide("", EXIT({ cart: "has_items", mood: "frustrated" }));
    expect(d.pitch).toBe("none");
    expect(d.reply).toBe("");
    expect(d.flags).toContain("mood_brake");
    expect(d.flags).not.toContain("pitch:cart_recovery");
  });

  it("a REAL shopper message riding with a proactive flag is handled reactively (proactive is agent-initiated only)", async () => {
    // Defensive: an exit_intent flag on a NON-empty turn must NOT hijack the shopper's actual message —
    // the safety report still wins and the proactive branch never fires.
    const d = await decide("my face is burning after the serum", EXIT({ cart: "has_items" }));
    expect(d.mode).toBe("safety");
    expect(d.pitch).toBe("none");
    expect(d.flags).not.toContain("pitch:cart_recovery");
  });
});

describe("proactive exit-intent consumes the ONE budget — it cannot nag (INV-E)", () => {
  it("a second proactive nudge after the first is over budget → none AND surfaces nothing (one-strike)", async () => {
    const s = await createSession(createBrain(new MockModelAdapter()), { level: "cautious" }); // budget = 1
    const d1 = await s.send("", EXIT({ cart: "has_items" }) as never);
    expect(d1.pitch).toBe("cart_recovery"); // first nudge allowed
    expect(d1.reply.length).toBeGreaterThan(0);
    const d2 = await s.send("", EXIT({ cart: "has_items" }) as never);
    expect(d2.pitch).toBe("none"); // second is over the one-per-conversation budget
    expect(d2.flags).toContain("budget_capped");
    expect(d2.reply).toBe(""); // ...and surfaces NOTHING — no nag
  });

  it("exit-intent after the budget was spent on reactive pitches → none, nothing surfaced (the cap holds)", async () => {
    const s = await createSession(createBrain(new MockModelAdapter()), { level: "balanced" }); // budget = 2
    const sig = { mood: "neutral" as const, cart: "has_items" as const };
    await s.send("tell me about the serum", sig); // reactive pitch #1
    await s.send("what about the moisturizer", sig); // reactive pitch #2 — budget now spent
    const d = await s.send("", EXIT({ cart: "has_items" }) as never); // proactive, over budget
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("budget_capped");
    expect(d.reply).toBe("");
  });

  it("an allowed proactive nudge consumes exactly one budget unit, like any pitch", async () => {
    const s = await createSession(createBrain(new MockModelAdapter()), { level: "balanced" }); // budget = 2
    const d1 = await s.send("", EXIT({ cart: "has_items" }) as never); // proactive cart_recovery — spends 1
    expect(d1.pitch).toBe("cart_recovery");
    expect(s.state.pitchesUsed).toBe(1);
    const d2 = await s.send("tell me about the serum", { mood: "neutral", cart: "has_items" }); // reactive #2
    expect(d2.pitch).not.toBe("none");
    expect(s.state.pitchesUsed).toBe(2);
    const d3 = await s.send("and the cleanser?", { mood: "neutral", cart: "has_items" }); // over budget
    expect(d3.pitch).toBe("none");
    expect(d3.flags).toContain("budget_capped");
  });
});

// WS-B3b — "reengage" (client-detected dwell / idle_then_return) EXTENDS the exact same exit-intent rung
// rather than adding a new one: same conservative cart_recovery pitch, same INV-E budget, same
// atCap/kill/mood/no_cart suppression, NO money logic added. Only the flag differs (proactive:reengage vs
// proactive:exit_intent) so the two are distinguishable in the audit log/eval corpus.
const REENGAGE = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ proactiveTrigger: "reengage", mood: "neutral", ...extra });

describe("proactive reengage (WS-B3b) — reuses the exit-intent rung verbatim", () => {
  it("reengage + an unrecovered cart + budget available → the SAME single cart_recovery pitch, labeled proactive:reengage", async () => {
    const d = await decide("", REENGAGE({ cart: "has_items", proactivityLevel: "balanced" }));
    expect(d.mode).toBe("sales");
    expect(d.pitch).toBe("cart_recovery");
    expect(d.flags).toContain("proactive:reengage");
    expect(d.flags).not.toContain("proactive:exit_intent"); // distinguishable from the exit-intent moment
    expect(d.flags).toContain("pitch:cart_recovery");
    expect(d.outbound).toBe(false);
    expect(d.reply.length).toBeGreaterThan(0);
  });

  it("NO cart / 'just browsing' → quiet: pitch none, EMPTY reply (never nag)", async () => {
    for (const cart of ["empty", undefined]) {
      const d = await decide("", REENGAGE({ cart }));
      expect(d.pitch, String(cart)).toBe("none");
      expect(d.reply, String(cart)).toBe("");
      expect(d.flags, String(cart)).toContain("no_cart");
      expect(d.flags, String(cart)).toContain("proactive:reengage");
      expect(d.flags, String(cart)).not.toContain("pitch:cart_recovery");
    }
  });

  it("negative mood suppresses reengage exactly like exit-intent (mood brake reused, not re-implemented)", async () => {
    const d = await decide("", REENGAGE({ cart: "has_items", mood: "frustrated" }));
    expect(d.pitch).toBe("none");
    expect(d.reply).toBe("");
    expect(d.flags).toContain("mood_brake");
    expect(d.flags).not.toContain("pitch:cart_recovery");
  });

  it("operator kill still halts a reengage trigger — no autonomous action survives the kill switch", async () => {
    const d = await decide("", REENGAGE({ cart: "has_items", kill: true }));
    expect(d.flags).toContain("kill_switch");
    expect(d.pitch).toBe("none");
    expect(d.escalateToHuman).toBe(true);
    expect(d.model).toBe("guardrail"); // short-circuits before the proactive branch ever runs
  });

  it("§8a invariant 14 basic-mode-at-cap suppresses reengage exactly like exit-intent", async () => {
    const d = await decide(
      "",
      REENGAGE({ cart: "high_value", mood: "satisfied", atCap: true }),
    );
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("at_cap");
    expect(d.flags).toContain("no_pitch");
  });

  it("reengage consumes the SAME ONE INV-E budget as exit-intent — the two triggers cannot double-spend it", async () => {
    const s = await createSession(createBrain(new MockModelAdapter()), { level: "cautious" }); // budget = 1
    const d1 = await s.send("", REENGAGE({ cart: "has_items" }) as never);
    expect(d1.pitch).toBe("cart_recovery");
    const d2 = await s.send("", EXIT({ cart: "has_items" }) as never); // same session, same shared budget
    expect(d2.pitch).toBe("none");
    expect(d2.flags).toContain("budget_capped");
    expect(d2.reply).toBe("");
  });

  it("a REAL shopper message riding with a reengage flag is handled reactively, never hijacked", async () => {
    const d = await decide("my face is burning after the serum", REENGAGE({ cart: "has_items" }));
    expect(d.mode).toBe("safety");
    expect(d.pitch).toBe("none");
    expect(d.flags).not.toContain("pitch:cart_recovery");
  });
});
