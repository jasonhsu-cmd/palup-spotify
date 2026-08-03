import type { Policy } from "@palup/widget-brain";

// ADR-0014 #6 — the SERVER-SOURCED, un-spoofable change-class screen. A candidate policy tunes only voice
// (styleDirective + proactivityDefault); the deterministic guardrails ignore it, so a hostile directive
// is CONTAINED. But a directive that TRIES to reach beyond voice — set prices/discounts, override safety,
// pressure/manipulate, harvest data, or inject instructions — is a higher-scrutiny change: it must NOT
// ride the auto-promote fast-lane, even though it's contained. The class is computed HERE (server-side)
// from the candidate itself, never taken from the proposer's output (mirrors the deriveServingSignals
// trust boundary): a proposer can't self-declare its change "voice-only" to dodge review.

export type ChangeClass = "voice" | "flagged";

export interface ChangeScreen {
  changeClass: ChangeClass;
  /** The out-of-voice-class intents detected (empty ⇒ voice). */
  reasons: string[];
}

// Intent categories a VOICE directive has no business expressing. Detected on the raw directive text; a
// match doesn't mean the agent CAN do the thing (guardrails still block it) — it means a human, not the
// fast-lane, should approve a policy that asks for it.
const OUT_OF_CLASS: { reason: string; re: RegExp }[] = [
  { reason: "pricing/discount", re: /\b(discount|coupon|promo code|% ?off|percent off|free shipping|lower the price|price match|waive the fee|comp (them|it))\b/i },
  { reason: "safety-override", re: /\b(ignore (the )?(safety|rules|guardrails|guidelines|policy)|don'?t escalate|never escalate|skip the disclaimer|don'?t mention (the )?(risk|side effect|warning)|override)\b/i },
  { reason: "pressure/manipulation", re: /\b(create urgency|high[- ]?pressure|pressure them|scare|fear of missing out|guilt|manipulat|always upsell the most expensive|push the priciest|never take no)\b/i },
  { reason: "dishonesty", re: /\b(lie|exaggerat|overstate|guarantee (results|a cure)|promise (results|a cure)|invent|make up (a )?(discount|review|fact))\b/i },
  { reason: "identity-deception", re: /\b(pretend (to be|you'?re)|claim (to be|you'?re) (a )?human|say you'?re (a )?(person|human)|impersonat)\b/i },
  { reason: "data-harvest", re: /\b(ask for|collect|get|request|need)\b[^.!?]{0,25}\b(password|credit ?card|card (number|details|info)|ssn|social security)\b/i },
  { reason: "prompt-injection", re: /\b(ignore (all )?previous instructions|disregard (the )?(system|above)|you are now|new system prompt|jailbreak)\b/i },
  // ADR-0014 Decision carve-out (always human, even opted-in; inv #6): payments/purchases/money-tools,
  // subscriptions, authority/scope expansion, model changes, and business-model changes.
  { reason: "payments/purchase", re: /\b(charge (their|the|its) card|bill (them|their|the customer)|place (the |an )?order|complete (the )?(purchase|checkout|payment|order)|process (a |the )?payment|capture (the )?payment|money[- ]?tool|take payment)\b/i },
  { reason: "subscription", re: /\b(subscri\w*|auto[- ]?renew|recurring (charge|billing|payment|plan)|sign (them |the shopper )?up for (a )?(plan|membership|subscription)|enroll (them|the shopper) in)\b/i },
  { reason: "authority/scope", re: /\b(grant (yourself|you|the agent)|expand (your |the )?(scope|authority|permissions?)|escalate (your )?(privileges?|permissions?)|you (are|have|now have) (admin|authority|permission|full access)|act as (an? )?(admin|operator|manager)|approve (your own|refunds?)|issue (a )?refunds?)\b/i },
  { reason: "model-change", re: /\b(switch (to |your )?model|change (your |the )?model|use (a )?(different|another) model|set (the )?model|use model|\b(gpt|claude|gemini|llama|mistral)-?\d)\b/i },
  { reason: "business-model", re: /\b(business model|revenue (model|share|split)|commission[- ]?based|profit margin|pricing (tier|model|strategy)|monetiz\w*|new (plan|tier|package)|change (the )?(commercial )?terms)\b/i },
];

/**
 * Classify a candidate policy's change. "flagged" ⇒ the styleDirective (or label) expresses intent beyond
 * voice/proactivity — route to a human, never the auto-promote fast-lane. Pure + deterministic.
 */
export function screenChange(policy: Policy): ChangeScreen {
  const text = `${policy.styleDirective} ${policy.label ?? ""}`;
  const reasons = OUT_OF_CLASS.filter((c) => c.re.test(text)).map((c) => c.reason);
  return { changeClass: reasons.length ? "flagged" : "voice", reasons };
}
