import type { Policy } from "@palup/widget-brain";
import type { StorePort } from "@palup/platform-ports";
import { EvolutionEngine } from "./engine.js";
import type { Champion, Grader, ImprovementEntry, PolicyMetrics, Proposer, Weakness } from "./types.js";

export interface AutoLoopDeps {
  engine: EvolutionEngine;
  grader: Grader; // MUST be the same grader the engine was built with
  proposer: Proposer;
  store: StorePort;
  /** Injected clock (engine/loop code never calls Date.now() directly). */
  now: () => string;
  /** How many candidates to ask the proposer for each round (default 2). */
  candidatesPerRound?: number;
  /** Minimum quality gain to accept a promotion — absorbs live-judge run-to-run noise (default 0.05). */
  minDelta?: number;
  /** Demo convenience: auto-approve a gate-passing candidate. false ⇒ stop at awaiting_approval (HITL). */
  autoApprove?: boolean;
  /** ADR-0014 #9 — the per-merchant rate-limit + freeze check on the SHARED orchestrator registry
   * (state-postgres/orchestrator-registry.ts), consulted BEFORE every AUTO approval+promotion. Returns a
   * halt reason (frozen after a rollback, or inside the ≤1/window frequency cap) or null (clear). Injected
   * (this package stays decoupled from state-postgres); the composition root wires it. REQUIRED whenever
   * autoApprove is on — a missing checker or a throwing registry HALTS (fail-closed, like killCheck). */
  rateLimitCheck?: () => Promise<string | null>;
  /** ADR-0014 #9 — stamp the frequency-cap clock on the shared registry after an auto-promotion. */
  recordPromotion?: () => Promise<void>;
  /** ADR-0014 #6 — the SERVER-SOURCED change-class screen. Given the winning candidate's policy, returns a
   * reason if its change reaches beyond voice (pricing/safety-override/manipulation/…) ⇒ route to a HUMAN,
   * or null if it's a clean voice change. Injected + fail-closed: a missing/throwing screen routes to a
   * human (never auto-promotes an unscreened change). */
  changeScreen?: (policy: Policy) => Promise<string | null>;
  /** ADR-0014 #4 — write the guardrail-gated auto-promoted champion to SERVING (the RuntimeStatePort the
   * shopper widget reads), so an auto-promotion actually reaches shoppers. Called SERVE-FIRST (before the
   * engine advances): a serving/kill failure throws and leaves both the engine and serving on the prior
   * champion (no divergence). Optional — when absent the auto-promotion stays in-memory (legacy behavior);
   * the composition root wires it. */
  serveChampion?: (champion: Champion) => Promise<void>;
  /**
   * ADR-0014 #1 / NN #4 — the SHARED three-scope run-time kill check, consulted BEFORE every AUTO
   * approval+promotion (fail-closed). Injected (not a direct state-postgres import) so this package stays
   * decoupled; the composition root wires it to `() => matchedKill(runtimeStore, {tenantId, agentType})`.
   * Returns the armed scope (⇒ halt) or null (⇒ clear). REQUIRED whenever autoApprove is on — a missing
   * checker or a throwing/unreadable registry HALTS auto-promotion (never proceeds unguarded).
   */
  killCheck?: () => Promise<{ scope: string } | null>;
  log?: (m: string) => void;
}

const STORE_KEYS = {
  champion: "champion",
  candidates: "candidates",
  history: "history",
  audit: "audit",
  timeline: "improvement-timeline",
} as const;

function weakest(metrics: PolicyMetrics, k = 3): Weakness[] {
  return Object.entries(metrics.perCriteria ?? {})
    .map(([criterion, passRate]) => ({ criterion, passRate }))
    .sort((a, b) => a.passRate - b.passRate)
    .filter((w) => w.passRate < 1)
    .slice(0, k);
}

/**
 * The real self-improvement loop: grade champion → find weakest criteria → ask the proposer for
 * candidates that target them → evaluate + gate each → promote the best gate-passing improvement →
 * record it in a durable improvement timeline → repeat until a round yields no improvement (settle).
 * Governance is unchanged: the gate + (optionally) a human approval still guard every promotion.
 */
export class AutoLoop {
  private readonly d: Required<Omit<AutoLoopDeps, "log" | "killCheck">> & { log: (m: string) => void; killCheck?: AutoLoopDeps["killCheck"] };
  constructor(deps: AutoLoopDeps) {
    this.d = {
      candidatesPerRound: 2,
      minDelta: 0.05,
      autoApprove: false,
      log: () => {},
      ...deps,
    };
  }

  /**
   * ADR-0014 #9 — the per-merchant rate-limit + freeze check on the SHARED orchestrator registry, run
   * before an AUTO-promotion. Returns a halt reason or null. FAIL-CLOSED (mirrors checkKill): a MISSING
   * checker or a throwing registry HALTS — auto-promotion must never proceed without a working drift
   * bound. (Only gates the autoApprove fast-lane; the human path stops for review anyway.)
   */
  private async checkRateLimit(): Promise<string | null> {
    if (!this.d.rateLimitCheck) return "no rate-limiter wired"; // fail closed: auto-promote requires the cap
    // The cap can't advance without a recorder — an unstamped promotion would let the cap never trip
    // (unbounded auto-promotions). Require BOTH together (fail closed, symmetric with the check).
    if (!this.d.recordPromotion) return "no promotion recorder wired";
    try {
      return await this.d.rateLimitCheck();
    } catch {
      return "rate-limit registry unreadable"; // fail closed
    }
  }

  /**
   * ADR-0014 #6 — screen the candidate's change class. Returns a reason to ROUTE TO A HUMAN (the change
   * reaches beyond voice), or null (clean voice change ⇒ fast-lane ok). FAIL-CLOSED: a missing or throwing
   * screen routes to a human — an unscreened change never rides the auto-promote fast-lane.
   */
  private async screenChange(policy: Policy): Promise<string | null> {
    if (!this.d.changeScreen) return "no change-screen wired";
    try {
      const r = await this.d.changeScreen(policy);
      if (r) return r; // a reason ⇒ route to human
      if (r === null) return null; // ONLY an explicit null is a clean voice change
      return "change-screen-invalid"; // undefined / contract violation ⇒ fail closed (never auto-promote unscreened)
    } catch {
      return "change-screen unreadable";
    }
  }

  /**
   * Fail-CLOSED shared-kill check for the AUTO-promote path (ADR-0014 #1). Returns the armed scope (halt)
   * or null (clear). A MISSING checker or a throwing/unreadable registry is treated as ARMED — an auto
   * promotion must never proceed without a working kill check. (The human path stops for review anyway,
   * so this only gates the autoApprove fast-lane.)
   */
  private async checkKill(): Promise<{ scope: string } | null> {
    if (!this.d.killCheck) return { scope: "no-kill-checker" }; // fail closed: auto-promote requires a checker
    try {
      const r = await this.d.killCheck();
      if (r) return r; // armed { scope }
      if (r === null) return null; // ONLY an explicit null is "clear"
      return { scope: "kill-check-invalid" }; // undefined / contract violation ⇒ fail closed (never proceed)
    } catch {
      return { scope: "kill-registry-unreadable" }; // fail closed: an unreadable registry halts
    }
  }

  private async persistState(): Promise<void> {
    const e = this.d.engine;
    await this.d.store.write(STORE_KEYS.champion, e.getChampion());
    await this.d.store.write(STORE_KEYS.candidates, e.getCandidates());
    await this.d.store.write(STORE_KEYS.history, e.getHistory());
    await this.d.store.write(STORE_KEYS.audit, e.getAudit());
  }
  private async recordTimeline(entry: ImprovementEntry): Promise<void> {
    await this.d.store.append(STORE_KEYS.timeline, entry);
  }

  async run(maxRounds = 3): Promise<ImprovementEntry[]> {
    const { engine, grader, proposer, log } = this.d;
    const timeline: ImprovementEntry[] = [];

    // Round 0 — baseline (champion metrics were graded at engine construction).
    let champ = engine.getChampion();
    const baseline: ImprovementEntry = {
      round: 0,
      at: this.d.now(),
      event: "baseline",
      toPolicyId: champ.policy.id,
      qualityAfter: champ.metrics.qualityScore,
      perCriteriaAfter: champ.metrics.perCriteria ?? {},
      note: `baseline champion "${champ.policy.label}" quality ${champ.metrics.qualityScore.toFixed(2)}`,
    };
    timeline.push(baseline);
    await this.recordTimeline(baseline);
    await this.persistState();
    log(`round 0 (baseline): ${champ.policy.id} q=${champ.metrics.qualityScore.toFixed(3)}`);

    for (let round = 1; round <= maxRounds; round++) {
      champ = engine.getChampion();
      const weaknesses = weakest(champ.metrics, 3);
      if (weaknesses.length === 0) {
        log(`round ${round}: champion has no failing criteria — settled.`);
        break;
      }
      log(`round ${round}: weakest = ${weaknesses.map((w) => `${w.criterion}(${w.passRate.toFixed(2)})`).join(", ")}`);

      let candidates: Policy[] = [];
      try {
        candidates = (await proposer.propose(champ.policy, weaknesses)).slice(0, this.d.candidatesPerRound);
      } catch (e) {
        log(`round ${round}: proposer failed (${(e as Error).message}) — stopping.`);
        break;
      }
      if (candidates.length === 0) {
        log(`round ${round}: proposer returned nothing — stopping.`);
        break;
      }

      // Evaluate + gate each candidate (engine.evaluate runs the same grader + the gate).
      const evaluated: { id: string; metrics: PolicyMetrics; pass: boolean; delta: number }[] = [];
      for (const cand of candidates) {
        const uniqueId = `${cand.id}-r${round}`;
        const policy = { ...cand, id: uniqueId };
        engine.propose(policy);
        const rec = await engine.evaluate(uniqueId);
        await this.persistState();
        evaluated.push({
          id: uniqueId,
          metrics: rec.metrics!,
          pass: rec.gate?.pass ?? false,
          delta: rec.gate?.delta ?? 0,
        });
        log(`  candidate ${uniqueId}: q=${rec.metrics!.qualityScore.toFixed(3)} Δ=${(rec.gate?.delta ?? 0).toFixed(3)} gate=${rec.gate?.pass ? "PASS" : "block(" + rec.gate?.reasons.join(",") + ")"}`);
      }

      // Pick the best gate-passing candidate that beats the noise floor.
      const winner = evaluated
        .filter((c) => c.pass && c.delta >= this.d.minDelta)
        .sort((a, b) => b.metrics.qualityScore - a.metrics.qualityScore)[0];

      if (!winner) {
        const entry: ImprovementEntry = {
          round,
          at: this.d.now(),
          event: "no_improvement",
          toPolicyId: champ.policy.id,
          qualityAfter: champ.metrics.qualityScore,
          perCriteriaAfter: champ.metrics.perCriteria ?? {},
          note: `no candidate beat champion by ≥${this.d.minDelta} — settled at ${champ.metrics.qualityScore.toFixed(2)}`,
        };
        timeline.push(entry);
        await this.recordTimeline(entry);
        log(`round ${round}: no improvement — settled.`);
        break;
      }

      // Governance: human approval (auto in demo mode), then promote.
      if (this.d.autoApprove) {
        // ADR-0014 #1 / NN #4 — fail CLOSED on the SHARED run-time kill registry before an AUTO
        // approval+promotion (in addition to the engine's own kill flag, checked inside approve/promote).
        // An armed kill at ANY scope (global > tenant > agent), a missing checker, or an unreadable
        // registry all HALT the loop — auto-promotion never proceeds unguarded.
        const kill = await this.checkKill();
        if (kill) {
          log(`round ${round}: kill switch armed (${kill.scope}) — halting auto-promotion (no approval/promote).`);
          await this.persistState();
          break;
        }
        // ADR-0014 #9 — bound silent drift: refuse if frozen (recent rollback) or inside the frequency cap.
        const limited = await this.checkRateLimit();
        if (limited) {
          log(`round ${round}: auto-promotion rate-limited — ${limited}; halting.`);
          await this.persistState();
          break;
        }
        // ADR-0014 #6 — a change whose styleDirective reaches beyond voice must go to a HUMAN, not the
        // fast-lane (server-sourced screen; fail-closed). Route to review and stop, exactly like the
        // human-approval path — the candidate stays awaiting_approval for an operator to decide.
        const winnerPolicy = engine.getCandidate(winner.id)?.policy;
        const flagged = winnerPolicy ? await this.screenChange(winnerPolicy) : "winner policy unavailable";
        if (flagged) {
          log(`round ${round}: ${winner.id} routed to HUMAN review (change-class screen: ${flagged}) — not auto-promoting.`);
          await this.persistState();
          break;
        }
        engine.approve(winner.id, "auto-loop");
      } else {
        log(`round ${round}: ${winner.id} awaiting HUMAN approval (autoApprove off) — stopping for review.`);
        await this.persistState();
        break;
      }
      const before = champ.metrics;
      // ADR-0014 #4 — wire promote→serving: the guardrail-gated auto-promotion now REACHES shoppers. Write
      // serving FIRST (mirrors promoteToServing: a serving/kill failure leaves BOTH the engine and serving
      // on the prior champion — no divergence), then advance the engine.
      const winnerPolicy = engine.getCandidate(winner.id)!.policy;
      if (this.d.serveChampion) {
        try {
          await this.d.serveChampion({ policy: winnerPolicy, metrics: winner.metrics });
        } catch (e) {
          log(`round ${round}: serving write failed (${(e as Error).message}) — engine NOT advanced; halting.`);
          await this.persistState();
          break;
        }
      }
      const newChamp = engine.promote(winner.id);
      await this.d.recordPromotion?.(); // ADR-0014 #9 — stamp the shared frequency-cap clock
      await this.persistState();

      const targeted = weaknesses.map((w) => w.criterion);
      const improvedNote = targeted
        .filter((c) => (winner.metrics.perCriteria?.[c] ?? 0) > (before.perCriteria?.[c] ?? 0))
        .join(", ");
      const entry: ImprovementEntry = {
        round,
        at: this.d.now(),
        event: "promoted",
        fromPolicyId: before.policyId,
        toPolicyId: newChamp.policy.id,
        qualityBefore: before.qualityScore,
        qualityAfter: winner.metrics.qualityScore,
        perCriteriaBefore: before.perCriteria ?? {},
        perCriteriaAfter: winner.metrics.perCriteria ?? {},
        note: `promoted ${newChamp.policy.id} (Δ +${winner.delta.toFixed(2)})${improvedNote ? `; improved: ${improvedNote}` : ""}`,
      };
      timeline.push(entry);
      await this.recordTimeline(entry);
      log(`round ${round}: PROMOTED ${newChamp.policy.id} — quality ${before.qualityScore.toFixed(3)} → ${winner.metrics.qualityScore.toFixed(3)}`);
    }

    return timeline;
  }
}
