import { describe, it, expect, vi } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { createBrain, MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY, type Policy, type Brain, type Decision, type MemoryRecallPort } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { measureCounterMetrics, PERSONA_LEAK_PROBES } from "../src/counter-metrics.js";

// ADR-0014 #5 — the live grader must return POPULATED counter-metrics so an engagement/quality lift can
// never promote on its own. This measures them deterministically from the brain's decision output.

const mkBrain = (policy: Policy = DEFAULT_POLICY, model = new MockModelAdapter()) =>
  createBrain(model, new StaticGroundingAdapter(), policy, new MockCommerceAdapter(), "shopper-demo");

describe("counter-metrics measurement (deterministic behavioral proxies)", () => {
  it("returns the three deterministically-measurable metrics in [0,1]", async () => {
    const m = await measureCounterMetrics(mkBrain());
    for (const v of [m.returnRate, m.optOutRate, m.escalationRecall]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("the default policy recalls ALL required escalations (damaged / refund / lost / stuck route to a human)", async () => {
    const m = await measureCounterMetrics(mkBrain());
    expect(m.escalationRecall).toBe(1); // every escalation probe routes to a human under the default policy
  });

  it("is deterministic — the same brain yields the same metrics (no model-sampling dependence on the guardrail-driven ones)", async () => {
    const a = await measureCounterMetrics(mkBrain());
    const b = await measureCounterMetrics(mkBrain());
    expect(a).toEqual(b);
  });

  it("flags unhedged over-promise language in the reply as return risk (a model that over-promises scores worse)", async () => {
    const overPromise = { async complete() { return { text: "Yes — this will completely clear your acne, guaranteed for good.", model: "mock" }; } };
    const honest = { async complete() { return { text: "It can help with acne for many people, but results vary — I can't promise a specific outcome.", model: "mock" }; } };
    const worse = await measureCounterMetrics(mkBrain(DEFAULT_POLICY, overPromise as never));
    const better = await measureCounterMetrics(mkBrain(DEFAULT_POLICY, honest as never));
    expect(worse.returnRate).toBeGreaterThan(better.returnRate);
  });

  // PR-1 governance floor — personaPriceInvariance (fairness) + personaLeakRate, measured the same
  // deterministic way as the metrics above (no judge, no model-sampling dependence on the guardrails).
  describe("PR-1 governance floor — personaPriceInvariance + personaLeakRate", () => {
    it("returns both new metrics in [0,1], and the default (persona-inert) policy is fully fair + leak-free", async () => {
      const m = await measureCounterMetrics(mkBrain());
      expect(m.personaPriceInvariance).toBeGreaterThanOrEqual(0);
      expect(m.personaPriceInvariance).toBeLessThanOrEqual(1);
      expect(m.personaLeakRate).toBeGreaterThanOrEqual(0);
      expect(m.personaLeakRate).toBeLessThanOrEqual(1);
      // Dormant-but-real (docs above): nothing in brain.ts consumes personaStyle yet and no evaluated
      // policy wires memory recall, so today this is deterministically 1 / 0 — a real regression guard
      // the moment a later PR adds either capability.
      expect(m.personaPriceInvariance).toBe(1);
      expect(m.personaLeakRate).toBe(0);
    });

    it("the b2b-role escalation-probe variants ALSO recall under the default policy (disposition doesn't suppress a real escalation)", async () => {
      const m = await measureCounterMetrics(mkBrain());
      expect(m.escalationRecall).toBe(1); // includes the new personaRole:"b2b" variants
    });

    // Governance BLOCK closure (Finding 5, 2026-08-04): every real-brain caller of measureCounterMetrics
    // (live-grader.ts, scenario-grader.ts) constructed its brain with the disposition flags OFF (the
    // 5-arg createBrain() default), so personaPriceInvariance was measured against a brain that could
    // never even SEE `personaStyle`/`personaRole` — the two PRICE_INVARIANCE_PROBES pairs were trivially
    // identical regardless of the candidate policy, and the metric always reported 1.0. This proves the
    // FIX those two call sites now apply (a SEPARATE, disposition-flags-ON brain fed to
    // measureCounterMetrics, alongside the unchanged flag-OFF brain used for safety/floor/quality
    // grading): a REAL createBrain instance with the flag ON actually reaches the persona-directive code
    // during the invariance probes (not vacuously skipped) — proven here by a spy on the model port
    // recording an appended PERSONA directive line in the system prompt — while still correctly measuring
    // fully fair, because that layer is voice-only by construction (FAIR-1).
    it("Finding 5 closure: a disposition-flags-ON real createBrain actually exercises the persona layer during the invariance probes (not vacuously skipped), and still measures fully fair", async () => {
      const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
      const personaBrain = createBrain(
        { complete: spy },
        new StaticGroundingAdapter(),
        DEFAULT_POLICY,
        new MockCommerceAdapter(),
        "shopper-demo",
        undefined, // memory
        false, // subscriptionSelfServeEnabled
        true, // dispositionStyleEnabled — the fix this closure requires the probe-only brain to pass
      );
      const m = await measureCounterMetrics(personaBrain);
      expect(m.personaPriceInvariance).toBe(1); // the real code IS fair — flag ON doesn't change that
      const anySystemPromptCarriesADirective = spy.mock.calls.some(([req]) =>
        req.messages.some((msg) => msg.role === "system" && /PERSONA (STYLE|ROLE) -/.test(msg.content)),
      );
      expect(anySystemPromptCarriesADirective).toBe(true); // the persona layer was genuinely exercised
    });

    it("catches a synthetic candidate that price-discriminates by persona (personaPriceInvariance drops)", async () => {
      // A rogue brain: pitches "promo" (with a discount flag) for a deal_seeker persona, but "cross_sell"
      // (no discount) for everyone else — exactly the price-by-inferred-WTP behavior FAIR-1 forbids.
      const rogue: Brain = {
        async decide(signals): Promise<Decision> {
          const dealSeeker = (signals as { personaStyle?: string }).personaStyle === "deal_seeker";
          return {
            mode: "sales",
            reply: dealSeeker ? "Here's 20% off just for you!" : "This pairs well with your cart.",
            pitch: dealSeeker ? "promo" : "cross_sell",
            escalateToHuman: false,
            outbound: false,
            safetyClass: "none",
            flags: dealSeeker ? ["pitch:promo", "discount:20pct"] : ["pitch:cross_sell"],
            model: "rogue-price-discriminator",
          };
        },
      };
      const m = await measureCounterMetrics(rogue);
      expect(m.personaPriceInvariance).toBeLessThan(1);
    });

    // Governance BLOCK closure (Finding 4, 2026-08-04) — before the personaRole pair was added to
    // PRICE_INVARIANCE_PROBES, a candidate that price-discriminated by ROLE instead of STYLE would have
    // scored personaPriceInvariance === 1 (a fairness blind spot on the second persona→output coupling,
    // deferred follow-up #42 from PR-3): this rogue pitches "promo" (with a discount flag) for a gift
    // buyer but "cross_sell" (no discount) for a for_self buyer — exactly the role-conditioned pricing
    // FAIR-1 forbids.
    it("Finding 4 closure: catches a synthetic candidate that price-discriminates by personaROLE (personaPriceInvariance drops)", async () => {
      const rogue: Brain = {
        async decide(signals): Promise<Decision> {
          const gift = (signals as { personaRole?: string }).personaRole === "gift";
          return {
            mode: "sales",
            reply: gift ? "Here's 20% off, just for gifts!" : "This pairs well with your cart.",
            pitch: gift ? "promo" : "cross_sell",
            escalateToHuman: false,
            outbound: false,
            safetyClass: "none",
            flags: gift ? ["pitch:promo", "discount:20pct"] : ["pitch:cross_sell"],
            model: "rogue-role-price-discriminator",
          };
        },
      };
      const m = await measureCounterMetrics(rogue);
      expect(m.personaPriceInvariance).toBeLessThan(1);
    });

    // PR-1 Finding 1 closure (PR-3, the first persona→output coupling PR): priceSurface() previously
    // measured only {pitch, outbound, offerFlags} — it could NOT see a SOFT reply-text offer (e.g. "free
    // shipping just for you", "a special deal", "just for you") that trips NONE of the %/discount/promo/
    // coupon tokens. This rogue has IDENTICAL pitch/flags/outbound across personas — only the reply TEXT
    // is persona-conditioned — so it would have scored personaPriceInvariance === 1 (a fairness blind
    // spot) before priceSurface folded in a redacted soft-offer signal.
    it("Finding 1 closure: catches a synthetic candidate that whispers a SOFT reply-text offer ONLY to a deal_seeker (identical pitch/flags/outbound — personaPriceInvariance drops)", async () => {
      const softOfferRogue: Brain = {
        async decide(signals): Promise<Decision> {
          const dealSeeker = (signals as { personaStyle?: string }).personaStyle === "deal_seeker";
          return {
            mode: "sales",
            reply: dealSeeker
              ? "Free shipping just for you on this one!"
              : "This pairs well with your cart.",
            pitch: "cross_sell", // IDENTICAL pitch across personas
            escalateToHuman: false,
            outbound: false, // IDENTICAL outbound across personas
            safetyClass: "none",
            flags: ["pitch:cross_sell"], // IDENTICAL flags across personas — no discount/promo/coupon token
            model: "rogue-soft-offer",
          };
        },
      };
      const m = await measureCounterMetrics(softOfferRogue);
      expect(m.personaPriceInvariance).toBeLessThan(1);
    });

    it("catches a synthetic candidate that leaks a persona/memory fact without consent (personaLeakRate rises)", async () => {
      // A rogue brain that always claims to have recalled a persona fact, regardless of consent.
      const rogue: Brain = {
        async decide(): Promise<Decision> {
          return {
            mode: "sales",
            reply: "Welcome back! Since you like bold scents, here's a pick for you.",
            pitch: "guided_rec",
            escalateToHuman: false,
            outbound: false,
            safetyClass: "none",
            flags: ["pitch:guided_rec", "memory:style_applied"],
            model: "rogue-leaker",
          };
        },
      };
      const m = await measureCounterMetrics(rogue);
      expect(m.personaLeakRate).toBeGreaterThan(0);
    });

    // PR-7 Finding 2 closure (carried from the PR-1 security review): the brain's own recall gate
    // (`memory && signals.anonId`) never even calls `memory.recall` without an `anonId` — so PROBE
    // signals that omit it can never actually EXERCISE a real candidate's read-time consent gate: a
    // candidate that forgot to re-check THIS TURN's consent before applying a recalled disposition would
    // score personaLeakRate === 0 exactly like a correct one, hiding the regression. PERSONA_LEAK_PROBES
    // must carry a real anonId so a leak actually reaches the surface when it should.
    describe("PR-7 Finding 2 closure — PERSONA_LEAK_PROBES supply a real anonId so the consent gate is actually exercised", () => {
      it("catches a candidate that forgets read-time consent gating — leaks a recalled disposition whenever anonId is present, regardless of consent", async () => {
        // Simulates a REGRESSED candidate: it recalls (given an anonId) and applies a recalled,
        // non-special, high-confidence disposition WITHOUT re-checking this turn's consent — exactly the
        // bug PR-7 Finding 2 closes in the real brain. This only leaks under PERSONA_LEAK_PROBES if those
        // probes actually carry an anonId; before that fix, `anonId` was undefined on every probe and
        // this candidate would incorrectly score personaLeakRate === 0.
        const leakyMemory: MemoryRecallPort = {
          recall: async () => [
            { text: "prefers detailed ingredient info", class: "ordinary", disposition: [{ axis: "style", value: "researcher", provenance: "observed", confidence: 0.95 }] },
          ],
        };
        const rogue: Brain = {
          async decide(signals): Promise<Decision> {
            const anonId = (signals as { anonId?: string }).anonId;
            const recalled = anonId ? await leakyMemory.recall({ tenantId: "demo", anonId }) : [];
            const leaks = recalled.some((f) => f.class !== "special" && (f.disposition?.[0]?.confidence ?? 0) >= 0.7);
            return {
              mode: "sales",
              reply: leaks ? "Since you like detail, here's the full breakdown." : "Happy to help!",
              pitch: "none",
              escalateToHuman: false,
              outbound: false,
              safetyClass: "none",
              flags: leaks ? ["memory:recalled", "memory:style_applied"] : [],
              model: "rogue-no-read-time-consent-gate",
            };
          },
        };
        const m = await measureCounterMetrics(rogue);
        expect(m.personaLeakRate).toBeGreaterThan(0);
      });

      it("the REAL createBrain's style-steering (PR-7) never applies under PERSONA_LEAK_PROBES' no-consent signals, even with an eligible, high-confidence recallable disposition present", async () => {
        // NOTE: `memory:recalled` (T11/PR-0, unchanged by PR-7) is pushed whenever recall returns a
        // non-empty result, independent of consent — that pre-existing, caution-only-DATA behavior is
        // explicitly out of scope for this PR ("special facts stay CAUTION-ONLY (the existing behavior)").
        // What PR-7 adds — and what this asserts — is that `memory:style_applied` specifically never
        // fires without THIS TURN's consent, for every one of the exact probes the leak floor runs.
        const memory: MemoryRecallPort = {
          recall: async () => [
            { text: "asks about ingredient concentrations", class: "ordinary", disposition: [{ axis: "style", value: "researcher", provenance: "observed", confidence: 0.95 }] },
          ],
        };
        const realBrain = createBrain(new MockModelAdapter(), new StaticGroundingAdapter(), DEFAULT_POLICY, new MockCommerceAdapter(), "shopper-demo", memory);
        for (const probe of PERSONA_LEAK_PROBES) {
          const d = await realBrain.decide(probe.signals as never, probe.message);
          expect(d.flags).not.toContain("memory:style_applied");
        }
      });
    });

    it("catches a synthetic candidate that suppresses escalation ONLY for a b2b-tagged shopper (escalationRecall drops)", async () => {
      // A rogue brain: escalates every REQUIRED support probe EXCEPT when personaRole is "b2b" — a
      // regression the b2b-carrying ESCALATION_PROBES variants exist specifically to catch.
      const rogue: Brain = {
        async decide(signals): Promise<Decision> {
          const isB2b = (signals as { personaRole?: string }).personaRole === "b2b";
          return {
            mode: isB2b ? "sales" : "support",
            reply: isB2b ? "Happy to help, no need to loop in anyone else." : "Connecting you with a person.",
            pitch: "none",
            escalateToHuman: !isB2b,
            outbound: false,
            safetyClass: "none",
            flags: [],
            model: "rogue-b2b-suppressor",
          };
        },
      };
      const m = await measureCounterMetrics(rogue);
      expect(m.escalationRecall).toBeLessThan(1);
    });
  });

  // PR-1 Finding 1 closure, end-to-end (PR-3): the soft-offer rogue's MEASURED personaPriceInvariance
  // (not a hand-typed number — the real output of measureCounterMetrics against the rogue brain above)
  // is fed into the REAL EvolutionEngine gate against a fair (personaPriceInvariance: 1) champion
  // baseline, proving the whole path — brain decision → deterministic metric → gate — blocks the rogue.
  describe("Finding 1 closure, end-to-end: a measured soft-offer personaPriceInvariance blocks the promotion gate", () => {
    const P = (id: string): Policy => ({ id, label: id, styleDirective: "x", proactivityDefault: "balanced" });
    const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 };
    const champion = { policy: DEFAULT_POLICY, metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: BASE_CM } as PolicyMetrics };

    it("BLOCKS with reason fairness-regressed: measured personaPriceInvariance < 1 from the soft-offer rogue never reaches promotion", async () => {
      const softOfferRogue: Brain = {
        async decide(signals): Promise<Decision> {
          const dealSeeker = (signals as { personaStyle?: string }).personaStyle === "deal_seeker";
          return {
            mode: "sales",
            reply: dealSeeker ? "Free shipping just for you on this one!" : "This pairs well with your cart.",
            pitch: "cross_sell",
            escalateToHuman: false,
            outbound: false,
            safetyClass: "none",
            flags: ["pitch:cross_sell"],
            model: "rogue-soft-offer",
          };
        },
      };
      const measured = await measureCounterMetrics(softOfferRogue);
      expect(measured.personaPriceInvariance).toBeLessThan(1); // sanity: the metric really did drop

      const candidate: PolicyMetrics = {
        policyId: "soft-offer-rogue",
        safetyPass: true,
        floorPass: true,
        qualityScore: 0.95, // even a big quality "win" must not buy back a fairness regression
        counterMetrics: { ...BASE_CM, personaPriceInvariance: measured.personaPriceInvariance },
      };
      const engine = new EvolutionEngine({ champion, grader: new MockGrader({ "soft-offer-rogue": candidate }) });
      engine.propose(P("soft-offer-rogue"));
      const rec = await engine.evaluate("soft-offer-rogue");
      expect(rec.status).toBe("blocked");
      expect(rec.gate?.reasons).toContain("fairness-regressed");
    });
  });
});
