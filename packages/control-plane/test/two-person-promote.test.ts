import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { promoteToServing, servingChampion } from "../src/champion-promoter.js";

// TWO-PERSON RULE on the promotion that reaches 100% of live traffic.
//
// The plane already refused an AUTOMATED approval (approvedBy "auto-loop") — no self-deployment. What it
// could not refuse was ONE operator doing both halves: approve, then promote. Combined with a single
// shared OPERATOR_TOKEN and a hardcoded approver string, a single compromised or careless credential
// carried a policy change all the way to shoppers with no second pair of eyes, and the immutable audit
// recorded both actions as the literal string "operator".
//
// SATISFIABILITY IS THE HONEST PART. A two-person rule needs two people. With one shared token every
// operator IS "operator", so enforcing it unconditionally would block every promotion in the current
// deployment, and quietly skipping it would be the "control that exists but never applies" pattern this
// codebase keeps producing. So the rule is enforced when the caller supplies a promoter identity, and
// the control-plane supplies one only when >= 2 distinct operators are configured — an observable state
// (`GET /api/state.twoPersonPromote`), not a silent default.

const BASE_CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1, personaPriceInvariance: 1, personaLeakRate: 0 };
const CHAMP: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.75, counterMetrics: BASE_CM };
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });

const mkEngine = () =>
  new EvolutionEngine({
    champion: { policy: DEFAULT_POLICY, metrics: CHAMP },
    grader: new MockGrader({ cand: { policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...BASE_CM, returnRate: 0.06, optOutRate: 0.08 } } }),
  });

/** propose → gate → stage (§3 NN#2) → approve, leaving it ready to promote. */
async function readyFor(engine: EvolutionEngine, approver: string) {
  engine.propose(P("cand"));
  await engine.evaluate("cand");
  engine.beginStaging("cand");
  engine.recordShadow("cand", { n: 200, delta: 0.02, at: "2026-08-05T00:00:00Z" }, { maxRegression: 0.05 });
  engine.recordCanary("cand", { n: 500, delta: 0.02, elapsedMs: 3_600_000, at: "2026-08-05T01:00:00Z" }, { minN: 100, minWindowMs: 600_000, minDelta: -0.01 });
  engine.approve("cand", approver);
}

describe("two-person promotion — one operator cannot both approve and ship", () => {
  it("THE CONTROL: the approver promoting their OWN approval is refused", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyFor(engine, "alice");

    await expect(promoteToServing(engine, "cand", store, "demo", undefined, { promotedBy: "alice" })).rejects.toThrow(
      /two-person|same operator|approved it/i,
    );
    expect(await servingChampion(store, "demo")).toBeNull();
  });

  it("a DIFFERENT operator may promote it", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyFor(engine, "alice");

    const champ = await promoteToServing(engine, "cand", store, "demo", undefined, { promotedBy: "bob" });
    expect(champ.policy.id).toBe("cand");
    expect((await servingChampion(store, "demo"))?.policy.id).toBe("cand");
  });

  it("the audit records BOTH people — approver and promoter — not one anonymous 'operator'", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyFor(engine, "alice");
    await promoteToServing(engine, "cand", store, "demo", undefined, { promotedBy: "bob" });

    const entry = (await store.readAudit({ tenantId: "demo" })).find((a) => a.action === "champion.promote");
    expect(entry?.actor).toBe("alice"); // approver of record, bound from the candidate
    expect(JSON.stringify(entry?.input)).toContain("bob"); // and who actually pushed it
  });

  it("omitting the promoter identity leaves the rule unenforced — the single-shared-token deployment", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyFor(engine, "operator");

    // No promotedBy ⇒ nothing to compare. This is the CURRENT deployment's behaviour, unchanged, and it
    // is why the control-plane only supplies an identity when >= 2 operators exist.
    const champ = await promoteToServing(engine, "cand", store, "demo");
    expect(champ.policy.id).toBe("cand");
  });

  it("the rule does NOT weaken the existing no-self-deployment refusal", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    await readyFor(engine, "auto-loop"); // automated approval

    // Refused for being automated, regardless of who promotes it.
    await expect(promoteToServing(engine, "cand", store, "demo", undefined, { promotedBy: "bob" })).rejects.toThrow(
      /not HUMAN-approved/i,
    );
  });

  it("the rule does NOT weaken the stage requirement", async () => {
    const store = new InMemoryRuntimeStore();
    const engine = mkEngine();
    engine.propose(P("cand"));
    await engine.evaluate("cand");
    engine.approve("cand", "alice"); // approved but never staged

    await expect(promoteToServing(engine, "cand", store, "demo", undefined, { promotedBy: "bob" })).rejects.toThrow(
      /shadow-not-passed|canary-not-passed/,
    );
  });
});
