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
});
