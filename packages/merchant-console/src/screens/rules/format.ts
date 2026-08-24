import type { CategoryRuleEnvelope, PalupFloor, ProposalCategory } from "@palup/platform-ports";

// Task 9 — pure, unit-testable formatting helpers for the rules editor's three-layer honesty
// requirement (task-9-brief.md, the Task-5-ruling honesty rule): PalUp inviolable floor <
// merchant envelope (what they set) < effective agent auto-limit (clampToFloor(merchant, floor)).
//
// BUILD-SAFETY NOTE (verified, not speculative): every import from `@palup/platform-ports` here is
// `import type` only — deliberately, matching `app/api.ts`'s existing precedent. A real (value)
// import of ANYTHING from that package — confirmed by testing `AUTO_ELIGIBLE_DIMENSIONS` and,
// separately, `clampToFloor` — breaks `vite build` for this console: the package's `main` is its
// single barrel `src/index.ts`, which also re-exports `audit-hash.ts` (`import { createHash } from
// "node:crypto"`), and Rollup does not tree-shake that node-only import out of the browser bundle
// even when the requested export is unrelated to it (`"createHash" is not exported by
// "__vite-browser-external"`). So `AUTO_ELIGIBLE_DIMENSIONS` (which categories are pct/usd
// auto-eligible) and the clamp arithmetic are duplicated below as plain local data/logic — the same
// numbers `@palup/platform-ports`'s `PALUP_FLOORS`/`clampToFloor` encode, kept in sync by comment
// reference, not by a runtime import this package's structure cannot yet support safely.
// Every function here is pure data-in/string-out so RulesEditor/CategoryRuleCard never compute
// their own copy of "what does this number actually mean" — a single source of truth, same
// discipline as `@palup/platform-ports`' own `clampToFloor`/`mergeOverDefaults`.

const LABELS: Record<ProposalCategory, string> = {
  discount: "Discounts", ad_spend: "Ad spend", refund: "Refunds & price-match",
  campaign: "Campaigns & messaging", subscription: "Subscriptions", autonomy_scope: "Other actions",
};
export function categoryLabel(c: ProposalCategory): string { return LABELS[c]; }

/** Local mirror of `@palup/platform-ports`' `AUTO_ELIGIBLE_DIMENSIONS` (see the build-safety note
 *  above for why this can't be a runtime import) — which dimensions a category's numeric caps
 *  actually mean something for, independent of which floors happen to be non-zero. Keep this in
 *  sync with `PALUP_FLOORS`/`AUTO_ELIGIBLE_DIMENSIONS` (packages/platform-ports/src/index.ts) by
 *  hand if either ever changes; there is no compiler check tying the two together. */
const AUTO_ELIGIBLE_DIMENSIONS: Record<ProposalCategory, ReadonlyArray<"pct" | "usd">> = {
  discount: ["pct", "usd"],
  ad_spend: ["usd"],
  refund: ["usd"],
  campaign: [],
  subscription: [],
  autonomy_scope: [],
};

/** One plain-language sentence for the "your agent may auto-act up to X" line — always reflecting the
 *  EFFECTIVE cap (merchant value clamped to the PalUp floor), never claiming more than the floor. */
export function describeAutoGrant(category: ProposalCategory, env: CategoryRuleEnvelope, floor: PalupFloor): string {
  if (!env.allowedAuto) return "Everything in this category comes to you for approval.";
  if (category === "discount") {
    const pct = Math.min(env.maxPct ?? floor.maxAutoPct, floor.maxAutoPct);
    return `Your agent can apply discounts up to ${pct}%${env.stackable ? ", stacking allowed" : ", never stacking"} automatically. Anything deeper needs your approval.`;
  }
  if (category === "refund") {
    const usd = Math.min(env.maxUsd ?? floor.maxAutoUsd ?? 0, floor.maxAutoUsd ?? 0);
    const pm = Math.min(env.priceMatchMaxUsd ?? 0, floor.maxAutoUsd ?? 0);
    return `Your agent can auto-refund up to $${usd} and price-match up to $${pm}. Larger amounts need your approval.`;
  }
  if (category === "ad_spend") {
    const perAction = Math.min(env.maxUsd ?? floor.maxAutoUsd ?? 0, floor.maxAutoUsd ?? 0);
    const period = Math.min(env.periodBudgetUsd ?? floor.maxAutoPeriodUsd ?? 0, floor.maxAutoPeriodUsd ?? 0);
    return `Your agent can auto-buy ads up to $${perAction} per action and $${period} per period, only at ${env.roiFloor ?? "—"}× ROI or better.`;
  }
  if (category === "subscription") {
    const acts = env.subscriptionSelfServe ?? [];
    return acts.length ? `Your agent can auto-handle: ${acts.join(", ")}. Anything else escalates to you.` : "All subscription changes escalate to you.";
  }
  if (category === "campaign") {
    const q = env.quietHours;
    return `Auto-sends respect a ${env.frequencyCapPerWeek ?? "—"}/week cap per person${q ? ` and quiet hours ${q.startHour}:00–${q.endHour}:00` : ""}. Bulk sends still need your approval.`;
  }
  return "This category always requires your approval.";
}

/** The read-only "inviolable ceiling" line (layer 1) — dimension-aware so a category with a
 *  structurally no-op `maxAutoPct` (e.g. refund/ad_spend/campaign/subscription's 100%, see
 *  `PALUP_FLOORS`'s own comments in @palup/platform-ports) never gets shown as if it were a real
 *  percentage cap. That would be its own small honesty violation — a merchant reading "PalUp caps
 *  this at 100%" for refunds would reasonably conclude PalUp allows 100%-of-order auto-refunds,
 *  when the real (and only real) ceiling is the dollar one. Only dimensions this category is
 *  actually auto-eligible on (`AUTO_ELIGIBLE_DIMENSIONS`) are rendered. */
export function floorCeilingText(category: ProposalCategory, floor: PalupFloor): string {
  const dims = AUTO_ELIGIBLE_DIMENSIONS[category];
  const parts: string[] = [];
  if (dims.includes("pct")) parts.push(`${floor.maxAutoPct}%`);
  if (dims.includes("usd") && floor.maxAutoUsd !== undefined) parts.push(`$${floor.maxAutoUsd}`);
  if (parts.length === 0) {
    return category === "campaign"
      ? `No dollar/percentage cap here — mass sends of ${floor.massSendRecipientFloor}+ recipients always require your approval, platform-wide.`
      : "This category has no auto-act dollar/percentage ceiling — every action here requires your approval.";
  }
  let text = `PalUp caps this at ${parts.join(" / ")}`;
  if (category === "ad_spend" && floor.maxAutoPeriodUsd !== undefined) {
    text += ` per action, $${floor.maxAutoPeriodUsd} per rolling period`;
  }
  return text;
}

/** Layer-3 honesty flags (the review-mandated core of this screen): one message per numeric
 *  dimension where the STORED merchant envelope exceeds PalUp's inviolable floor — i.e. exactly the
 *  case where showing only the raw merchant value would mislead the merchant into thinking their
 *  agent can act past the floor. Empty when nothing the merchant set is above the floor. Checked
 *  independent of `allowedAuto` — the stored value can be above the floor whether or not auto-act
 *  is currently on (write-time clamping is intentionally not done; see task-9-brief.md). */
export function cappedWarnings(category: ProposalCategory, env: CategoryRuleEnvelope, floor: PalupFloor): string[] {
  const warnings: string[] = [];
  const dims = AUTO_ELIGIBLE_DIMENSIONS[category];
  if (dims.includes("pct") && env.maxPct !== undefined && env.maxPct > floor.maxAutoPct) {
    warnings.push(
      `Capped at ${floor.maxAutoPct}% by PalUp's floor — your setting of ${env.maxPct}% won't take effect for auto-actions.`,
    );
  }
  if (dims.includes("usd") && floor.maxAutoUsd !== undefined && env.maxUsd !== undefined && env.maxUsd > floor.maxAutoUsd) {
    warnings.push(
      `Capped at $${floor.maxAutoUsd} by PalUp's floor — your setting of $${env.maxUsd} won't take effect for auto-actions.`,
    );
  }
  if (floor.maxAutoPeriodUsd !== undefined && env.periodBudgetUsd !== undefined && env.periodBudgetUsd > floor.maxAutoPeriodUsd) {
    warnings.push(
      `Capped at $${floor.maxAutoPeriodUsd} per period by PalUp's floor — your setting of $${env.periodBudgetUsd} won't take effect for auto-actions.`,
    );
  }
  if (floor.maxAutoUsd !== undefined && env.priceMatchMaxUsd !== undefined && env.priceMatchMaxUsd > floor.maxAutoUsd) {
    warnings.push(
      `Price-match capped at $${floor.maxAutoUsd} by PalUp's floor — your setting of $${env.priceMatchMaxUsd} won't take effect for auto-actions.`,
    );
  }
  return warnings;
}
