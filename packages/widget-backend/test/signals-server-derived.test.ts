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

  // WS6: proactiveTrigger is a non-trust-bearing UI enum — accepted for the two known values, anything
  // else (a made-up trigger trying to reach a different rung) is dropped to undefined.
  it("WS6: accepts proactiveTrigger 'greeting'/'exit_intent', drops any other value", () => {
    expect(deriveServingSignals({ proactiveTrigger: "greeting" } as Signals, ctx).proactiveTrigger).toBe("greeting");
    expect(deriveServingSignals({ proactiveTrigger: "exit_intent" } as Signals, ctx).proactiveTrigger).toBe("exit_intent");
    expect(deriveServingSignals({ proactiveTrigger: "buy_now" } as unknown as Signals, ctx).proactiveTrigger).toBeUndefined();
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

  it("ADR-0019 task 4 (invariant 4): a client-sent anonId is IGNORED — the subject is ctx.memorySubject ONLY", () => {
    const validId = generateGuestId();
    // Client sends a well-formed anonId but there is no server-derived subject → it is NOT accepted.
    // (Superseded ADR-0015 T12, which accepted the client value via validateAnonId — that fallback was the
    // F1 hole the tasks-4/9 review caught; the guest subject now comes only from a verified x-guest-token,
    // surfaced here as `ctx.memorySubject`.)
    expect(deriveServingSignals({ anonId: validId } as Signals, ctx).anonId).toBeUndefined();
    // When the server HAS derived a subject, that — and only that — is used, regardless of the client value.
    expect(deriveServingSignals({ anonId: validId } as Signals, { ...ctx, memorySubject: "acct:demo:1" }).anonId).toBe("acct:demo:1");
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

  // ADR-0017 T5: shopperId + relationship are server-derived from ctx, never the client.
  describe("ADR-0017: shopperId + relationship", () => {
    it("a client-sent shopperId/relationship is dropped — anonymous ctx ⇒ anonymous relationship, no shopperId", () => {
      const out = deriveServingSignals({ shopperId: "evil-injected-id", relationship: "vip" } as Signals, ctx);
      expect(out.shopperId).toBeUndefined();
      expect(out.relationship).toBe("anonymous");
    });

    it("a verified ctx shopperId ⇒ relationship 'new' (never vip/subscriber — ADR-0015 Tier 2 territory)", () => {
      const out = deriveServingSignals(
        { shopperId: "evil-injected-id", relationship: "vip" } as Signals,
        { ...ctx, shopperId: "shopify:acme:48291", shopperVerified: true },
      );
      expect(out.shopperId).toBe("shopify:acme:48291"); // from ctx, never the client's "evil-injected-id"
      expect(out.relationship).toBe("new");
    });

    it("shopperId present but NOT verified ⇒ treated as anonymous (defense in depth)", () => {
      const out = deriveServingSignals(undefined, { ...ctx, shopperId: "shopify:acme:48291", shopperVerified: false });
      expect(out.relationship).toBe("anonymous");
      expect(out.shopperId).toBeUndefined(); // the id is gated on `verified` too — never keys ownership unverified
    });
  });

  // PR-11a (ADR-0015 T12) — ctx.consent is the server's OWN consent-store lookup result, threaded in by
  // the caller (server.ts, BEFORE this function runs). This closes the old hardcode: memoryOrdinary/
  // memorySpecial now reflect ctx.consent when the caller supplies it, and still fail closed to
  // "unknown"/"unknown" when it doesn't (byte-identical default to before this field existed).
  describe("PR-11a: ctx.consent (server-looked-up memory consent)", () => {
    it("no ctx.consent supplied ⇒ still fails closed to unknown/unknown (unchanged default)", () => {
      const out = deriveServingSignals(undefined, ctx);
      expect(out.consent).toEqual({ email: "unknown", sms: "unknown", memoryOrdinary: "unknown", memorySpecial: "unknown" });
    });

    it("ctx.consent is threaded straight into signals.consent.memoryOrdinary/memorySpecial", () => {
      const out = deriveServingSignals(undefined, { ...ctx, consent: { memoryOrdinary: "in", memorySpecial: "out" } });
      expect(out.consent).toEqual({ email: "unknown", sms: "unknown", memoryOrdinary: "in", memorySpecial: "out" });
    });

    it("the client's OWN signals.consent is still ignored — only ctx.consent (server lookup) is consulted", () => {
      const out = deriveServingSignals(
        { consent: { memoryOrdinary: "in", memorySpecial: "in" } } as Signals,
        { ...ctx, consent: { memoryOrdinary: "out", memorySpecial: "unknown" } },
      );
      // The server's ctx.consent ("out"/"unknown") wins — NOT the client's claimed "in"/"in".
      expect(out.consent).toEqual({ email: "unknown", sms: "unknown", memoryOrdinary: "out", memorySpecial: "unknown" });
    });
  });
});
