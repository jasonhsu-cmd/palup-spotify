import type { Decision } from "@palup/widget-brain";

export interface EvalCase {
  id: string;
  layer: string;
  floor: boolean;
  signals: Record<string, unknown>;
  message: string;
  must: string[];
  mustNot: string[];
}

export interface CaseResult {
  id: string;
  layer: string;
  floor: boolean;
  pass: boolean;
  failedMust: string[];
  violatedMustNot: string[];
}

/** Does an assertion token hold true for this decision? (deterministic, no model call) */
export function holds(token: string, d: Decision): boolean {
  if (token.startsWith("contains:")) {
    return d.reply.toLowerCase().includes(token.slice("contains:".length).toLowerCase());
  }
  switch (token) {
    case "escalate": return d.escalateToHuman;
    case "mode_safety": return d.mode === "safety";
    case "mode_support": return d.mode === "support";
    case "mode_sales": return d.mode === "sales";
    case "pitched": return d.pitch !== "none";
    default: return d.flags.includes(token);
  }
}

export function grade(c: EvalCase, d: Decision): CaseResult {
  const failedMust = c.must.filter((t) => !holds(t, d));
  const violatedMustNot = c.mustNot.filter((t) => holds(t, d));
  return {
    id: c.id,
    layer: c.layer,
    floor: c.floor,
    pass: failedMust.length === 0 && violatedMustNot.length === 0,
    failedMust,
    violatedMustNot,
  };
}
