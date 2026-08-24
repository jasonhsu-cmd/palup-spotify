import type { AgentAction, LearnedInsight, LearnedStore, ReversalPlan, RuntimeStateCtx } from "@palup/platform-ports";
import { proposeOrExecute, type EngineDeps, type Executor, type ProposeOrExecuteResult } from "./loop.js";

/** Voice changes are proposed by the insight synthesizer agent — the same agent type the LearnedStore's
 *  voice insights are attributed to. */
export const VOICE_AGENT_TYPE = "insight_synthesizer";

export interface ProposeVoiceChangeInput { ctx: RuntimeStateCtx; now: string; proposedVoiceText: string; rationale: string; agentId?: string; }

/**
 * The agent PROPOSING a voice change — never a silent write (spec §10: "merchant owns voice — the agent
 * may propose voice changes but never silently alters how it talks"). Routed through the W1 spine
 * (`proposeOrExecute`) as `autonomy_scope`, which is NEVER auto-eligible (`AUTO_ELIGIBLE_DIMENSIONS
 * .autonomy_scope = []`, `PALUP_FLOORS.autonomy_scope.maxAutoPct = 0`) — so it always becomes a pending
 * proposal the merchant must approve. `assertNotKilled` (inside `proposeOrExecute`) still gates it.
 * Belt-and-suspenders: `action.type = "change_voice"` is ALSO unmapped in `classify.ts`'s
 * `ACTION_TYPE_CATEGORY`, so `categoryForAction` independently re-derives `autonomy_scope` from the
 * action itself (the loop never trusts a caller-declared category) — this is doubly, not singly,
 * forced into the pending path.
 */
export async function proposeVoiceChange(input: ProposeVoiceChangeInput, deps: EngineDeps): Promise<ProposeOrExecuteResult> {
  const action: AgentAction = { type: "change_voice", params: { proposedVoiceText: input.proposedVoiceText }, irreversible: false };
  const reversalPlan: ReversalPlan = {
    reversible: true,
    plan: "Reversible: the prior voice guidance stays in the Learned store; delete the new voice insight (DELETE /learned/:id) or re-teach the prior wording to revert. Nothing is sent to shoppers by approving a voice change.",
  };
  const result = await proposeOrExecute(
    { ctx: input.ctx, agentId: input.agentId ?? VOICE_AGENT_TYPE, agentType: VOICE_AGENT_TYPE, category: "autonomy_scope",
      rationale: input.rationale, reversalPlan, now: input.now, action,
      estimatedImpact: { note: "Changes how the agent talks; no direct spend or send." } },
    deps,
  );
  // Defensive (§3): a voice/behavior change must NEVER auto-apply. If the loop ever executes one, that is
  // a governance breach, not a result to return silently.
  if (result.kind === "executed") {
    throw new Error("proposeVoiceChange: a voice change was auto-executed — this must never happen (CLAUDE.md §3); voice is merchant-owned and requires approval");
  }
  return result;
}

/** The executor the W1 loop runs on APPROVAL: it writes the approved voice text as a private voice
 *  insight. Attributed to the synthesizer (origin "synthesized"); confidence "high" because a human
 *  approved it. `newId`/`now` injected (no `Date.now()`/uuid in this module). */
export function voiceChangeExecutor(learnedStore: LearnedStore, newId: () => string, now: () => string): Executor {
  return async ({ ctx, agentId, action }) => {
    const text = String(action.params.proposedVoiceText ?? "").trim();
    if (!text) return { ok: false, detail: "empty voice text — nothing to apply" };
    const at = now();
    const insight: LearnedInsight = {
      id: newId(), tenantId: ctx.tenantId, category: "voice", tier: "private", origin: "synthesized",
      text, grounding: { source: "approved_voice_change", sampleSize: 0, confidence: "high" },
      pinned: false, createdAt: at, updatedAt: at,
    };
    await learnedStore.record(ctx, insight, agentId);
    return { ok: true, detail: `voice insight ${insight.id} recorded` };
  };
}
