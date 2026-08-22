import { describe, it, expect } from "vitest";
import { deriveServingSignals, classifyDevice } from "../src/signals.js";
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
  // WS-B3b adds "reengage" (dwell / idle_then_return) to the same whitelist — it reuses the exit-intent
  // rung's guardrails, so it is exactly as safe to accept from the client as "exit_intent" was.
  it("WS6/WS-B3b: accepts proactiveTrigger 'greeting'/'exit_intent'/'reengage', drops any other value", () => {
    expect(deriveServingSignals({ proactiveTrigger: "greeting" } as Signals, ctx).proactiveTrigger).toBe("greeting");
    expect(deriveServingSignals({ proactiveTrigger: "exit_intent" } as Signals, ctx).proactiveTrigger).toBe("exit_intent");
    expect(deriveServingSignals({ proactiveTrigger: "reengage" } as Signals, ctx).proactiveTrigger).toBe("reengage");
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

  // WS-B2b: ctx.relationship carries the server-computed lifecycle stage (deriveLifecycle, lifecycle.ts)
  // through to signals.relationship, winning over the old new/anonymous-only default.
  describe("WS-B2b: ctx.relationship (lifecycle)", () => {
    it("ctx.relationship='vip' wins over the old verified-shopper default of 'new'", () => {
      const out = deriveServingSignals(undefined, {
        ...ctx,
        shopperId: "shopify:acme:48291",
        shopperVerified: true,
        relationship: "vip",
      });
      expect(out.relationship).toBe("vip");
    });

    it("ctx.relationship absent ⇒ falls back to the old verified/anonymous default, byte-identical", () => {
      const verified = deriveServingSignals(undefined, {
        ...ctx,
        shopperId: "shopify:acme:48291",
        shopperVerified: true,
      });
      expect(verified.relationship).toBe("new");

      const anon = deriveServingSignals(undefined, ctx);
      expect(anon.relationship).toBe("anonymous");
    });

    it("a client-sent signals.relationship is still ignored even when ctx.relationship is absent", () => {
      const out = deriveServingSignals({ relationship: "vip" } as Signals, ctx);
      expect(out.relationship).toBe("anonymous");
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

  // WS-B4' — environment signals (device + entry), STYLE/FORMAT-ONLY (FAIR-1). device is SERVER-derived
  // (classifyDevice, from THIS request's own user-agent, via ctx — never the client body); entry is
  // accepted from the client, exactly like mood, validated against the closed Entry enum.
  describe("WS-B4': device (server-derived) + entry (client, enum-validated)", () => {
    it("classifyDevice: /ipad|tablet/i wins over mobile-like tokens, /mobi/i is mobile, else desktop", () => {
      expect(classifyDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
      expect(classifyDevice("Mozilla/5.0 (Linux; Android 13; SM-X200) Tablet")).toBe("tablet");
      expect(classifyDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148")).toBe("mobile");
      expect(classifyDevice("Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile")).toBe("mobile");
      expect(classifyDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("desktop");
      expect(classifyDevice(undefined)).toBe("desktop");
      expect(classifyDevice("")).toBe("desktop");
    });

    it("ctx.device (server-classified) is threaded straight into signals.device", () => {
      expect(deriveServingSignals(undefined, { ...ctx, device: "mobile" }).device).toBe("mobile");
      expect(deriveServingSignals(undefined, { ...ctx, device: "tablet" }).device).toBe("tablet");
      expect(deriveServingSignals(undefined, { ...ctx, device: "desktop" }).device).toBe("desktop");
    });

    it("no ctx.device ⇒ signals.device is omitted (key-omission discipline, byte-identical to before this field existed)", () => {
      const out = deriveServingSignals(undefined, ctx);
      expect(out.device).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(out, "device")).toBe(false);
    });

    it("a client-sent signals.device is IGNORED — only ctx.device (server-classified) is ever consulted", () => {
      const out = deriveServingSignals({ device: "mobile" } as Signals, { ...ctx, device: "desktop" });
      expect(out.device).toBe("desktop"); // ctx wins, not the client's claimed "mobile"
    });

    it("accepts a client-supplied entry only when it's a valid Entry enum value", () => {
      expect(deriveServingSignals({ entry: "ad" } as Signals, ctx).entry).toBe("ad");
      expect(deriveServingSignals({ entry: "organic" } as Signals, ctx).entry).toBe("organic");
      expect(deriveServingSignals({ entry: "direct" } as Signals, ctx).entry).toBe("direct");
      expect(deriveServingSignals({ entry: "email" } as Signals, ctx).entry).toBe("email");
      expect(deriveServingSignals({ entry: "social" } as Signals, ctx).entry).toBe("social");
    });

    it("drops an unknown/bogus entry rather than coercing or trusting it", () => {
      const out = deriveServingSignals({ entry: "referral-spam" as never } as Signals, ctx);
      expect(out.entry).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(out, "entry")).toBe(false);
    });

    it("no signals.entry sent at all ⇒ omitted", () => {
      expect(deriveServingSignals(undefined, ctx).entry).toBeUndefined();
    });
  });
});
