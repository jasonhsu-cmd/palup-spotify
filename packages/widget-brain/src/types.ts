// Domain types for the shopper widget brain. Mirrors docs/design/shopper-widget.md §4–§6, §6A.

export type Mood =
  | "frustrated"
  | "upset"
  | "anxious"
  | "confused"
  | "skeptical"
  | "neutral"
  | "satisfied";

export type Relationship =
  | "anonymous"
  | "new"
  | "repeat"
  | "vip"
  | "subscriber"
  | "replenishment_due"
  | "lapsed"
  | "one_and_done";

export type SafetyClass =
  | "none"
  | "product_safety"
  | "medical"
  | "distress"
  | "regulated_claim"
  | "legal"
  | "injection"
  | "abuse";

export type Mode = "safety" | "support" | "sales" | "smalltalk";

export type PitchKind =
  | "guided_rec"
  | "objection_close"
  | "cart_recovery"
  | "cross_sell"
  | "upsell"
  | "subscription"
  | "replenishment"
  | "promo"
  | "none";

export type ProactivityLevel = "cautious" | "balanced" | "confident";

export interface Signals {
  mood?: Mood;
  relationship?: Relationship;
  proactivityLevel?: ProactivityLevel;
  /** Support issues currently open (INV-B: any open issue suppresses sales). */
  openIssues?: string[];
  cart?: "empty" | "has_items" | "high_value";
  /** True once a safety event has latched this conversation (INV-A). */
  safetyLatched?: boolean;
}

export interface Decision {
  mode: Mode;
  reply: string;
  pitch: PitchKind;
  escalateToHuman: boolean;
  safetyClass: SafetyClass;
  /** Machine-checkable audit tags the eval harness grades against. */
  flags: string[];
  model: string;
}
