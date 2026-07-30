import { crossFamilyGuard } from "@palup/judge";

/**
 * The model family the LIVE shopper agent runs on today (Gemini) — see LiveGrader / eval judge-run.
 * The cross-family promotion gate compares the grading judge against THIS.
 */
export const AGENT_FAMILY = "gemini";

/**
 * The judge family a LiveGrader actually ends up with. Mirrors live-grader.ts EXACTLY: the Anthropic
 * cross-family judge when its key is configured, else the same-family Gemini fallback — which is NOT
 * gating. Extracted so the fail-closed decision is unit-testable without a live API.
 */
export function liveJudgeFamily(anthropicConfigured: boolean): string {
  return anthropicConfigured ? "anthropic" : "gemini";
}

export interface GatingDecision {
  /** May this grade GATE a promotion? Only a cross-family (proposer≠evaluator) judge may. */
  gating: boolean;
  agentFamily: string;
  judgeFamily: string;
  reason: string;
}

/**
 * Fail-CLOSED cross-family gate check (ADR-0014 security/steward review). A promotion-governing grade
 * may ONLY come from a judge in a DIFFERENT model family than the agent runtime. Calls crossFamilyGuard
 * in STRICT mode and REFUSES (gating:false) when the judge family == the agent family — the
 * Gemini-judges-Gemini advisory fallback (ANTHROPIC_API_KEY unset), or any case where no cross-family
 * judge is available. An advisory grade may still RUN (labelled), but stamps gating:false so engine.gate
 * will not treat its score as a pass. A real cross-family (Anthropic) judge returns gating:true.
 */
export function decideGating(agentFamily: string, judgeFamily: string): GatingDecision {
  try {
    crossFamilyGuard(agentFamily, judgeFamily, { strict: true });
    return { gating: true, agentFamily, judgeFamily, reason: `cross-family judge (${judgeFamily}) — gating` };
  } catch (e) {
    return { gating: false, agentFamily, judgeFamily, reason: (e as Error).message };
  }
}
