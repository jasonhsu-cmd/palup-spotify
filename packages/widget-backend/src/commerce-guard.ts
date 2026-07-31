import { AsyncLocalStorage } from "node:async_hooks";
import type { CommercePort, Principal } from "@palup/platform-ports";

// ADR-0016 fail-closed guard (ADR-0017 §3 "Wiring"), T7. ANY non-mock/live commerce (or subscription)
// adapter — READS as well as writes (F2: a live cross-account READ like getRecentOrder/getOrder against
// an unverified/constant shopperId is ALREADY an IDOR disclosure, no mutation required) — MUST refuse
// unless the CURRENT request's Principal is a server-VERIFIED shopper. The check is against the
// Principal, never a string, so a constant/spoofed shopperId string can never satisfy it.
//
// CommercePort's methods don't take a Principal parameter (and the brain instance that calls them is a
// per-POLICY singleton shared across every concurrent request — server.ts caches it), so "the current
// request's principal" is threaded via AsyncLocalStorage rather than a mutable module-level variable:
// ALS keeps concurrent requests' principals from bleeding into each other across the awaited call chain
// (no global mutable request state, no race between request A's anonymous check and request B's
// verified one). `withRequestPrincipal` is the ONLY way to set it; forgetting to call it simply means
// `currentPrincipal()` defaults to `{kind:"anonymous"}` — i.e. the guard fails CLOSED by default, never open.

const als = new AsyncLocalStorage<Principal>();

/** Run `fn` with `principal` bound as the CURRENT request's principal for any commerce-guard check
 * inside it (including across every `await` in the call chain). */
export function withRequestPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return als.run(principal, fn);
}

function currentPrincipal(): Principal {
  return als.getStore() ?? { kind: "anonymous" }; // no bound principal ⇒ fail CLOSED (anonymous), never open
}

export function isVerifiedShopper(principal: Principal): principal is Extract<Principal, { kind: "shopper" }> {
  return principal.kind === "shopper" && principal.verified === true;
}

export class CommerceGuardRefusalError extends Error {
  constructor(method: string) {
    super(`commerce-guard: live commerce access to ${method} requires a verified shopper principal (ADR-0016)`);
    this.name = "CommerceGuardRefusalError";
  }
}

/**
 * Wrap a CommercePort with the fail-closed guard. `isLive` is a capability marker set by the
 * composition root (model.ts) — false for MockCommerceAdapter (the guard becomes a tested no-op for
 * this slice), true for any future REAL adapter (Shopify orders/subscriptions, etc.) — at which point
 * EVERY method below (reads included) automatically inherits the check; a future adapter PR cannot
 * accidentally skip it by construction. `getPrincipal` defaults to the ALS-backed `currentPrincipal`
 * but is overridable for tests.
 */
export function guardCommercePort(port: CommercePort, isLive: boolean, getPrincipal: () => Principal = currentPrincipal): CommercePort {
  function check(method: string): void {
    if (!isLive) return; // MockCommerceAdapter (or any non-live adapter) -> tested no-op
    if (!isVerifiedShopper(getPrincipal())) throw new CommerceGuardRefusalError(method);
  }
  return {
    async getOrder(orderId) {
      check("getOrder");
      return port.getOrder(orderId);
    },
    async getRecentOrder(shopperId) {
      check("getRecentOrder");
      return port.getRecentOrder(shopperId);
    },
    async getPolicy() {
      check("getPolicy");
      return port.getPolicy();
    },
    async getSubscription(shopperId) {
      check("getSubscription");
      return port.getSubscription(shopperId);
    },
  };
}
