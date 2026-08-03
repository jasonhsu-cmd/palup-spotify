import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { AUDIT_GENESIS_HASH } from "@palup/platform-ports";
import { EvolutionEngine, MockGrader, verifyAuditChain, type PolicyMetrics } from "../src/index.js";

// Tamper-evident, hash-chained stage audit for the evolution pipeline.
// Spec: docs/AGENT-GOVERNANCE.md §3 (immutable audit, no silent transitions) +
// docs/design/governance-subsystems.md §6 (append-only, hash-chained event_hash + prev_hash).
// Mirrors the runtime-state audit chain (packages/platform-ports RuntimeStatePort.verifyAudit).

const champion = {
  policy: DEFAULT_POLICY,
  metrics: { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 } } as PolicyMetrics,
};

const P = (id: string): Policy => ({ id, label: id, styleDirective: "x", proactivityDefault: "balanced" });

async function runToPromotion(): Promise<EvolutionEngine> {
  const e = new EvolutionEngine({
    champion,
    grader: new MockGrader({ good: { policyId: "good", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { returnRate: 0.06, complaintRate: 0.02, optOutRate: 0.08, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 } } }),
  });
  e.propose(P("good"));
  await e.evaluate("good");
  e.approve("good");
  e.promote("good");
  return e;
}

describe("EvolutionEngine audit hash-chain (tamper-evident — docs/AGENT-GOVERNANCE.md §3)", () => {
  it("verifies over a real propose -> gate -> approve -> promote run", async () => {
    const e = await runToPromotion();
    const entries = e.getAudit();
    expect(entries.map((a) => a.action)).toEqual(
      expect.arrayContaining(["init", "propose", "gate_pass", "approve", "promote"]),
    );
    expect(verifyAuditChain(entries).ok).toBe(true);
    expect(e.verifyAudit().ok).toBe(true); // engine self-verify agrees
  });

  it("uses the documented genesis sentinel for the first entry and links every subsequent prevHash", async () => {
    const e = await runToPromotion();
    const entries = e.getAudit();
    expect(AUDIT_GENESIS_HASH).toBe("0".repeat(64)); // documented sentinel
    expect(entries[0].prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(entries[0].hash).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].prevHash).toBe(entries[i - 1].hash); // each links to the prior hash
    }
  });

  it("a mutated MIDDLE entry fails verification (rewrite is detected)", async () => {
    const e = await runToPromotion();
    const entries = e.getAudit(); // shallow copies; replacing an array slot does not touch engine state
    const mid = Math.floor(entries.length / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(entries.length - 1);
    entries[mid] = { ...entries[mid], action: "forged-action" }; // rewrite content, keep the old hash
    const res = verifyAuditChain(entries);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(entries[mid].seq); // recomputed hash no longer matches the stored one
  });

  it("a TRUNCATED tail fails verification against a trusted head anchor", async () => {
    const e = await runToPromotion();
    const entries = e.getAudit();
    const head = entries[entries.length - 1];
    const anchor = { seq: head.seq, hash: head.hash }; // persisted before truncation
    expect(verifyAuditChain(entries, { expectedHead: anchor }).ok).toBe(true);
    // Drop the last entry. The remaining chain is still internally consistent (a plain hash chain
    // cannot catch tail-truncation without a secret), but the trusted head anchor no longer matches
    // -> detected. Same trust model as the runtime-state port.
    const truncated = entries.slice(0, -1);
    const res = verifyAuditChain(truncated, { expectedHead: anchor });
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(anchor.seq);
  });
});
