import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// S4 §D — the STRUCTURED, retained record the HITL-POLICY §5 per-tenant promotion requires: a recorded
// eval+shadow result on a scale-representative corpus, NOT just stdout + an exit code. The operator's
// real-Vertex-at-scale run (DEPLOY.md runbook) emits one of these before enabling a tenant; the pgvector
// testcontainer test emits the same shape on the fake-embed path to prove the wiring in CI.

export interface RetrievalPromotionEvidence {
  tenantId: string;
  /** Embedding model id the run used (e.g. the Vertex model, or "fake-embed-…" in CI). */
  model: string;
  dimension: number;
  corpusSize: number;
  /** Fraction 0..1 of eval cases whose relevant product appeared in top-k (recall@k). `null` when this
   *  artifact was written by a run that does not measure recall (`pnpm shadow:retrieval` — see its own
   *  artifact for this tenant's `pnpm eval:retrieval` evidence instead). */
  recallAtK: number | null;
  /** Fraction 0..1 of eval cases with NO clearly-irrelevant product in top-k. Same `null` convention as
   *  `recallAtK`. */
  noWrongProduct: number | null;
  /** Shadow violation counts when narrowing the catalog (zero-tolerance safety bars). `null` when this
   *  artifact was written by `pnpm eval:retrieval` (which does not run the shadow harness) — see the
   *  companion `pnpm shadow:retrieval` artifact for this tenant's shadow result. When present, it is only
   *  ever `{0,0,0}`: today's shadow harness (`runShadow`/`safetyRegression`) does not categorize a
   *  violation into fabricated/stale/missing-product — it reports a single pass/fail per case — so an
   *  evidence artifact is written ONLY on the zero-violation (passing) run, where the all-zero split is
   *  trivially true regardless of category. A run with violations exits nonzero and writes no artifact. */
  shadow: { fabricated: number; stale: number; missingProduct: number } | null;
  vectorAnn: boolean;
  /** ISO-8601 timestamp the evidence was produced. */
  at: string;
}

/** Write the evidence to `reports/retrieval-promotion-evidence-<tenant>-<stamp>.json`; returns the path. */
export function writeRetrievalEvidence(ev: RetrievalPromotionEvidence, dir = "reports"): string {
  mkdirSync(dir, { recursive: true });
  const stamp = ev.at.replace(/[:.]/g, "-");
  const path = join(dir, `retrieval-promotion-evidence-${ev.tenantId}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(ev, null, 2));
  return path;
}
