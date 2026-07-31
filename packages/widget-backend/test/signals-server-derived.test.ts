import { describe, it, expect } from "vitest";
import { deriveServingSignals } from "../src/signals.js";
import type { Signals } from "@palup/widget-brain";
import { generateGuestId } from "@palup/widget-memory";

// T7: the shopper's browser must not be able to grant itself treatment, flip merchant policy, self-assert
// marketing consent, arm/bypass the kill switch, or inject support/safety state via `signals`.
describe("deriveServingSignals — client signals are untrusted", () => {
  const ctx = { tenantId: "acme", kill: false, region: "us" as const, groundingMode: "full" as const };

  it("ignores every trust-bearing field the client tries to set", () => {
    const malicious: Signals = {
      tenantId: "victim-merchant", // trying to impersonate another merchant's catalog
      relationship: "vip", // trying to grant VIP treatment
      consent: { email: "in", sms: "in", memoryOrdinary: "in", memorySpecial: "in" }, // trying to self-assert marketing + memory consent
      groundingMode: "off", // trying to flip merchant competitor-mode
      region: "eu", // trying to change data-residency regime
      proactivityLevel: "confident", // trying to crank up autonomy
      openIssues: ["fabricated-issue"], // trying to inject support state
      safetyLatched: true, // trying to inject safety state
      kill: true, // trying to arm/observe the kill switch
    };
    const out = deriveServingSignals(malicious, ctx);
    expect(out.tenantId).toBe("acme"); // from ctx (verified token), NOT the client's "victim-merchant"
    expect(out.relationship).toBe("anonymous");
    expect(out.consent).toEqual({ email: "unknown", sms: "unknown", memoryOrdinary: "unknown", memorySpecial: "unknown" });
    expect(out.groundingMode).toBe("full"); // from ctx (merchant), not the client's "off"
    expect(out.region).toBe("us"); // from ctx, not the client's "eu"
    expect(out.proactivityLevel).toBeUndefined(); // omitted → brain uses the policy default
    expect(out.openIssues).toBeUndefined(); // session-state only
    expect(out.safetyLatched).toBeUndefined(); // session-state only
    expect(out.kill).toBeUndefined(); // ctx.kill is false → not armed by the client
  });

  // ADR-0015 T12: the memory consent tiers are server/CMP-derived, never the client's — and an
  // anonId-that-fails-validation must never be trusted as a vector-namespace component (Inv 2/8).
  it("ADR-0015 T12: consent.memoryOrdinary/memorySpecial are always 'unknown' and a bad anonId is dropped", () => {
    const out = deriveServingSignals(
      { consent: { memoryOrdinary: "in", memorySpecial: "in" }, anonId: "not-a-valid-anon-id!!" } as Signals,
      ctx,
    );
    expect(out.consent).toEqual({ email: "unknown", sms: "unknown", memoryOrdinary: "unknown", memorySpecial: "unknown" });
    expect(out.anonId).toBeUndefined(); // fails validateAnonId's charset/length bound — dropped, never thrown
  });

  it("ADR-0015 T12: a well-formed client-sent anonId IS accepted via validateAnonId", () => {
    const validId = generateGuestId();
    const out = deriveServingSignals({ anonId: validId } as Signals, ctx);
    expect(out.anonId).toBe(validId);
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
    const out = deriveServingSignals(undefined, { tenantId: "acme", kill: false, region: "eu", groundingMode: "general" });
    expect(out.tenantId).toBe("acme");
    expect(out.region).toBe("eu");
    expect(out.groundingMode).toBe("general");
  });
});
