// The executor/validator registry the approve path (`executeApproved`, `agent-runtime/loop.ts`)
// is built on. Fail-closed by construction (CLAUDE.md §3/§4 — no silent no-op): an `AgentAction`
// whose `type` has no registered executor, or a `Proposal` whose `category` has no registered
// validator, THROWS rather than being silently executed with a no-op / silently approved with an
// always-valid stub. Extend the `switch` in each `resolve*` function as new run-time agents land;
// never widen either function to a default branch that executes/validates something unregistered.

import { randomUUID } from "node:crypto";
import type { CampaignCommsPort, LearnedStore, MerchantRulesStore, ProposalCategory, ProposalStore, RefundPort, RuntimeStatePort } from "@palup/platform-ports";
import {
  applyRuleChangeFromProposal,
  campaignExecutor,
  voiceChangeExecutor,
  refundExecutor,
  RULE_CHANGE_ACTION_TYPE,
  REFUND_ACTION_TYPE,
  type EngineDeps,
  type Executor,
  type PreconditionValidator,
  type RulesProvider,
} from "@palup/agent-runtime";

/** Everything a registered executor/validator might need to resolve. Grows as new run-time agents
 *  (beyond the win-back campaign agent) land their own action types/categories.
 *  `learnedStore` (W3 Task 6): needed to resolve `change_voice` -> `voiceChangeExecutor` — optional
 *  because it is irrelevant to every OTHER registered action type; `resolveExecutor` throws a clear
 *  error if a `change_voice` proposal is approved without one wired, rather than silently no-op'ing.
 *  `rulesStore` (W4-broaden Task 7): needed to resolve `change_rules` -> the executor that applies an
 *  agent-proposed rule-envelope change via `applyRuleChangeFromProposal` — same optional-because-
 *  irrelevant-to-other-types convention, same fail-closed throw if missing.
 *  `refundPort` (W5 Task 8): needed only when `actionType === REFUND_ACTION_TYPE` — the (dark by
 *  default) refund adapter. Optional/irrelevant to other types; `resolveExecutor` throws fail-closed
 *  if a refund is approved without one wired. */
export interface EngineWiringDeps {
  comms: CampaignCommsPort;
  learnedStore?: LearnedStore;
  rulesStore?: MerchantRulesStore;
  refundPort?: RefundPort;
}

/**
 * Resolves an `AgentAction.type` to the `Executor` that performs it. `send_campaign` -> the
 * win-back agent's `campaignExecutor` bound to `deps.comms`; `change_voice` (W3 Task 6) -> the
 * insight synthesizer's `voiceChangeExecutor` bound to `deps.learnedStore` — this is the ONLY place
 * a voice change is ever actually written, and only reachable via the approve path
 * (`executeApproved`), never on proposal creation. `change_rules` (W4-broaden Task 7) -> a closure
 * that calls `applyRuleChangeFromProposal(..., deps.rulesStore, ...)` — the ONLY place an
 * agent-proposed rule-envelope change is ever actually written to `MerchantRulesStore`, and only
 * reachable here, post human-approval, never on proposal creation (CLAUDE.md §3.1). `issue_refund`
 * (W5 Task 8) -> `refundExecutor(deps.refundPort)` — the ONLY place a refund side-effect ever runs,
 * reached either from `executeApproved` post human-approval, or (tiny in-policy goodwill within
 * `PALUP_FLOORS.refund`) from `proposeOrExecute`'s auto path; this registry does not distinguish the
 * two, it just resolves the action type to the executor. Throws on any unregistered type —
 * `executeApproved` must never fall through to a silent no-op for an action it doesn't recognize.
 */
export function resolveExecutor(actionType: string, deps: EngineWiringDeps): Executor {
  switch (actionType) {
    case "send_campaign":
      return campaignExecutor(deps.comms);
    case "change_voice":
      if (!deps.learnedStore) {
        throw new Error("resolveExecutor: change_voice requires a learnedStore, none was wired");
      }
      return voiceChangeExecutor(deps.learnedStore, randomUUID, () => new Date().toISOString());
    case RULE_CHANGE_ACTION_TYPE:
      if (!deps.rulesStore) {
        throw new Error(`resolveExecutor: ${RULE_CHANGE_ACTION_TYPE} requires a rulesStore, none was wired`);
      }
      return async (input) => {
        // The proposal already passed human approval + the kill/status guard in executeApproved.
        await applyRuleChangeFromProposal({ action: input.action }, deps.rulesStore!, input.ctx, input.agentId);
        return { ok: true, detail: "rule change applied (agent_proposed, post-approval)" };
      };
    case REFUND_ACTION_TYPE:
      if (!deps.refundPort) {
        throw new Error(`resolveExecutor: ${REFUND_ACTION_TYPE} requires a refundPort, none was wired`);
      }
      return refundExecutor(deps.refundPort);
    default:
      throw new Error(`resolveExecutor: no executor registered for action type "${actionType}"`);
  }
}

/**
 * Resolves a `ProposalCategory` to the `PreconditionValidator` `executeApproved` re-checks
 * immediately before executing an approved proposal (the world may have moved on since it was
 * created). v1 is minimal: `campaign` always validates (a win-back send has no time-sensitive
 * precondition to re-check beyond what the kill-switch/status-guard in `executeApproved` already
 * enforce); `autonomy_scope` (W3 Task 6 — voice changes; W4-broaden Task 7 — agent-proposed rule
 * changes share this same category) likewise always validates: the human approval itself IS the
 * gate for both — there is no time-sensitive external state (stock, discount code, budget) that
 * could have moved on since the proposal was created. `refund` (W5 Task 8) also always validates
 * here: the kill/status guard in `executeApproved` plus the `PALUP_FLOORS.refund` clamp already
 * gate it — see the `TODO(v2)` below for the real per-category revalidation this is a placeholder
 * for. Throws on any unregistered category — never a silent always-valid for a category this
 * registry doesn't know about yet.
 *
 * TODO(v2): add real per-category revalidation as agents that need it land — e.g. `discount` should
 * re-check the merchant's current rule caps (the discount % might have been tightened since the
 * proposal was created), `ad_spend` should re-check the remaining budget cap, `refund` should
 * re-check the order is still eligible (not already refunded/cancelled) once a live refund adapter
 * exists — the sandbox adapter has no real order state to re-check against.
 */
export function resolveValidator(category: ProposalCategory, _deps: EngineWiringDeps): PreconditionValidator {
  switch (category) {
    case "campaign":
    case "autonomy_scope":
    case "refund":
      return async () => ({ valid: true });
    default:
      throw new Error(`resolveValidator: no validator registered for category "${category}"`);
  }
}

export interface BuildEngineDepsInput {
  store: ProposalStore;
  state: RuntimeStatePort;
  rules: RulesProvider;
  /** The `AgentAction.type` the approve path is about to execute — resolves `executor`. */
  actionType: string;
  /** The `Proposal.category` the approve path is about to execute — resolves `validate`. */
  category: ProposalCategory;
  comms: CampaignCommsPort;
  /** W3 Task 6: needed only when `actionType === "change_voice"` — see `EngineWiringDeps`. */
  learnedStore?: LearnedStore;
  /** W4-broaden Task 7: needed only when `actionType === "change_rules"` — see `EngineWiringDeps`. */
  rulesStore?: MerchantRulesStore;
  /** W5 Task 8: needed only when `actionType === REFUND_ACTION_TYPE` — see `EngineWiringDeps`. */
  refundPort?: RefundPort;
}

/** Composes a full `EngineDeps` for the approve path (`executeApproved`) from the registry above —
 *  the same shape `internal-winback.ts` currently builds by hand; routes should prefer this going
 *  forward so the registry (and its fail-closed guarantees) stays the single place actions/
 *  categories are wired up. */
export function buildEngineDeps(input: BuildEngineDepsInput): EngineDeps {
  const wiring: EngineWiringDeps = { comms: input.comms, learnedStore: input.learnedStore, rulesStore: input.rulesStore, refundPort: input.refundPort };
  return {
    store: input.store,
    state: input.state,
    rules: input.rules,
    executor: resolveExecutor(input.actionType, wiring),
    validate: resolveValidator(input.category, wiring),
  };
}
