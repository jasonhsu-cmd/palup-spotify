import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteResult } from "./memory-recall-eval.js";

// semantic-memory-v1 (PR4/T10) — the STRUCTURED, retained record a future MEMORY_SEMANTIC_RECALL
// promotion decision would need, mirroring widget-backend/src/retrieval-promotion-evidence.ts's own
// `RetrievalPromotionEvidence` shape/writer 1:1 (same field discipline: `score: null` means genuinely
// UNMEASURED, never silently 0/100).
//
// NOTE FOR THE HUMAN WHO EVENTUALLY PROMOTES THIS FLAG (there is no runbook section for
// MEMORY_SEMANTIC_RECALL in docs/DEPLOY.md or docs/MEMORY-GO-LIVE-CHECKLIST.md yet — this file
// deliberately does not invent one; see this package's eval-memory-recall.ts header for what a human
// would need to do with this artifact before writing that runbook):
//   - This evidence is produced ENTIRELY on a deterministic, offline, hand-authored fixture with a MOCK
//     embed model — it proves the WIRING (ranking/floor/dedup all measurably work through the real
//     remember()/recall() paths), never quality on real embeddings, exactly like
//     widget-backend/src/eval-retrieval.ts's own fixture-only mode does for CATALOG_RETRIEVAL before its
//     §5 at-scale run. A real promotion would additionally need an at-scale run against a real embed
//     model — this harness does not attempt that (no Vertex dependency exists anywhere in this package).
//   - This gate does NOT flip MEMORY_SEMANTIC_RECALL, MEMORY_ENABLED, or MEMORY_ADR_ACCEPTED. Those stay
//     governed exactly as documented in flag.ts / service.ts's own doc comments (build-time,
//     human-reviewed, named-owner-merged changes) — a green run of this eval is necessary evidence for a
//     future promotion decision, never sufficient on its own, and never self-executing.

export interface MemoryRecallPromotionEvidence {
  suite: "relevance" | "safety-floor" | "dedup";
  passed: number;
  total: number;
  /** 0..100, or `null` when NOTHING was measured (suites.ts's "an absent measurement is not a pass"). */
  score: number | null;
  /** `true` ⇒ this suite must block promotion (any case failed, or nothing was measured at all). */
  blocked: boolean;
  cases: { id: string; pass: boolean; fails: string[] }[];
  /** The deterministic mock embed model id every case in this run used — NEVER a real Vertex model id;
   *  present so a reviewer can see at a glance that no real embeddings were involved in this artifact. */
  embedModel: string;
  at: string;
}

export function suiteToEvidence(suite: MemoryRecallPromotionEvidence["suite"], result: SuiteResult, embedModel: string, at: string): MemoryRecallPromotionEvidence {
  return { suite, passed: result.passed, total: result.total, score: result.score, blocked: result.blocked, cases: result.cases, embedModel, at };
}

/** Write the evidence to `reports/memory-recall-promotion-evidence-<stamp>.json`; returns the path. */
export function writeMemoryRecallEvidence(suites: MemoryRecallPromotionEvidence[], dir = "reports"): string {
  mkdirSync(dir, { recursive: true });
  const at = suites[0]?.at ?? new Date().toISOString();
  const stamp = at.replace(/[:.]/g, "-");
  const path = join(dir, `memory-recall-promotion-evidence-${stamp}.json`);
  writeFileSync(path, JSON.stringify(suites, null, 2));
  return path;
}
