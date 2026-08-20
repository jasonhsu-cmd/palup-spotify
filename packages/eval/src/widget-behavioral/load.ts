import { readFileSync } from "node:fs";
import type { BehavioralCase } from "./schema.js";

/**
 * Loads and validates a widget-behavioral case file. Kept deliberately small at Task 1 — just
 * enough shape-checking (array, unique id, exactly one of message/turns) that later tasks (the
 * runner, the grounding stub) can trust the corpus without re-deriving these invariants.
 */
export function loadCases(path: string): BehavioralCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as BehavioralCase[];
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array of cases`);
  const ids = new Set<string>();
  for (const c of raw) {
    if (!c.id) throw new Error(`${path}: a case is missing id`);
    if (ids.has(c.id)) throw new Error(`${path}: duplicate case id ${c.id}`);
    ids.add(c.id);
    const hasMsg = typeof c.message === "string";
    const hasTurns = Array.isArray(c.turns);
    if (hasMsg === hasTurns) {
      throw new Error(`${path}: case ${c.id} must have exactly one of message or turns (not both, not neither)`);
    }
  }
  return raw;
}
