// The win-back agent (WB): turns lapsed customers into a real Approval Center proposal. This is
// the first NEW run-time agent built on E1 (proposeOrExecute/executeApproved) + W4-min (merchant
// rules). Three pieces, built incrementally (this repo's `.superpowers/sdd/2026-08-23-WB-winback-
// agent/`):
//   1. `findLapsedSegment` + `draftWinBack` — the agent's INPUTS: who is lapsed, and what to say.
//      No LLM in v1 (deterministic template) — a generated draft is a later governed enhancement.
//   2. `proposeWinBack` — ALWAYS produces a pending `campaign` Proposal, NEVER auto-sends (task 3).
//   3. `campaignExecutor` — the approved-send path an operator's `executeApproved` call drives,
//      once (and only once) a human has approved the proposal (task 4).
//
// Determinism: no `Date.now()`/`Math.random()` anywhere in this module — `now` is always
// caller-supplied so the agent is replayable in tests/evals (same discipline as `loop.ts`).

import type {
  AgentAction,
  CampaignCommsPort,
  CampaignMessage,
  CustomerLastOrder,
  CustomerListingCommerce,
  ReversalPlan,
  RuntimeStateCtx,
} from "@palup/platform-ports";
import { proposeOrExecute, type EngineDeps, type Executor, type ProposeOrExecuteResult } from "../loop.js";

// --- Task 2: findLapsedSegment + draftWinBack -----------------------------------------------------

export interface FindLapsedSegmentOpts {
  /** A customer is "lapsed" once this many whole days have passed since their last order. */
  lapsedDays: number;
  /** ISO-8601 "now" — caller-supplied (no `Date.now()` in this module). */
  now: string;
}

/**
 * Selects the tenant's lapsed-customer segment: every customer whose last order is older than
 * `opts.lapsedDays` as of `opts.now`. Depends on the narrow `CustomerListingCommerce` capability
 * (not the full `CommercePort` — see `commerce-port.ts`'s header for why that method is optional),
 * so any adapter (a real Shopify Admin-API adapter, or the dev/test `SandboxCustomerDirectory`)
 * that implements it works here unchanged.
 */
export async function findLapsedSegment(
  commerce: CustomerListingCommerce,
  ctx: RuntimeStateCtx,
  opts: FindLapsedSegmentOpts,
): Promise<CustomerLastOrder[]> {
  const all = await commerce.listCustomersWithLastOrder(ctx);
  const nowMs = Date.parse(opts.now);
  const thresholdMs = opts.lapsedDays * 24 * 3600_000;
  return all.filter((c) => nowMs - Date.parse(c.lastOrderAt) > thresholdMs);
}

/** The win-back agent's outbound message shape — matches `CampaignMessage` (`comms-port.ts`) minus
 *  `to` (the recipient is filled in per-customer by `proposeWinBack`/`campaignExecutor`). */
export interface WinBackDraft {
  channel: "email" | "sms";
  subject?: string;
  body: string;
}

/**
 * Drafts the win-back message for a lapsed segment. Deliberately NOT model-generated in v1 — a
 * fixed, deterministic template referencing the brand, so the same segment+brand always produces
 * the exact same draft (replayable, no model-port dependency, no governed-prompt surface to
 * evolve yet). A generated draft is a later, separately governed enhancement.
 */
export function draftWinBack(_segment: CustomerLastOrder[], brand: string): WinBackDraft {
  return {
    channel: "email",
    subject: `We miss you at ${brand}`,
    body: `Hi there — it's been a while since your last order with ${brand}. Come back and enjoy 10% off your next purchase. We'd love to see you again.`,
  };
}

// --- Task 3: proposeWinBack — ALWAYS proposes, NEVER auto-sends ------------------------------------
//
// A `send_campaign` action carries no pct/usd param (`AUTO_ELIGIBLE_DIMENSIONS.campaign = []` in
// `@palup/platform-ports`'s `merchant-rules-store.ts`), so the real `classifyAction` can never
// classify one as "auto" — invariant 4 (unmeasured action) fires unconditionally. This function's
// own defensive check below is belt-and-suspenders on TOP of that structural guarantee: campaigns
// must never auto-send even if a future change to the classifier or its rules ever widened that.

export interface ProposeWinBackInput {
  segment: CustomerLastOrder[];
  draft: WinBackDraft;
  ctx: RuntimeStateCtx;
  /** ISO-8601; caller-supplied (no `Date.now()` in this module). */
  now: string;
  /** Defaults to `"win_back_agent"` — override for multi-instance/test traceability. */
  agentId?: string;
}

/**
 * Builds the win-back campaign's `AgentAction` and routes it through `proposeOrExecute` — which
 * ALWAYS lands a pending `campaign` `Proposal` for a human via the Approval Center; this agent has
 * no direct send path at all. Throws if the loop ever reported `"executed"` for a campaign — that
 * would be a governance breach (CLAUDE.md §3 non-negotiable #1), never a case to silently accept.
 */
export async function proposeWinBack(input: ProposeWinBackInput, deps: EngineDeps): Promise<ProposeOrExecuteResult> {
  const action: AgentAction = {
    type: "send_campaign",
    params: {
      recipients: input.segment.map((s) => s.contact),
      channel: input.draft.channel,
      subject: input.draft.subject,
      body: input.draft.body,
    },
    irreversible: true,
    blastRadius: input.segment.length,
  };

  const reversalPlan: ReversalPlan = {
    reversible: false,
    plan:
      "An email/SMS send cannot be unsent once delivered. Containment: reject/withdraw this " +
      "proposal before approval to stop it entirely; if already approved-and-sent in error, " +
      "immediately halt the win-back agent (kill switch) and send a correction/apology to the " +
      "same segment — the way back is containment + correction, never a true undo.",
  };

  const result = await proposeOrExecute(
    {
      ctx: input.ctx,
      agentId: input.agentId ?? "win_back_agent",
      agentType: "win_back",
      category: "campaign",
      rationale: `Win-back campaign for ${input.segment.length} lapsed customer(s).`,
      reversalPlan,
      now: input.now,
      action,
      estimatedImpact: { reach: input.segment.length },
    },
    deps,
  );

  // Defensive (§3-critical): a campaign action must NEVER auto-execute. This agent has no direct
  // send path — if the loop ever returns "executed" here, that is a governance breach, not a
  // result to hand back silently.
  if (result.kind === "executed") {
    throw new Error(
      "proposeWinBack: a campaign action was auto-executed — this must never happen (CLAUDE.md §3 HITL non-negotiable); the win-back agent has no direct send path",
    );
  }

  return result;
}

// --- Task 4: campaignExecutor — the approved-send path ----------------------------------------------
//
// Only ever called by `executeApproved` (E1, `loop.ts`) AFTER a human has approved the pending
// proposal `proposeWinBack` created — never directly, and never before approval. Idempotency is
// `executeApproved`'s job (its `status === "executed"` short-circuit, task 6); this executor is
// pure with respect to its inputs — the same `action` always builds the same `CampaignMessage[]`.

function requireRecipients(params: AgentAction["params"]): string[] {
  const v = params.recipients;
  if (!Array.isArray(v) || !v.every((r) => typeof r === "string")) {
    throw new Error("campaignExecutor: action.params.recipients must be a string[]");
  }
  return v;
}

function requireString(params: AgentAction["params"], key: string): string {
  const v = params[key];
  if (typeof v !== "string") throw new Error(`campaignExecutor: action.params.${key} must be a string`);
  return v;
}

/**
 * Builds an `Executor` (E1's injected side-effect seam) that sends a `send_campaign` action's
 * recipients via the given `CampaignCommsPort` — `SandboxCommsAdapter` in dev/test/staging, a real
 * (still consent/DLP-gated — see `comms-port.ts`'s header) provider adapter once one is wired.
 */
export function campaignExecutor(comms: CampaignCommsPort): Executor {
  return async ({ ctx, action }) => {
    const recipients = requireRecipients(action.params);
    const channel = requireString(action.params, "channel") as CampaignMessage["channel"];
    const subject = typeof action.params.subject === "string" ? action.params.subject : undefined;
    const body = requireString(action.params, "body");

    const messages: CampaignMessage[] = recipients.map((to) => ({ channel, to, subject, body }));
    const { sent } = await comms.send(messages, ctx);
    return { ok: true, detail: `sent ${sent}` };
  };
}
