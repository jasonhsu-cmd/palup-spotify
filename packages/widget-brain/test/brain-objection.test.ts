import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import {
  createBrain,
  createSession,
  MockModelAdapter,
  StaticGroundingAdapter,
  MockCommerceAdapter,
  DEFAULT_POLICY,
} from "../src/index.js";

// ITEM (widget in-progress): the "objection→close" pitch (docs/design/shopper-widget.md §5, the 8 pitch
// kinds) is defined in the PITCH_PLAYBOOK but was never SELECTED — selectPitch only ever returned
// guided_rec / cross_sell / cart_recovery / replenishment / none. A DETERMINISTIC price/fit/trust
// objection in the CURRENT message now routes the sales-path pitch to `objection_close`, but ONLY under
// the existing hard caps (§5 timing; §6A precedence ladder; INV-E budget; price/discount = HITL).
// Same wiring/style as brain-precedence.test.ts: one shared full brain + a decide(msg, signals) helper.
const brain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo");
const decide = (msg: string, signals: Record<string, unknown> = {}) => brain.decide(signals as never, msg);

// A clean sales turn whose base pitch (cart has_items + balanced) is normally cross_sell — so an
// objection must OVERRIDE it to objection_close, proving the trigger fires on the sales path.
const CLEAN_SALES = { mood: "neutral", cart: "has_items", proactivityLevel: "balanced" } as const;

describe("objection→close: a shopper objection routes to objection_close on the sales path (§5)", () => {
  it("a clear price objection in a clean sales turn → pitch objection_close (overrides cross_sell)", async () => {
    const d = await decide("honestly this is too expensive — is it really worth it?", CLEAN_SALES);
    expect(d.mode).toBe("sales");
    expect(d.pitch).toBe("objection_close");
    expect(d.pitch).not.toBe("cross_sell"); // the objection outranks the default cart pitch
    expect(d.flags).toContain("objection_detected");
    expect(d.flags).toContain("pitch:objection_close");
  });

  it("a fit/trust objection while browsing (no cart) → objection_close (overrides guided_rec)", async () => {
    const d = await decide("I'm not sure it's right for me and I'm on the fence.", { mood: "neutral", proactivityLevel: "balanced" });
    expect(d.mode).toBe("sales");
    expect(d.pitch).toBe("objection_close");
    expect(d.pitch).not.toBe("guided_rec");
  });

  it("detects the affordability / efficacy / worry variants too", async () => {
    for (const msg of ["I can't afford this right now", "does it really work though?", "worried it won't help my skin"]) {
      const d = await decide(msg, CLEAN_SALES);
      expect(d.pitch, msg).toBe("objection_close");
    }
  });

  it("FALSE-POSITIVE guard: a normal product question is NOT an objection (keeps the default pitch)", async () => {
    const d = await decide("what's a good serum for oily skin?", CLEAN_SALES);
    expect(d.mode).toBe("sales");
    expect(d.pitch).toBe("cross_sell"); // unchanged — the same signals still yield the normal pitch
    expect(d.pitch).not.toBe("objection_close");
    expect(d.flags).not.toContain("objection_detected");
  });
});

describe("objection→close: every hard cap still holds (an objection never bypasses a cap)", () => {
  it("objection + an open support issue → mode support, pitch none (INV-B suppresses sales)", async () => {
    const d = await decide("this is too expensive, is it worth it?", { openIssues: ["order_1042_late"], ...CLEAN_SALES });
    expect(d.mode).toBe("support");
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("no_pitch");
    expect(d.flags).not.toContain("pitch:objection_close");
  });

  it("objection + safety latched → mode safety, pitch none (INV-A latch wins)", async () => {
    const d = await decide("this is too expensive, is it worth it?", { safetyLatched: true, ...CLEAN_SALES });
    expect(d.mode).toBe("safety");
    expect(d.pitch).toBe("none");
    expect(d.flags).not.toContain("pitch:objection_close");
  });

  it("objection + negative mood → mood brake, pitch none (serve-and-brake asymmetry)", async () => {
    const d = await decide("this is too expensive, is it worth it?", { ...CLEAN_SALES, mood: "frustrated" });
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("mood_brake");
    expect(d.flags).not.toContain("pitch:objection_close");
  });

  it("objection over the cross-turn pitch budget → pitch none (INV-E budget_capped)", async () => {
    // Session budget for the Balanced level = 2 (session.ts). Spend it on two clean pitched turns, then
    // the objection turn is over budget → converted to none exactly like ANY other pitch (INV-E: the
    // budget is one per conversation and mode-switching never refills it).
    const s = await createSession(createBrain(new MockModelAdapter()), { level: "balanced" });
    const sig = { mood: "neutral" as const, cart: "has_items" as const };
    await s.send("tell me about the serum", sig); // pitch #1 (cross_sell)
    await s.send("what about the moisturizer", sig); // pitch #2 (cross_sell) — budget now spent
    const d = await s.send("but this is too expensive, is it worth it?", sig);
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("budget_capped");
    expect(d.flags).not.toContain("pitch:objection_close");
  });
});

describe("objection→close never invents a discount (price/discount = HITL, §5/§7)", () => {
  const sysOf = (spy: ReturnType<typeof vi.fn>) =>
    ((spy.mock.calls[0]![0] as ModelRequest).messages.find((m) => m.role === "system")?.content ?? "");

  it("threads the objection directive that FORBIDS inventing a discount into the model prompt", async () => {
    const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
    const b = createBrain({ complete: spy }, new StaticGroundingAdapter());
    const d = await b.decide({ tenantId: "demo", ...CLEAN_SALES }, "this is too expensive, is it worth it?");
    expect(d.pitch).toBe("objection_close"); // objection_close was actually selected → its directive is threaded
    const sys = sysOf(spy);
    expect(sys).toMatch(/PITCH - objection/);
    expect(sys).toMatch(/never invent or imply a discount/i); // the playbook directive forbids inventing one
    expect(sys).toMatch(/no false urgency/i);
  });

  it("if the model reply invents a '% off' during an objection, the reply-integrity backstop catches it (no false promise, escalate, no pitch)", async () => {
    const b = createBrain({ complete: async () => ({ text: "You're right it's pricey — here's 20% off to close the deal!", model: "spy" }) }, new StaticGroundingAdapter());
    const d = await b.decide({ tenantId: "demo", ...CLEAN_SALES }, "this is too expensive, is it worth it?");
    expect(d.flags).toContain("reply_integrity:ungrounded_discount");
    expect(d.escalateToHuman).toBe(true);
    expect(d.pitch).toBe("none"); // the invented-discount reply is never served, and no pitch rides along
    expect(d.reply).not.toContain("20%");
  });
});
