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

/**
 * A single prior conversational turn the CLIENT replays on /chat to give the model in-session,
 * multi-turn context (docs/design/shopper-widget.md §3.2 personalization, §6A conversation
 * continuity) — the fix for the "widget doesn't remember" gap. Client-facing wire shape: `role` is
 * "user" (shopper) or "agent" (assistant), mapped to the model port's user/assistant roles when
 * threaded. This is TRANSIENT request context: it is NEVER persisted server-side (SessionState stays
 * control-only) and, being a non-system message, is redacted at the model port like any user turn
 * before it reaches the provider. Cross-visit / durable per-customer recall is out of scope here.
 */
export interface HistoryTurn {
  role: "user" | "agent";
  content: string;
}

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
  /** Shopper jurisdiction; drives data-residency / consent regime (unknown = treat conservatively). */
  region?: "us" | "eu" | "uk" | "other";
  /** Operator kill switch for this session/scope — when true the agent halts and hands to a human. */
  kill?: boolean;
  /**
   * A human has taken over this conversation (live-agent / Approval Center handoff). Clears
   * `escalation_pending` (§6A: escalation hands off the mode). Server/operator-set, never client.
   */
  handoff?: boolean;
  /**
   * Tenant/merchant the agent is serving. SERVER-DERIVED from the verified widget token — never set by
   * the client (deriveServingSignals overwrites any client value). Drives per-merchant grounding
   * (the merchant's own catalog/policy) and model tenancy. Absent ⇒ the demo tenant during rollout.
   */
  tenantId?: string;
  /**
   * Shopper's LOCAL hour of day (0–23), SERVER-DERIVED from the request's locale/timezone — never
   * client-set (deriveServingSignals is the only origin, exactly like tenantId/region). Drives
   * quiet-hours OUTBOUND suppression ONLY (never the reactive reply). Absent ⇒ time unknown ⇒ NOT
   * treated as quiet hours (the consent gate still applies).
   */
  localHour?: number;
  /**
   * An AGENT-INITIATED proactive trigger (§4 Behavioral: exit-intent; §5 Timing) — NOT a shopper
   * message. "exit_intent" = the shopper's pointer left toward the top of the viewport with an
   * unrecovered cart. It is evaluated ONLY on the clean sales path (every higher precedence rung wins
   * first) and NEVER overrides a brake: it may surface AT MOST a single, value-aligned cart_recovery
   * pitch, still gated by the mood brake, support/safety suppression, and the ONE INV-E budget. It is
   * never run through the shopper-message intent classifiers; the shopper turn on a proactive trigger
   * is empty. Sentinel-valued.
   */
  proactiveTrigger?: "exit_intent";
  /**
   * The product/page the shopper is currently viewing (a short label from the embedding storefront), for
   * grounding the conversation to what they're looking at (§4 Contextual). UNTRUSTED merchant-page content
   * — sanitized (HTML stripped, newlines collapsed, the === fence defanged, capped) and fenced as DATA,
   * never instructions, before it reaches the model, exactly like the catalog.
   */
  pageContext?: string;
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
