import type { ModelPort } from "@palup/platform-ports";

/** Metering agentType for the 3b check's model calls — kept DISTINCT from generation/embedding/guard so a
 *  cost review can attribute this per-turn check spend on its own (ADR-0013). The server tags the metered
 *  model port with it (createMeteringModelPort). */
export const OFFER_CHECK_AGENT_TYPE = "outgoing-offer-check";

// 3b (ADR-0020) — SEMANTIC OUTGOING-OFFER CHECK. A language-agnostic model backstop for the deterministic
// reply-integrity floor (`replyOffersUngroundedDiscount`, sanitize.ts). PalUp grounds NO discounts, promo
// codes, freebies, or refunds, so any such promise in a MODEL reply is invented or injected and must never
// be served (NN#1 — nothing that affects money auto-applies; §8a invariant 7 — price/discount = HITL).
//
// WHY A SECOND CHECK. The floor is a REGEX in English patterns ("20% off", "use code X"). It misses:
//   • other languages ("20% de descuento", "免費送你一個");
//   • paraphrases the history-fence.ts comment already calls out ("Yes, your code FREE90 is still active",
//     "I've confirmed the arrangement we discussed") that assert an offer without a % or the word "code".
// This check reads the reply's MEANING and catches those. It runs ONLY when the cheap floor did not
// already fire (the floor stays the guaranteed catch; this is purely additive).
//
// FAIL-SAFE DIRECTION. Returns `false` (do not block) on ANY model/parse failure — because at every call
// site the deterministic floor has ALREADY screened this reply and passed it, so a check failure falls
// back to exactly the pre-3b baseline. This check can only ADD catches, never remove the floor's, and its
// failure is never worse than today. Only an explicit `{"inventsOffer":true}` blocks.
//
// GOVERNANCE. A per-turn extra model call (cost, ADR-0013 — metered under its own agentType by the server)
// AND a reply-behaviour change (money-guard), so it runs only behind the OUTGOING_OFFER_CHECK posture flag
// and is enabled only through the eval gate → shadow → canary → human promotion (HITL §5). Inert until then.

const OFFER_CHECK_SYSTEM_PROMPT =
  "You are a strict money-safety checker for a shopping assistant whose store provides it NO discounts, " +
  "promo/coupon/voucher codes, free products, or refunds. Decide whether the ASSISTANT REPLY below " +
  "PROMISES, CONFIRMS, GRANTS, or INVENTS any of: a discount or price reduction, a promo/coupon/voucher " +
  "code, a free product or freebie, or a refund/credit — in ANY language, including paraphrases and " +
  "indirect confirmations (for example: 'your code is still active', 'I've applied that for you', " +
  "'I've arranged the refund'). It is NOT inventing when the reply merely SAYS IT CANNOT offer one, " +
  "declines, or discusses the store's own grounded policy. Output ONLY this JSON, no prose, no markdown " +
  'fences: {"inventsOffer":true|false}';

/** Pull the first JSON object out of the checker's response, tolerating a markdown fence (mirrors
 *  brain.ts's extractPersonaClassifierJson). Throws when there is no extractable JSON — the caller fails
 *  safe (does not block) rather than treating model prose as a verdict. */
function extractOfferJson(text: string): { inventsOffer?: unknown } {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("offer check: no JSON object in response");
  return JSON.parse(raw.slice(start, end + 1)) as { inventsOffer?: unknown };
}

/**
 * True iff the reply invents an ungrounded discount/code/freebie/refund. Never throws; returns `false` on
 * any model/network/parse failure (fail-safe to the deterministic floor that already screened this reply).
 * Only an explicit boolean `true` blocks — a missing/again-non-boolean field is treated as "not an offer".
 */
export async function classifyOutgoingOffer(model: ModelPort, reply: string, tenantId: string): Promise<boolean> {
  let responseText: string;
  try {
    const res = await model.complete({
      messages: [
        { role: "system", content: OFFER_CHECK_SYSTEM_PROMPT },
        { role: "user", content: reply },
      ],
      temperature: 0,
      tenantId,
      responseSchema: {
        type: "object",
        additionalProperties: false,
        properties: { inventsOffer: { type: "boolean" } },
        required: ["inventsOffer"],
      },
    });
    responseText = res.text;
  } catch {
    return false; // fail-safe — a model/network error never blocks a reply the floor already passed
  }
  try {
    return extractOfferJson(responseText).inventsOffer === true;
  } catch {
    return false; // fail-safe — unparseable output is never treated as an offer verdict
  }
}
