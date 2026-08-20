import type { Decision } from "@palup/widget-brain";
import type { BehavioralCase } from "./schema.js";
import { makeBrain } from "./brain-factory.js";
import { gradeStructural } from "./grade-structural.js";

export type CaseOutcome = {
  id: string;
  family: string;
  severity: string;
  riskClass: string;
  pass: boolean;
  failures: string[];
  decision: Decision;
};

/** Task 3 — run one single-turn BehavioralCase through a freshly-constructed brain. */
export async function runSingle(c: BehavioralCase): Promise<CaseOutcome> {
  if (c.message === undefined) throw new Error(`runSingle: case ${c.id} has no message`);
  const brain = makeBrain(c.brain);
  const decision = await brain.decide(c.signals as never, c.message);
  const g = gradeStructural(c.expect ?? {}, decision);
  return {
    id: c.id,
    family: c.family,
    severity: c.severity,
    riskClass: c.riskClass,
    pass: g.pass,
    failures: g.failures,
    decision,
  };
}
