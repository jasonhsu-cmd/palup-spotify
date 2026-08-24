import type { MerchantRuleSet } from "./merchant-rules-store.js";

/** A named starting envelope a merchant can adopt in one click (onboarding or the rules editor).
 *  `vertical: "all"` is the industry-agnostic Day-1 baseline; others are informed by (but not gated on)
 *  the W3 aggregate layer. Every preset is authored ≤ PALUP_FLOORS so `clampToFloor` is a no-op on it. */
export interface RulePreset {
  id: string;
  label: string;
  vertical: string;
  description: string;
  envelope: MerchantRuleSet;
}

/** Conservative-but-useful Day-1 (ratified §10): the agent may answer + make tiny in-policy nudges,
 *  but ALL spend/discount/refund stay approval-gated until earned. Comms carry safe guardrails
 *  (frequency cap + quiet hours) so that if the merchant later enables campaign auto-send, the blast
 *  radius is already fenced. Nothing here auto-spends a cent. */
export const CONSERVATIVE_DAY1_PRESET: RulePreset = {
  id: "day1-conservative",
  label: "Conservative (recommended)",
  vertical: "all",
  description: "Your agent answers shoppers and makes tiny in-policy nudges automatically. Every discount, refund, or ad-spend still comes to you for approval until you widen these rules.",
  envelope: {
    discount: { allowedAuto: false, maxPct: 10, stackable: false },
    ad_spend: { allowedAuto: false, roiFloor: 3, periodBudgetUsd: 0 },
    refund: { allowedAuto: false, maxUsd: 0, priceMatchMaxUsd: 0 },
    subscription: { allowedAuto: false, subscriptionSelfServe: ["pause", "skip"] },
    campaign: { allowedAuto: false, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } },
  },
};

/** Per-vertical starting points. Still conservative on money (auto OFF for discount/ad_spend/refund),
 *  differing only in the SHAPE of the guardrails a vertical tends to need (e.g. skincare's higher
 *  price-match tolerance, tighter comms cadence). Tunable later from W3 aggregate data — that tuning
 *  is a future data-driven follow-on, not a dependency of shipping these. */
export const VERTICAL_PRESETS: readonly RulePreset[] = [
  {
    id: "skincare",
    label: "Skincare & beauty",
    vertical: "skincare",
    description: "Tighter message cadence and a modest price-match allowance suited to repeat-purchase skincare.",
    envelope: {
      discount: { allowedAuto: false, maxPct: 15, stackable: false },
      ad_spend: { allowedAuto: false, roiFloor: 3, periodBudgetUsd: 0 },
      refund: { allowedAuto: false, maxUsd: 0, priceMatchMaxUsd: 25 },
      subscription: { allowedAuto: false, subscriptionSelfServe: ["pause", "skip"] },
      campaign: { allowedAuto: false, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } },
    },
  },
  {
    id: "apparel",
    label: "Apparel & accessories",
    vertical: "apparel",
    description: "Room for seasonal discounting depth with codes that never auto-stack; standard comms cadence.",
    envelope: {
      discount: { allowedAuto: false, maxPct: 20, stackable: false },
      ad_spend: { allowedAuto: false, roiFloor: 2.5, periodBudgetUsd: 0 },
      refund: { allowedAuto: false, maxUsd: 0, priceMatchMaxUsd: 0 },
      subscription: { allowedAuto: false, subscriptionSelfServe: [] },
      campaign: { allowedAuto: false, frequencyCapPerWeek: 3, quietHours: { startHour: 21, endHour: 8 } },
    },
  },
  {
    id: "supplements",
    label: "Supplements & wellness",
    vertical: "supplements",
    description: "Subscription-first: self-serve pause/skip, cancellations escalate; conservative discounting.",
    envelope: {
      discount: { allowedAuto: false, maxPct: 10, stackable: false },
      ad_spend: { allowedAuto: false, roiFloor: 3, periodBudgetUsd: 0 },
      refund: { allowedAuto: false, maxUsd: 0, priceMatchMaxUsd: 0 },
      subscription: { allowedAuto: false, subscriptionSelfServe: ["pause", "skip"] },
      campaign: { allowedAuto: false, frequencyCapPerWeek: 2, quietHours: { startHour: 21, endHour: 9 } },
    },
  },
];

export function listPresets(): readonly RulePreset[] {
  return [CONSERVATIVE_DAY1_PRESET, ...VERTICAL_PRESETS];
}

export function findPreset(id: string): RulePreset | undefined {
  return listPresets().find((p) => p.id === id);
}
