// Identity port (ADR-0001 / docs/design/identity-and-access.md §8): authenticate a credential to a
// Principal and make DEFAULT-DENY authorization decisions. The operator/merchant identity ALWAYS comes
// from a verified credential — never from a client-supplied value (the core tenancy invariant, IAM §9).
//
// Adapters: an operator bearer-token adapter (control-plane, this slice), a signed widget-token adapter
// (storefront tenant identity, slice 2), a Shopify App-Proxy + PalUp session-token shopper adapter
// (ADR-0017, slice 3) and later SSO/passkey — all behind this one port so the mechanism is swappable
// without touching route code (portability, NN #3).

export type Principal =
  | { kind: "operator"; operatorId: string }
  | { kind: "merchant"; merchantId: string }
  /**
   * A server-VERIFIED shopper (ADR-0017). `verified` is always `true` by construction — there is no
   * "unverified shopper" Principal; an unauthenticated/failed credential is `anonymous`, never this
   * case with `verified:false` (mirrors the `authenticate` contract: unauthenticated ⇒ anonymous, not
   * an error / half-trusted state). `shopperId` is namespaced `<source>:<merchantId>:<subjectId>` (see
   * `buildShopifyShopperId`/`shopperIdTenant` below) — NEVER a client-supplied value.
   */
  | { kind: "shopper"; shopperId: string; source: "shopify" | "otp"; verified: true }
  | { kind: "anonymous" };

export interface IdentityPort {
  /** Verify a credential (e.g. a bearer token). Returns a Principal — `anonymous` if absent/invalid.
   *  MUST NOT throw (an unauthenticated caller is anonymous, not an error). */
  authenticate(credential: string | undefined): Promise<Principal>;
  /** Default-deny policy decision: may this principal perform `action`? Unknown/anonymous ⇒ false. */
  authorize(principal: Principal, action: string): boolean;
}

// --- Shopper-id namespace (ADR-0017 §1, F6 collision-safety) ---------------------------------------
//
// Shape: "<source>:<merchantId>:<subjectId>" e.g. "shopify:acme:48291" or (OTP, later)
// "otp:acme:<emailHash>". Shopify's customer id is stable but unique only PER STORE, so it must be
// namespaced by the already-verified merchant tenant — otherwise `shopify:a:b` could ambiguously
// collide with a different (tenant, subject) split if `merchantId` (operator config, not user input)
// ever contained a ":". We validate BOTH components at construction and refuse anything malformed
// (⇒ the caller degrades to anonymous), rather than trust the caller to have sanitized them.
const MERCHANT_ID_RE = /^[a-z0-9-]+$/;
const SHOPIFY_CUSTOMER_ID_RE = /^\d+$/;

/**
 * Build + validate the namespaced Shopify shopper id `shopify:<merchantId>:<customerId>`.
 * F6: `merchantId` MUST match `[a-z0-9-]+` and `customerId` MUST match `\d+` — anything else returns
 * `undefined` (the caller must treat that as anonymous, never partially trust it).
 */
export function buildShopifyShopperId(merchantId: string, customerId: string): string | undefined {
  if (!MERCHANT_ID_RE.test(merchantId) || !SHOPIFY_CUSTOMER_ID_RE.test(customerId)) return undefined;
  return `shopify:${merchantId}:${customerId}`;
}

/**
 * Parse the tenant (`merchantId`) prefix out of a namespaced shopper id (`<source>:<merchantId>:<subject>`),
 * or `undefined` if the shape doesn't match. Used at `/chat` (ADR-0017 F1) to re-bind: the tenant
 * embedded in a VERIFIED shopper token must equal the tenant of the VERIFIED widget token on the SAME
 * request, else the shopper degrades to anonymous (prevents presenting a `shopify:A:123` shopper token
 * on a session authenticated as tenant B).
 */
export function shopperIdTenant(shopperId: string): string | undefined {
  const m = /^[a-z0-9]+:([a-z0-9-]+):.+$/.exec(shopperId);
  return m?.[1];
}

// --- Port-level default-deny authorize (T1) ---------------------------------------------------------
//
// A single canonical policy answer for any Principal, independent of which adapter verified it:
//   - a VERIFIED shopper may perform `account:*` / `shopper:self:*` (its own account-scoped actions —
//     WHICH record is enforced downstream in the commerce/support layer, e.g. support.ts's ownership
//     check, never here);
//   - a merchant may perform `shopper:*` / `widget:*` (mirrors widget-token-identity.ts's own authorize,
//     kept here too so any caller has one place to ask);
//   - an operator may perform `operator:*`;
//   - anonymous, or a principal reaching outside its own namespace (e.g. a shopper asking for
//     `merchant:*`/`widget:*`/`operator:*`), is DENIED. Never throws; fails closed.
export function authorize(principal: Principal, action: string): boolean {
  switch (principal.kind) {
    case "shopper":
      return principal.verified === true && (action.startsWith("account:") || action.startsWith("shopper:self:"));
    case "merchant":
      return action.startsWith("shopper:") || action.startsWith("widget:");
    case "operator":
      return action.startsWith("operator:");
    default:
      return false;
  }
}
