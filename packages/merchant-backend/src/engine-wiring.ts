// The executor/validator registry the approve path (`executeApproved`, `agent-runtime/loop.ts`)
// is built on. Fail-closed by construction (CLAUDE.md §3/§4 — no silent no-op): an `AgentAction`
// whose `type` has no registered executor, or a `Proposal` whose `category` has no registered
// validator, THROWS rather than being silently executed with a no-op / silently approved with an
// always-valid stub. Extend the `switch` in each `resolve*` function as new run-time agents land;
// never widen either function to a default branch that executes/validates something unregistered.

import { randomUUID } from "node:crypto";
import type { CampaignCommsPort, LearnedStore, ProposalCategory, ProposalStore, RuntimeStatePort } from "@palup/platform-ports";
import { campaignExecutor, voiceChangeExecutor, type EngineDeps, type Executor, type PreconditionValidator, type RulesProvider } from "@palup/agent-runtime";

/** Everything a registered executor/validator might need to resolve. Grows as new run-time agents
 *  (beyond the win-back campaign agent) land their own action types/categories.
 *  `learnedStore` (W3 Task 6): needed to resolve `change_voice` -> `voiceChangeExecutor` — optional
 *  because it is irrelevant to every OTHER registered action type; `resolveExecutor` throws a clear
 *  error if a `change_voice` proposal is approved without one wired, rather than silently no-op'ing. */
export interface EngineWiringDeps {
  comms: CampaignCommsPort;
  learnedStore?: LearnedStore;
}

/**
 * Resolves an `AgentAction.type` to the `Executor` that performs it. `send_campaign` -> the
 * win-back agent's `campaignExecutor` bound to `deps.comms`; `change_voice` (W3 Task 6) -> the
 * insight synthesizer's `voiceChangeExecutor` bound to `deps.learnedStore` — this is the ONLY place
 * a voice change is ever actually written, and only reachable via the approve path
 * (`executeApproved`), never on proposal creation. Throws on any unregistered type —
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
    default:
      throw new Error(`resolveExecutor: no executor registered for action type "${actionType}"`);
  }
}

/**
 * Resolves a `ProposalCategory` to the `PreconditionValidator` `executeApproved` re-checks
 * immediately before executing an approved proposal (the world may have moved on since it was
 * created). v1 is minimal: `campaign` always validates (a win-back send has no time-sensitive
 * precondition to re-check beyond what the kill-switch/status-guard in `executeApproved` already
 * enforce); `autonomy_scope` (W3 Task 6 — voice changes) likewise always validates: there is no
 * external state (stock, discount code, budget) that could have moved on for a voice-text change.
 * Throws on any unregistered category — never a silent always-valid for a category this registry
 * doesn't know about yet.
 *
 * TODO(v2): add real per-category revalidation as agents that need it land — e.g. `discount` should
 * re-check the merchant's current rule caps (the discount % might have been tightened since the
 * proposal was created), `ad_spend` should re-check the remaining budget cap, `refund` should
 * re-check the order is still eligible (not already refunded/cancelled).
 */
export function resolveValidator(category: ProposalCategory, _deps: EngineWiringDeps): PreconditionValidator {
  switch (category) {
    case "campaign":
    case "autonomy_scope":
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
}

/** Composes a full `EngineDeps` for the approve path (`executeApproved`) from the registry above —
 *  the same shape `internal-winback.ts` currently builds by hand; routes should prefer this going
 *  forward so the registry (and its fail-closed guarantees) stays the single place actions/
 *  categories are wired up. */
export function buildEngineDeps(input: BuildEngineDepsInput): EngineDeps {
  const wiring: EngineWiringDeps = { comms: input.comms, learnedStore: input.learnedStore };
  return {
    store: input.store,
    state: input.state,
    rules: input.rules,
    executor: resolveExecutor(input.actionType, wiring),
    validate: resolveValidator(input.category, wiring),
  };
}
