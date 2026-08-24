import { createHmac } from "node:crypto";
import { gradeInsight, type ConfidenceTier, type LearnedCategory, type LearnedInsight } from "./learned-store.js";

// W3 Task 2 — the two-tier aggregate cross-merchant PRIOR layer (spec §10, §13). This is the single
// most privacy-sensitive piece in W3: it sits behind a HARD WALL from Task 1's private, per-tenant
// `LearnedStore` (`learned-store.ts`). No store's specifics — tenant id, insight id, source, pins,
// timestamps — may ever cross into an aggregate prior. Only category/text/sampleSize survive, plus a
// one-way HMAC tag used solely to count DISTINCT contributors for k-anonymity.
//
// Build DARK per CLAUDE.md §3 + §13: enabling this is a legal/security-gated, human-only step, never
// a build agent's, and never a side effect of other work. This task builds the mechanism and store
// with ZERO live callers — nothing in serving/production calls `contribute` or `readPriors`.

/** The aggregate cross-merchant layer's build-time gate — memory's double-gate pattern (flag.ts): even
 *  with `AGGREGATE_LEARNING_ENABLED=true`, this const being `false` keeps it OFF. Flipping it is a
 *  legal/security review (spec §13: the private↔aggregate boundary needs a rigorous "aggregate enough" +
 *  competitive-fairness definition first), a named-human code change — NEVER a build agent's, NEVER a
 *  side effect of other work. */
export const AGGREGATE_LEARNING_ADR_ACCEPTED = false;

/** True only when BOTH the operator flag is the exact string "true" AND the ADR has been accepted in
 * code. Any other value (unset, "1", "yes", "", wrong case, …) is treated as off — fail closed. */
export function isAggregateLearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGGREGATE_LEARNING_ENABLED === "true" && AGGREGATE_LEARNING_ADR_ACCEPTED;
}

/** k-anonymity floor: a prior is not readable until at least this many DISTINCT merchants contributed the
 *  same insight — so no single store's specifics can be reverse-identified from a prior. The exact value
 *  and the whole readability rule are part of the deferred legal/security review; this is a conservative
 *  placeholder for the mechanism. */
export const MIN_CONTRIBUTING_MERCHANTS = 5;

export interface AggregatePriorContribution {
  category: LearnedCategory;
  text: string;
  sampleSize: number;
  contributorTag: string;
}

/** The hard wall in one function: reduce a private `LearnedInsight` to ONLY the fields an aggregate prior
 *  may carry — category, text, sampleSize — plus a one-way HMAC of the tenant id used solely to count
 *  DISTINCT contributors for k-anonymity (never reversible to the tenant, never surfaced in a read). No
 *  id, tenantId, source, pins, or timestamps cross. */
export function anonymizePrivateInsight(insight: LearnedInsight, secret: string): AggregatePriorContribution {
  return {
    category: insight.category,
    text: insight.text,
    sampleSize: insight.grounding.sampleSize,
    contributorTag: createHmac("sha256", secret).update(insight.tenantId).digest("hex"),
  };
}

export interface AggregatePrior {
  category: LearnedCategory;
  text: string;
  sampleSize: number;
  contributingMerchants: number;
  confidence: ConfidenceTier;
}

export interface AggregatePriorStore {
  contribute(insight: LearnedInsight, secret: string): Promise<void>;
  readPriors(filter?: { category?: LearnedCategory }): Promise<AggregatePrior[]>;
}

interface Bucket {
  category: LearnedCategory;
  text: string;
  totalSample: number;
  contributors: Set<string>;
}

/** In-memory aggregate store — the tested MECHANISM. Production reads are hard-off
 * (`isAggregateLearningEnabled` ⇒ false via the ADR const); the `isEnabled` inject exists ONLY so the
 * k-anon/dedup logic can be unit-tested, never as a runtime enable path. Keyed by (category, normalized
 * text). */
export class InMemoryAggregatePriorStore implements AggregatePriorStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly isEnabled: () => boolean;

  constructor(opts: { isEnabled?: () => boolean } = {}) {
    this.isEnabled = opts.isEnabled ?? (() => isAggregateLearningEnabled());
  }

  async contribute(insight: LearnedInsight, secret: string): Promise<void> {
    const c = anonymizePrivateInsight(insight, secret);
    const key = `${c.category}::${c.text.trim().toLowerCase()}`;
    const b = this.buckets.get(key) ?? { category: c.category, text: c.text, totalSample: 0, contributors: new Set<string>() };
    // Dedup by contributor tag: count each distinct tenant once for BOTH the k-anon floor and the
    // sample sum (no inflation from a single tenant re-contributing the same insight).
    if (!b.contributors.has(c.contributorTag)) {
      b.contributors.add(c.contributorTag);
      b.totalSample += c.sampleSize;
    }
    this.buckets.set(key, b);
  }

  async readPriors(filter?: { category?: LearnedCategory }): Promise<AggregatePrior[]> {
    if (!this.isEnabled()) return []; // dark: no cross-merchant prior is ever read while disabled
    const out: AggregatePrior[] = [];
    for (const b of this.buckets.values()) {
      if (filter?.category && b.category !== filter.category) continue;
      if (b.contributors.size < MIN_CONTRIBUTING_MERCHANTS) continue; // k-anon floor
      const verdict = gradeInsight({ category: b.category, text: b.text, source: "aggregate", sampleSize: b.totalSample });
      if (!verdict.surface) continue;
      out.push({
        category: b.category,
        text: b.text,
        sampleSize: b.totalSample,
        contributingMerchants: b.contributors.size,
        confidence: verdict.confidence,
      });
    }
    return out;
  }
}
