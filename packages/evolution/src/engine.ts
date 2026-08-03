import { createHash } from "node:crypto";
import { AUDIT_GENESIS_HASH, canonicalize } from "@palup/platform-ports";
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
    // Hash-chain every entry (docs/AGENT-GOVERNANCE.md §3 "immutable audit ... no silent transitions";
    // docs/design/governance-subsystems.md §6 "hash-chained (event_hash + prev_hash)"). prevHash links
    // to the prior entry's hash (genesis sentinel for the first), so any in-place edit, reorder, or
    // mid-chain removal is detectable by verifyAuditChain. Mirrors the runtime-state audit chain
    // (packages/platform-ports/src/in-memory-runtime-store.ts) EXACTLY: same canonicalize + sha256.
    const prevHash = this.audit.length ? this.audit[this.audit.length - 1].hash : AUDIT_GENESIS_HASH;
    const base: Omit<AuditEntry, "hash"> = { seq: this.next(), prevHash, actor, action, target, detail };
    this.audit.push({ ...base, hash: hashAuditEntry(base) });
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
    // ADR-0014 #5 — counter-metrics are MANDATORY EVIDENCE, checked FAIL-CLOSED. A candidate MUST carry
    // the measured counter-metrics (escalationRecall + returnRate + optOutRate; control-plane/counter-
    // metrics.ts) and the champion baseline must too, or the gate blocks: an engagement/quality lift can
    // NEVER promote on its own without proof it did not worsen the outcomes that matter. This closes the
    // old vacuity where absent counter-metrics defaulted to 0 and `0 > 0` never blocked. (complaintRate is
    // a LIVE-TRAFFIC metric that ADR-0014 #10's delayed-signal measurement WILL compute in the canary
    // window — that is not built yet, so complaintRate is enforced nowhere today; it is optional here, and
    // when BOTH sides do carry it a rise still blocks.)
    const candCm = counterMetricsComplete(cand.counterMetrics);
    const champCm = counterMetricsComplete(champ.counterMetrics);
    if (!candCm) reasons.push("counter-metrics-absent");
    else if (!champCm) reasons.push("counter-metrics-baseline-absent"); // no baseline ⇒ can't prove not-worse
    const worseCounters =
      candCm && champCm &&
      (cand.counterMetrics!.returnRate! > champ.counterMetrics!.returnRate! ||
        cand.counterMetrics!.optOutRate! > champ.counterMetrics!.optOutRate! ||
        cand.counterMetrics!.escalationRecall! < champ.counterMetrics!.escalationRecall! ||
        (cand.counterMetrics!.complaintRate !== undefined &&
          champ.counterMetrics!.complaintRate !== undefined &&
          cand.counterMetrics!.complaintRate > champ.counterMetrics!.complaintRate));
    if (worseCounters) reasons.push("counter-metrics-worsened");
    // Fail-CLOSED cross-family gate (ADR-0014): a grade the grader marked ADVISORY (gating === false —
    // a same-family judge, e.g. Gemini grading the Gemini agent, or no cross-family judge available) can
    // NEVER pass. It may still be recorded/observed, but proposer≠evaluator is unmet so it must not gate
    // a promotion. `undefined` (offline MockGrader / a real cross-family judge) stays gating-eligible.
    if (cand.gating === false) reasons.push("advisory-grade-not-gating");
    const improved = delta > 0;
    const pass =
      cand.safetyPass && cand.floorPass && cand.qualityScore >= champ.qualityScore && improved &&
      candCm && champCm && !worseCounters && cand.gating !== false;
    if (pass) reasons.push("passed: safe + no-regression + improved + counter-metrics ok");
    else if (reasons.length === 0 && !improved) reasons.push("no-improvement-over-champion");
    return { pass, reasons, delta };
  }

  /** HUMAN gate (HITL). Only a gated-pass candidate can be approved; blocked when the kill switch is on. */
  approve(id: string, approver = "operator"): CandidateRecord {
    if (this.killed) throw new Error("kill switch is ON — approvals halted");
    const rec = this.require(this.candidates.get(id), id);
    if (rec.status !== "awaiting_approval")
      throw new Error(`cannot approve ${id} in status ${rec.status}`);
    rec.status = "approved";
    // NN #5 audit fidelity: record the TRUE actor. An automated (opt-in) auto-loop approval must not
    // masquerade as a human in the immutable log — attribute it to "auto-loop" so it's auditable as
    // a non-human approval. Persist it on the record too, so a downstream promote→serving path can
    // POSITIVELY verify the approval was human ("approved" alone is autonomy-agnostic) rather than
    // trusting a caller-supplied approver string.
    const automated = approver === "auto-loop";
    rec.approvedBy = approver;
    rec.automated = automated;
    this.log(automated ? "auto-loop" : "human", "approve", id, { approver, automated });
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
  /** The candidate record for `id`, or undefined. Lets a promote→serving bridge inspect the approval
   * (approvedBy/automated) WITHOUT mutating engine state, so it can verify human approval + write the
   * durable serving store BEFORE advancing the engine. */
  getCandidate(id: string): CandidateRecord | undefined {
    return this.candidates.get(id);
  }
  /** The previous champion (the rollback target), or null. Read-only — lets a bridge persist the
   * rollback to serving BEFORE calling rollback(), so a store fault can't strand prevChampion=null. */
  getPreviousChampion(): Champion | null {
    return this.prevChampion;
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

  /** Recompute this engine's own audit chain and report whether it is intact (see verifyAuditChain). */
  verifyAudit(opts?: { expectedHead?: { seq: number; hash: string } }): { ok: boolean; brokenAt?: number } {
    return verifyAuditChain(this.audit, opts);
  }
}

/**
 * sha256 over the canonicalized audit body (every field except `hash`). Reuses platform-ports'
 * `canonicalize` (recursively key-sorted JSON) + node:crypto sha256 so the evolution audit chain
 * hashes IDENTICALLY to the runtime-state chain (packages/platform-ports/src/audit-hash.ts). No new
 * dependency — node:crypto is stdlib and already used there.
 */
/** All THREE deterministically-measured counter-metrics present (escalationRecall + returnRate +
 * optOutRate; control-plane/counter-metrics.ts). complaintRate is canary-sourced (ADR-0014 #10) and
 * optional. Any missing ⇒ the gate fails CLOSED (ADR-0014 #5) — no promotion on quality/engagement alone. */
function counterMetricsComplete(cm?: PolicyMetrics["counterMetrics"]): boolean {
  // Fail CLOSED: require a real, in-range rate — NOT just typeof "number" (typeof NaN/±Infinity is
  // "number", and a NaN would slip through as "complete" AND "not worse" since every NaN comparison is
  // false, i.e. fail-OPEN). Number.isFinite + [0,1] range rejects NaN/Infinity/out-of-range outright.
  const ok = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  return !!cm && ok(cm.returnRate) && ok(cm.optOutRate) && ok(cm.escalationRecall);
}

function hashAuditEntry(base: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonicalize(base)).digest("hex");
}

/**
 * Recompute an evolution audit chain and report whether it is intact — mirrors
 * RuntimeStatePort.verifyAudit (packages/platform-ports/src/in-memory-runtime-store.ts) EXACTLY.
 * In-place mutation, reorder, and mid-chain removal are caught by the chain math (prevHash linkage +
 * per-entry hash recompute). Tail-truncation and a full re-hash are NOT catchable from the chain alone
 * (no secret is stored); pass a trusted `expectedHead` (a separately persisted head anchor) to detect
 * those too — the same trust model the runtime-state port documents.
 */
export function verifyAuditChain(
  entries: AuditEntry[],
  opts?: { expectedHead?: { seq: number; hash: string } },
): { ok: boolean; brokenAt?: number } {
  let prev = AUDIT_GENESIS_HASH;
  for (const r of entries) {
    const { hash, ...base } = r;
    if (r.prevHash !== prev || hashAuditEntry(base) !== hash) return { ok: false, brokenAt: r.seq };
    prev = hash;
  }
  if (opts?.expectedHead) {
    const head = entries[entries.length - 1];
    if (!head || head.seq !== opts.expectedHead.seq || head.hash !== opts.expectedHead.hash)
      return { ok: false, brokenAt: opts.expectedHead.seq };
  }
  return { ok: true };
}
