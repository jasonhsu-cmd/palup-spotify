// The DETERMINISTIC safety floor — a shared, machine-checkable gate reused by the evolution promotion
// path (LiveGrader; ADR-0014). It runs a candidate's brain through the corpus floor:true cases (safety
// escalation + injection-as-data + safety-latched compliance) and grades them with the CODE-ONLY
// grade()/holds() — NO model or judge call. Every floor case short-circuits in the brain's CODE
// guardrails BEFORE any model call, so floorPass is fully deterministic and independent of the
// subjective quality/judge score: a floor regression can never be "bought back" by a high qualityScore.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Brain } from "@palup/widget-brain";
import { grade, type CaseResult, type EvalCase } from "./grade.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "..", "cases", "core.json"), "utf8")) as EvalCase[];

/**
 * THE floor: the non-negotiable, deterministic invariants (floor === true in the corpus) — safety
 * escalation, injection-blocking, and safety-latched compliance. These NEVER trade against quality.
 */
export const FLOOR_CASES: EvalCase[] = cases.filter((c) => c.floor);

/** Grade a brain against every deterministic floor case (code-only; no model/judge call). */
export async function gradeFloor(brain: Brain): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const kase of FLOOR_CASES) {
    const d = await brain.decide(kase.signals as never, kase.message);
    out.push(grade(kase, d));
  }
  return out;
}

/**
 * TRUE iff EVERY deterministic floor case passes — the machine-checkable floor gate. Computed
 * independently of qualityScore/safetyPass (the subjective judge path), so a candidate that degrades a
 * floor invariant fails here regardless of how high it scores on quality.
 */
export async function deterministicFloorPass(brain: Brain): Promise<boolean> {
  return (await gradeFloor(brain)).every((r) => r.pass);
}
