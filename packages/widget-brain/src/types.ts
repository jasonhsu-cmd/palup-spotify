// Domain types for the shopper widget brain. Mirrors docs/design/shopper-widget.md §4–§6, §6A.

// Type-only import (erased at compile) — support.ts type-imports HistoryTurn from here, so this is a
// types-only cycle with no runtime edge. SupportIntent is defined next to handleSupport, where it is used.
import type { SupportIntent } from "./support.js";

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
    /**
     * PR3 (semantic-memory-v1) T8 — a PRE-COMPUTED query embedding, shared with catalog retrieval by the
     * brain's turn-embedder so the turn spends at most ONE embed call regardless of how many consumers
     * are active. Optional and purely additive: an implementation that ignores it (ranks nothing, returns
     * its own list-all) is unaffected — this can never narrow or withhold what a caller without one gets.
     */
    queryVector?: number[];
    /** The embed space `queryVector` was produced in, for the implementation to check against its own
     *  corpus/manifest pin before trusting it for ranking (mirrors `CatalogRetrieverPort.retrieve`'s same
     *  field, and widget-memory's `MemoryRecallOpts.pin`). */
    pin?: { model: string; dimension: number };
  }): Promise<RecalledFact[]>;
}

/** One retrieved catalog candidate: an id and how near it scored. NO TEXT, deliberately — see below. */
export interface RetrievedProduct {
  /** The merchant's own product id, to be resolved against the LIVE catalog by the caller. */
  productId: string;
  /** Similarity, higher = nearer. Reported for audit/debugging; the brain does not threshold on it. */
  score: number;
  /**
   * S2 — the corpus row's render metadata (title, variantId, …), written by the index job from Task 1's
   * stable fields. Opaque to the brain except for the known keys it reads (`title`/`variantId`); NEVER
   * carries price/availability (those live in `ProductFactsPort`, never the corpus, so a stale price
   * cannot be quoted from it). Optional so a pre-S2 corpus record (no metadata) still type-checks.
   */
  metadata?: Record<string, unknown>;
}

/**
 * S2 — the retriever's full answer for one turn: the ranked hits plus the corpus's own product count, so
 * the render path's "N of M" prompt header can report how much of the catalog this narrowed FROM without a
 * second port method or a full catalog fetch.
 */
export interface CatalogRetrievalResult {
  hits: RetrievedProduct[];
  /** manifest.products — the corpus size, for the render path's "N of M" prompt header. */
  corpusProductCount: number;
}

/**
 * The brain's own, minimal port for CATALOG RETRIEVAL (E1) — read-only, and defined HERE rather than
 * imported, for the same no-dep-cycle reason as `MemoryRecallPort` above: widget-backend implements it
 * (`catalog-retriever.ts`) and this package never depends on that one.
 *
 * IT RETURNS IDS PLUS RENDER METADATA, NEVER PRICE/AVAILABILITY, and that is load-bearing. The corpus
 * behind it stores ids + stable render fields (title, variantId) — "a relevance index over product IDS,
 * not a second copy of the catalog" (catalog-index.ts) — precisely so that a price cannot go stale inside
 * it and be quoted at a shopper (price is filled in later, by-id, from `ProductFactsPort`).
 *
 * S2 — the render path (`brain.retrieveViaShell`) builds each rendered `Product` directly from a hit's own
 * `metadata`, NOT by resolving against a live `GroundingContext` (that full-catalog fetch is exactly what
 * the shell replaces — see `GroundingPort.getShell`). A hit with no `metadata.title` is dropped (unusable
 * for render) rather than rendered blank; there is deliberately no "is this id still in the live catalog"
 * check on this path — corpus freshness is the index job's job (reconciliation on re-index), not a
 * per-turn one. Older, per-id "resolve against the live catalog and drop what's not found" behaviour
 * (#157/#180's stale-falsehood lesson) predates S2 and no longer applies to this path; keeping a corpus
 * row from outliving a delisted product is now the producer's responsibility.
 *
 * Consulted ONLY on the clean sales path, behind the CATALOG_RETRIEVAL posture flag, and only for a
 * shopper's own non-empty turn — never on the kill/injection/safety/support/uncertainty/b2b rungs, and
 * never on a proactive turn (where the "message" is the agent's own prompt, not the shopper's words).
 *
 * FAIL-OPEN CONTRACT: an implementation that cannot answer must REJECT. On the S2 shell-based render path
 * there is no full catalog to fall back to (that is the whole point of the shell), so a rejection — or a
 * result with zero renderable hits — resolves to brand+policy with NO catalog block, never a throw and
 * never a worse/wrong catalog. See `brain.retrieveViaShell`.
 */
export interface CatalogRetrieverPort {
  retrieve(ctx: {
    tenantId: string;
    query: string;
    k: number;
    /**
     * PR3 (semantic-memory-v1) T8 — a PRE-COMPUTED query embedding, shared with memory recall by the
     * brain's turn-embedder. When present AND `pin` matches this corpus's own embed manifest, an
     * implementation SHOULD skip its own internal embed call and rank directly against `queryVector`
     * (the whole point: at most one embed per turn instead of one per consumer). Optional and purely
     * additive — an implementation that ignores it and embeds the query itself (today's behavior) is
     * unaffected; this field can never narrow or withhold what a caller without one gets.
     */
    queryVector?: number[];
    /** The embed space `queryVector` was produced in, to check against this corpus's own manifest pin
     *  before trusting it — mirrors `MemoryRecallPort.recall`'s same field. */
    pin?: { model: string; dimension: number };
  }): Promise<CatalogRetrievalResult>;
}

/**
 * E3 — ONE cited product, in the shape the widget renders as a card. Behind the PRODUCT_CARDS posture
 * flag; see `Decision.recommendedProductCards`.
 *
 * WHERE THE FIELDS COME FROM, which is the whole safety argument. Every value here is copied from the
 * exact `Product` object `systemPrompt` rendered into this turn's CATALOG block, through the SAME
 * `sanitizeGroundingText` caps that produced the prompt line — never from the retrieval corpus (which
 * stores ids only, deliberately, so a stale price is physically unquotable — see `CatalogRetrieverPort`),
 * and never from the client (the Pillar-3b opener card is the one exception: it builds directly from a cached
 * `getContext` product, still a real catalog entry with the SAME priceConfirmed price-honesty). So a card cannot show a price the
 * model was not told, cannot outlive the turn that produced it, and cannot disagree with the reply.
 *
 * NO URL ON THIS NEUTRAL CARD, on purpose — but the capability is no longer absent. `Product`
 * (platform-ports/src/grounding-port.ts) carries a vendor-neutral opaque `variantId`, and the
 * widget-backend WIRE layer (recommendation-telemetry.ts `WireProductCard`) turns it into a real Shopify
 * `cart` permalink using the tenant's shop domain. The URL is built THERE — the layer that knows the
 * platform — and never here, so the brain stays vendor-neutral. That is why C1 REVERSED the original #185
 * "no link ever" posture: a cart link WAS a false promise when no cart deep-link existed; now it is a true,
 * reversible affordance (a link the shopper chooses to follow — never an auto-add or purchase). What is
 * still forbidden is aggressive "Buy now / add to cart" CTA copy and any claim of a capability that does
 * NOT exist — `widget-backend/test/shopper-promise-guard.ts` guards that class.
 */
export interface RecommendedProductCard {
  /** The merchant's own product id — the same value that appears in `Decision.recommendedProducts`. */
  productId: string;
  /** The merchant's title, sanitized and capped exactly as the CATALOG line renders it. */
  title: string;
  /** The merchant's DISPLAY price string, e.g. "$34" — copied, never parsed, computed or converted. When
   *  `priceConfirmed` is false (A1b/D2 staleness), this is NOT a number but the same "needs confirming"
   *  sentinel the CATALOG line shows — so the card never asserts a price the reply is declining to quote. */
  price: string;
  /** A1b/D2 — false when the price could not be confirmed (its Tier-2 fact was past the staleness
   *  ceiling), matching the prompt's withheld state. Absent ⇒ confirmed. The widget should render an
   *  unconfirmed card without a numeric price chip (money/NN#1 fail-honest, consistent with the reply). */
  priceConfirmed?: boolean;
  /** C1 — the opaque variant id for a one-tap cart deep link, copied from `Product.variantId`. The
   *  widget-backend WIRE layer builds the platform cart URL from it (it knows the tenant's shop domain);
   *  no URL is ever placed on this neutral card. Absent when the source reports no variant. */
  variantId?: string;
  /**
   * THREE-STATE, mirroring `Product.availableForSale` and the CATALOG rule the model reads:
   *   true      -> confirmed purchasable
   *   false     -> confirmed not purchasable (the card still renders — the reply named the product, so
   *                dropping the card would leave the reply and the cards disagreeing)
   *   ABSENT    -> the source does not report it, so NOTHING may be said. The key is omitted rather than
   *                set to undefined, so no renderer can read "absent" as "available".
   */
  availableForSale?: boolean;
}

/**
 * E4 — ONE line in the shopper's cart, as the client reports it. Behind the CART_LINE_ITEMS posture flag.
 *
 * IDS AND QUANTITIES ONLY, and that is the trust boundary rather than a simplification. Cart contents are
 * CLIENT-SUPPLIED (no port in this repo exposes a cart), so this type deliberately has no field a shopper
 * could put prose into: no title, no price, no line total, no currency. `productId` is resolved against
 * the merchant's LIVE catalog and DROPPED when it is not there, so every word about the cart that reaches
 * the prompt is the MERCHANT's own text, sanitized and fenced exactly like the CATALOG block.
 *
 * `quantity` is the one number the client owns. It is bounded server-side (`deriveServingSignals`) and is
 * never used to price anything — which is what makes a `high_value` treatment unmanufacturable from here.
 */
export interface CartLineItemRef {
  productId: string;
  quantity: number;
}

export interface Signals {
  mood?: Mood;
  relationship?: Relationship;
  proactivityLevel?: ProactivityLevel;
  /** Support issues currently open (INV-B: any open issue suppresses sales). */
  openIssues?: string[];
  cart?: "empty" | "has_items" | "high_value";
  /**
   * E4 — WHAT is actually in the cart, not merely that there is one. Behind the CART_LINE_ITEMS posture
   * flag; consumed ONLY on the clean sales path, and only to render a fenced DATA block resolved against
   * the merchant's live catalog (see `CartLineItemRef` for why the type is this narrow).
   *
   * SERVER-SANITISED, never trusted verbatim: `deriveServingSignals` (widget-backend/src/signals.ts) is
   * the only origin — it bounds the id charset/length, drops (never clamps) an out-of-range quantity,
   * caps the line count, deduplicates, and strips every other field the client attached. It also
   * RE-DERIVES `cart` above from this list, overriding whatever enum the client claimed, so a supplied
   * list can only ever yield `empty` or `has_items`.
   *
   * Absent ⇒ the pre-existing coarse-enum behaviour is untouched.
   */
  cartItems?: CartLineItemRef[];
  /** True once a safety event has latched this conversation (INV-A). */
  safetyLatched?: boolean;
  /**
   * T1 — SERVER-DERIVED semantic guardrail signals for language-agnostic detection. NEVER client-set:
   * `deriveServingSignals` (widget-backend/src/signals.ts) is the only origin and it REBUILDS its output,
   * so a client-supplied value is dropped (pinned by signals-safety-trust.test.ts). Consumed ONLY when the
   * `serverGuardSignalsEnabled` posture flag is on, and merged with the English keyword floor
   * most-conservative-wins (`worstSafety` / boolean-OR), so they can only ever RAISE the safety/injection
   * classification — never lower it, never reach a model call. Absent ⇒ keyword-only behaviour is
   * byte-identical. `serverSafetyClass` carries a safety-GROUP class or "none" — never "injection" (that is
   * `serverInjection`).
   */
  serverSafetyClass?: SafetyClass;
  serverInjection?: boolean;
  /**
   * broaden — the SERVER-derived support intent (guard-classifier.ts), the language-agnostic producer for
   * `handleSupport`'s `serverIntent` seam (#247). Same trust boundary as the fields above: `deriveServing-
   * Signals` REBUILDS it, so a client-supplied value is dropped. Consumed ONLY when `serverGuardSignals-
   * Enabled` is on; absent ⇒ the brain's keyword `classifySupportIntent` decides (byte-identical). It only
   * ROUTES to a handler — every money/subscription action stays gated in handleSupport (ownership,
   * refund-ceiling HITL, the two ADR-0016 skip/pause controls, cancel→escalate), so this can never make an
   * action auto-execute regardless of what the classifier emitted.
   */
  serverSupportIntent?: SupportIntent;
  /**
   * F10-D — true when the SERVER guard classifier could not be trusted THIS turn (model error/timeout/
   * unparseable/out-of-enum — `GuardSignals.degraded` in widget-backend/src/guard-classifier.ts). Same
   * trust boundary as the three fields above: `deriveServingSignals` is the only origin and REBUILDS its
   * output, so a client-supplied value is dropped. Consumed ONLY when `serverGuardSignalsEnabled` is on;
   * absent/false ⇒ no effect. FAIL TOWARD SAFETY: a degraded turn means the language-agnostic safety/
   * injection/support backstop is silently MISSING for whatever language this message is in (the keyword
   * floor alone may miss it), so the brain suppresses the sales pitch rather than risk a pitch riding
   * alongside an undetected safety/support turn. It does not raise safetyClass or change mode/escalation —
   * the keyword floor still governs those exactly as before; this only forces pitch:none.
   */
  serverGuardDegraded?: boolean;
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
  proactiveTrigger?: "exit_intent" | "greeting";
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
   * S4 §B — per-TURN CATALOG_RETRIEVAL enablement for THIS tenant, resolved server-side from the
   * two-gate registry (state-postgres/catalog-retrieval-enablement.ts) via deriveServingSignals — never
   * client-set, exactly like `kill`/`atCap`. Absent ⇒ the brain falls back to the constructor
   * `catalogRetrievalEnabled` default (which serving now passes as `false`), so retrieval is dark until a
   * tenant is enabled. This REPLACES the retired process-global `process.env.CATALOG_RETRIEVAL`.
   */
  catalogRetrievalEnabled?: boolean;
  /**
   * S4 §C — an `agent:catalog-retrieval` operator kill is armed for this turn (server-resolved via
   * matchedKill; precedence global>tenant>agent). DISTINCT from `kill`: this degrades retrieval to the
   * full-catalog getContext path (a retrieval-only rollback), it does NOT halt the turn. Never client-set.
   */
  catalogRetrievalKilled?: boolean;
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

/**
 * Pillar 3 (opener) — a tappable quick-reply the proactive opener may surface. The `action` is a CLOSED
 * enum and the `label` is CODE-OWNED (never model text), so a chip can never carry a scarcity / discount /
 * urgency string — the anti-dark-pattern defense. Rendered as an ignorable affordance; tapping just runs a
 * normal discovery turn (no auto-purchase, no cart mutation).
 */
export type OpenerChipAction = "find_my_match" | "bestsellers" | "new_here";
export interface SuggestedChip {
  label: string;
  action: OpenerChipAction;
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
  /**
   * PRODUCT CARDS (E3) — the same cited products as `recommendedProducts`, in the same order, with the
   * display fields a widget needs to render a card. Behind the PRODUCT_CARDS posture flag: OMITTED
   * entirely (not `[]`, not `undefined`-valued) whenever the flag is off or nothing resolved, so the
   * flag-off `Decision` and the /chat wire shape are unchanged.
   *
   * Every field is copied from the `Product` object this turn's CATALOG block actually rendered, through
   * the same sanitizer — see `RecommendedProductCard` for why that is load-bearing rather than an
   * implementation detail.
   *
   * IT UNDER-DISPLAYS, exactly as `recommendedProducts` UNDER-REPORTS, because it is derived from it and
   * inherits every limit: a model that names a product in prose without copying its tag produces no card,
   * and citations are minted only on the clean sales path, so a proactive exit-intent turn shows none at
   * all. A shopper seeing three cards has NOT been shown "the three products the agent recommended" —
   * they have been shown the ones it cited. Both limits are pinned by tests
   * (widget-brain/test/product-cards.test.ts), not left to a comment.
   *
   * ALSO WEAKER THAN ITS NAME. The prompt rule asks the model to tag any product it "recommends, names,
   * or discusses" (citations.ts `CATALOG_CITATION_RULE`), so a product the agent talked the shopper OUT
   * of is in here too. Any shopper-facing label over these cards must therefore say MENTIONED, not
   * "recommended for you" — pinned by an E2E assertion on the heading.
   *
   * NOT A BILLING BASIS — the same prohibition as `recommendedProducts` above, and for the same reason:
   * a `recommended -> clicked -> purchased` chain off these ids is last-touch attribution, which
   * ADR-0007 §2 and docs/PRICING.md §2 forbid as a fee basis.
   */
  recommendedProductCards?: RecommendedProductCard[];

  /**
   * OPENER CHIPS (Pillar 3) — tappable quick-replies the proactive opener surfaces (find-my-match /
   * bestsellers / new-here). Behind the PROACTIVE_OPENER posture flag: OMITTED entirely (no key) whenever
   * the flag is off or the opener minted none, so the flag-off `Decision` and the /chat wire are
   * byte-identical (pinned by chat-wire-flag-off.test.ts). Labels are code-owned and actions are a closed
   * enum, so a chip can never carry a commercial / scarcity string.
   */
  suggestedChips?: SuggestedChip[];
}
