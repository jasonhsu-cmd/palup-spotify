import { describe, it, expect } from "vitest";
import { deriveServingSignals } from "../src/signals.js";
import type { Signals } from "@palup/widget-brain";

// T7: the shopper's browser must not be able to grant itself treatment, flip merchant policy, self-assert
// marketing consent, arm/bypass the kill switch, or inject support/safety state via `signals`.
describe("deriveServingSignals — client signals are untrusted", () => {
  const ctx = { kill: false, region: "us" as const, groundingMode: "full" as const };

  it("ignores every trust-bearing field the client tries to set", () => {
    const malicious: Signals = {
      relationship: "vip", // trying to grant VIP treatment
      consent: { email: "in", sms: "in" }, // trying to self-assert marketing consent
      groundingMode: "off", // trying to flip merchant competitor-mode
      region: "eu", // trying to change data-residency regime
      proactivityLevel: "confident", // trying to crank up autonomy
      openIssues: ["fabricated-issue"], // trying to inject support state
      safetyLatched: true, // trying to inject safety state
      kill: true, // trying to arm/observe the kill switch
    };
    const out = deriveServingSignals(malicious, ctx);
    expect(out.relationship).toBe("anonymous");
    expect(out.consent).toEqual({ email: "unknown", sms: "unknown" });
    expect(out.groundingMode).toBe("full"); // from ctx (merchant), not the client's "off"
    expect(out.region).toBe("us"); // from ctx, not the client's "eu"
    expect(out.proactivityLevel).toBeUndefined(); // omitted → brain uses the policy default
    expect(out.openIssues).toBeUndefined(); // session-state only
    expect(out.safetyLatched).toBeUndefined(); // session-state only
    expect(out.kill).toBeUndefined(); // ctx.kill is false → not armed by the client
  });

  it("sources kill state from the server context, not the client", () => {
    // Client says kill:false but operator has armed it → armed.
    expect(deriveServingSignals({ kill: false }, { ...ctx, kill: true }).kill).toBe(true);
    // Client says kill:true but operator has NOT armed it → not armed.
    expect(deriveServingSignals({ kill: true }, { ...ctx, kill: false }).kill).toBeUndefined();
  });

  it("passes through mood/cart only when a valid enum value", () => {
    expect(deriveServingSignals({ mood: "frustrated", cart: "high_value" }, ctx)).toMatchObject({
      mood: "frustrated",
      cart: "high_value",
    });
    const bogus = deriveServingSignals({ mood: "elated" as never, cart: "overflowing" as never }, ctx);
    expect(bogus.mood).toBeUndefined();
    expect(bogus.cart).toBeUndefined();
  });

  it("carries the merchant ctx values through", () => {
    const out = deriveServingSignals(undefined, { kill: false, region: "eu", groundingMode: "general" });
    expect(out.region).toBe("eu");
    expect(out.groundingMode).toBe("general");
  });
});
