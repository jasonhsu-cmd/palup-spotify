import { describe, it, expect, vi } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { createBrain, DEFAULT_POLICY, StaticGroundingAdapter, MockCommerceAdapter } from "../src/index.js";
import { worstSafety } from "../src/safety.js";

// T1 phase 1 — the server-derived guardrail-signal CONTRACT. When the SERVER_GUARD_SIGNALS flag is ON, a
// server-derived semantic signal (serverSafetyClass / serverInjection) RE-ENTERS the SAME deterministic
// guardrail branches the English keyword ladder uses — so every guarantee comes back for free: mode:safety,
// escalate, no_pitch, the safety:* audit flag, the injection block, and a string-literal reply (no model
// call). Flag OFF ⇒ the fields are IGNORED and behaviour is byte-identical to today. The real classifier
// that POPULATES these fields is T1 phase 2; here the signal is injected directly to pin the contract
// deterministically. (createBrain is positional — the flag is the 17th/last arg.)

function spyBrain(serverGuardSignalsEnabled = false) {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  const brain = createBrain(
    { complete: spy },
    new StaticGroundingAdapter(),
    DEFAULT_POLICY,
    new MockCommerceAdapter(),
    "shopper-demo",
    undefined, // memory
    false, // subscriptionSelfServeEnabled
    false, // dispositionStyleEnabled
    false, // dispositionBehavioralEnabled
    false, // dispositionClassifierEnabled
    undefined, // catalogRetriever
    false, // catalogRetrievalEnabled
    undefined, // catalogRetrievalK
    false, // productCitationsEnabled
    false, // productCardsEnabled
    false, // cartLineItemsEnabled
    serverGuardSignalsEnabled,
  );
  return { brain, spy };
}

// Carries NO English safety/injection keyword, so the keyword ladder classifies it "none" — any guardrail
// behaviour here can ONLY come from the server signal.
const BENIGN = "what should i get for dull skin?";

describe("worstSafety — most-conservative-wins merge (only ever raises)", () => {
  it("returns the keyword class unchanged when there is no server signal (inert / byte-identical)", () => {
    expect(worstSafety("none", undefined)).toBe("none");
    expect(worstSafety("product_safety", undefined)).toBe("product_safety");
  });
  it("raises 'none' to a server-detected class", () => {
    expect(worstSafety("none", "distress")).toBe("distress");
  });
  it("picks the MORE severe when the two disagree, and never lowers", () => {
    expect(worstSafety("abuse", "distress")).toBe("distress"); // server more severe -> raise
    expect(worstSafety("distress", "none")).toBe("distress"); // server 'none' never lowers a real class
    expect(worstSafety("product_safety", "abuse")).toBe("product_safety"); // keyword floor higher -> kept
  });
});

describe("T1 contract — server signal re-enters the guardrail branches (flag ON)", () => {
  it("serverSafetyClass on a benign message enters the SAFETY branch with every guarantee", async () => {
    const { brain, spy } = spyBrain(true);
    const d = await brain.decide({ serverSafetyClass: "distress" }, BENIGN);
    expect(d.mode).toBe("safety");
    expect(d.safetyClass).toBe("distress");
    expect(d.escalateToHuman).toBe(true);
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("safety:distress");
    expect(d.flags).toContain("no_pitch");
    expect(d.model).toBe("guardrail"); // string-literal reply — no model.complete reached on the safety path
    expect(spy).not.toHaveBeenCalled();
  });

  it("serverInjection on a benign message enters the INJECTION branch", async () => {
    const { brain } = spyBrain(true);
    const d = await brain.decide({ serverInjection: true }, BENIGN);
    expect(d.flags).toContain("injection_blocked");
    expect(d.safetyClass).toBe("injection");
    expect(d.pitch).toBe("none");
  });

  it("keeps SAFETY outranking INJECTION when both signals are present", async () => {
    const { brain } = spyBrain(true);
    const d = await brain.decide({ serverSafetyClass: "product_safety", serverInjection: true }, BENIGN);
    expect(d.mode).toBe("safety"); // safety rung is checked before injection
    expect(d.safetyClass).toBe("product_safety");
  });
});

describe("T1 flag OFF — server signals are ignored (byte-identical to today)", () => {
  it("does NOT enter a guardrail branch even with both server signals set", async () => {
    const { brain } = spyBrain(false);
    const d = await brain.decide({ serverSafetyClass: "distress", serverInjection: true }, BENIGN);
    expect(d.mode).not.toBe("safety");
    expect(d.safetyClass).not.toBe("distress");
    expect(d.flags).not.toContain("safety:distress");
    expect(d.flags).not.toContain("injection_blocked");
  });
});
