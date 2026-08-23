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

import { createHash, randomUUID } from "node:crypto";
import type { RuntimeStateCtx, RuntimeStatePort } from "@palup/platform-ports";
import { classifyAction, type RulesProvider } from "./classify.js";
import { assertNotKilled } from "./kill.js";
import { ProposalNotFoundError, type ProposalStore } from "./proposal-store.js";
import {
  ttlForCategory,
  type AgentAction,
  type Proposal,
  type ProposalCategory,
  type ProposalStatus,
  type ReversalPlan,
} from "./types.js";

/** Statuses `executeApproved` refuses to move past — a human (or the TTL) has already settled this
 * proposal's fate; re-approving it would silently overturn that decision. */
const TERMINAL_BLOCKING_STATUSES: ReadonlySet<ProposalStatus> = new Set(["rejected", "withdrawn", "expired", "killed"]);

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
    // Kill-Switch gate (governance non-negotiable #4): checked immediately before the ONLY
    // execution path in this function, so a killed merchant/agent-type/global halt can never reach
    // the executor. A `requires_approval` classification still creates its proposal below —
    // proposing is not autonomous execution; `executeApproved` (Task 6) re-checks this same gate
    // before it would ever execute an approved proposal.
    await assertNotKilled(deps.state, input.ctx, input.agentType);

    // F1 (NN#5 — no silent actions): write the INTENT record BEFORE calling the executor. If the
    // executor throws, or the process dies between the executor call and a result audit, this
    // record still exists — money never moves with zero audit trail. `deps.state.audit` commits
    // immediately (it is not part of a buffered tx), so this write is durable the instant it
    // resolves, independent of whatever happens next.
    const executionId = randomUUID();
    await deps.state.audit(
      input.ctx,
      {
        actor: input.agentId,
        action: "agent.action.auto.intent",
        input: { agentType: input.agentType, category: classification.category, action: input.action, executionId },
        decision: { status: "executing" },
        reversalPath: input.reversalPlan.plan,
      },
      input.now,
    );

    let result: ExecutionResult;
    try {
      result = await deps.executor({
        ctx: input.ctx,
        agentId: input.agentId,
        agentType: input.agentType,
        action: input.action,
        executionId,
      });
    } catch (e) {
      await deps.state.audit(
        input.ctx,
        {
          actor: input.agentId,
          action: "agent.action.failed",
          input: { agentType: input.agentType, category: classification.category, action: input.action, executionId },
          decision: { error: e instanceof Error ? e.message : String(e) },
          reversalPath: input.reversalPlan.plan,
        },
        input.now,
      );
      throw e;
    }

    await deps.state.audit(
      input.ctx,
      {
        actor: input.agentId,
        action: "agent.action.auto",
        input: { agentType: input.agentType, category: classification.category, action: input.action, executionId },
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

/** A deterministic idempotency key for one proposal — derived from `id` ALONE (never `decidedBy`).
 * F3 RULING: `execution_failed` is retryable (not in `TERMINAL_BLOCKING_STATUSES`), and a retry can
 * legitimately be re-approved by a DIFFERENT human than the one who approved the failed attempt.
 * Keying on `decidedBy` too would mint a NEW `executionId` for that retry, so a downstream commerce
 * port's idempotency check would no longer catch it — a double charge/refund. Keying on `id` alone
 * keeps the idempotency key stable across every retry of the same proposal, whoever approves it. */
function mintExecutionId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/**
 * Execute a proposal a human has approved (W1's `POST /approvals/:id/approve`). Re-validates
 * preconditions immediately before executing (the world may have moved on since the proposal was
 * created) and is idempotent: calling it again on an already-`executed` proposal is a no-op that
 * returns the settled row without touching the executor. Every transition is audited
 * (governance non-negotiable #5); the Kill-Switch is checked before any execution (#4).
 *
 * Takes `ctx` explicitly (not folded into `deps`) because every `ProposalStore`/`RuntimeStatePort`
 * call underneath is tenant-scoped — there is no cross-tenant lookup-by-id surface, by design
 * (tenant isolation is the port's core guarantee).
 */
export async function executeApproved(
  ctx: RuntimeStateCtx,
  id: string,
  decidedBy: string,
  now: string,
  deps: EngineDeps,
): Promise<Proposal> {
  const proposal = await deps.store.get(ctx, id);
  if (!proposal) throw new ProposalNotFoundError(id);

  await assertNotKilled(deps.state, ctx, proposal.agentType);

  if (proposal.status === "executed") return proposal; // idempotent short-circuit
  if (TERMINAL_BLOCKING_STATUSES.has(proposal.status)) {
    throw new Error(`executeApproved: proposal ${id} is ${proposal.status}, cannot execute`);
  }

  const validation = await deps.validate(proposal, ctx);
  if (!validation.valid) {
    await deps.state.audit(
      ctx,
      {
        actor: decidedBy,
        action: "proposal.revalidation_failed",
        input: { id, reason: validation.reason },
        decision: { status: proposal.status },
        reversalPath: proposal.reversalPlan.plan,
      },
      now,
    );
    throw new Error(`executeApproved: precondition no longer holds for proposal ${id}: ${validation.reason ?? "invalid"}`);
  }

  const executionId = mintExecutionId(id);

  const approved = await deps.store.transition(ctx, id, proposal.version, {
    status: "approved",
    decidedBy,
    decidedAt: now,
  });
  await deps.state.audit(
    ctx,
    {
      actor: decidedBy,
      action: "proposal.approved",
      input: { id },
      decision: { status: approved.status },
      reversalPath: approved.reversalPlan.plan,
    },
    now,
  );

  const executing = await deps.store.transition(ctx, id, approved.version, {
    status: "executing",
    executionId,
  });
  await deps.state.audit(
    ctx,
    {
      actor: decidedBy,
      action: "proposal.executing",
      input: { id, executionId },
      decision: { status: executing.status },
      reversalPath: executing.reversalPlan.plan,
    },
    now,
  );

  let result: ExecutionResult;
  try {
    result = await deps.executor({
      ctx,
      agentId: executing.agentId,
      agentType: executing.agentType,
      action: executing.action,
      executionId,
    });
  } catch (e) {
    const failed = await deps.store.transition(ctx, id, executing.version, {
      status: "execution_failed",
      executionResult: { ok: false, detail: e instanceof Error ? e.message : String(e) },
    });
    await deps.state.audit(
      ctx,
      {
        actor: decidedBy,
        action: "proposal.execution_failed",
        input: { id, executionId },
        decision: { status: failed.status, error: e instanceof Error ? e.message : String(e) },
        reversalPath: failed.reversalPlan.plan,
      },
      now,
    );
    return failed;
  }

  const finalStatus = result.ok ? "executed" : "execution_failed";
  const done = await deps.store.transition(ctx, id, executing.version, {
    status: finalStatus,
    executedAt: now,
    executionResult: result,
  });
  await deps.state.audit(
    ctx,
    {
      actor: decidedBy,
      action: finalStatus === "executed" ? "proposal.executed" : "proposal.execution_failed",
      input: { id, executionId },
      decision: { status: done.status, result },
      reversalPath: done.reversalPlan.plan,
    },
    now,
  );
  return done;
}

/**
 * A human (or automated policy) rejects a pending proposal. Optimistic-locked + audited; a rejected
 * proposal is terminal — `executeApproved` refuses to move it forward afterward.
 */
export async function rejectProposal(
  ctx: RuntimeStateCtx,
  id: string,
  decidedBy: string,
  reason: string,
  now: string,
  deps: EngineDeps,
): Promise<Proposal> {
  if (!reason || !reason.trim()) {
    throw new Error("rejectProposal: reason is required");
  }
  const proposal = await deps.store.get(ctx, id);
  if (!proposal) throw new ProposalNotFoundError(id);
  const rejected = await deps.store.transition(ctx, id, proposal.version, {
    status: "rejected",
    decidedBy,
    decidedAt: now,
    decisionNote: reason,
  });
  await deps.state.audit(
    ctx,
    {
      actor: decidedBy,
      action: "proposal.rejected",
      input: { id, reason },
      decision: { status: rejected.status },
      reversalPath: rejected.reversalPlan.plan,
    },
    now,
  );
  return rejected;
}

/**
 * The proposing agent (or an operator on its behalf) withdraws a still-pending proposal — e.g. the
 * opportunity it was chasing evaporated. Optimistic-locked + audited; terminal, same as `reject`.
 */
export async function withdrawProposal(
  ctx: RuntimeStateCtx,
  id: string,
  reason: string,
  now: string,
  deps: EngineDeps,
): Promise<Proposal> {
  if (!reason || !reason.trim()) {
    throw new Error("withdrawProposal: reason is required");
  }
  const proposal = await deps.store.get(ctx, id);
  if (!proposal) throw new ProposalNotFoundError(id);
  const withdrawn = await deps.store.transition(ctx, id, proposal.version, {
    status: "withdrawn",
    decidedAt: now,
    decisionNote: reason,
  });
  await deps.state.audit(
    ctx,
    {
      actor: proposal.agentId,
      action: "proposal.withdrawn",
      input: { id, reason },
      decision: { status: withdrawn.status },
      reversalPath: withdrawn.reversalPlan.plan,
    },
    now,
  );
  return withdrawn;
}

/**
 * Sweeps this tenant's pending proposals and expires any whose `expiresAt` has elapsed (`<= now`).
 * Called periodically (a cron/job, not per-request); each expiry is optimistic-locked + audited
 * individually so a concurrent decision on the same proposal can't be silently clobbered.
 */
export async function expireStale(ctx: RuntimeStateCtx, now: string, deps: EngineDeps): Promise<Proposal[]> {
  const { items } = await deps.store.list(ctx, { status: "pending" });
  const expired: Proposal[] = [];
  for (const p of items) {
    // F4: compare as instants, not strings — string comparison is lexicographic and gets the
    // ordering wrong across differing ISO precisions (e.g. "...Z" vs "....123Z").
    if (Date.parse(p.expiresAt) > Date.parse(now)) continue;
    const done = await deps.store.transition(ctx, p.id, p.version, {
      status: "expired",
      decidedAt: now,
      decisionNote: "ttl elapsed",
    });
    await deps.state.audit(
      ctx,
      {
        actor: "system",
        action: "proposal.expired",
        input: { id: p.id, expiresAt: p.expiresAt },
        decision: { status: done.status },
        reversalPath: done.reversalPlan.plan,
      },
      now,
    );
    expired.push(done);
  }
  return expired;
}
