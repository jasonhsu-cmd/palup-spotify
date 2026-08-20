import { createSession, type HistoryTurn } from "@palup/widget-brain";
import type { BehavioralCase, SessionInvariants } from "./schema.js";
import { makeBrain } from "./brain-factory.js";
import { gradeStructural } from "./grade-structural.js";

// Task 4 — multi-turn runner. Mirrors eval-full.ts:100-113's turn-replay loop (createSession is
// async; history is replayed each turn, exactly like the production server) but grades each turn
// structurally against `perTurnExpect`/`expect` and asserts end-of-arc Session-state invariants
// (`session.state` — confirmed a plain readonly property, not a method, at
// packages/widget-brain/src/session.ts:152/220 — fields `safetyLatched`/`openIssues`/`pitchesUsed`
// match SessionState at session.ts:69-71 exactly).

export type MultiOutcome = {
  id: string; family: string; severity: string; riskClass: string;
  pass: boolean; failures: string[];
  perTurn: { turn: number; reply: string; mode: string; pitch: string }[];
};

function checkInvariants(inv: SessionInvariants, state: any): string[] {
  const f: string[] = [];
  if (inv.safetyLatched !== undefined && Boolean(state.safetyLatched) !== inv.safetyLatched)
    f.push(`safetyLatched: expected ${inv.safetyLatched}, got ${Boolean(state.safetyLatched)}`);
  if (inv.openIssuesEmpty !== undefined && ((state.openIssues?.length ?? 0) === 0) !== inv.openIssuesEmpty)
    f.push(`openIssuesEmpty: expected ${inv.openIssuesEmpty}, got ${(state.openIssues?.length ?? 0) === 0}`);
  if (inv.pitchesUsedAtMost !== undefined && (state.pitchesUsed ?? 0) > inv.pitchesUsedAtMost)
    f.push(`pitchesUsed ${state.pitchesUsed} exceeds budget ${inv.pitchesUsedAtMost}`);
  return f;
}

/** Task 4 — run a multi-turn BehavioralCase (`turns`) through one Session, grading each turn and
 * the final Session-state invariants. */
export async function runMulti(c: BehavioralCase): Promise<MultiOutcome> {
  if (!c.turns) throw new Error(`runMulti: case ${c.id} has no turns`);
  const brain = makeBrain(c.brain);
  const s = await createSession(brain);
  const history: HistoryTurn[] = [];
  const failures: string[] = [];
  const perTurn: MultiOutcome["perTurn"] = [];
  const turns = c.turns;
  for (const [i, turn] of turns.entries()) {
    const d = await s.send(turn, c.signals as never, history);
    history.push({ role: "user", content: turn }, { role: "agent", content: d.reply });
    perTurn.push({ turn: i, reply: d.reply, mode: d.mode, pitch: d.pitch });
    const exp = c.perTurnExpect?.[i] ?? (i === turns.length - 1 ? c.expect : undefined);
    if (exp) gradeStructural(exp, d).failures.forEach((x) => failures.push(`turn ${i}: ${x}`));
  }
  if (c.session) checkInvariants(c.session, (s as any).state).forEach((x) => failures.push(x));
  return { id: c.id, family: c.family, severity: c.severity, riskClass: c.riskClass,
    pass: failures.length === 0, failures, perTurn };
}
