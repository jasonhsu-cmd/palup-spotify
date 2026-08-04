import type { Signals, Consent } from "@palup/widget-brain";
import { validateAnonId } from "@palup/widget-memory";

// T7 — derive the trusted `signals` the brain runs on from UNTRUSTED client input. The default is that
// a client-supplied field is IGNORED; only explicitly non-trust-bearing context (mood/cart, and only
// when a valid enum) is passed through. Everything that grants treatment, governs behavior, or is
// legally load-bearing is supplied by the caller from server/merchant/operator/session sources. See the
// TRUST BOUNDARY note in server.ts for the per-field rationale.

const MOODS = new Set<string>(["frustrated", "upset", "anxious", "confused", "skeptical", "neutral", "satisfied"]);
const CARTS = new Set<string>(["empty", "has_items", "high_value"]);

export interface ServingSignalContext {
  /** The verified tenant/merchant this request serves (from the widget token, server-side). */
  tenantId: string;
  /** Operator kill state for this scope (from the registry, server-side). */
  kill: boolean;
  /** Merchant/geo jurisdiction (server config). */
  region: NonNullable<Signals["region"]>;
  /** Merchant "discuss competitors" mode (merchant policy). */
  groundingMode: NonNullable<Signals["groundingMode"]>;
  /**
   * Shopper's LOCAL hour of day (0–23), computed server-side from the request locale/timezone.
   * Optional: when omitted, quiet-hours OUTBOUND suppression is simply not applied. NEVER taken from
   * the client (like tenantId/kill/region, this is the trusted, server-derived origin of the signal).
   */
  localHour?: number;
  /**
   * ADR-0017 — the server-VERIFIED shopper id for this request (from the shopper session token, after
   * the /chat tenant re-binding check), or undefined when the shopper is anonymous / SHOPPER_AUTH is
   * off. NEVER taken from the client. `shopperVerified` is carried alongside for clarity even though
   * (in this slice) its presence and `shopperId`'s presence always coincide.
   */
  shopperId?: string;
  shopperVerified?: boolean;
  /**
   * PR-11a (ADR-0015 T12) — the server-looked-up memory-consent record for THIS subject (from the
   * consent store, `@palup/state-postgres`'s runtime-consent-store.ts), or undefined when there is no
   * valid subject key to look one up for (no/invalid anonId — mirrors every other "nothing to key on"
   * guard in this file). This is the ONLY source `deriveServingSignals` consults for
   * memoryOrdinary/memorySpecial — the client's own `signals.consent` stays ignored, exactly as before
   * this field existed. Absent ⇒ fail-closed "unknown"/"unknown" (byte-identical to the old hardcode).
   */
  consent?: { memoryOrdinary: Consent; memorySpecial: Consent };
  /**
   * SUBJECT-SCOPED AUTH — the server-derived cross-visit-memory subject for this request
   * (`acct:<shopperId>` for a verified shopper, else the validated guest `anonId`; see
   * `memorySubjectId`). When present it BECOMES `signals.anonId`, so every memory consumer — the
   * brain's `memory.recall` gate, `remember()`, the retention sweep, and the consent lookup — reads and
   * writes the SAME namespace. Absent (memory off, or a caller that doesn't supply it) the old
   * client-validated behavior applies, keeping the inert path byte-identical.
   */
  memorySubject?: string;
}

export function deriveServingSignals(raw: Signals | undefined, ctx: ServingSignalContext): Signals {
  const r = (raw ?? {}) as Signals;
  return {
    // Accepted shopper/UI context — only when a valid enum value.
    mood: typeof r.mood === "string" && MOODS.has(r.mood) ? r.mood : undefined,
    cart: typeof r.cart === "string" && CARTS.has(r.cart) ? r.cart : undefined,
    // Agent-initiated proactive UI trigger (§4 Behavioral: exit-intent) — non-trust-bearing UI context
    // like mood/cart, accepted ONLY as the known enum. It can only route to a MORE restrained proactive
    // cart_recovery on the clean sales path; every server cap still holds (precedence ladder, mood brake,
    // support/safety suppression, and the ONE INV-E budget), so passing it through grants no autonomy.
    proactiveTrigger: r.proactiveTrigger === "exit_intent" ? "exit_intent" : undefined,
    // Page context (§4): the product/page the shopper is viewing — UNTRUSTED merchant-page content,
    // bounded here (defense-in-depth) and sanitized again in the brain before it reaches the model.
    pageContext: typeof r.pageContext === "string" && r.pageContext ? r.pageContext.slice(0, 400) : undefined,
    // Server-derived trust-bearing signals — never taken from the client.
    tenantId: ctx.tenantId, // the verified merchant; drives per-merchant grounding — never client-set
    // ADR-0017 — the verified shopper id (if any) OVERWRITES any client-supplied `signals.shopperId`.
    // relationship: a verified shopper is a KNOWN account with no history loaded yet ⇒ "new" — NEVER
    // "vip"/"subscriber" here (that uplift is ADR-0015 Tier 2, keyed off order history, not this slice);
    // anonymous (no verified shopper) ⇒ unchanged "anonymous", never client-claimed.
    // Gate the id on the VERIFIED flag too (not just relationship) — an (id-set, unverified) ctx (e.g. a
    // future OTP adapter mid-verify) must never key the ownership check on an unverified id.
    shopperId: ctx.shopperVerified && ctx.shopperId ? ctx.shopperId : undefined,
    relationship: ctx.shopperVerified && ctx.shopperId ? "new" : "anonymous",
    consent: {
      email: "unknown",
      sms: "unknown",
      // ADR-0015 T12 / PR-11a: the two cross-visit MEMORY consent tiers, now sourced from the server's
      // OWN consent-store lookup (ctx.consent — populated by server.ts's `lookupConsent` call BEFORE
      // this function runs), never the client's `signals.consent` (a shopper can't self-assert their
      // own memory consent any more than they can self-assert VIP status). No record for this subject
      // (ctx.consent undefined, or an absent field on it) ⇒ fail-closed "unknown" — byte-identical to
      // the old hardcode. email/sms stay hardcoded "unknown" — a real CMP for those is still out of
      // scope (unchanged from before this PR).
      memoryOrdinary: ctx.consent?.memoryOrdinary ?? "unknown",
      memorySpecial: ctx.consent?.memorySpecial ?? "unknown",
    },
    groundingMode: ctx.groundingMode,
    region: ctx.region,
    // proactivityLevel omitted ⇒ the session applies its own server-side default ("balanced"), never
    // the shopper. (A canary policy's proactivityDefault is not threaded onto /chat today — tracked;
    // server-controlled either way, no client influence.)
    // openIssues / safetyLatched omitted ⇒ sourced only from persisted session state
    kill: ctx.kill ? true : undefined,
    // Quiet-hours clock is SERVER-derived (ctx), never the client's r.localHour. Only a valid 0–23
    // integer is honored; anything else ⇒ omitted ⇒ quiet-hours suppression simply does not apply.
    localHour:
      typeof ctx.localHour === "number" && Number.isInteger(ctx.localHour) && ctx.localHour >= 0 && ctx.localHour <= 23
        ? ctx.localHour
        : undefined,
    // ADR-0015 T12: the cross-visit memory subject key. A client MAY replay a previously-minted anon id
    // (so the same browser recognizes itself across visits) — but it is NEVER trusted verbatim: it must
    // pass `validateAnonId` (charset + length bound, from @palup/widget-memory — the composition root
    // may import that package) before it can key a vector namespace. A bad/oversized/forged value is
    // dropped to `undefined` (never thrown), exactly like an invalid mood/cart enum above. Recall stays
    // inert regardless (the flag.ts double gate), so this is wiring-correctness ahead of go-live, not a
    // live capability.
    // SUBJECT-SCOPED AUTH: the server-derived subject WINS when supplied. Without this the recall path
    // (brain.ts's `memory.recall({ anonId: signals.anonId })`) would keep reading the raw client value
    // while writes went to the bound subject — a verified shopper could read another subject's facts by
    // supplying their anonId, and the read-time consent gate would be evaluated against the CALLER's
    // consent record rather than the record whose facts were read. Both surfaced in security review.
    anonId: ctx.memorySubject ?? validateAnonId(typeof r.anonId === "string" ? r.anonId : undefined),
  };
}
