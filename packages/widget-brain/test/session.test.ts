import { describe, it, expect } from "vitest";
import {
  createBrain,
  createSession,
  createMemorySessionStore,
  MockModelAdapter,
} from "../src/index.js";

const brain = () => createBrain(new MockModelAdapter());

describe("session: multi-turn state", () => {
  it("INV-A: safety latches across a topic change", async () => {
    const s = await createSession(brain());
    await s.send("my face is burning after using it");
    const d = await s.send("anyway, add the serum to my cart", { cart: "has_items" });
    expect(d.mode).toBe("safety");
    expect(d.pitch).toBe("none");
  });

  it("INV-E: one proactivity budget across the conversation (balanced = 2)", async () => {
    const s = await createSession(brain(), { level: "balanced" });
    const sig = { mood: "neutral" as const, cart: "has_items" as const };
    const d1 = await s.send("tell me about the serum", sig);
    const d2 = await s.send("what about the moisturizer", sig);
    const d3 = await s.send("and the cleanser?", sig);
    expect(d1.pitch).not.toBe("none");
    expect(d2.pitch).not.toBe("none");
    expect(d3.pitch).toBe("none");
    expect(d3.flags).toContain("budget_capped");
  });

  it("INV-B: an open support issue suppresses sales until resolved, then re-enables", async () => {
    const s = await createSession(brain());
    const t1 = await s.send("where's my order #1042?");
    expect(t1.mode).toBe("support");
    const t2 = await s.send("I'll grab the serum too", { cart: "has_items" });
    expect(t2.mode).toBe("support"); // suppressed while issue open
    expect(t2.pitch).toBe("none");
    await s.send("thanks, all set");
    const t4 = await s.send("ok tell me about the serum", { cart: "has_items" });
    expect(t4.mode).toBe("sales"); // resolved -> sales re-enabled
    expect(t4.pitch).not.toBe("none");
  });

  it("SW-12: open issues persist across sessions via the store", async () => {
    const store = createMemorySessionStore();
    const s1 = await createSession(brain(), { sessionId: "c1", store });
    await s1.send("where's my order #1050?");
    const s2 = await createSession(brain(), { sessionId: "c1", store });
    expect(s2.state.openIssues.length).toBeGreaterThan(0);
    const d = await s2.send("hi", { cart: "has_items" });
    expect(d.mode).toBe("support");
    expect(d.pitch).toBe("none");
  });
});

describe("consent-gated outbound", () => {
  it("suppresses outbound when consent is unknown", async () => {
    const d = await brain().decide(
      { relationship: "replenishment_due", cart: "empty", proactivityLevel: "balanced", consent: { email: "unknown" } },
      "hey, I'm back",
    );
    expect(d.outbound).toBe(false);
    expect(d.flags).toContain("outbound_suppressed_no_consent");
  });

  it("allows outbound only with explicit consent", async () => {
    const d = await brain().decide(
      { relationship: "replenishment_due", cart: "empty", proactivityLevel: "balanced", consent: { email: "in" } },
      "hey, I'm back",
    );
    expect(d.outbound).toBe(true);
    expect(d.flags).toContain("outbound");
  });
});

describe("fairness: no persona price-discrimination", () => {
  it("treats a VIP and a new shopper identically (no discount, same pitch policy)", async () => {
    const msg = "which serum should I get?";
    const sig = { mood: "neutral" as const, cart: "has_items" as const, proactivityLevel: "balanced" as const };
    const vip = await brain().decide({ ...sig, relationship: "vip" }, msg);
    const neu = await brain().decide({ ...sig, relationship: "new" }, msg);
    expect(vip.pitch).toBe(neu.pitch);
    expect(vip.reply).not.toMatch(/%|discount|coupon/i);
    expect(neu.reply).not.toMatch(/%|discount|coupon/i);
  });
});
