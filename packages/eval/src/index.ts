// Package entrypoint for @palup/eval — the DETERMINISTIC eval surface (code-only, no model/judge call)
// reused by the control plane's promotion gate (see live-grader.ts). The heavier live-eval scripts
// (judge-run, eval-full) stay behind their own files and are intentionally NOT re-exported here, so this
// import graph pulls in no model/judge SDK.
export { grade, holds } from "./grade.js";
export type { EvalCase, CaseResult } from "./grade.js";
export { FLOOR_CASES, gradeFloor, deterministicFloorPass } from "./floor.js";
