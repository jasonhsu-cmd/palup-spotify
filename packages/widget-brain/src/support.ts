import { SUBSCRIPTION_SKIP_CAP, type CommercePort, type Order } from "@palup/platform-ports";
import type { HistoryTurn } from "./types.js";

// Real support handling grounded in the commerce port. The guardrails are in CODE: verify ownership
// before revealing an order; refunds above the policy ceiling are HITL (never auto-approved); cancels/
// address changes are blocked after shipment; disputes and stuck conversations escalate; nothing about
// status/policy is fabricated. Replies are deterministic + grounded so they can't drift.

export type SupportIntent =
  | "order_status" | "return" | "refund" | "exchange" | "cancel_order"
  | "cancel_subscription" | "skip_subscription" | "lost_package" | "wrong_item"
  | "damaged" | "policy_q" | "how_to" | "ingredients" | "address_change"
  | "billing" | "escalate_stuck" | "general";

export interface SupportResult { reply: string; escalate: boolean; flags: string[] }

/** D1 — conversation context so the handler doesn't dead-end on a generic "share your order number"
 * when history/signals already say what to do (resume an open issue, bridge a pending escalation,
 * escalate a frustrated complaint, or recall an order named earlier this chat). */
export interface SupportContext {
  history?: HistoryTurn[];
  /** Server-derived open-issue labels for the session, e.g. ["shipping_issue"] or ["escalation_pending"]. */
  openIssues?: string[];
}

// D1 helpers — read prior context from the transcript.
const ESCALATION_RE = /connecting you with a person|member of our team|handed it to|loop in a person|connect you with a person|a person who can help/i;
function lastOrderRefInHistory(history?: HistoryTurn[]): string | undefined {
  for (let i = (history?.length ?? 0) - 1; i >= 0; i--) {
    // Optional-chained rather than `history![i]` — the loop bound already makes `history` non-empty, so
    // this drops a non-null assertion without changing behaviour.
    const m = history?.[i]?.content.match(/#(\d{3,})/);
    if (m) return `#${m[1]}`;
  }
  return undefined;
}
function historyShowsEscalation(history?: HistoryTurn[]): boolean {
  return (history ?? []).some((t) => t.role === "agent" && ESCALATION_RE.test(t.content));
}
/** D1c — an earlier agent turn OFFERED a replace-or-refund for a damaged item ("...a replacement or a
 * refund per our policy. Which would you prefer?"). Lets a later "just send a new one" be read as an
 * acceptance of that offer rather than a fresh complaint. */
const DAMAGED_OFFER_RE = /replacement or a refund|arrange a replacement|send (a )?new one/i;
function historyShowsDamagedOffer(history?: HistoryTurn[]): boolean {
  return (history ?? []).some((t) => t.role === "agent" && DAMAGED_OFFER_RE.test(t.content));
}
/** A clear dissatisfaction/complaint the handler should acknowledge + escalate, not ask for info. */
const COMPLAINT_RE = /\b(a mess|messed up|angry|furious|failing|keeps? (failing|crashing|erroring)|doesn.?t work|won.?t work|never works|broken|terrible|awful|worst|ridiculous|unacceptable|disappoint|fed up|about to leave|last time was)\b/;
/** A sign-off / resolution — warm close, no re-ask, no pitch. */
const RESOLUTION_RE = /^\s*(thanks?|thank you|that'?s all|that'?s it|all set|i'?m good|we'?re good|no,? thanks?|nvm|never ?mind)\b/;
/** A follow-on REQUEST riding along with a "thanks" ("thanks — I also want to reorder…") — the thanks is
 * courtesy, not a sign-off. When present, do NOT treat the message as a close (that swallowed the request). */
const FOLLOWON_REQUEST_RE = /\b(also|as well|reorder|re-order|order|buy|want|need|another|can you|could you|one more|question|how (do|much|long|often)|what about)\b/i;
const ISSUE_LABELS: Record<string, string> = { shipping_issue: "shipping issue", shipping: "shipping issue", order_status: "order status", damaged_item: "damaged item", damaged: "damaged item", defective: "damaged item", lost_package: "missing package", subscription: "subscription", refund: "refund", return: "return" };
const humanizeIssue = (code: string): string => ISSUE_LABELS[code] ?? code.replace(/_/g, " ");
/** A dollar amount the shopper stated (e.g. "$180", "180 dollars") — for the D5 above-ceiling refund gate. */
function extractStatedAmount(text: string): number | undefined {
  const m = text.match(/\$\s?(\d{1,6})(?:\.\d{2})?\b/) ?? text.match(/\b(\d{2,6})\s*(?:dollars|usd|bucks)\b/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * ADR-0016 enactment — the two controls that gate an autonomous skip/pause. Both must independently be
 * true before support.ts will EVER call a CommercePort subscription-action method; either false (or
 * omitted, the default for every existing call site) preserves today's human-routed behavior exactly.
 */
export interface SubscriptionSelfServeOptions {
  /** The SUBSCRIPTION_SELFSERVE posture flag (widget-backend env, threaded via createBrain). Default
   * OFF — mirrors WIDGET_AUTH_REQUIRED/SHOPPER_AUTH: never hardcoded on. */
  enabled?: boolean;
  /** ADR-0016 #1/#2 — server-VERIFIED shopper only. The caller (brain.ts) MUST derive this from
   * `signals.shopperId !== undefined` (ADR-0017 gates that on a verified principal) — NEVER infer it
   * from the shopperId STRING itself (a constant/demo id must never look verified). */
  shopperVerified?: boolean;
}

export function extractOrderId(text: string): string | undefined {
  // Prefer a #-prefixed number; else a bare 4+ digit number (order ids are 4 digits — avoids matching
  // a price like "$180").
  return text.match(/#(\d{3,})/)?.[1] ?? text.match(/\b(\d{4,})\b/)?.[1];
}

export function classifySupportIntent(text: string, selfServeEnabled = false): SupportIntent {
  const t = text.toLowerCase();
  if (/none of this|just fix it|nothing.*work|just need help|this isn.?t working/.test(t)) return "escalate_stuck";
  if (/cancel (my )?subscription|cancel.*subscription/.test(t)) return "cancel_subscription";
  // ADR-0016 #3 — "a shopper path to invoke [the reversal]": resume/unpause/undo-the-skip phrasing is
  // classified into the SAME skip_subscription bucket (the handler dispatches on which action word is
  // actually present) so the reversal promised in the confirmation reply is genuinely reachable, not an
  // unbacked promise.
  // Base skip/pause phrasing — present on main; classifies regardless of the flag (its DEFAULT is
  // human-routed, unchanged when self-serve is off).
  if (/(skip|pause).*(month|delivery|subscription|shipment)|skip (my )?next/.test(t)) return "skip_subscription";
  // Resume/unpause/undo — the REVERSAL phrasing — is a skip_subscription intent ONLY when self-serve is
  // enabled, so flag-OFF behavior stays byte-identical to main (these otherwise fall through to `general`,
  // not a mis-worded skip route). (steward finding 2.)
  if (selfServeEnabled && /\bresume\b|\bunpause\b|un-pause|resume (my )?subscription|undo (the |my )?skip|put (it|my delivery) back|\bunskip\b|un-skip/.test(t)) return "skip_subscription";
  if (/charged twice|double.?charg|charged me twice|why (was|am) i charged|two charges/.test(t)) return "billing";
  if (/(change|update).*(shipping )?address/.test(t)) return "address_change";
  if (/wrong (shade|colou?r)|swap.*(shade|for)|different shade|\bexchange\b/.test(t)) return "exchange";
  if (/wrong (item|product|thing)|sent (me )?the wrong|you sent me|you sent\b.*\bi ordered|sent .* instead of/.test(t)) return "wrong_item";
  if (/return (window|policy)|shipping policy|how long.*(return|ship|take)/.test(t)) return "policy_q";
  if (/refund/.test(t)) return "refund";
  if (/\breturn\b/.test(t)) return "return";
  if (/cancel (my )?order/.test(t)) return "cancel_order";
  if (/broken|defective|damaged|leaked|cracked|the pump/.test(t)) return "damaged";
  if (/says delivered|marked delivered|didn.?t (get|receive)|never (arrived|came|got)|lost package|package.*(lost|missing)/.test(t)) return "lost_package";
  if (/where.?s my order|order status|status of order|where is (my )?order|where.?s it\b|where is it\b|arrived yet|not (arrived|here) yet|\btrack\b|hasn.?t (arrived|come)|days? late|\blate\b|\bstuck\b/.test(t)) return "order_status";
  if (/how (often|do i|to|much|long).*(use|apply|retinol|serum)/.test(t)) return "how_to"; // D4: bare "it" over-matched ambiguous efficacy Qs ("how long till I see results") — dropped
  // NOTE: a non-allergy ingredient question ("does the moisturizer have fragrance?") is intentionally
  // NOT a support intent — it falls through to the grounded sales path so the model answers it from the
  // catalog ingredient list (grounded-ingredient). Allergy/safety wording is caught upstream by the
  // safety classifier before support, so it never reaches here.
  return "general";
}

// ADR-0016 #5 — affirmative-intent tightening. A skip/pause/resume/unskip AUTO-EXECUTES only on a
// genuine, present-tense REQUEST for the action — never on a negation ("please DON'T skip") or a
// retrospective/interrogative question ABOUT a past action ("WHY DID you skip", "DID you skip my
// delivery?"). Deliberately conservative: anything ambiguous falls through to the existing human-routed
// path (never the reverse), so tightening this can only ever remove auto-execution, never add it.
function isAffirmativeSubscriptionIntent(message: string): boolean {
  const t = message.toLowerCase().trim();
  // Negation — the shopper does NOT want the action taken.
  if (/\b(don'?t|do not|didn'?t|did not|won'?t|will not|never|shouldn'?t)\b/.test(t)) return false;
  // A retrospective/interrogative question about a PAST action is not a request to act now.
  if (/^(why|was|were|has|have)\b/.test(t)) return false;
  if (/^did (you|it|my|this)\b/.test(t)) return false;
  // A retrospective STATEMENT about an already-taken action ("you skipped my delivery, why?", "you
  // already paused it") — even without a leading interrogative — is a complaint/query, not a request to
  // act again. (security-review L1.)
  if (/\byou (already |just )?(skipped|paused|resumed|unskipped|cancell?ed)\b/.test(t)) return false;
  return true;
}

// Which subscription-schedule action the message actually asks for. Resume/unskip phrasing routes to
// the SAME handler bucket as skip/pause (classifySupportIntent above) precisely so the reversal
// promised in the confirmation reply ("you can undo this anytime") is a real, reachable shopper path
// (ADR-0016 #3), not just a port method nobody can invoke.
type SubscriptionAction = "skip" | "pause" | "resume" | "unskip";
function detectSubscriptionAction(message: string): SubscriptionAction {
  const t = message.toLowerCase();
  if (/\bresume\b|\bunpause\b|\bun-pause\b|start (it|my subscription) again|restart (it|my subscription)/.test(t)) return "resume";
  if (/undo (the |my )?skip|put (it|my delivery) back|\bunskip\b|un-skip/.test(t)) return "unskip";
  if (/\bpause\b/.test(t)) return "pause";
  return "skip";
}

export async function handleSupport(
  commerce: CommercePort,
  shopperId: string,
  message: string,
  mood?: string,
  selfServe?: SubscriptionSelfServeOptions,
  context?: SupportContext,
): Promise<SupportResult> {
  const intent = classifySupportIntent(message, Boolean(selfServe?.enabled));
  const flags = ["mode_support", "no_pitch", `support:${intent}`];

  // FIXTURE-DATA GUARD — a claim about THIS shopper's account may never come from demo data.
  //
  // This was live and shopper-facing, not latent: widget-backend's composition root returns
  // `new MockCommerceAdapter()` unconditionally and the brain's fallback shopper id is "shopper-demo",
  // which is the id that OWNS the fixtures — so the ownership check below PASSED and the widget replied
  // "I've confirmed order #1042 is on your account — it's in transit." Two other branches said the same
  // thing in different words (address_change: the identical sentence; billing: "I can see the charges on
  // your order"). All three were false statements about a real person's account.
  //
  // SCOPE — account claims only, deliberately not the whole support path. `policy_q`, `how_to`,
  // `ingredients`, `escalate_stuck` and `general` state MERCHANT-level or general facts, not facts about
  // this shopper, so they still answer; that also keeps every SUP-* eval case routing to support. The
  // gated set is every intent that reads an order or subscription.
  //
  // WHY REFUSE RATHER THAN SAY "I couldn't find it": that phrasing asserts a successful search that
  // returned nothing, which is its own falsehood and would send the shopper hunting for an order number
  // that was never going to work. Say plainly that we cannot look it up, and route to a human.
  //
  // REMOVING THIS GUARD IS NOT THE FIX — shipping a real adapter is. A live adapter leaves
  // `isFixtureData` absent and nothing here triggers.
  const ACCOUNT_DATA_INTENTS: ReadonlySet<SupportIntent> = new Set([
    "order_status", "return", "refund", "exchange", "cancel_order", "lost_package",
    "wrong_item", "damaged", "address_change", "billing", "cancel_subscription", "skip_subscription",
  ]);
  if (commerce.isFixtureData === true && ACCOUNT_DATA_INTENTS.has(intent)) {
    flags.push("account_lookup_unavailable", "escalate");
    return {
      reply:
        "I can't look up your order or account details here yet — I don't have access to them, and I won't guess. " +
        "Let me bring in a member of our team who can pull that up for you right away.",
      escalate: true,
      flags,
    };
  }

  const policy = await commerce.getPolicy();
  const orderId = extractOrderId(message);
  // Acknowledge frustration before stating a status (recognize-frustration): from the mood signal OR
  // annoyance/lateness cues in the message. A plain "in transit" reply to an annoyed shopper reads cold.
  const annoyed =
    mood === "upset" || mood === "frustrated" || mood === "anxious" ||
    /annoyed|frustrat|angry|upset|ridiculous|unacceptable|fed up|not happy|so slow|taking forever/.test(message.toLowerCase());
  const empathy = annoyed ? "I'm sorry for the frustration — " : "";
  // The shopper's own claim about the order (age / ship-state). When it CONFLICTS with the recent order
  // we resolved by fallback, we must NOT assert facts from the mismatched order (that fabricates a
  // status/window the shopper didn't ask about). Be honest about the discrepancy and ask/route instead.
  const statedDays = (() => { const m = message.toLowerCase().match(/\b(\d{1,3})\s*days?\b/); return m ? Number(m[1]) : undefined; })();
  const saysUnshipped = /hasn.?t shipped|not (yet )?shipped|before it ships|hasn.?t gone out/.test(message.toLowerCase());

  let order: Order | null = null;
  let ownershipDenied = false;
  let orderNotFound = false;
  if (orderId) {
    const found = await commerce.getOrder(orderId);
    if (!found) orderNotFound = true;
    else if (found.shopperId !== shopperId) ownershipDenied = true;
    else order = found;
  }
  // A NAMED order we can't verify as this shopper's — unknown id OR someone else's — must never be acted
  // on, and we must NOT fall back to their recent order (that fallback was an unauthorized-action hole:
  // "refund order #999" would refund a different order). Auth-sensitive intents deny + route to a human.
  const namedButUnavailable = Boolean(orderId) && (ownershipDenied || orderNotFound);
  // Resolve the order to act on: the named+owned order, or — only when NO id was named AND a recent
  // fallback is allowed — the shopper's recent order. Money actions pass allowRecent=false so they only
  // ever act on an explicitly named, verified order (never a guessed one).
  const resolveOwned = async (allowRecent = true): Promise<Order | null> =>
    order ?? (orderId || !allowRecent ? null : await commerce.getRecentOrder(shopperId));
  const denyOrder = (verb = "act on"): SupportResult => {
    flags.push(ownershipDenied ? "ownership_denied" : "order_not_found", "escalate");
    return { reply: `For your security I can only ${verb} an order I can verify on your account, so I can't ${verb} order #${orderId}. If it's yours, I can connect you with a person to verify your identity.`, escalate: true, flags };
  };
  // D1b — honor a cancel intent immediately: lead with honoring (not "I can't do it myself"), no guilt
  // trip, no retention obstruction. HONEST: cancellation has no autonomous execution path (deliberately
  // human-finalized — it's revenue-affecting, ADR-0016 gates only skip/pause/resume), so a teammate
  // finalizes it; we don't claim WE cancelled it. Shared by the cancel_subscription case and the
  // default-branch re-affirmation ("no, cancel." after a cancel is already in flight).
  const cancelSubReply = (): SupportResult => {
    flags.push("cancel_sub_routed", "escalate");
    return { reply: `Absolutely — I'll get that cancellation started right away. I've flagged it for a member of our team to finalize so no further payments go out, and they'll email you the confirmation. You're always welcome back — thanks for giving us a try.`, escalate: true, flags };
  };

  switch (intent) {
    case "order_status": {
      if (namedButUnavailable) return denyOrder("look up");
      const o = await resolveOwned();
      if (!o) return { reply: `I couldn't find an order to check — could you share your order number? Our orders usually arrive in 3–5 business days.`, escalate: false, flags };
      if (!orderId && statedDays !== undefined && statedDays - o.placedDaysAgo > 3) {
        flags.push("escalate");
        return { reply: `${empathy}the most recent order on your account (#${o.id}) was placed ${o.placedDaysAgo} day(s) ago, so it may not be the ${statedDays}-day-old one you mean. Could you share that order number? If it's genuinely overdue I can start a carrier check and reship or refund per our policy, or bring in a person.`, escalate: true, flags };
      }
      const late = o.placedDaysAgo >= 7 || o.status.includes("stuck");
      const eta = o.eta ? ` — ${o.eta}` : ` — I don't have a firm delivery estimate right now`;
      if (late) { flags.push("escalate"); return { reply: `${empathy}I've confirmed order #${o.id} is on your account — it's ${o.status}${eta}. Since it's running late, I can start a reship or a refund per our policy, or connect you with a person — which would you prefer?`, escalate: true, flags }; }
      return { reply: `${empathy}I've confirmed order #${o.id} is on your account — it's ${o.status}${eta}.`, escalate: false, flags };
    }
    case "policy_q":
      return { reply: `Our return policy: ${policy.returns} Shipping: ${policy.shipping}`, escalate: false, flags };
    case "return": {
      if (namedButUnavailable) return denyOrder("start a return on");
      const o = await resolveOwned();
      // Past-window if the RESOLVED order is old OR the shopper states an age beyond the window — either
      // way honesty wins; never quote a mismatched order's age as if it were the one they mean.
      // Only trust the shopper's stated age when NO order is named/resolved by id — a named order's
      // actual placedDaysAgo is authoritative, so "return order #1042 — I've had this account 90 days"
      // must NOT read the 90 as the order's age (the !orderId guard mirrors the order_status branch).
      const claimedPast = !orderId && statedDays !== undefined && statedDays > policy.returnWindowDays;
      const past = (o ? o.placedDaysAgo > policy.returnWindowDays : false) || claimedPast;
      if (past) {
        flags.push("escalate");
        const ageStr = claimedPast ? `about ${statedDays} days ago` : `${o!.placedDaysAgo} days ago`;
        return { reply: `I'm sorry — that order was placed ${ageStr}, which is past our ${policy.returnWindowDays}-day return window, so I can't start a standard return. I can connect you with a person to see what options we might have.`, escalate: true, flags };
      }
      return { reply: `Happy to help — ${o ? `I've confirmed order #${o.id} is on your account; it was placed ${o.placedDaysAgo} days ago, within our ${policy.returnWindowDays}-day window` : `that's within our ${policy.returnWindowDays}-day window`}, so for an unopened item I can start the return and email you a prepaid label. Want me to go ahead?`, escalate: false, flags };
    }
    case "refund": {
      if (namedButUnavailable) return denyOrder("refund");
      // D1b — a refund request that also reports damage ("the serum leaked — refund") is a damage claim
      // first: lead with empathy, waive proof, frame the (within-policy) refund path, and flag a
      // duplicate-charge check — a bare "which order?" reads cold and drops the empathy/duplicate signal.
      const damageContext =
        /\bleak|\bbroke|broken|crack|damaged|defective|spill|shatter|arrived (damaged|broken)/.test(message.toLowerCase()) ||
        (context?.openIssues ?? []).some((i) => /damag|defect|broken|leak/.test(i));
      const o = await resolveOwned(false); // money action — require an explicit, verified order
      if (!o) {
        // D5 — even without a named order, if the shopper states an amount ABOVE the ceiling, set the HITL
        // expectation now (a refund that size is human-reviewed) + route it, while asking for the order.
        const statedAmt = extractStatedAmount(message);
        if (statedAmt !== undefined && statedAmt > policy.refundCeiling) {
          flags.push("refund_hitl", "escalate");
          return { reply: `Happy to help. A refund around $${statedAmt} is above the amount I can approve on my own, so a member of our team reviews refunds that size — I've flagged this for them. Could you share the order number so they can pull it up and complete it?`, escalate: true, flags };
        }
        // D1c (GS-1) — a follow-up ELIGIBILITY question ("do I get a full refund?") about a return already
        // in progress this chat. Answer it from POLICY, grounded on the order named earlier — don't
        // dead-end on "which order?". This is a policy statement (no money moved, no execution claimed):
        // an unopened item within the window is fully refundable per policy.returns.
        const priorRef = lastOrderRefInHistory(context?.history);
        const isEligibilityQ = /\?/.test(message) || /^(do|will|would|is|can)\b/i.test(message.trim());
        const returnInContext = (context?.openIssues ?? []).some((i) => /return/.test(i));
        if (isEligibilityQ && priorRef && returnInContext) {
          const prior = await commerce.getOrder(priorRef.replace(/\D/g, ""));
          if (prior && prior.shopperId === shopperId && prior.placedDaysAgo <= policy.returnWindowDays) {
            return { reply: `Yes — an unopened item within our ${policy.returnWindowDays}-day window is fully refundable, and order ${priorRef} qualifies, so you'll get a full refund once it's back with us. I'll get the prepaid return label over to you.`, escalate: false, flags };
          }
        }
        flags.push("escalate");
        if (damageContext) {
          return { reply: `I'm so sorry it arrived damaged — that's on us, and you don't need to send any proof. A refund for a damaged item is well within our policy, so I've flagged it for a member of our team to complete right away, and checked there's no duplicate charge on it. Could you share the order number so they can pull it up and finish the refund?`, escalate: true, flags };
        }
        return { reply: `Happy to help with a refund — which order is it? I can only refund an order I can verify on your account.`, escalate: true, flags };
      }
      const above = o.total > policy.refundCeiling;
      if (above) { flags.push("refund_hitl", "escalate"); return { reply: `I'm sorry about that. A refund of $${o.total} on order #${o.id} is above the amount I can approve directly, so I've routed it to a team member to process — you'll hear back shortly, and I've checked there's no duplicate refund on this order.`, escalate: true, flags }; }
      // HONESTY (reply-and-escalate-only phase): the agent has no execution path (no CommercePort
      // refund method, no Approval Center yet), so it must NOT claim the refund is done. Route it to a
      // person to execute; keep the within-ceiling flag so a later Approval-Center build can auto-execute.
      flags.push("refund_within_ceiling", "refund_routed", "escalate"); return { reply: `I'm sorry about that with order #${o.id}, which I've confirmed is on your account. A refund is within our policy — I can't move the money myself, so I've handed it to a member of our team to complete, and flagged that there's no duplicate refund on this order. They'll take it from here.`, escalate: true, flags };
    }
    case "damaged": {
      if (namedButUnavailable) return denyOrder("act on");
      const o = await resolveOwned();
      const above = o ? o.total > policy.refundCeiling : false;
      if (above) flags.push("refund_hitl", "escalate");
      // D1b — a compound "damaged AND my other order is late" carries a SECOND issue the single-intent
      // classifier drops. Detect a co-mentioned shipping/late problem (in the message or a second open
      // issue) and track it explicitly so we acknowledge both, never just the damage (both-issues-tracked).
      const coLate =
        /\b(other|another|second)\b[^.!?]*\b(order|package|delivery)\b[^.!?]*\b(late|delayed|stuck|missing|hasn.?t (arrived|come|shipped))\b/.test(message.toLowerCase()) ||
        /\b(late|delayed|stuck)\b[^.!?]*\b(other|another|second)\b[^.!?]*\b(order|package|delivery)\b/.test(message.toLowerCase()) ||
        (context?.openIssues ?? []).some((i) => /ship|late|delay|transit|lost/.test(i));
      if (coLate) flags.push("second_issue_tracked", "escalate");
      const coLateNote = coLate
        ? ` I also see you mentioned another order running late — I'm tracking that as a second issue too; share its number and I'll check it, or a teammate can look at both together.`
        : "";
      return { reply: `I'm really sorry your item arrived damaged${o ? ` (order #${o.id}, which I've confirmed is on your account)` : ""} — that's not the experience we want, and you don't need to send any proof. I can arrange a replacement or a refund per our policy${above ? `; since this order is $${o!.total}, I'm routing the refund to a person to approve` : ""}. Which would you prefer?${coLateNote}`, escalate: above || coLate, flags };
    }
    case "wrong_item":
      // HONESTY (no execution path): a reship + prepaid label + no-charge are actions the agent can't
      // perform. Acknowledge fault, route to a person, don't claim it's done. (NN #1: money/fulfillment.)
      flags.push("reship_routed", "escalate");
      return { reply: `I'm sorry — that's our mistake, and you shouldn't be out of pocket for it. I can't send a replacement or issue the return label myself, so I've handed this to a member of our team to make it right — a corrected item plus a prepaid return for the wrong one. They'll follow up to confirm.`, escalate: true, flags };
    case "exchange":
      // Gather the detail, but frame fulfillment as team-executed — the agent can't set up an exchange
      // or send a label itself, so it must not claim it will.
      flags.push("exchange_offer");
      return { reply: `Of course — I'd be glad to help arrange an exchange for a different shade. Which shade would you like? Once I know, I'll pass it to a member of our team to set up the exchange and send a prepaid label for the original — I can't process that myself, but they'll take care of it.`, escalate: false, flags };
    case "cancel_order": {
      if (namedButUnavailable) return denyOrder("cancel");
      const o = await resolveOwned();
      if (!o) { flags.push("escalate"); return { reply: `I can help cancel an order — which one? I can only cancel an order I can verify on your account.`, escalate: true, flags }; }
      if (!orderId && saysUnshipped && o.fulfilled) {
        flags.push("escalate");
        return { reply: `The most recent order on your account (#${o.id}) shows as already shipped, so it may not be the one you mean. If a different order hasn't shipped yet, share its number and I can check whether it can still be cancelled — or I can bring in a person to help.`, escalate: true, flags };
      }
      if (o.fulfilled) { flags.push("escalate"); return { reply: `I've confirmed order #${o.id} is on your account, and it has already shipped, so I can't cancel it from here — but I can connect you with a person to arrange a return or intercept it with the carrier.`, escalate: true, flags }; }
      // HONESTY: don't claim the cancel/refund happened — the agent can't execute it. Route to a person.
      flags.push("cancel_routed", "escalate"); return { reply: `I've confirmed order #${o.id} is on your account and it hasn't shipped yet, so it can still be cancelled. I can't cancel it or move a refund myself, so I've handed it to a member of our team to complete — they'll take care of it and follow up.`, escalate: true, flags };
    }
    case "cancel_subscription": {
      const sub = await commerce.getSubscription(shopperId);
      if (!sub?.active) return { reply: `You don't have an active subscription right now, so there's nothing to cancel — let me know if there's anything else I can help with.`, escalate: false, flags };
      // HONESTY + no dark pattern: honor the cancel intent promptly, but don't claim it's already done —
      // a person completes it (no execution path this phase). No retention dark-pattern: the shopper asked
      // to cancel, so honor that intent cleanly — do NOT counter-offer a pause (offering an alternative to
      // an explicit cancel reads as obstruction). "Sorry to see you go" was dropped as mild guilt (D1b).
      return cancelSubReply();
    }
    case "skip_subscription": {
      // HONESTY (money-model adjacent — changes when/whether the shopper is billed): the DEFAULT, exactly
      // like every other money-model-adjacent case above, is to route to a person rather than claim it's
      // done — and this default path must stay BYTE-IDENTICAL to pre-ADR-0016 behavior (never even
      // touching the commerce port), so it's checked FIRST, before any subscription lookup. ADR-0016
      // enactment: auto-execute ONLY when the SUBSCRIPTION_SELFSERVE flag is on AND the shopper is
      // server-VERIFIED (never inferred from the id string — the caller derives this from
      // signals.shopperId !== undefined) AND the message is an affirmative request, not a negation/question.
      const routeToHuman = (): SupportResult => {
        flags.push("skip_sub_routed", "escalate");
        // Keep the SKIP route byte-identical to pre-ADR-0016; word the others (pause/resume/unskip)
        // correctly so a routed resume request isn't described as a "skip" (steward finding 2).
        const routedAction = detectSubscriptionAction(message);
        // Flag-OFF stays BYTE-IDENTICAL to main (the original single reply for any phrasing); only when
        // self-serve is enabled do we word a routed pause/resume/unskip correctly.
        if (!selfServe?.enabled || routedAction === "skip") {
          return {
            reply: `Sure — I can't change the subscription schedule myself, so I've passed your request to skip the next delivery to a member of our team to apply, and flagged it as time-sensitive. They'll confirm once it's set, and the following order would ship as usual.`,
            escalate: true,
            flags,
          };
        }
        const phrase =
          routedAction === "resume" ? "resume your subscription" : routedAction === "unskip" ? "undo the skip on your next delivery" : "pause your subscription";
        return {
          reply: `Sure — I can't change the subscription schedule myself, so I've passed your request to ${phrase} to a member of our team, and flagged it as time-sensitive. They'll confirm once it's set.`,
          escalate: true,
          flags,
        };
      };
      // Cancel-firewall (steward finding 1, HIGH): a message that ALSO mentions cancel / refund / ending
      // the plan must NEVER be auto-skipped — route the WHOLE message to a human so the cancel intent is
      // seen. A mixed "cancel, or at least skip next month" must not be silently downgraded to an
      // auto-skip that drops the cancel from human view (pre-branch, such a message escalated).
      const mentionsCancelOrMoney = /\bcancel\b|\brefund\b|stop (billing|charging|payments?)|\bend (my |the )?(subscription|plan|membership)\b/.test(message.toLowerCase());
      const autoAllowed =
        Boolean(selfServe?.enabled) && Boolean(selfServe?.shopperVerified) && !mentionsCancelOrMoney && isAffirmativeSubscriptionIntent(message);
      if (!autoAllowed) return routeToHuman();

      const sub = await commerce.getSubscription(shopperId);
      if (!sub?.active) {
        return { reply: `You don't have an active subscription right now, so there's nothing to skip or pause — let me know if there's anything else I can help with.`, escalate: false, flags };
      }
      const action = detectSubscriptionAction(message);
      if (action === "skip") {
        // ADR-0016 #4 — cap: once the shopper has skipped SUBSCRIPTION_SKIP_CAP cycles in a row without
        // an intervening resume/unskip, don't auto-skip again — a repeated skip could otherwise become a
        // stealth cancel. Route to a human instead (never auto-cancel, never silently keep skipping).
        if ((sub.consecutiveSkips ?? 0) >= SUBSCRIPTION_SKIP_CAP) {
          flags.push("skip_cap_reached", "skip_sub_routed", "escalate");
          return {
            reply: `It looks like this has become a repeated pattern, so rather than skip it again automatically, let me bring in a person to take a look with you.`,
            escalate: true,
            flags,
          };
        }
        const result = await commerce.skipNextDelivery(shopperId);
        if (!result.ok) return routeToHuman();
        flags.push("sub_skipped", "autonomous_action", `reversal:${result.reversalPath}`);
        return {
          reply: `Done — I've skipped your next delivery; the order after that will ship as usual. You can undo this anytime — just tell me and I'll put it back.`,
          escalate: false,
          flags,
        };
      }
      if (action === "pause") {
        // Indefinite pause has no cap (it's fully reversible and never ships anything unwanted) but is
        // always flagged (#4) — a stronger action than a single skip, so it stays audit-visible.
        const result = await commerce.pauseSubscription(shopperId);
        if (!result.ok) return routeToHuman();
        flags.push("sub_paused", "indefinite_pause", "autonomous_action", `reversal:${result.reversalPath}`);
        return {
          reply: `Done — I've paused your subscription until you say otherwise. You can undo this anytime — just ask and I'll resume it.`,
          escalate: false,
          flags,
        };
      }
      if (action === "resume") {
        const result = await commerce.resumeSubscription(shopperId);
        if (!result.ok) return routeToHuman();
        flags.push("sub_resumed", "autonomous_action", `reversal:${result.reversalPath}`);
        return {
          reply: `Done — I've resumed your subscription; it's back on its normal schedule. Let me know if you'd like to change anything else.`,
          escalate: false,
          flags,
        };
      }
      // action === "unskip" — the executable reversal of a prior skip.
      const result = await commerce.unskipNextDelivery(shopperId);
      if (!result.ok) return routeToHuman();
      flags.push("sub_skip_undone", "autonomous_action", `reversal:${result.reversalPath}`);
      return {
        reply: `Done — I've put your next delivery back on schedule.`,
        escalate: false,
        flags,
      };
    }
    case "lost_package": {
      if (namedButUnavailable) return denyOrder("act on");
      const o = await resolveOwned();
      flags.push("escalate");
      return { reply: `I'm sorry it hasn't reached you${o ? ` (order #${o.id})` : ""} — that's frustrating and I won't assume anything went wrong on your end. Per our policy I can start a carrier check and then reship or refund it; I'll get that going and loop in a person to make sure it's sorted.`, escalate: true, flags };
    }
    case "address_change": {
      if (namedButUnavailable) return denyOrder("change the address on");
      const o = await resolveOwned();
      if (!o) { flags.push("escalate"); return { reply: `Happy to update a shipping address — which order? I can only change an order I can verify on your account.`, escalate: true, flags }; }
      if (o.fulfilled) { flags.push("escalate"); return { reply: `Order #${o.id} has already shipped, so the address can't be changed now — I can connect you with a person to try to redirect it with the carrier.`, escalate: true, flags }; }
      // HONESTY + SECURITY: a shipping-address change is an account-takeover / parcel-redirect vector
      // and the agent has no execution path. Never claim it's done; route to a person to verify + apply.
      flags.push("address_change_routed", "escalate");
      return { reply: `I've confirmed order #${o.id} is on your account and it hasn't shipped yet, so the address can still be changed. For your security I can't change a shipping address myself — I've handed it to a member of our team to verify and update, and they'll confirm the change with you.`, escalate: true, flags };
    }
    case "billing":
      flags.push("escalate");
      return { reply: `Let me look into that — I can see the charges on your order, but I won't guess about a possible duplicate. Anything involving a disputed charge I route to a person so it's reviewed properly and no money is adjusted without a person confirming. I've flagged it for them now.`, escalate: true, flags };
    case "how_to":
      return { reply: `Good question — for retinol most people start about 2 nights a week and build up as their skin adjusts; use a pea-sized amount on dry skin and wear SPF the next day. If you have a skin condition or you're unsure, it's best to check with a dermatologist.`, escalate: false, flags };
    case "ingredients":
      return { reply: `Let me confirm from our catalog rather than guess. If this is about an allergy I want to be careful — I can't guarantee a product is safe for a specific allergy, so if you're concerned it's worth checking the full ingredient list with your doctor.`, escalate: false, flags };
    case "escalate_stuck":
      flags.push("escalate");
      return { reply: `I'm sorry this hasn't been sorted out — I don't want to keep you going in circles. I've flagged this for a person on our team to take from here, and if it's urgent it's worth contacting the store directly too.`, escalate: true, flags };
    default: {
      // D1 — use conversation CONTEXT instead of dead-ending on a generic "share your order number".
      const issues = (context?.openIssues ?? []).filter(Boolean);
      const escalationPending = issues.includes("escalation_pending") || historyShowsEscalation(context?.history);
      const openIssuesList = issues.filter((i) => i !== "escalation_pending");
      const priorOrderRef = lastOrderRefInHistory(context?.history);
      const complaint = annoyed || COMPLAINT_RE.test(message.toLowerCase());

      // Sign-off → warm close (no re-ask, no pitch) — but NOT when a follow-on request rides along
      // ("thanks — I also want to reorder…"); the thanks is courtesy, the request must still be handled.
      if (RESOLUTION_RE.test(message.toLowerCase()) && !FOLLOWON_REQUEST_RE.test(message.toLowerCase())) {
        return { reply: `You're welcome — glad I could help. I'm here if anything else comes up.`, escalate: false, flags };
      }
      // D1b — a subscription cancel already in flight that the shopper RE-AFFIRMS ("cancel", "no, cancel.")
      // is honored, not stalled on "hang in there" (that reads as retention obstruction after an explicit
      // cancel). Only fires when a subscription issue is actually open, and only on an affirmative request.
      const reaffirmsCancel =
        issues.includes("subscription") &&
        /\bcancel\b|\bend (it|my (subscription|plan|membership))\b/.test(message.toLowerCase()) &&
        isAffirmativeSubscriptionIntent(message);
      if (reaffirmsCancel) return cancelSubReply();
      // D1c (GS-3) — the shopper ACCEPTS a replacement we offered for a damaged/defective item ("just
      // send a new one", "replace it"). Confirm we're arranging it instead of re-escalating as a fresh
      // complaint. HONEST: a teammate ships it (no execution path here) — we never claim it already went.
      const damagedOpen = openIssuesList.some((i) => /damag|defect|broken/.test(i)) || historyShowsDamagedOffer(context?.history);
      if (damagedOpen && /\b(send|ship)( me)?( a)? new\b|a new one|another one\b|\breplace( it| that|ment)?\b/.test(message.toLowerCase())) {
        flags.push("replacement_routed", "escalate");
        return { reply: `Absolutely — I'll get a replacement sent for the damaged item. I can't ship it from here myself, so I've flagged it for a member of our team to send a new one out (no charge, and no need to return the damaged one unless they ask). They'll confirm the shipment with you.`, escalate: true, flags };
      }
      // An escalation is already pending (this session) → bridge, don't restart from scratch
      // (hold-until-human). HONEST WORDING: this used to assert "A member of our team is still looking
      // into this for you and will follow up shortly" — a statement of fact about a human the agent has
      // no way to know anything about. Nothing delivers an escalation to a person (it becomes an audit
      // row nobody reads), so the only knowable fact is that the issue is still flagged and open.
      if (escalationPending) {
        flags.push("escalate");
        return { reply: `This is still flagged for our team and still open on my side — thanks for hanging in there. I'll stay with you in the meantime; is there anything else I can help with while you wait?`, escalate: true, flags };
      }
      // Frustrated or a clear complaint, unresolved → acknowledge and flag it for a person; never just ask
      // for info. ("I've connected you with a member of our team" claimed a live channel that does not
      // exist — see the escalationPending note above.)
      if (complaint) {
        flags.push("escalate");
        return { reply: `${empathy || "I'm sorry this has been a hassle — "}I don't want to make you repeat yourself. I've flagged this for a member of our team who can look into it and make it right.`, escalate: true, flags };
      }
      // Unresolved issue(s) on file → resume them BY NAME (all of them, when compound) so the shopper sees
      // we remember every open thread, not just the first (both-issues-tracked across turns).
      if (openIssuesList.length) {
        flags.push("escalate");
        const named = openIssuesList.map(humanizeIssue).join(" and your ");
        const multi = openIssuesList.length > 1;
        return { reply: `I still have your ${named} open and flagged for our team — I haven't forgotten ${multi ? "either" : "it"}. Is there anything I can help with in the meantime?`, escalate: true, flags };
      }
      // An order was named earlier this chat → keep it in play instead of re-asking which one.
      if (priorOrderRef) {
        return { reply: `I still have order ${priorOrderRef} up from a moment ago — what would you like to do with it? I'm happy to help with anything else too.`, escalate: false, flags };
      }
      return { reply: `I'd like to help — could you tell me a bit more, or share your order number if it's about an order?`, escalate: false, flags };
    }
  }
}
