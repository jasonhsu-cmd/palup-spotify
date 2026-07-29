// Identity port (ADR-0001 / docs/design/identity-and-access.md §8): authenticate a credential to a
// Principal and make DEFAULT-DENY authorization decisions. The operator/merchant identity ALWAYS comes
// from a verified credential — never from a client-supplied value (the core tenancy invariant, IAM §9).
//
// Adapters: an operator bearer-token adapter (control-plane, this slice), a signed widget-token adapter
// (storefront tenant identity, slice 2), and later SSO/passkey + Shopify — all behind this one port so
// the mechanism is swappable without touching route code (portability, NN #3).

export type Principal =
  | { kind: "operator"; operatorId: string }
  | { kind: "merchant"; merchantId: string }
  | { kind: "anonymous" };

export interface IdentityPort {
  /** Verify a credential (e.g. a bearer token). Returns a Principal — `anonymous` if absent/invalid.
   *  MUST NOT throw (an unauthenticated caller is anonymous, not an error). */
  authenticate(credential: string | undefined): Promise<Principal>;
  /** Default-deny policy decision: may this principal perform `action`? Unknown/anonymous ⇒ false. */
  authorize(principal: Principal, action: string): boolean;
}
