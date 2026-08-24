import type { Proposal, ProposalCategory } from "@palup/platform-ports";

// Shared display helpers for the Approval Center screens (Tasks 2-4) — kept in one place so the
// queue row and the detail view can never drift on how a category/impact/reversibility is worded.

export const CATEGORY_LABEL: Record<ProposalCategory, string> = {
  discount: "Discount",
  ad_spend: "Ad spend",
  refund: "Refund",
  campaign: "Campaign",
  autonomy_scope: "Autonomy scope",
  subscription: "Subscription",
};

/** The authoritative reversibility signal for a proposal. `reversalPlan.reversible` is REQUIRED on
 *  every `Proposal` (`platform-ports/proposal-store.ts` — "creation throws without it"), unlike the
 *  optional `action.irreversible` hint, and it is the exact field whose companion `plan` text is
 *  shown to the merchant — so the marker and the explanation can never disagree. */
export function isIrreversible(proposal: Proposal): boolean {
  return proposal.reversalPlan.reversible === false;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** A short, human-readable summary of `estimatedImpact` (e.g. "$4,200 est. · 210 reach"),
 *  used by both the queue row and the detail view. Renders an honest "impact not estimated"
 *  rather than a blank or fabricated number when the agent didn't supply one — `estimatedImpact`
 *  is optional on `Proposal`. */
export function formatImpact(proposal: Proposal): string {
  const impact = proposal.estimatedImpact;
  if (!impact) return "impact not estimated";
  const parts: string[] = [];
  if (typeof impact.amountUsd === "number") parts.push(`${usd.format(impact.amountUsd)} est.`);
  if (typeof impact.reach === "number") parts.push(`${impact.reach.toLocaleString()} reach`);
  if (impact.note) parts.push(impact.note);
  return parts.length > 0 ? parts.join(" · ") : "impact not estimated";
}
