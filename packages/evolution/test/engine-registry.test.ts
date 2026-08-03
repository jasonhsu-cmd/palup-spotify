import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY } from "@palup/widget-brain";
import { EngineRegistry, EvolutionEngine, MockGrader, type PolicyMetrics } from "../src/index.js";

// ADR-0014 #4 — per-tenant engine binding. The EvolutionEngine holds a tenant's in-memory evolution
// state (champion, candidates, audit). The auto-optimize orchestrator (T4) must operate on the engine
// that governs THIS tenant — champion-promoter's H3 precondition. A single global engine bound to one
// demo tenant made H3 comment-only; the registry makes it structural: exactly one engine per tenant,
// so a proposal/promotion for tenant A can never touch tenant B's engine state.

const CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };
const metrics = (id: string): PolicyMetrics => ({ policyId: id, safetyPass: true, floorPass: true, qualityScore: 0.7, counterMetrics: CM });
const mkEngine = () => new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: metrics(DEFAULT_POLICY.id) }, grader: new MockGrader({}) });

describe("EngineRegistry — per-tenant engine binding (one engine per tenant, blast-radius isolated)", () => {
  it("returns a STABLE engine per tenant and a DISTINCT one across tenants", () => {
    let made = 0;
    const reg = new EngineRegistry(() => { made++; return mkEngine(); });
    const a1 = reg.engineFor("a");
    const a2 = reg.engineFor("a");
    const b = reg.engineFor("b");
    expect(a1).toBe(a2); // same instance for the same tenant → state persists across calls
    expect(a1).not.toBe(b); // different tenant → different engine
    expect(made).toBe(2); // factory called once per tenant, not once per call
  });

  it("state on tenant A's engine never appears on tenant B's engine (blast radius)", () => {
    const reg = new EngineRegistry(() => mkEngine());
    reg.engineFor("a").propose({ id: "cand-a", label: "a", styleDirective: "voice-a", proactivityDefault: "balanced" });
    expect(reg.engineFor("a").getCandidate("cand-a")).toBeTruthy();
    expect(reg.engineFor("b").getCandidate("cand-a")).toBeUndefined(); // B's engine is clean
  });

  it("requires a non-empty tenantId (fail-closed — no ambient/default tenant)", () => {
    const reg = new EngineRegistry(() => mkEngine());
    expect(() => reg.engineFor("")).toThrow(/tenantId/i);
  });
});
