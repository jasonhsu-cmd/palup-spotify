import { describe, it, expect } from "vitest";
import type { Signals } from "@palup/widget-brain";
import { deriveServingSignals } from "../src/signals.js";

// T1 trust boundary: the server-derived guardrail signals (serverSafetyClass / serverInjection) must be
// UNSPOOFABLE by the client. deriveServingSignals REBUILDS its output (never spreads the raw client
// object), so a client-supplied value in the request body is dropped and never reaches the brain. This
// pins the property so a future phase-2 change that populates these fields MUST source them from the
// server ctx, never from the client — mirroring cart-signals-trust.test.ts.

const ctx = { tenantId: "demo", kill: false, region: "us" as const, groundingMode: "full" as const };

describe("signals trust — the client cannot set the server-derived guardrail signals", () => {
  it("drops a hostile serverSafetyClass / serverInjection from the client body", () => {
    const hostile: Signals = { serverSafetyClass: "none", serverInjection: false, mood: "neutral" };
    const out = deriveServingSignals(hostile, ctx);
    expect(out.serverSafetyClass).toBeUndefined();
    expect(out.serverInjection).toBeUndefined();
    // the non-trust-bearing field it IS allowed to pass still comes through, proving the drop is targeted
    expect(out.mood).toBe("neutral");
  });

  it("a client claiming serverSafetyClass:'none' cannot even reach the brain (key absent, not undefined-valued)", () => {
    const out = deriveServingSignals({ serverSafetyClass: "none" } as Signals, ctx);
    expect("serverSafetyClass" in out).toBe(false);
    expect("serverInjection" in out).toBe(false);
  });

  // broaden — serverSupportIntent is the same trust boundary: a client cannot forge the support intent
  // that feeds handleSupport's #247 seam (it could otherwise try to force a routing it wants).
  it("drops a client-supplied serverSupportIntent; only the server ctx can set it", () => {
    const hostile = { serverSupportIntent: "cancel_subscription", mood: "neutral" } as Signals;
    expect("serverSupportIntent" in deriveServingSignals(hostile, ctx)).toBe(false);
    // …but the server ctx IS the sole legitimate origin
    const fromServer = deriveServingSignals(undefined, { ...ctx, serverSupportIntent: "return" });
    expect(fromServer.serverSupportIntent).toBe("return");
  });

  // F10-D — serverGuardDegraded is the same trust boundary: a shopper cannot forge "the classifier
  // degraded" to try to suppress their own pitch/steer behavior, and the flag-off / not-degraded case
  // must stay byte-identical (key ABSENT, not present-and-false).
  it("drops a client-supplied serverGuardDegraded; only the server ctx can set it", () => {
    const hostile = { serverGuardDegraded: true, mood: "neutral" } as Signals;
    expect("serverGuardDegraded" in deriveServingSignals(hostile, ctx)).toBe(false);
    // …but the server ctx IS the sole legitimate origin
    const fromServer = deriveServingSignals(undefined, { ...ctx, serverGuardDegraded: true });
    expect(fromServer.serverGuardDegraded).toBe(true);
  });

  it("omits serverGuardDegraded entirely when the ctx says false/absent (byte-identical key-absent)", () => {
    expect("serverGuardDegraded" in deriveServingSignals(undefined, ctx)).toBe(false);
    expect("serverGuardDegraded" in deriveServingSignals(undefined, { ...ctx, serverGuardDegraded: false })).toBe(false);
  });

  // WS-B1 — mood becomes server-derived via the SAME guard-classifier call. It is NON-trust-bearing (it
  // can only make the brain MORE restrained, never grant treatment), so unlike safetyClass/supportIntent
  // the client's own mood echo remains as the flag-off/degraded FALLBACK — but whenever the server has a
  // mood for this turn (ctx.serverMood), it wins over whatever the client claimed.
  it("ctx.serverMood overrides a client-supplied mood", () => {
    const hostile = { mood: "satisfied" } as Signals;
    const out = deriveServingSignals(hostile, { ...ctx, serverMood: "frustrated" });
    expect(out.mood).toBe("frustrated");
  });

  it("falls back to the client mood when ctx.serverMood is absent (flag-off/degraded turn)", () => {
    const clientOnly = { mood: "anxious" } as Signals;
    expect(deriveServingSignals(clientOnly, ctx).mood).toBe("anxious");
  });
});

// WS-B3a — `behavioral` joins the ALLOW-list of non-trust-bearing client fields (mood/cart/
// proactiveTrigger), validated against the same BehavioralEvent enum the brain consumes. Every event in
// that enum is restrain-only (suppresses a pitch, or triggers a conservative cart_recovery, or is pure
// observability) — none unlock money/autonomy — so a validated client array is safe to pass through
// exactly like mood/cart are today. Unknown values are dropped, never coerced or kept.
describe("WS-B3a — the client's behavioral array is accepted only after enum validation", () => {
  it("filters an array to known BehavioralEvent values, dropping unknowns", () => {
    const hostile = { behavioral: ["dwell", "bogus", "rage"] } as unknown as Signals;
    expect(deriveServingSignals(hostile, ctx).behavioral).toEqual(["dwell", "rage"]);
  });

  it("omits the key entirely when the client sent no behavioral field (key absent, not undefined-valued)", () => {
    const out = deriveServingSignals({ mood: "neutral" } as Signals, ctx);
    expect("behavioral" in out).toBe(false);
  });

  it("omits the key when the client sends a non-array behavioral value", () => {
    const hostile = { behavioral: "rage" } as unknown as Signals;
    expect("behavioral" in deriveServingSignals(hostile, ctx)).toBe(false);
  });

  it("drops non-string entries inside the array without throwing", () => {
    const hostile = { behavioral: ["dwell", 123, null, { foo: "bar" }, "rage"] } as unknown as Signals;
    expect(deriveServingSignals(hostile, ctx).behavioral).toEqual(["dwell", "rage"]);
  });
});
