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

// ── Persona / shopper-disposition layer (PR-0, INERT until the DISPOSITION_* flags flip) ────────────
// First-class runtime representation of the disposition taxonomy (docs/design/shopper-widget.md §4).
// These steer SERVICE/GUIDANCE STYLE ONLY — never price/offers/tier (FAIR-1). Inert in PR-0.
/** The service/guidance posture that best fits the shopper. */
export type PersonaStyle = "ready" | "researcher" | "deal_seeker" | "needs_guidance";
/** Who the shopper is buying for. `b2b` still routes to escalate; `gift` is style-only. */
export type PersonaRole = "for_self" | "gift" | "b2b";
/** Concrete in-session behavioral events (server-derived; never trusted raw). */
export type BehavioralEvent = "dwell" | "hesitation" | "repeat_question" | "pitch_declined" | "idle_then_return" | "rage";
export type Device = "mobile" | "desktop" | "tablet";
export type Entry = "ad" | "organic" | "direct" | "email" | "social";
export type SessionRecency = "new" | "returning" | "cross_day";

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

/**
 * Persona-disposition layer (PR-0), brain-side shape. OPAQUE bare-string data — NOT imported from
 * @palup/widget-memory (preserves the no-dep-cycle contract), but structurally compatible with that
 * package's own narrower-typed `Disposition` (axis is a closed enum there; a bare string here because
 * the brain must never branch on it — Inv 10 / fairness). Named here (PR-8) so both `RecalledFact`
 * (durable, cross-visit) and `SessionState.sessionDisposition` / `Signals.sessionDisposition` (transient,
 * in-session fallback) share one shape without either side trusting it as anything but opaque data.
 */
export interface Disposition {
  axis: string;
  value: string;
  provenance: string;
  confidence: number;
  sourceQuote?: string;
}

/**
 * A single durable, cross-visit fact recalled about a shopper (ADR-0015 T11). Defined HERE — NOT
 * imported from @palup/widget-memory — so this package never depends on that one (no dep cycle;
 * widget-memory already depends on widget-brain for the shared Consent/region vocabulary). The shape is
 * structurally compatible with widget-memory's own `RecalledFact`, so any real MemoryService satisfies
 * `MemoryRecallPort` with zero adapter code. `class` is optional/untyped here (a bare string) precisely
 * because the brain must treat it as opaque, untrusted DATA — it is NEVER branched on to change
 * guardrail behavior (Inv 10).
 */
export interface RecalledFact {
  text: string;
  class?: string;
  /**
   * Persona-disposition layer (PR-0). OPAQUE bare-string data on the brain side — NOT imported from
   * @palup/widget-memory (preserves the no-dep-cycle contract), but structurally compatible with that
   * package's typed `Disposition`. The brain NEVER branches on it (Inv 10 / fairness): a later PR
   * translates a recalled disposition through a code-owned whitelist into a benign voice directive,
   * never trusting it raw. Inert in PR-0.
   */
  disposition?: Disposition[];
}

/**
 * The brain's own, minimal port for cross-visit memory RECALL (ADR-0015 T11). Read-only by design: the
 * brain only ever needs to READ prior facts to add caution to the clean sales path — it never writes
 * (that's the memory service's `remember`, called elsewhere, outside the brain). Consulted ONLY on the
 * clean sales path, after every guardrail rung has already short-circuited, and ONLY when an `anonId` is
 * available on `Signals` — never on the kill/injection/safety/support/uncertainty/b2b/proactive rungs.
 */
export interface MemoryRecallPort {
  /**
   * `region` and `consent` are OPTIONAL and carry THIS TURN's server-derived consent context. They exist
   * because a recall implementation may need to apply retention correctly — the memory service slides a
   * still-consented fact's TTL forward on a return visit (ADR-0015 Inv 4 amendment) and cannot decide
   * that without knowing what the shopper consented to. Before they were threaded, widget-backend's
   * wrapper hardcoded `"unknown"` for both tiers, so the renewal NEVER fired on the /chat path — a
   * documented, pre-existing functional gap, closed by B7 (2026-08-05).
   *
   * They are NOT the brain's own read-time gate: the brain applies `consentPermits` (consent-rules.ts)
   * to whatever this port returns, independently, so an implementation that ignores these fields can
   * still never cause an unconsented fact to surface. Optional so a third-party adapter need not
   * implement them.
   */
  recall(ctx: {
    tenantId: string;
    anonId: string;
    region?: Signals["region"];
    consent?: Signals["consent"];
  }): Promise<RecalledFact[]>;
}

/** One retrieved catalog candidate: an id and how near it scored. NO TEXT, deliberately — see below. */
export interface RetrievedProduct {
  /** The merchant's own product id, to be resolved against the LIVE catalog by the caller. */
  productId: string;
  /** Similarity, higher = nearer. Reported for audit/debugging; the brain does not threshold on it. */
  score: number;
}

/**
 * The brain's own, minimal port for CATALOG RETRIEVAL (E1) — read-only, and defined HERE rather than
 * imported, for the same no-dep-cycle reason as `MemoryRecallPort` above: widget-backend implements it
 * (`catalog-retriever.ts`) and this package never depends on that one.
 *
 * IT RETURNS IDS, NOT TEXT, and that is load-bearing. The corpus behind it stores ids only — "a relevance
 * index over product IDS, not a second copy of the catalog" (catalog-index.ts) — precisely so that a
 * price or description cannot go stale inside it and be quoted at a shopper. The brain resolves each id
 * against the LIVE `GroundingContext` and drops anything it cannot find, so a delisted product is
 * physically unquotable no matter what the corpus still remembers (#157/#180's stale-falsehood lesson).
 *
 * Consulted ONLY on the clean sales path, behind the CATALOG_RETRIEVAL posture flag, and only for a
 * shopper's own non-empty turn — never on the kill/injection/safety/support/uncertainty/b2b rungs, and
 * never on a proactive turn (where the "message" is the agent's own prompt, not the shopper's words).
 *
 * FAIL-OPEN CONTRACT: an implementation that cannot answer must REJECT. The brain treats a rejection and
 * an empty result identically — it renders the FULL catalog exactly as it does today. Retrieval can
 * therefore make a prompt smaller, never make an answer worse-grounded than the flag-off baseline.
 */
export interface CatalogRetrieverPort {
  retrieve(ctx: { tenantId: string; query: string; k: number }): Promise<RetrievedProduct[]>;
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
  /** Marketing consent per channel; drives outbound gating (TCPA/CAN-SPAM). Also carries the two
   * cross-visit MEMORY consent tiers (ADR-0015 T12: `memoryOrdinary` = Consent 1, `memorySpecial` =
   * Consent 2 — independent of each other and of email/sms). Server/CMP-derived, never client-set;
   * unknown behaves as no-consent. These are consumed by the memory SERVICE at write-time, not by the
   * brain — the brain's own `memory.recall` call carries no consent (see `MemoryRecallPort`). */
  consent?: { email?: Consent; sms?: Consent; memoryOrdinary?: Consent; memorySpecial?: Consent };
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
   * §8a invariant 14 — the merchant (or the platform) has reached its cost/billing cap, so the agent runs
   * in BASIC MODE: no proactive/outbound initiation, while live chat continues to be answered normally.
   *
   * SERVER-DERIVED, never client-set: it comes from the shared cost-cap registry
   * (`state-postgres/src/cost-cap-registry.ts`) via `deriveServingSignals`, exactly like `kill`. A shopper
   * who could set this could silence a merchant's agent; a merchant's own storefront must not be able to
   * either.
   *
   * DELIBERATELY NOT `kill`. A kill halts the agent and hands off to a person. At cap the shopper must
   * keep being served — "live chat continues" — because a merchant's billing state is not the shopper's
   * problem and must never be visible to them. Suppression only: this signal can never grant a pitch,
   * lift the safety latch, or enable outbound.
   */
  atCap?: boolean;
  /**
   * The product/page the shopper is currently viewing (a short label from the embedding storefront), for
   * grounding the conversation to what they're looking at (§4 Contextual). UNTRUSTED merchant-page content
   * — sanitized (HTML stripped, newlines collapsed, the === fence defanged, capped) and fenced as DATA,
   * never instructions, before it reaches the model, exactly like the catalog.
   */
  pageContext?: string;
  /**
   * The SERVER-derived, per-subject key for cross-visit memory recall (ADR-0015 T12) — the guest anon
   * id, or the account id post sign-up merge. Like tenantId/region, this arrives via
   * `deriveServingSignals`, never trusted verbatim from the client: a client-sent id is only honored
   * after `validateAnonId` (charset+length bound); a bad/oversized one is dropped to `undefined`.
   * Absent ⇒ `createBrain`'s `memory.recall` is simply never consulted this turn (no subject to key on).
   */
  anonId?: string;
  /**
   * The SERVER-verified shopper id (ADR-0017), e.g. "shopify:<merchantId>:<customerId>" — SAME
   * server-derived contract as `tenantId`: `deriveServingSignals` is the only origin, overwriting any
   * client-supplied value; a client can never set/claim its own `shopperId`. Absent ⇒ anonymous shopper
   * (the brain falls back to its constructor `shopperId`, the anonymous rollout default). Drives which
   * account the support/commerce path (support.ts) verifies ownership against — never a constant.
   */
  shopperId?: string;
  // ── Persona / shopper-disposition layer (PR-0, INERT) ──────────────────────────────────────────
  // All optional; the wire-key NAMES match full-corpus.json so the eval corpus feeds the brain with zero
  // corpus edits. `personaStyle`/`personaRole` are per-turn classified + TRANSIENT (never persisted;
  // mirror `mood`). The rest are SERVER-derived + validated in deriveServingSignals, never trusted raw.
  /** The classified service/guidance posture for this turn (transient). */
  personaStyle?: PersonaStyle;
  /** Who the shopper is buying for (b2b → escalate; gift → style only). */
  personaRole?: PersonaRole;
  /** Concrete in-session behavioral events (server-derived). */
  behavioral?: BehavioralEvent[];
  device?: Device;
  entry?: Entry;
  sessionRecency?: SessionRecency;
  /** Relationship modifiers (server-derived from CSAT/complaint/return history) — style only, never price. */
  csat?: number;
  hasComplaintHistory?: boolean;
  hasReturnHistory?: boolean;
  /**
   * Shopper-disposition program PR-8 — carried forward from `SessionState.sessionDisposition` at
   * session.ts's existing merge point (mirrors `behavioral`'s carry). The in-session STYLE fallback for
   * when durable cross-visit memory is off or unconsented: an "observed" style disposition captured
   * earlier THIS session, still available on a later turn that doesn't re-supply `personaStyle`. Opaque
   * bare-string data, exactly like `RecalledFact.disposition` — the brain only ever turns it into a
   * voice directive via the SAME whitelisted lookup, never trusts it for anything else (never
   * price/pitch/outbound). Dies with the session; never durable, never merged to an account.
   */
  sessionDisposition?: Disposition[];
}

/**
 * Persona-layer flag tokens the eval harness grades against. `Decision.flags` stays `string[]`; this is
 * the controlled VOCABULARY (grade.ts `holds()` asserts these strings). PR-0 documents them; later PRs
 * emit them. Keeping the vocabulary typed here prevents drift between emitters and the graded corpus.
 */
export type PersonaFlag =
  | "persona:researcher" | "persona:deal_seeker" | "persona:needs_guidance" | "persona:ready"
  // `persona:role_gift` / `persona:role_self` complete the role vocabulary (deferred follow-up #42 from
  // PR-3, brain.ts's PERSONA_ROLE_FLAG) for the two roles that stay voice-only. There is deliberately NO
  // `persona:role_b2b`: governance BLOCK closure (Finding 3, 2026-08-04) made `personaRole === "b2b"`
  // escalate through the SAME pre-existing guardrail rung the B2B-keyword detector uses (`persona:b2b`,
  // §3.5 brain.ts, always with `escalateToHuman: true`), rather than shipping a separate voice-only b2b
  // flag that could (and did, before this fix) drift from the documented "B2B → escalate" invariant.
  | "persona:role_gift" | "persona:role_self"
  | "behavioral:dwell" | "behavioral:hesitation" | "behavioral:repeat_question" | "behavioral:declined" | "behavioral:idle_return" | "behavioral:rage"
  | "disposition:one_strike" | "safety:regulated_claim" | "memory:style_applied";

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
  /**
   * PRODUCT CITATIONS (E2) — the merchant product ids this reply actually CITED, deduplicated, in the
   * order the reply first cites each. Behind the PRODUCT_CITATIONS posture flag: OMITTED entirely (not
   * `[]`, not `undefined`-valued) whenever the flag is off or nothing resolved, so the flag-off
   * `Decision` and the /chat wire shape are unchanged.
   *
   * HOW IT IS PRODUCED, and why it can be trusted as far as it goes: the prompt renders a per-turn,
   * per-line citation tag `[P<n>-<nonce>]` for each product in the CATALOG block; the model copies tags;
   * resolution is a `hasOwnProperty`-guarded lookup in THAT turn's map with no fallback path (see
   * ./citations.ts). So an id here is always a product the model was actually shown this turn — a forged,
   * stale, invented or prototype-keyed tag resolves to nothing and is reported as `citations:dropped`.
   *
   * IT IS A LOWER BOUND, NEVER COMPLETE COVERAGE. A model that recommends a product in prose without
   * copying its tag produces NO entry here — the mechanism cannot see a paraphrase. Absence of an id
   * therefore means "not cited", never "not recommended". Any consumer that reads this as the full set of
   * what the agent recommended will under-count, and any RATE computed from it measures the model's
   * citation compliance, not its recommendation behaviour.
   *
   * NOT A BILLING BASIS. Chaining `recommended -> clicked -> purchased` off this field is LAST-TOUCH
   * attribution, which ADR-0007 §2 and docs/PRICING.md §2 forbid as a fee basis ("conservative,
   * incrementality-based attribution ... never last-touch inflation"). This is recommendation TELEMETRY:
   * product cards, link-outs, per-product eval grading, merchant-facing "what did it suggest" reporting.
   */
  recommendedProducts?: string[];
}
