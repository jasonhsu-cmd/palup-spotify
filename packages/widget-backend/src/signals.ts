import type { Signals, CartLineItemRef, Consent, SafetyClass, SupportIntent } from "@palup/widget-brain";

// T7 — derive the trusted `signals` the brain runs on from UNTRUSTED client input. The default is that
// a client-supplied field is IGNORED; only explicitly non-trust-bearing context (mood/cart, and only
// when a valid enum) is passed through. Everything that grants treatment, governs behavior, or is
// legally load-bearing is supplied by the caller from server/merchant/operator/session sources. See the
// TRUST BOUNDARY note in server.ts for the per-field rationale.

const MOODS = new Set<string>(["frustrated", "upset", "anxious", "confused", "skeptical", "neutral", "satisfied"]);
const CARTS = new Set<string>(["empty", "has_items", "high_value"]);

// ── E4: cart line items ──────────────────────────────────────────────────────────────────────────
//
// THE TRUST PROBLEM, stated before the bounds so the bounds read as consequences rather than magic
// numbers. `signals.cart` is a three-value enum today; E4 lets the client describe WHAT is in the cart so
// the agent can reason about it. Richer input is more spoofable input, and this file exists precisely
// because "client input must not grant treatment" (header above). So the accepted shape is the narrowest
// one that still answers the question:
//
//   • IDS AND QUANTITIES ONLY. Every other field the client attaches — a title, a price, a line total, a
//     currency, a "value" hint — is DROPPED here and never seen again. The brain then resolves each id
//     against the merchant's LIVE catalog and drops what is not there, so the only TEXT about the cart
//     that ever reaches the prompt is the merchant's own, sanitized and fenced exactly like the CATALOG
//     block. There is no field a shopper can put prose into, which is a stronger property than escaping
//     one would be.
//   • THE CART STATE IS RE-DERIVED, NOT ACCEPTED. When a list is supplied it OVERRIDES the client's own
//     `cart` enum, and the derivation has exactly two reachable outputs: `empty` and `has_items`.
//     `high_value` needs PRICES, prices are not a field the client can send, and this layer has no
//     catalog to look one up in — so a `high_value` treatment is UNREACHABLE from line items by
//     construction, not by validation. (cart-signals-trust.test.ts asserts that over hostile payloads.)
//   • QUANTITIES ARE DROPPED, NEVER CLAMPED. Clamping 10_000 to 99 would tell the agent a quantity the
//     shopper never had; dropping the line is the honest failure, and the prompt then declares itself a
//     partial view (brain.ts's CART_PARTIAL_RULE).
//
// WHAT THIS DOES **NOT** CLOSE, stated rather than implied: the PRE-EXISTING bare `cart: "high_value"`
// enum is still accepted from a client that sends no line items (`CARTS` above, unchanged). That is
// behaviourally inert today — `selectPitch` and the exit-intent `hasCart` check in widget-brain/src/
// brain.ts treat `has_items` and `high_value` identically, verified by execution — but it is a real,
// separate gap. It is deliberately not fixed here: tightening it would change flag-OFF behaviour and
// break the byte-identical bar this wave ships under.

/** Ids a real storefront produces: Shopify gids (`gid://shopify/Product/123`), handles, numeric strings. */
const CART_PRODUCT_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
/** Enough lines for a genuinely large basket; small enough that the prompt cannot be inflated by one. */
export const MAX_CART_LINE_ITEMS = 30;
/** A per-line quantity a real cart reaches. Above it we drop the line rather than believe or clamp it. */
export const MAX_CART_LINE_QUANTITY = 99;

/**
 * Validate + BOUND an untrusted `cartItems` payload. Returns `undefined` when the client sent no array at
 * all (⇒ the pre-existing coarse-enum path is untouched), and an array — possibly EMPTY, when everything
 * was rejected — when it did. Never throws.
 */
function sanitizeCartItems(raw: unknown): CartLineItemRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CartLineItemRef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_CART_LINE_ITEMS) break;
    if (!entry || typeof entry !== "object") continue;
    const rawId = (entry as { productId?: unknown }).productId;
    const quantity = (entry as { quantity?: unknown }).quantity;
    if (typeof rawId !== "string") continue;
    const productId = rawId.trim();
    if (!CART_PRODUCT_ID.test(productId)) continue;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CART_LINE_QUANTITY) continue;
    // Dedupe keeps the FIRST occurrence rather than summing: summing would report a quantity the shopper
    // never had on any line, which is inventing data rather than sanitizing it. A `Set` is used instead
    // of an object map so no client string is ever an object key.
    if (seen.has(productId)) continue;
    seen.add(productId);
    // REBUILT, never spread: only these two fields survive, whatever else the client attached.
    out.push({ productId, quantity });
  }
  return out;
}

export interface ServingSignalContext {
  /** The verified tenant/merchant this request serves (from the widget token, server-side). */
  tenantId: string;
  /** Operator kill state for this scope (from the registry, server-side). */
  kill: boolean;
  /**
   * §8a inv 14 — this tenant (or the platform) is at its cost cap, from the shared cost-cap registry.
   * Server-side like `kill`; NEVER taken from the client. A shopper who could set this could silence a
   * merchant's agent, and a merchant's storefront must not be able to either.
   */
  atCap?: boolean;
  /**
   * S4 §B — whether CATALOG_RETRIEVAL is enabled for this tenant this turn (from the two-gate registry,
   * server-side via `catalogRetrievalEnabledFor`). NEVER client-set (rebuilt here, like kill/atCap).
   */
  catalogRetrievalEnabled?: boolean;
  /** S4 §C — an `agent:catalog-retrieval` kill is armed for this tenant/agent/globally (matchedKill). */
  catalogRetrievalKilled?: boolean;
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
  /**
   * E4 — the CART_LINE_ITEMS posture flag, at this layer. `server.ts` now passes it, from the same
   * `CART_LINE_ITEMS` env read that feeds the brain's own gate. Default OFF ⇒ `signals.cartItems` is not
   * even PARSED: the returned object has no `cartItems` key and `cart` keeps its pre-E4 behaviour
   * exactly. Gated here as well as in the brain because parsing
   * client input is itself an attack surface, and because turning this on changes what `cart` means for a
   * request that carries line items — a run-time behaviour change governed by docs/HITL-POLICY.md §5.
   */
  cartLineItemsEnabled?: boolean;
  /**
   * T1 — the server-side guard classifier's result for THIS turn (computed by classifyGuardSignals in
   * server.ts BEFORE this function runs, only when SERVER_GUARD_SIGNALS is on; absent otherwise). Passed
   * through here so the SERVER is the sole origin of `Signals.serverSafetyClass`/`serverInjection` — the
   * client's own values are never read (this function rebuilds), exactly like tenantId/kill/consent.
   */
  serverSafetyClass?: SafetyClass;
  serverInjection?: boolean;
  /** broaden — the guard classifier's whitelisted support intent for THIS turn (same source + trust
   *  boundary as the two above). Passed through so the SERVER is the sole origin of
   *  `Signals.serverSupportIntent`; the client's own value is never read (this function rebuilds). */
  serverSupportIntent?: SupportIntent;
}

export function deriveServingSignals(raw: Signals | undefined, ctx: ServingSignalContext): Signals {
  const r = (raw ?? {}) as Signals;
  // E4 — `undefined` when the flag is off OR the client sent no array; an array (possibly empty) when it
  // did. The distinction matters: `undefined` leaves the pre-existing enum path alone, while `[]` is a
  // POSITIVE statement that the cart is empty.
  const cartItems = ctx.cartLineItemsEnabled ? sanitizeCartItems((r as { cartItems?: unknown }).cartItems) : undefined;
  return {
    // Accepted shopper/UI context — only when a valid enum value.
    mood: typeof r.mood === "string" && MOODS.has(r.mood) ? r.mood : undefined,
    // E4 — a supplied line-item list RE-DERIVES this and overrides whatever the client claimed. Only two
    // outputs are reachable from it, so a shopper cannot manufacture `high_value` out of a cart payload;
    // see the trust note above `sanitizeCartItems`, including what this deliberately does NOT close.
    cart: cartItems
      ? cartItems.length > 0
        ? "has_items"
        : "empty"
      : typeof r.cart === "string" && CARTS.has(r.cart)
        ? r.cart
        : undefined,
    // SPREAD, so the key is ABSENT (not present-and-undefined) whenever the flag is off — the same
    // discipline `Decision.recommendedProducts` uses, and what keeps an `Object.keys` consumer and a
    // strict-equal fixture unchanged while E4 is unwired.
    ...(cartItems ? { cartItems } : {}),
    // Agent-initiated proactive UI trigger (§4 Behavioral: exit-intent) — non-trust-bearing UI context
    // like mood/cart, accepted ONLY as the known enum. It can only route to a MORE restrained proactive
    // cart_recovery on the clean sales path; every server cap still holds (precedence ladder, mood brake,
    // support/safety suppression, and the ONE INV-E budget), so passing it through grants no autonomy.
    proactiveTrigger:
      r.proactiveTrigger === "exit_intent" || r.proactiveTrigger === "greeting" ? r.proactiveTrigger : undefined,
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
    // Same shape and same trust rule as `kill` directly above: omitted unless the SERVER says so, so a
    // client-supplied `atCap` in the request body is ignored exactly like a client-supplied `kill`.
    atCap: ctx.atCap ? true : undefined,
    // S4 §B — SPREAD, so the key is ABSENT (not present-and-undefined) whenever the tenant is not
    // enabled — same discipline as `cartItems` above, byte-identical to pre-S4 for every tenant while
    // both KV gates default OFF.
    ...(ctx.catalogRetrievalEnabled ? { catalogRetrievalEnabled: true } : {}),
    // S4 §C — same spread discipline: ABSENT (not present-and-false) whenever no kill is armed, so
    // flag-off/no-kill goldens stay byte-identical.
    ...(ctx.catalogRetrievalKilled ? { catalogRetrievalKilled: true } : {}),
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
    // SUBJECT-SCOPED AUTH (ADR-0019 task 4, invariant 4): the memory subject is SERVER-DERIVED ONLY —
    // `ctx.memorySubject` is a verified shopper's `acct:` id or a verified `x-guest-token`'s anonId. There
    // is NO fallback to the client's `r.anonId`. The prior `?? validateAnonId(r.anonId)` fallback was the
    // F1 hole the tasks-4/9 security review caught: with no token, `memorySubject` is undefined and recall
    // (brain.ts's `memory.recall({ anonId: signals.anonId })`) would key off the raw client value — letting
    // a caller read any namespace by naming its id, with the read-time consent gate evaluated against the
    // CALLER's record, not the victim's. Dropping the fallback closes it: no credential ⇒ no
    // `signals.anonId` ⇒ no recall, no write.
    anonId: ctx.memorySubject,
    // T1 — server-derived guard signals, SPREAD so the key is ABSENT (not present-and-undefined) whenever
    // the classifier didn't run / said "none" — keeping the SERVER_GUARD_SIGNALS-off path byte-identical
    // and a client-supplied value dropped (rebuild-not-spread; pinned by signals-safety-trust.test.ts).
    ...(ctx.serverSafetyClass !== undefined ? { serverSafetyClass: ctx.serverSafetyClass } : {}),
    ...(ctx.serverInjection !== undefined ? { serverInjection: ctx.serverInjection } : {}),
    ...(ctx.serverSupportIntent !== undefined ? { serverSupportIntent: ctx.serverSupportIntent } : {}),
  };
}
