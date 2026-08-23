// proposeOrExecute — the engine loop that ties classification (classify.ts) to the durable
// proposal registry (proposal-store.ts): every `AgentAction` a run-time agent wants to take flows
// through here. `classifyAction` decides "auto" vs "requires_approval" (CLAUDE.md §3.1); "auto"
// calls the injected `executor` directly and audits the result, "requires_approval" NEVER executes
// — it lands as a pending `Proposal` for a human via the Approval Center (W1). A `reversalPlan` is
// mandatory for either path: this module refuses to even classify an action with none (governance
// non-negotiable — no boundary-crossing action may run without a way back).
//
// Determinism: `now` is caller-supplied ISO (no `Date.now()` here) so the loop is a pure function
// of its inputs given a fixed `now` — replayable in tests and evals.

import { randomUUID } from "node:crypto";
import type { RuntimeStateCtx, RuntimeStatePort } from "@palup/platform-ports";
import { classifyAction, type RulesProvider } from "./classify.js";
import type { ProposalStore } from "./proposal-store.js";
import { ttlForCategory, type AgentAction, type Proposal, type ProposalCategory, type ReversalPlan } from "./types.js";

/** The outcome of running an `AgentAction` through the injected `Executor`. */
export interface ExecutionResult {
  ok: boolean;
  detail: string;
}

/** What an `Executor` is called with — enough to actually perform the action, plus (when executing
 * an already-approved `Proposal`) the minted idempotency key. */
export interface ExecutorInput {
  ctx: RuntimeStateCtx;
  agentId: string;
  agentType: string;
  action: AgentAction;
  /** Present when executing an approved proposal (Task 6) — the executor's own idempotency key. */
  executionId?: string;
}

/** Performs the real side effect (e.g. calls the commerce port). Feature code injects the real
 * implementation; tests inject a fake. Never called for a `requires_approval` classification. */
export type Executor = (input: ExecutorInput) => Promise<ExecutionResult>;

/** The result of re-checking a pending proposal's preconditions at approval time (Task 6) — the
 * world may have moved on since the proposal was created (e.g. the discount code expired, the SKU
 * sold out). */
export interface PreconditionResult {
  valid: boolean;
  reason?: string;
}

/** Re-validates a `Proposal`'s preconditions immediately before executing it. */
export type PreconditionValidator = (proposal: Proposal, ctx: RuntimeStateCtx) => Promise<PreconditionResult>;

/** Everything the loop needs, injected — no vendor SDK, no ambient state (portability + testability). */
export interface EngineDeps {
  store: ProposalStore;
  state: RuntimeStatePort;
  rules: RulesProvider;
  executor: Executor;
  validate: PreconditionValidator;
}

/** What a run-time agent hands the loop for one candidate action. `category` documents the
 * caller's own intent for traceability, but the loop always classifies from `action` itself
 * (`classifyAction`/`categoryForAction`) — a caller-declared category can never substitute for, or
 * widen, the classifier's own derivation. */
export interface ProposeInput {
  ctx: RuntimeStateCtx;
  agentId: string;
  agentType: string;
  category: ProposalCategory;
  rationale: string;
  reversalPlan: ReversalPlan;
  /** ISO-8601; caller-supplied (no `Date.now()` in this module). */
  now: string;
  action: AgentAction;
  preconditions?: Record<string, unknown>;
  estimatedImpact?: Proposal["estimatedImpact"];
}

export interface ProposeOrExecuteResult {
  kind: "executed" | "proposed";
  proposal?: Proposal;
  result?: ExecutionResult;
}

/** `new Date(iso).toISOString()` always appends milliseconds (`.000Z`); category TTLs land on
 * whole seconds in every test/spec fixture, so trim a trailing `.000Z` back to `Z` for a
 * predictable, human-diffable ISO string. */
function addIso(iso: string, ms: number): string {
  const out = new Date(new Date(iso).getTime() + ms).toISOString();
  return out.endsWith(".000Z") ? `${out.slice(0, -5)}Z` : out;
}

/**
 * Run one `AgentAction` through classification. "auto" executes immediately (audited); otherwise a
 * `pending` `Proposal` is created for the Approval Center (audited). Throws if `reversalPlan` is
 * missing — never classifies, let alone executes, a boundary-crossing action with no way back.
 */
export async function proposeOrExecute(input: ProposeInput, deps: EngineDeps): Promise<ProposeOrExecuteResult> {
  if (!input.reversalPlan) {
    throw new Error("proposeOrExecute: reversalPlan is required — no action may proceed without a way back");
  }

  const classification = await classifyAction(input.action, input.ctx, deps.rules);

  if (classification.decision === "auto") {
    const result = await deps.executor({
      ctx: input.ctx,
      agentId: input.agentId,
      agentType: input.agentType,
      action: input.action,
    });
    await deps.state.audit(
      input.ctx,
      {
        actor: input.agentId,
        action: "agent.action.auto",
        input: { agentType: input.agentType, category: classification.category, action: input.action },
        decision: { result },
        reversalPath: input.reversalPlan.plan,
      },
      input.now,
    );
    return { kind: "executed", result };
  }

  const proposal: Proposal = {
    id: randomUUID(),
    tenantId: input.ctx.tenantId,
    agentId: input.agentId,
    agentType: input.agentType,
    action: input.action,
    category: classification.category,
    rationale: input.rationale,
    boundaryReasons: classification.boundaryReasons,
    estimatedImpact: input.estimatedImpact,
    reversalPlan: input.reversalPlan,
    preconditions: input.preconditions ?? {},
    status: "pending",
    version: 0,
    createdAt: input.now,
    expiresAt: addIso(input.now, ttlForCategory(classification.category)),
  };

  const created = await deps.store.create(proposal);
  await deps.state.audit(
    input.ctx,
    {
      actor: input.agentId,
      action: "proposal.created",
      input: { id: created.id, category: created.category, action: created.action },
      decision: { status: created.status, boundaryReasons: created.boundaryReasons },
      reversalPath: created.reversalPlan.plan,
    },
    input.now,
  );
  return { kind: "proposed", proposal: created };
}
