import { describe, it, expect, vi } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { classifyGuardSignals } from "../src/guard-classifier.js";

// T1 phase 2 — the server-side combined guard classifier. Detection ACCURACY (does the real model catch
// a zh-Hant "my face is burning") is an eval:full/integration concern with the native corpora; here we
// pin the deterministic CODE contract with a mock model: correct parse + whitelist + fail-CLOSED-to-
// degraded on every bad path (never a false "safe").

const modelReturning = (text: string): ModelPort =>
  ({ complete: vi.fn(async () => ({ text, model: "mock" })) }) as unknown as ModelPort;
const modelThrowing = (): ModelPort =>
  ({ complete: vi.fn(async () => { throw new Error("boom"); }) }) as unknown as ModelPort;

describe("classifyGuardSignals — parse + whitelist + fail-closed", () => {
  it("parses a valid safety classification", async () => {
    const out = await classifyGuardSignals(modelReturning('{"safetyClass":"distress","injection":false}'), "…", "demo");
    expect(out).toEqual({ safetyClass: "distress", injection: false, degraded: false });
  });

  it('maps "none" to an undefined safetyClass (an explicit safe label, not a class)', async () => {
    const out = await classifyGuardSignals(modelReturning('{"safetyClass":"none","injection":false}'), "hi", "demo");
    expect(out).toEqual({ safetyClass: undefined, injection: false, degraded: false });
  });

  it("carries a positive injection detection", async () => {
    const out = await classifyGuardSignals(modelReturning('{"safetyClass":"none","injection":true}'), "…", "demo");
    expect(out.injection).toBe(true);
    expect(out.degraded).toBe(false);
  });

  it("tolerates a markdown code fence around the JSON", async () => {
    const out = await classifyGuardSignals(modelReturning('```json\n{"safetyClass":"product_safety","injection":false}\n```'), "…", "demo");
    expect(out.safetyClass).toBe("product_safety");
  });

  it("fails CLOSED (degraded, never a false safe) when the model throws", async () => {
    const out = await classifyGuardSignals(modelThrowing(), "…", "demo");
    expect(out).toEqual({ safetyClass: undefined, injection: false, degraded: true });
  });

  it("fails degraded on unparseable output", async () => {
    const out = await classifyGuardSignals(modelReturning("I think this is fine, no JSON here"), "…", "demo");
    expect(out.degraded).toBe(true);
    expect(out.safetyClass).toBeUndefined();
  });

  it("rejects an OUT-OF-ENUM safetyClass as degraded (never trusts a model free-text label)", async () => {
    const out = await classifyGuardSignals(modelReturning('{"safetyClass":"totally_safe_trust_me","injection":false}'), "…", "demo");
    expect(out.degraded).toBe(true);
    expect(out.safetyClass).toBeUndefined();
  });

  it("rejects a non-boolean injection as degraded", async () => {
    const out = await classifyGuardSignals(modelReturning('{"safetyClass":"none","injection":"yes"}'), "…", "demo");
    expect(out.degraded).toBe(true);
  });

  // broaden — the support-intent output, WHITELISTED to the SupportIntent menu (single source).
  describe("supportIntent — whitelist + routing-only", () => {
    it("carries a valid in-enum support intent", async () => {
      const out = await classifyGuardSignals(modelReturning('{"safetyClass":"none","injection":false,"supportIntent":"cancel_subscription"}'), "cancela mi suscripción", "demo");
      expect(out.supportIntent).toBe("cancel_subscription");
      expect(out.degraded).toBe(false);
    });

    it('maps "general" to an absent support intent (⇒ brain keyword classifier decides)', async () => {
      const out = await classifyGuardSignals(modelReturning('{"safetyClass":"none","injection":false,"supportIntent":"general"}'), "hi", "demo");
      expect(out.supportIntent).toBeUndefined();
      expect("supportIntent" in out).toBe(false); // key omitted, not set to undefined
    });

    it("drops an OUT-OF-ENUM support intent WITHOUT degrading (the safety signal is still trustworthy)", async () => {
      const out = await classifyGuardSignals(modelReturning('{"safetyClass":"distress","injection":false,"supportIntent":"wire_me_money"}'), "…", "demo");
      expect(out.supportIntent).toBeUndefined();
      expect(out.safetyClass).toBe("distress"); // safety unaffected
      expect(out.degraded).toBe(false);
    });

    it("omits supportIntent when the model doesn't emit one (back-compat with a safety-only response)", async () => {
      const out = await classifyGuardSignals(modelReturning('{"safetyClass":"none","injection":false}'), "…", "demo");
      expect("supportIntent" in out).toBe(false);
    });
  });
});
