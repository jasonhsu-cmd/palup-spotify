import type { PrimaryGoalKind } from "../../app/api";

// Shared display helpers for the Revenue Home screens (W2 T7/T8) — one place so the tiles, the net
// card, and the activity feed can never drift on wording. Copy tone matches
// palup-merchant-app.html #dashboard; every NUMBER is API-driven (governance: no fake numbers).

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$1,234.56"; negatives use the typographic minus the mockup uses ("−$0.50"). */
export function fmtUsd(n: number): string {
  return n < 0 ? `−${usd.format(Math.abs(n))}` : usd.format(n);
}

export const GOAL_LABELS: Record<PrimaryGoalKind, string> = {
  recover_carts: "Recover more carts",
  close_more_chat_sales: "Close more chat sales",
  grow_repeat_purchases: "Grow repeat purchases",
  increase_aov: "Increase average order value",
  win_back_lapsed: "Win back lapsed customers",
};

/** Activity-slug → merchant copy. Keyed by the exact audit actions routes/activity.ts allowlists
 * (agent-runtime/src/loop.ts's slugs). An unknown slug falls back to the raw slug — honest, never
 * dropped or guessed. */
export const ACTION_LABELS: Record<string, string> = {
  "agent.action.auto.intent": "Started an in-envelope action",
  "agent.action.auto": "Completed an in-envelope action",
  "agent.action.failed": "An action failed (logged for review)",
  "proposal.created": "Drafted a proposal for your approval",
  "proposal.approved": "Proposal approved",
  "proposal.rejected": "Proposal rejected",
  "proposal.executing": "Started executing an approved proposal",
  "proposal.executed": "Executed an approved proposal",
  "proposal.execution_failed": "An approved proposal failed to execute",
  "proposal.expired": "A proposal expired unanswered",
  "proposal.withdrawn": "A proposal was withdrawn",
  "proposal.revalidation_failed": "An approved proposal no longer passed its checks",
};

export function activityLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
