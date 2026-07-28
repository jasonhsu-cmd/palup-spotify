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

/**
 * The TUNABLE slice of agent behavior that a self-improvement candidate may vary. It shapes the sales
 * *voice* and proactivity only — the guardrails (safety escalation, injection-as-data,
 * no-pitch-into-problem, no invented discounts) live in code and are NOT part of the policy, so a
 * candidate can never loosen them. This is what makes self-improvement governable.
 */
export interface Policy {
  id: string;
  label: string;
  /** Injected into the system prompt to shape voice/conciseness/emphasis. */
  styleDirective: string;
  /** Default proactivity when the shopper's own signal doesn't specify one. */
  proactivityDefault: ProactivityLevel;
}

/** Consent state per channel (legally load-bearing; unknown is treated as no-consent). */
export type Consent = "in" | "out" | "unknown";

export interface Signals {
  mood?: Mood;
  relationship?: Relationship;
  proactivityLevel?: ProactivityLevel;
  /** Support issues currently open (INV-B: any open issue suppresses sales). */
  openIssues?: string[];
  cart?: "empty" | "has_items" | "high_value";
  /** True once a safety event has latched this conversation (INV-A). */
  safetyLatched?: boolean;
  /** Marketing consent per channel; drives outbound gating (TCPA/CAN-SPAM). */
  consent?: { email?: Consent; sms?: Consent };
  /** Merchant "discuss competitors" mode (default full). Governs competitor-comparison replies. */
  groundingMode?: "off" | "general" | "full";
  /** Kill switch engaged for this agent/merchant/global — the agent must halt and hand off to a human. */
  killed?: boolean;
}

export interface Decision {
  mode: Mode;
  reply: string;
  pitch: PitchKind;
  escalateToHuman: boolean;
  /** Whether the agent initiated an outbound channel action (email/SMS follow-up). Gated on consent. */
  outbound: boolean;
  safetyClass: SafetyClass;
  /** Machine-checkable audit tags the eval harness grades against. */
  flags: string[];
  model: string;
}
