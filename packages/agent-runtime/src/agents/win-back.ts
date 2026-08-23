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

import type { CustomerLastOrder, CustomerListingCommerce, RuntimeStateCtx } from "@palup/platform-ports";

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
