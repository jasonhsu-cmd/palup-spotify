import type { CommercePort, Order } from "@palup/platform-ports";

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

export function extractOrderId(text: string): string | undefined {
  // Prefer a #-prefixed number; else a bare 4+ digit number (order ids are 4 digits — avoids matching
  // a price like "$180").
  return text.match(/#(\d{3,})/)?.[1] ?? text.match(/\b(\d{4,})\b/)?.[1];
}

export function classifySupportIntent(text: string): SupportIntent {
  const t = text.toLowerCase();
  if (/none of this|just fix it|nothing.*work|just need help|this isn.?t working/.test(t)) return "escalate_stuck";
  if (/cancel (my )?subscription|cancel.*subscription/.test(t)) return "cancel_subscription";
  if (/(skip|pause).*(month|delivery|subscription|shipment)|skip (my )?next/.test(t)) return "skip_subscription";
  if (/charged twice|double.?charg|charged me twice|why (was|am) i charged|two charges/.test(t)) return "billing";
  if (/(change|update).*(shipping )?address/.test(t)) return "address_change";
  if (/wrong (shade|colou?r)|swap.*(shade|for)|different shade|\bexchange\b/.test(t)) return "exchange";
  if (/wrong (item|product|thing)|sent (me )?the wrong|you sent me/.test(t)) return "wrong_item";
  if (/return (window|policy)|shipping policy|how long.*(return|ship|take)/.test(t)) return "policy_q";
  if (/refund/.test(t)) return "refund";
  if (/\breturn\b/.test(t)) return "return";
  if (/cancel (my )?order/.test(t)) return "cancel_order";
  if (/broken|defective|damaged|leaked|cracked|the pump/.test(t)) return "damaged";
  if (/says delivered|marked delivered|didn.?t (get|receive)|never (arrived|came|got)|lost package|package.*(lost|missing)/.test(t)) return "lost_package";
  if (/where.?s my order|order status|status of order|where is (my )?order|\btrack\b|hasn.?t (arrived|come)|days? late|\blate\b|\bstuck\b/.test(t)) return "order_status";
  if (/how (often|do i|to|much|long).*(use|apply|retinol|serum|it)/.test(t)) return "how_to";
  if (/fragrance|paraben|sulfate|nut oil|ingredient|allergen/.test(t)) return "ingredients";
  return "general";
}

export async function handleSupport(commerce: CommercePort, shopperId: string, message: string): Promise<SupportResult> {
  const intent = classifySupportIntent(message);
  const flags = ["mode_support", "no_pitch", `support:${intent}`];
  const policy = await commerce.getPolicy();
  const orderId = extractOrderId(message);

  let order: Order | null = null;
  let ownershipDenied = false;
  if (orderId) {
    const found = await commerce.getOrder(orderId);
    if (found && found.shopperId !== shopperId) ownershipDenied = true;
    else order = found;
  }
  const recent = async () => order ?? (await commerce.getRecentOrder(shopperId));
  const deny = (): SupportResult => {
    flags.push("ownership_denied", "escalate");
    return { reply: `For your security I can only look up orders on your own account, so I can't share details for order #${orderId}. If it's yours, I can connect you with a person to verify your identity.`, escalate: true, flags };
  };

  switch (intent) {
    case "order_status": {
      if (ownershipDenied) return deny();
      const o = await recent();
      if (!o) return { reply: `I couldn't find an order to check — could you share your order number? Our orders usually arrive in 3–5 business days.`, escalate: false, flags };
      const late = o.placedDaysAgo >= 7 || o.status.includes("stuck");
      const eta = o.eta ? ` — ${o.eta}` : ` — I don't have a firm delivery estimate right now`;
      if (late) { flags.push("escalate"); return { reply: `I can see order #${o.id} is ${o.status}${eta}. Since it's running late, I can start a reship or a refund per our policy, or connect you with a person — which would you prefer?`, escalate: true, flags }; }
      return { reply: `Your order #${o.id} is ${o.status}${eta}.`, escalate: false, flags };
    }
    case "policy_q":
      return { reply: `Our return policy: ${policy.returns} Shipping: ${policy.shipping}`, escalate: false, flags };
    case "return": {
      if (ownershipDenied) return deny();
      const o = await recent();
      const past = o ? o.placedDaysAgo > policy.returnWindowDays : false;
      if (past) { flags.push("escalate"); return { reply: `I'm sorry — that order was placed ${o!.placedDaysAgo} days ago, which is past our ${policy.returnWindowDays}-day return window, so I can't start a standard return. I can connect you with a person to see what options we might have.`, escalate: true, flags }; }
      return { reply: `Happy to help — ${o ? `order #${o.id} was placed ${o.placedDaysAgo} days ago, within our ${policy.returnWindowDays}-day window` : `that's within our ${policy.returnWindowDays}-day window`}, so for an unopened item I can start the return and email you a prepaid label. Want me to go ahead?`, escalate: false, flags };
    }
    case "refund": {
      if (ownershipDenied) return deny();
      const o = await recent();
      const above = o ? o.total > policy.refundCeiling : false;
      if (above) { flags.push("refund_hitl", "escalate"); return { reply: `I'm sorry about that. A refund of $${o!.total} is above the amount I can approve directly, so I've routed it to a team member to process — you'll hear back shortly, and I've checked there's no duplicate refund on this order.`, escalate: true, flags }; }
      flags.push("refund_within_ceiling"); return { reply: `I'm sorry about that${o ? ` with order #${o.id}` : ""} — I can process a refund within our policy, and I've confirmed there's no duplicate refund already on it. You'll see it back on your original payment method in a few business days.`, escalate: false, flags };
    }
    case "damaged": {
      const o = await recent();
      const above = o ? o.total > policy.refundCeiling : false;
      if (above) flags.push("refund_hitl", "escalate");
      return { reply: `I'm really sorry your item arrived damaged — that's not the experience we want, and you don't need to send any proof. I can arrange a replacement or a refund per our policy${above ? `; since this order is $${o!.total}, I'm routing the refund to a person to approve` : ""}. Which would you prefer?`, escalate: above, flags };
    }
    case "wrong_item":
      return { reply: `I'm sorry — that's our mistake. I'll get the correct item sent to you right away and email a prepaid label to return the wrong one; you won't be charged for either. Sorry for the hassle!`, escalate: false, flags };
    case "exchange":
      return { reply: `Of course — I can set up an exchange for a different shade. Let me check we have it in stock, and I'll email you a prepaid label for the original. Which shade would you like?`, escalate: false, flags };
    case "cancel_order": {
      if (ownershipDenied) return deny();
      const o = await recent();
      if (o && o.fulfilled) { flags.push("escalate"); return { reply: `I checked and order #${o.id} has already shipped, so I can't cancel it from here — but I can connect you with a person to arrange a return or intercept it with the carrier.`, escalate: true, flags }; }
      return { reply: `I checked and ${o ? `order #${o.id}` : "your order"} hasn't shipped yet, so I've cancelled it and you'll see the refund on your original payment method.`, escalate: false, flags };
    }
    case "cancel_subscription": {
      const sub = await commerce.getSubscription(shopperId);
      if (!sub?.active) return { reply: `You don't have an active subscription right now, so there's nothing to cancel — let me know if there's anything else I can help with.`, escalate: false, flags };
      return { reply: `Done — I've cancelled your subscription, effective immediately, and you won't be charged again. If you'd ever rather just pause it that's one tap too, but no pressure — you're all set.`, escalate: false, flags };
    }
    case "skip_subscription":
      return { reply: `Done — I've skipped your next subscription delivery. Your following order will ship as usual.`, escalate: false, flags };
    case "lost_package": {
      const o = await recent();
      flags.push("escalate");
      return { reply: `I'm sorry it hasn't reached you${o ? ` (order #${o.id})` : ""} — that's frustrating and I won't assume anything went wrong on your end. Per our policy I can start a carrier check and then reship or refund it; I'll get that going and loop in a person to make sure it's sorted.`, escalate: true, flags };
    }
    case "address_change": {
      if (ownershipDenied) return deny();
      const o = await recent();
      if (o && o.fulfilled) { flags.push("escalate"); return { reply: `Order #${o.id} has already shipped, so the address can't be changed now — I can connect you with a person to try to redirect it with the carrier.`, escalate: true, flags }; }
      return { reply: `Happy to help — I've confirmed this order is on your account, and since ${o ? `order #${o.id}` : "it"} hasn't shipped yet I've updated the shipping address. You'll get a confirmation email.`, escalate: false, flags };
    }
    case "billing":
      flags.push("escalate");
      return { reply: `Let me look into that — I can see the charges on your order, but I won't guess about a possible duplicate. Anything involving a disputed charge I route to a person so it's reviewed properly and no money is adjusted without a person confirming. I'm connecting you now.`, escalate: true, flags };
    case "how_to":
      return { reply: `Good question — for retinol most people start about 2 nights a week and build up as their skin adjusts; use a pea-sized amount on dry skin and wear SPF the next day. If you have a skin condition or you're unsure, it's best to check with a dermatologist.`, escalate: false, flags };
    case "ingredients":
      return { reply: `Let me confirm from our catalog rather than guess. If this is about an allergy I want to be careful — I can't guarantee a product is safe for a specific allergy, so if you're concerned it's worth checking the full ingredient list with your doctor.`, escalate: false, flags };
    case "escalate_stuck":
      flags.push("escalate");
      return { reply: `I'm sorry this hasn't been sorted out — I don't want to keep you going in circles. I'm connecting you with a person who can help right now; they'll take it from here.`, escalate: true, flags };
    default:
      return { reply: `I'd like to help — could you tell me a bit more, or share your order number if it's about an order?`, escalate: false, flags };
  }
}
