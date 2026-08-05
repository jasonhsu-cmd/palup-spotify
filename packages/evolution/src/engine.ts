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
  StageMarker,
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
    const prevHash = this.audit.at(-1)?.hash ?? AUDIT_GENESIS_HASH;
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
    // PR-1 governance floor (shopper-disposition program) — fairness/leak as DETERMINISTIC gate floors,
    // checked FAIL-CLOSED exactly like the counter-metrics above, so no persona/memory capability can ever
    // land ungoverned: absent/NaN/out-of-range on EITHER side blocks (never fail-open), and a regression
    // vs. the champion baseline blocks too. Two INDEPENDENT reasons (not folded into counter-metrics-*
    // above) so a fairness or leak regression is never mistaken for/hidden behind a generic counter-metric
    // miss.
    if (!fairnessOk(cand.counterMetrics, champ.counterMetrics)) reasons.push("fairness-regressed");
    if (!leakOk(cand.counterMetrics, champ.counterMetrics)) reasons.push("persona-leak");
    // ADR-0014 #7 — anti-overfit: a candidate that improves the VISIBLE quality but REGRESSES on the
    // secret holdout the proposer never saw is gaming the eval. Checked FAIL-CLOSED:
    //   • holdout-absent — the champion baseline carries a holdoutScore but the candidate does NOT: it
    //     skipped the anti-overfit check the baseline was held to (a candidate can't drop its holdout to
    //     dodge the gate). (A champion with no holdout ⇒ nothing to compare, the pre-feature bootstrap.)
    //   • holdout-seed-mismatch — both carry a score but under DIFFERENT rotation seeds (a mid-run
    //     rotation scores them over different sets): not comparable, so we refuse rather than compare
    //     apples-to-oranges (re-grade the champion under the current seed to clear it).
    //   • holdout-regressed — comparable + same seed + candidate worse on the unseen set.
    const candH = cand.holdoutScore;
    const champH = champ.holdoutScore;
    const holdoutComparable = candH !== undefined && champH !== undefined;
    const holdoutAbsent = champH !== undefined && candH === undefined; // candidate dropped the check the baseline has
    const holdoutBaselineAbsent = candH !== undefined && champH === undefined; // no baseline ⇒ can't prove no-overfit (symmetric to counter-metrics; a stale pre-feature champion never reaches here in current wiring, but fail closed for durability)
    // A comparison is valid ONLY with both scores AND both seeds present AND equal — a missing seed is as
    // uncomparable as a mismatched one (fail closed, never compare a bare score across unknown epochs).
    const seedsMatch = cand.holdoutSeed !== undefined && cand.holdoutSeed === champ.holdoutSeed;
    const holdoutSeedMismatch = holdoutComparable && !seedsMatch;
    const holdoutRegressed = holdoutComparable && seedsMatch && candH! < champH!;
    if (holdoutAbsent) reasons.push("holdout-absent");
    if (holdoutBaselineAbsent) reasons.push("holdout-baseline-absent");
    if (holdoutSeedMismatch) reasons.push("holdout-seed-mismatch");
    if (holdoutRegressed) reasons.push("holdout-regressed");
    const holdoutOk = !holdoutAbsent && !holdoutBaselineAbsent && !holdoutSeedMismatch && !holdoutRegressed;
    // Fail-CLOSED cross-family gate (ADR-0014): a grade the grader marked ADVISORY (gating === false —
    // a same-family judge, e.g. Gemini grading the Gemini agent, or no cross-family judge available) can
    // NEVER pass. It may still be recorded/observed, but proposer≠evaluator is unmet so it must not gate
    // a promotion. `undefined` (offline MockGrader / a real cross-family judge) stays gating-eligible.
    if (cand.gating === false) reasons.push("advisory-grade-not-gating");
    const improved = delta > 0;
    const fairnessAndLeakOk =
      fairnessOk(cand.counterMetrics, champ.counterMetrics) && leakOk(cand.counterMetrics, champ.counterMetrics);
    const pass =
      cand.safetyPass && cand.floorPass && cand.qualityScore >= champ.qualityScore && improved &&
      candCm && champCm && !worseCounters && holdoutOk && cand.gating !== false && fairnessAndLeakOk;
    if (pass) reasons.push("passed: safe + no-regression + improved + counter-metrics + fairness/leak ok");
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

  // ─── ADR-0014 T4 auto-optimize lane (engine-ENFORCED stage completion, inv #3) ────────────────────
  // These methods make "no skippable stage" a property of the ENGINE, not the orchestrator loop: each
  // advances only from the correct prior stage and only on an engine-DERIVED pass, and the durable
  // serving write (serveAutoChampion) refuses unless autoPromotable() re-derives ok. This forecloses the
  // PR #125 failure class (self-approval reaching the 100% slot skipping shadow/canary) at the engine.

  /**
   * Enter the STAGED promotion path (shadow → canary). LANE-NEUTRAL: the human lane calls this directly;
   * the auto lane goes through `beginAutoOptimize`, which adds its own stricter preconditions on top.
   *
   * WHY THIS EXISTS: the stage machine below was reachable only via `beginAutoOptimize`, so it governed
   * only the DORMANT auto lane. The human lane — propose → gate → approve → promoteToServing — walked
   * straight to 100% of live traffic with no shadow and no canary, violating CLAUDE.md §3 NN#2 and the
   * "no stage is skippable" absolute repeated in four other documents. Staging is now expressible for
   * both lanes, and `humanPromotable` (below) requires it.
   */
  beginStaging(id: string): CandidateRecord {
    if (this.killed) throw new Error("kill switch is ON — staging halted");
    const rec = this.require(this.candidates.get(id), id);
    if (rec.status !== "awaiting_approval") throw new Error(`cannot begin staging for ${id} in status ${rec.status} (needs a gate pass)`);
    if (rec.gate?.pass !== true) throw new Error(`cannot begin staging for ${id} — gate did not pass`);
    rec.auto = { stage: "eval-passed" };
    this.log("engine", "staging_begin", id, {});
    return rec;
  }

  /** Enter the auto-optimize lane. The ONLY entry, and the single place that demands a POSITIVE
   * cross-family gating grade (gating===true) — engine.gate() passes gating===undefined (the offline
   * MockGrader opt-out), which must NEVER auto-promote to shoppers. Builds on `beginStaging`; the
   * `gating: true` marker it adds is what `autoPromotable` requires and `humanPromotable` does not, so
   * opening staging to the human lane cannot widen the auto lane. */
  beginAutoOptimize(id: string): CandidateRecord {
    if (this.killed) throw new Error("kill switch is ON — auto-optimize halted");
    const rec = this.require(this.candidates.get(id), id);
    if (rec.status !== "awaiting_approval") throw new Error(`cannot begin auto-optimize for ${id} in status ${rec.status} (needs a gate pass)`);
    if (rec.gate?.pass !== true) throw new Error(`cannot begin auto-optimize for ${id} — gate did not pass`);
    if (rec.metrics?.gating !== true) throw new Error(`cannot begin auto-optimize for ${id} — requires a POSITIVE cross-family gating grade (gating===true), got ${String(rec.metrics?.gating)}`);
    rec.auto = { stage: "eval-passed", gating: true };
    this.log("engine", "auto_begin", id, { gating: true });
    return rec;
  }

  /**
   * READ-ONLY: may this candidate be promoted to SERVING by a human? The human-lane counterpart of
   * `autoPromotable`, and the guard `promoteToServing` (control-plane) consults before the durable write.
   *
   * Requires ALL of: a passed gate, a HUMAN approval (not "auto-loop", not automated), and BOTH stage
   * markers passed. Re-derived from the individual markers rather than the `stage` label, exactly like
   * `autoPromotable`, so a hand-set label cannot fake a stage.
   *
   * Deliberately does NOT require `metrics.gating === true`. `gate()` accepts `gating === undefined`
   * (the offline MockGrader path), and requiring a positive live-judge grade here would make the human
   * lane unusable wherever the judge is unconfigured. That asymmetry is the point: the auto lane has no
   * human in it, so it carries the stricter bar. Whether a human promotion should also require a
   * positive live grade is a policy question for the named owner.
   */
  humanPromotable(id: string): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const rec = this.candidates.get(id);
    if (!rec) return { ok: false, reasons: ["unknown-candidate"] };
    if (this.killed) reasons.push("kill-switch-on");
    if (rec.status !== "approved") reasons.push(`status-${rec.status}`);
    if (rec.automated || !rec.approvedBy || rec.approvedBy === "auto-loop") reasons.push("not-human-approved");
    if (rec.gate?.pass !== true) reasons.push("gate-not-passed");
    if (rec.auto?.shadow?.pass !== true) reasons.push("shadow-not-passed");
    if (rec.auto?.canary?.pass !== true) reasons.push("canary-not-passed");
    return { ok: reasons.length === 0, reasons };
  }

  /** Record the shadow (0%) result. Advances to "shadowed" ONLY if the engine-derived pass holds (finite
   * counts + no regression beyond maxRegression). Throws unless the prior stage is eval-passed. */
  recordShadow(id: string, raw: { n: number; delta: number; at: string }, bounds: { maxRegression: number; maxImprovement?: number }): CandidateRecord {
    const rec = this.require(this.candidates.get(id), id);
    if (rec.auto?.stage !== "eval-passed") throw new Error(`cannot record shadow for ${id} — stage is ${rec.auto?.stage ?? "none"}, expected eval-passed`);
    // "behavioral diff within bounds" (ADR cond #5) is BOTH-sided: bound the downside regression AND, when
    // maxImprovement is set, the upside — a suspiciously LARGE swing (even if the judge scores it higher)
    // is exactly the kind of change a human should look at, so it fails shadow and routes to a human.
    const pass =
      Number.isFinite(raw.n) && raw.n > 0 && Number.isFinite(raw.delta) &&
      raw.delta >= -bounds.maxRegression &&
      (bounds.maxImprovement === undefined || raw.delta <= bounds.maxImprovement);
    const marker: StageMarker = { n: raw.n, delta: raw.delta, at: raw.at, pass };
    rec.auto.shadow = marker;
    if (pass) rec.auto.stage = "shadowed";
    this.log("engine", "auto_shadow", id, { n: raw.n, delta: raw.delta, pass });
    return rec;
  }

  /** Record the canary (1-5%) result. Advances to "canaried" ONLY if the engine-derived pass holds
   * (statistical power AND delta≥minDelta — the SAME arithmetic as control-plane windowedVerdictFor,
   * thresholds INJECTED so the engine never imports control-plane). Throws unless shadow passed. */
  recordCanary(id: string, raw: { n: number; delta: number; elapsedMs: number; at: string }, power: { minN: number; minWindowMs: number; minDelta: number }): CandidateRecord {
    const rec = this.require(this.candidates.get(id), id);
    if (rec.auto?.stage !== "shadowed" || rec.auto.shadow?.pass !== true) throw new Error(`cannot record canary for ${id} — requires a passing shadow (stage ${rec.auto?.stage ?? "none"})`);
    const pass = Number.isFinite(raw.n) && Number.isFinite(raw.elapsedMs) && raw.n >= power.minN && raw.elapsedMs >= power.minWindowMs && raw.delta >= power.minDelta;
    const marker: StageMarker = { n: raw.n, delta: raw.delta, elapsedMs: raw.elapsedMs, at: raw.at, pass };
    rec.auto.canary = marker;
    if (pass) rec.auto.stage = "canaried";
    this.log("engine", "auto_canary", id, { n: raw.n, delta: raw.delta, elapsedMs: raw.elapsedMs, pass });
    return rec;
  }

  /** READ-ONLY: may this candidate be auto-promoted to serving? Re-derived from the INDIVIDUAL markers
   * (not merely the stage label), so serveAutoChampion can consult it as its first guard. `reasons`
   * enumerates every miss so the orchestrator routes to a human with a specific cause. */
  autoPromotable(id: string): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const rec = this.candidates.get(id);
    if (!rec) return { ok: false, reasons: ["unknown-candidate"] };
    if (this.killed) reasons.push("kill-switch-on");
    if (rec.status !== "awaiting_approval") reasons.push(`status-${rec.status}`);
    if (rec.gate?.pass !== true) reasons.push("gate-not-passed");
    if (rec.metrics?.gating !== true) reasons.push("not-positively-gating");
    if (rec.auto?.gating !== true) reasons.push("auto-not-begun");
    if (rec.auto?.shadow?.pass !== true) reasons.push("shadow-not-passed");
    if (rec.auto?.canary?.pass !== true) reasons.push("canary-not-passed");
    if (rec.auto?.stage !== "canaried") reasons.push(`auto-stage-${rec.auto?.stage ?? "none"}`);
    return { ok: reasons.length === 0, reasons };
  }

  /** After-commit bookkeeping for an auto-promotion (mirror of promote(), attributed to "auto-loop", never
   * "human"). Called by serveAutoChampion ONLY after the durable serving write commits. Re-asserts
   * autoPromotable + the kill switch (fail-closed). */
  markAutoPromoted(id: string): Champion {
    if (this.killed) throw new Error("kill switch is ON — auto-promotion halted");
    const check = this.autoPromotable(id);
    if (!check.ok) throw new Error(`cannot mark ${id} auto-promoted: ${check.reasons.join(", ")}`);
    const rec = this.require(this.candidates.get(id), id);
    this.prevChampion = this.champion;
    this.champion = { policy: rec.policy, metrics: rec.metrics! };
    rec.status = "promoted";
    rec.auto!.stage = "promoted";
    this.history.push({ seq: this.next(), fromPolicyId: this.prevChampion.policy.id, toPolicyId: rec.policy.id, delta: rec.gate?.delta ?? 0 });
    this.log("auto-loop", "auto_promote", id, { from: this.prevChampion.policy.id, to: rec.policy.id });
    return this.champion;
  }

  /**
   * READ-ONLY regression verdict for an observation. Mutates nothing and writes no log entry, so a
   * caller that needs to act DURABLY (control-plane `monitorServing`) can decide first and revert the
   * serving store before touching engine state.
   *
   * A safety failure always regresses. A quality regression is measured against the PREVIOUS champion —
   * the bar the current one had to beat — so with no previous champion there is nothing to regress
   * against and only safety can trip it.
   */
  regressionVerdict(observed: { qualityScore: number; safetyPass: boolean }): { regressed: boolean; reason?: string } {
    if (!observed.safetyPass) return { regressed: true, reason: "safety-regression" };
    // The bar is the PREVIOUS champion's score — the one the current champion had to beat to ship. Once
    // that is spent (a rollback nulls prevChampion, depth-1), fall back to the CURRENT champion's own
    // recorded score: "you are performing worse than you graded at the gate" is still a real regression,
    // and it is the only bar left. Without this fallback a post-rollback regression read as HEALTHY —
    // the monitor went blind exactly when a second problem was most likely, and would then have recorded
    // the regressing champion as the known-good baseline.
    const bar = (this.prevChampion ?? this.champion).metrics.qualityScore;
    if (observed.qualityScore < bar) return { regressed: true, reason: "quality-regression" };
    return { regressed: false };
  }

  /**
   * Post-promotion monitor: auto-rollback if observed quality regresses below the previous champion.
   *
   * IN-MEMORY ONLY — this rolls back THIS PROCESS'S champion and nothing else. It does NOT revert the
   * durable serving champion (CHAMPION/active), which is what widget-backend actually reads per turn,
   * and it does not freeze the auto-promote fast-lane. Calling it on a regression therefore leaves
   * shoppers on the regressing policy while every dashboard reports a successful rollback — which is
   * exactly what shipped, because this was the only monitor the wired route called.
   *
   * PRODUCTION CODE MUST USE control-plane `monitorServing`, which reverts the store first and then
   * advances the engine. This remains for the offline demo (evolution/src/demo.ts) and for callers that
   * genuinely only want in-memory state.
   */
  monitor(observed: { qualityScore: number; safetyPass: boolean }): { rolledBack: boolean; reason?: string } {
    const verdict = this.regressionVerdict(observed);
    this.log("monitor", "observe", this.champion.policy.id, observed);
    if (verdict.regressed && this.prevChampion) {
      this.rollback(verdict.reason!);
      return { rolledBack: true, reason: verdict.reason };
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

/** A finite, in-range [0,1] rate — same fail-closed predicate as `counterMetricsComplete`'s inner `ok`,
 * hoisted so the PR-1 fairness/leak checks below share it (NaN/Infinity/out-of-range ⇒ false, never
 * mistaken for a valid 0). */
function isRate01(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** PR-1 governance floor — FAIL CLOSED (never fail-open): `personaPriceInvariance` (HIGHER is better; 1 =
 * the price/offer surface is IDENTICAL across signal-sets differing only in a WTP-adjacent persona
 * disposition — FAIR-1, docs/design/shopper-widget.md invariant #9) must be a valid rate on BOTH the
 * candidate and the champion baseline, and the candidate must not DROP below the baseline. Absent (either
 * side never measured it) or NaN/out-of-range blocks exactly like a regression — there is no vacuous-pass
 * default, so no persona capability can land without this floor already gating it. */
function fairnessOk(cand?: PolicyMetrics["counterMetrics"], champ?: PolicyMetrics["counterMetrics"]): boolean {
  const c = cand?.personaPriceInvariance;
  const b = champ?.personaPriceInvariance;
  if (!isRate01(c) || !isRate01(b)) return false;
  return c >= b;
}

/** PR-1 governance floor — FAIL CLOSED (never fail-open): `personaLeakRate` (LOWER is better; 0 = no
 * persona/disposition fact reached the decision surface — a `memory:*` flag — without consent) must be a
 * valid rate on BOTH sides, and the candidate must not RISE above the baseline. Absent or NaN/out-of-range
 * blocks, same treatment as `fairnessOk`. */
function leakOk(cand?: PolicyMetrics["counterMetrics"], champ?: PolicyMetrics["counterMetrics"]): boolean {
  const c = cand?.personaLeakRate;
  const b = champ?.personaLeakRate;
  if (!isRate01(c) || !isRate01(b)) return false;
  return c <= b;
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
