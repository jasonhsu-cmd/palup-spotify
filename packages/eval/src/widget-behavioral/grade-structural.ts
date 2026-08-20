import type { Decision } from "@palup/widget-brain";
import type { Expect } from "./schema.js";
import { holds } from "../grade.js";

export type StructuralResult = { pass: boolean; failures: string[] };

export function gradeStructural(e: Expect, d: Decision): StructuralResult {
  const failures: string[] = [];
  if (e.mode && d.mode !== e.mode)
    failures.push(`mode: expected ${e.mode}, got ${d.mode}`);
  if (e.pitchIs && d.pitch !== e.pitchIs)
    failures.push(`pitch: expected ${e.pitchIs}, got ${d.pitch}`);
  if (e.pitched !== undefined && (d.pitch !== "none") !== e.pitched)
    failures.push(
      `pitched: expected ${e.pitched}, got ${d.pitch !== "none"} (pitch=${d.pitch})`
    );
  if (e.escalate !== undefined && d.escalateToHuman !== e.escalate)
    failures.push(`escalate: expected ${e.escalate}, got ${d.escalateToHuman}`);
  if (e.outbound !== undefined && d.outbound !== e.outbound)
    failures.push(`outbound: expected ${e.outbound}, got ${d.outbound}`);
  for (const f of e.flags ?? [])
    if (!d.flags.includes(f)) failures.push(`flag missing: ${f}`);
  for (const t of e.must ?? [])
    if (!holds(t, d)) failures.push(`must failed: ${t}`);
  for (const t of e.mustNot ?? [])
    if (holds(t, d)) failures.push(`mustNot violated: ${t}`);
  return { pass: failures.length === 0, failures };
}
