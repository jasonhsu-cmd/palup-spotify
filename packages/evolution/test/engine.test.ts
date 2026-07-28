import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "../src/index.js";

const champion = {
  policy: DEFAULT_POLICY,
  metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75 } as PolicyMetrics,
};

const P = (id: string): Policy => ({ id, label: id, styleDirective: "x", proactivityDefault: "balanced" });

function engineWith(scores: Record<string, PolicyMetrics>) {
  return new EvolutionEngine({ champion, grader: new MockGrader(scores) });
}

describe("EvolutionEngine gate", () => {
  it("gates PASS a safe, improved candidate -> awaiting_approval", async () => {
    const e = engineWith({ good: { policyId: "good", safetyPass: true, floorPass: true, qualityScore: 0.9 } });
    e.propose(P("good"));
    const rec = await e.evaluate("good");
    expect(rec.status).toBe("awaiting_approval");
    expect(rec.gate?.pass).toBe(true);
  });

  it("BLOCKS a candidate that regresses quality", async () => {
    const e = engineWith({ worse: { policyId: "worse", safetyPass: true, floorPass: true, qualityScore: 0.6 } });
    e.propose(P("worse"));
    const rec = await e.evaluate("worse");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("quality-regressed");
  });

  it("BLOCKS on a safety-floor failure regardless of quality (hard gate)", async () => {
    const e = engineWith({ unsafe: { policyId: "unsafe", safetyPass: false, floorPass: true, qualityScore: 0.99 } });
    e.propose(P("unsafe"));
    const rec = await e.evaluate("unsafe");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("safety-floor-failed");
  });

  it("BLOCKS when counter-metrics (returns/complaints) worsen", async () => {
    const e = engineWith({
      pushy: { policyId: "pushy", safetyPass: true, floorPass: true, qualityScore: 0.95, counterMetrics: { returnRate: 0.2 } },
    });
    e.propose(P("pushy"));
    const rec = await e.evaluate("pushy");
    expect(rec.status).toBe("blocked");
    expect(rec.gate?.reasons).toContain("counter-metrics-worsened");
  });
});

describe("EvolutionEngine governance", () => {
  it("cannot promote without a human approval (no self-promotion)", async () => {
    const e = engineWith({ good: { policyId: "good", safetyPass: true, floorPass: true, qualityScore: 0.9 } });
    e.propose(P("good"));
    await e.evaluate("good");
    expect(() => e.promote("good")).toThrow(/needs human approval/);
    e.approve("good");
    const champ = e.promote("good");
    expect(champ.policy.id).toBe("good");
  });

  it("kill switch halts approvals and promotions", async () => {
    const e = engineWith({ good: { policyId: "good", safetyPass: true, floorPass: true, qualityScore: 0.9 } });
    e.propose(P("good"));
    await e.evaluate("good");
    e.kill("test");
    expect(() => e.approve("good")).toThrow(/kill switch/i);
  });

  it("auto-rolls back on a post-promotion regression", async () => {
    const e = engineWith({ good: { policyId: "good", safetyPass: true, floorPass: true, qualityScore: 0.9 } });
    e.propose(P("good"));
    await e.evaluate("good");
    e.approve("good");
    e.promote("good");
    expect(e.getChampion().policy.id).toBe("good");
    const r = e.monitor({ qualityScore: 0.5, safetyPass: true }); // below the prev champion's 0.75
    expect(r.rolledBack).toBe(true);
    expect(e.getChampion().policy.id).toBe(DEFAULT_POLICY.id);
  });

  it("audits every action", async () => {
    const e = engineWith({ good: { policyId: "good", safetyPass: true, floorPass: true, qualityScore: 0.9 } });
    e.propose(P("good"));
    await e.evaluate("good");
    e.approve("good");
    e.promote("good");
    const actions = e.getAudit().map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["init", "propose", "gate_pass", "approve", "promote"]));
  });
});
