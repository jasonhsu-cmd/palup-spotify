import type { Policy } from "@palup/widget-brain";
import type {
  AuditEntry,
  Champion,
  CandidateRecord,
  GateResult,
  Grader,
  PolicyMetrics,
  PromotionEvent,
} from "./types.js";

export interface EngineOptions {
  champion: Champion;
  grader: Grader;
}

/**
 * The governed self-improvement pipeline (docs/design/governance-subsystems.md §4, CLAUDE.md §3):
 *   propose -> evaluate -> GATE (safety floor + no-regression + improved) -> HUMAN approve
 *   -> promote -> monitor -> auto-rollback on regression.
 * Non-negotiables enforced here: the safety floor is never tradeable; NOTHING promotes without an
 * explicit human approval (no self-promotion); the kill switch halts all promotion instantly; every
 * action is appended to an immutable audit log.
 */
export class EvolutionEngine {
  private champion: Champion;
  private prevChampion: Champion | null = null;
  private readonly grader: Grader;
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly history: PromotionEvent[] = [];
  private readonly audit: AuditEntry[] = [];
  private killed = false;
  private seq = 0;

  constructor(opts: EngineOptions) {
    this.champion = opts.champion;
    this.grader = opts.grader;
    this.log("engine", "init", opts.champion.policy.id, {
      qualityScore: opts.champion.metrics.qualityScore,
    });
  }

  private next(): number {
    return ++this.seq;
  }

  private log(actor: AuditEntry["actor"], action: string, target?: string, detail?: Record<string, unknown>) {
    this.audit.push({ seq: this.next(), actor, action, target, detail });
  }

  private require(rec: CandidateRecord | undefined, id: string): CandidateRecord {
    if (!rec) throw new Error(`unknown candidate: ${id}`);
    return rec;
  }

  /** Register a candidate policy for evaluation. */
  propose(policy: Policy): string {
    const rec: CandidateRecord = { policy, status: "proposed", seq: this.next() };
    this.candidates.set(policy.id, rec);
    this.log("engine", "propose", policy.id, { label: policy.label });
    return policy.id;
  }

  /** Run the grader and apply the gate. Result: "blocked" or "awaiting_approval". */
  async evaluate(id: string): Promise<CandidateRecord> {
    const rec = this.require(this.candidates.get(id), id);
    rec.status = "evaluating";
    const metrics = await this.grader.grade(rec.policy);
    rec.metrics = metrics;
    const gate = this.gate(metrics, this.champion.metrics);
    rec.gate = gate;
    rec.status = gate.pass ? "awaiting_approval" : "blocked";
    this.log("engine", gate.pass ? "gate_pass" : "gate_block", id, {
      reasons: gate.reasons,
      delta: gate.delta,
      qualityScore: metrics.qualityScore,
      safetyPass: metrics.safetyPass,
    });
    return rec;
  }

  /** The gate: safety floor is a HARD requirement; promotion also requires no regression + improvement. */
  gate(cand: PolicyMetrics, champ: PolicyMetrics): GateResult {
    const reasons: string[] = [];
    const delta = cand.qualityScore - champ.qualityScore;
    if (!cand.safetyPass) reasons.push("safety-floor-failed");
    if (!cand.floorPass) reasons.push("deterministic-floor-failed");
    if (cand.qualityScore < champ.qualityScore) reasons.push("quality-regressed");
    const worseCounters =
      (cand.counterMetrics?.returnRate ?? 0) > (champ.counterMetrics?.returnRate ?? 0) ||
      (cand.counterMetrics?.complaintRate ?? 0) > (champ.counterMetrics?.complaintRate ?? 0);
    if (worseCounters) reasons.push("counter-metrics-worsened");
    const improved = delta > 0;
    const pass =
      cand.safetyPass && cand.floorPass && cand.qualityScore >= champ.qualityScore && improved && !worseCounters;
    if (pass) reasons.push("passed: safe + no-regression + improved");
    else if (reasons.length === 0 && !improved) reasons.push("no-improvement-over-champion");
    return { pass, reasons, delta };
  }

  /** HUMAN gate (HITL). Only a gated-pass candidate can be approved; blocked when the kill switch is on. */
  approve(id: string, human = "operator"): CandidateRecord {
    if (this.killed) throw new Error("kill switch is ON — approvals halted");
    const rec = this.require(this.candidates.get(id), id);
    if (rec.status !== "awaiting_approval")
      throw new Error(`cannot approve ${id} in status ${rec.status}`);
    rec.status = "approved";
    this.log("human", "approve", id, { human });
    return rec;
  }

  reject(id: string, human = "operator", reason?: string): CandidateRecord {
    const rec = this.require(this.candidates.get(id), id);
    if (rec.status !== "awaiting_approval")
      throw new Error(`cannot reject ${id} in status ${rec.status}`);
    rec.status = "rejected";
    this.log("human", "reject", id, { human, reason });
    return rec;
  }

  /** Promote an APPROVED candidate to champion. Never callable without a prior human approval. */
  promote(id: string): Champion {
    if (this.killed) throw new Error("kill switch is ON — promotion halted");
    const rec = this.require(this.candidates.get(id), id);
    if (rec.status !== "approved") throw new Error(`cannot promote ${id} in status ${rec.status} (needs human approval)`);
    this.prevChampion = this.champion;
    this.champion = { policy: rec.policy, metrics: rec.metrics! };
    rec.status = "promoted";
    this.history.push({
      seq: this.next(),
      fromPolicyId: this.prevChampion.policy.id,
      toPolicyId: rec.policy.id,
      delta: rec.gate?.delta ?? 0,
    });
    this.log("engine", "promote", id, { from: this.prevChampion.policy.id, to: rec.policy.id });
    return this.champion;
  }

  /** Post-promotion monitor: auto-rollback if observed quality regresses below the previous champion. */
  monitor(observed: { qualityScore: number; safetyPass: boolean }): { rolledBack: boolean; reason?: string } {
    const regressed =
      !observed.safetyPass || (this.prevChampion && observed.qualityScore < this.prevChampion.metrics.qualityScore);
    this.log("monitor", "observe", this.champion.policy.id, observed);
    if (regressed && this.prevChampion) {
      const reason = !observed.safetyPass ? "safety-regression" : "quality-regression";
      this.rollback(reason);
      return { rolledBack: true, reason };
    }
    return { rolledBack: false };
  }

  /** Restore the previous champion (auto or manual). */
  rollback(reason: string): Champion {
    if (!this.prevChampion) throw new Error("no previous champion to roll back to");
    const bad = this.champion;
    this.champion = this.prevChampion;
    this.prevChampion = null;
    const last = this.history[this.history.length - 1];
    if (last) last.rolledBack = true;
    const rec = this.candidates.get(bad.policy.id);
    if (rec) rec.status = "rolled_back";
    this.log("monitor", "rollback", bad.policy.id, { reason, restored: this.champion.policy.id });
    return this.champion;
  }

  /** Kill switch — halts all approvals/promotions instantly (governance non-negotiable). */
  kill(reason = "operator"): void {
    this.killed = true;
    this.log("human", "kill_switch_on", undefined, { reason });
  }
  unkill(): void {
    this.killed = false;
    this.log("human", "kill_switch_off");
  }

  getChampion(): Champion {
    return this.champion;
  }
  isKilled(): boolean {
    return this.killed;
  }
  getCandidates(): CandidateRecord[] {
    return [...this.candidates.values()].sort((a, b) => a.seq - b.seq);
  }
  getHistory(): PromotionEvent[] {
    return [...this.history];
  }
  getAudit(): AuditEntry[] {
    return [...this.audit];
  }
}
