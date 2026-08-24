import type { RuntimeStateCtx, RuntimeStatePort } from "./runtime-state-port.js";

// W3 Task 1 — the per-tenant LEARNED layer (spec §10 "Learned/Memory & Voice"): insights the
// platform synthesizes about a merchant's own customers/products/voice/policies from that
// merchant's own data, plus insights a merchant explicitly teaches. Lives here (not in
// `@palup/agent-runtime`) for the SAME reason `MerchantRulesStore`/`PrimaryGoalStore` do — a
// Postgres-backed adapter (`@palup/state-postgres`, Task 3) must import this port/types without a
// package cycle. Registry pattern over `RuntimeStatePort` (mirrors `merchant-rules-store.ts` /
// `primary-goal-store.ts`): tenant isolation rides on the port's own guarantee.
//
// Build DARK per CLAUDE.md §3: this is a storage/grading port only. No §3 HITL surface, no flag
// flip, no caller wiring yet — that is a later task in this same W3 build.

export type LearnedCategory = "customers" | "products" | "voice" | "policies";
export type LearnedTier = "private" | "aggregate";
export type LearnedOrigin = "synthesized" | "merchant_taught";
/** "low" is never surfaced — it is a drop (see `gradeInsight`), not a stored/returned value. */
export type ConfidenceTier = "medium" | "high";

export interface LearnedGrounding {
  source: string;
  sampleSize: number;
  confidence: ConfidenceTier;
}

export interface LearnedInsight {
  id: string;
  tenantId: string;
  category: LearnedCategory;
  tier: LearnedTier;
  origin: LearnedOrigin;
  text: string;
  grounding: LearnedGrounding;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InsightCandidate {
  category: LearnedCategory;
  text: string;
  source: string;
  sampleSize: number;
}

export type GroundingVerdict = { surface: false; reason: string } | { surface: true; confidence: ConfidenceTier };

/** Below this observation count an insight is NOT surfaced at all — a wrong insight acted on burns
 * trust. Between this and the high floor it surfaces at "medium". */
export const INSIGHT_SURFACE_MIN_SAMPLE = 30;
/** At/above this an insight may earn "high" confidence. Deliberately generous — mirrors the spirit
 * of attribution's `MIN_EXPOSURES_PER_ARM` (200, `outcome-ledger.ts`) floor: a headline claim needs
 * a real sample behind it. */
export const INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE = 200;

/** The conservative grounding gate the insight synthesizer runs BEFORE anything is surfaced. No
 * source, empty text, or a sub-floor sample size all drop the candidate (never a fabricated "high"
 * confidence over thin data — that is what makes this gate conservative). */
export function gradeInsight(c: InsightCandidate): GroundingVerdict {
  if (!c.text.trim()) return { surface: false, reason: "empty insight text" };
  if (!c.source.trim()) return { surface: false, reason: "no grounding source" };
  if (c.sampleSize < INSIGHT_SURFACE_MIN_SAMPLE) {
    return { surface: false, reason: `sample size ${c.sampleSize} below floor ${INSIGHT_SURFACE_MIN_SAMPLE}` };
  }
  return { surface: true, confidence: c.sampleSize >= INSIGHT_HIGH_CONFIDENCE_MIN_SAMPLE ? "high" : "medium" };
}

export type TeachingStance = "tighten" | "loosen";

/** Guardrail keys a merchant teaching may only TIGHTEN, never loosen — the teaching safety floor.
 * These are engine/product-owned keys the future teaching-write path will pass; they do NOT
 * reference `PALUP_FLOORS` (`merchant-rules-store.ts`) — that map is keyed by `ProposalCategory`
 * (discount/refund/campaign/subscription/ad_spend/autonomy_scope), a different vocabulary entirely,
 * not by a guardrail key. Seeded conservatively (money-adjacent + safety-critical answer types); the
 * teaching-write path (a later W3 task) is what will actually call `isSafetyFloorViolation` with
 * real guardrail keys as they're defined. */
export const SAFETY_CRITICAL_GUARDRAILS: ReadonlySet<string> = new Set([
  "mass_send_floor", "refund_cap", "discount_depth", "medical_safety_answer", "allergen_disclosure",
]);

/** True when `stance` would loosen a guardrail this platform treats as safety-critical — tightening
 * a guardrail is always allowed, in any direction, for any key. */
export function isSafetyFloorViolation(guardrailKey: string, stance: TeachingStance): boolean {
  return stance === "loosen" && SAFETY_CRITICAL_GUARDRAILS.has(guardrailKey);
}

export interface LearnedListFilter {
  category?: LearnedCategory;
  tier?: LearnedTier;
}

export class LearnedInsightNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`learned insight ${id}: not found`);
    this.name = "LearnedInsightNotFoundError";
  }
}

/** Tenant-scoped store for a merchant's PRIVATE learned layer. Every mutation audits internally
 * (NN#5), same obligation `MerchantRulesStore`/`PrimaryGoalStore` carry — there is no single
 * engine-loop call site that owns it. The aggregate (cross-merchant) tier is a structurally
 * SEPARATE store, not yet built in this task, and is never served from here — `list` treats any
 * non-"private" tier filter as an empty result, a hard wall rather than a leaky one. */
export interface LearnedStore {
  list(ctx: RuntimeStateCtx, filter?: LearnedListFilter): Promise<LearnedInsight[]>;
  get(ctx: RuntimeStateCtx, id: string): Promise<LearnedInsight | null>;
  record(ctx: RuntimeStateCtx, insight: LearnedInsight, by: string): Promise<LearnedInsight>;
  setPinned(ctx: RuntimeStateCtx, id: string, pinned: boolean, by: string, at: string): Promise<LearnedInsight>;
  remove(ctx: RuntimeStateCtx, id: string, by: string, at: string): Promise<void>;
}

const COLLECTION = "learned_private";

function newestFirst(a: LearnedInsight, b: LearnedInsight): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

export class InMemoryLearnedStore implements LearnedStore {
  constructor(private readonly store: RuntimeStatePort) {}

  async list(ctx: RuntimeStateCtx, filter?: LearnedListFilter): Promise<LearnedInsight[]> {
    // The private store NEVER serves the aggregate tier — that is a different store entirely
    // (hard wall, not a filter someone could accidentally widen).
    if ((filter?.tier ?? "private") !== "private") return [];
    const rows = await this.store.list<LearnedInsight>(ctx, COLLECTION);
    let items = rows.map((r) => r.value);
    if (filter?.category) items = items.filter((i) => i.category === filter.category);
    return items.sort(newestFirst);
  }

  async get(ctx: RuntimeStateCtx, id: string): Promise<LearnedInsight | null> {
    return this.store.get<LearnedInsight>(ctx, COLLECTION, id);
  }

  async record(ctx: RuntimeStateCtx, insight: LearnedInsight, by: string): Promise<LearnedInsight> {
    await this.store.put(ctx, COLLECTION, insight.id, insight);
    await this.store.audit(
      ctx,
      {
        actor: by,
        action: "learned.recorded",
        input: { id: insight.id, category: insight.category, origin: insight.origin, source: insight.grounding.source },
        decision: { confidence: insight.grounding.confidence, sampleSize: insight.grounding.sampleSize, tier: insight.tier },
        reversalPath: `LearnedStore.remove(ctx, "${insight.id}", by, at) deletes this insight for tenant ${ctx.tenantId}`,
      },
      insight.updatedAt,
    );
    return insight;
  }

  async setPinned(ctx: RuntimeStateCtx, id: string, pinned: boolean, by: string, at: string): Promise<LearnedInsight> {
    const cur = await this.store.get<LearnedInsight>(ctx, COLLECTION, id);
    if (!cur) throw new LearnedInsightNotFoundError(id);
    const next: LearnedInsight = { ...cur, pinned, updatedAt: at };
    await this.store.put(ctx, COLLECTION, id, next);
    await this.store.audit(
      ctx,
      {
        actor: by,
        action: "learned.pinned",
        input: { id, pinned },
        decision: { was: cur.pinned },
        reversalPath: `LearnedStore.setPinned(ctx, "${id}", ${cur.pinned}, by, at) restores the prior pin state`,
      },
      at,
    );
    return next;
  }

  async remove(ctx: RuntimeStateCtx, id: string, by: string, at: string): Promise<void> {
    const cur = await this.store.get<LearnedInsight>(ctx, COLLECTION, id);
    if (!cur) throw new LearnedInsightNotFoundError(id);
    await this.store.delete(ctx, COLLECTION, id);
    await this.store.audit(
      ctx,
      {
        actor: by,
        action: "learned.removed",
        input: { id, category: cur.category, origin: cur.origin },
        decision: { removed: true },
        reversalPath: `irreversible delete — re-teach via LearnedStore.record to restore it for tenant ${ctx.tenantId}`,
      },
      at,
    );
  }
}
