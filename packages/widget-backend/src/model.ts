import type { CommercePort, GroundingContext, GroundingPort, GroundingShell, ModelPort, RuntimeStatePort, SecretsPort } from "@palup/platform-ports";
import { createRedactingModelPort, createCachingGroundingPort } from "@palup/platform-ports";
import { MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import type { MerchantCredentialRead } from "@palup/state-postgres";
import { resolveStorefrontCredential } from "./merchant-store.js";
import { createShopifyGroundingAdapter, type StorefrontFetch } from "./shopify-grounding.js";

// D2: the router refuses rather than silently falling back to fixtures when a custodied credential
// exists but cannot be read back (undecryptable / malformed) — never serve a merchant's shoppers the
// wrong brand's catalog. The caching wrapper below degrades a cold throw to safe-empty defensively; a
// graceful shopper-facing "unavailable" surface is a later task's pre-flight, not this router's job.
export class GroundingCredentialUnreadableError extends Error {
  constructor(public readonly reason: "undecryptable" | "malformed-record") {
    super(`grounding credential unreadable: ${reason}`);
    this.name = "GroundingCredentialUnreadableError";
  }
}

// Composition root: pick the real Vertex adapter when GOOGLE_CLOUD_PROJECT is set, else the
// deterministic mock. Feature code only ever sees a ModelPort — it never knows which (ADR-0001).
// T8 (security-data-path §3): wrap whichever adapter in the PII-redaction guardrail so a payment
// card / SSN a shopper pastes never reaches the provider. The wrapper is transparent (same port).
export function createModelPort(): { port: ModelPort; name: string } {
  const { port, name } = isVertexConfigured()
    ? { port: createVertexAdapter(), name: "vertex/gemini" }
    : { port: new MockModelAdapter(), name: "mock" };
  return { port: createRedactingModelPort(port), name };
}

// Grounding source (ADR-0012). Per request tenant, route to the merchant's Shopify store when its
// credentials resolve (via the SecretsPort), else fall back to the multi-tenant fixtures adapter —
// mirrors isVertexConfigured() for the model port, but per-tenant. Wrapped in the caching + degradation
// layer (per-tenant TTL cache, hard timeouts, stale-while-error, fail-closed safe-empty). The whole
// thing stays behind GroundingPort. During rollout no tenant has Shopify creds ⇒ everyone gets fixtures.
//
// D1 — the SHOP DOMAIN now comes through the merchant resolver (`opts.shopDomainFor`), so a revoked
// merchant's catalog can no longer be pulled into a prompt from a stale `SHOPIFY_STORES` entry. The TOKEN
// is unchanged: still `SecretsPort` (see resolveShopifyStore's own doc comment for why, and for what that
// means for a merchant who installs through C1).
export function createGroundingPort(
  store: RuntimeStatePort,
  secrets: SecretsPort,
  opts: {
    shopifyFetch?: StorefrontFetch; // injectable for tests; defaults to the live Storefront call
    /** D1: registry-first shop-domain resolution. Absent ⇒ the pre-D1 `SHOPIFY_STORES`-only path. */
    shopDomainFor?: (tenantId: string) => Promise<string | undefined>;
    /** D2: the custodied delegate credential store's read(). Consulted only when `readbackEnabled`. */
    credRead?: (tenantId: string) => Promise<MerchantCredentialRead>;
    /** D2: gates the read-back path above; off ⇒ unchanged SecretsPort-only resolution. */
    readbackEnabled?: boolean;
  } = {},
): GroundingPort {
  const fixtures = new StaticGroundingAdapter();
  const router: GroundingPort = {
    async getContext(tenantId: string): Promise<GroundingContext> {
      // tenantId here is the SERVER-DERIVED request tenant (threaded from the verified widget token via
      // the brain) — never client input, so one merchant can never resolve another's store creds.
      const outcome = await resolveStorefrontCredential(tenantId, {
        secrets,
        credRead: opts.credRead,
        readbackEnabled: opts.readbackEnabled,
        shopDomainFor: opts.shopDomainFor,
      });
      if (outcome.status === "live")
        return createShopifyGroundingAdapter(outcome.creds, opts.shopifyFetch).getContext(tenantId);
      if (outcome.status === "refuse") throw new GroundingCredentialUnreadableError(outcome.reason);
      return fixtures.getContext(tenantId);
    },
    async getShell(tenantId: string): Promise<GroundingShell> {
      const outcome = await resolveStorefrontCredential(tenantId, {
        secrets,
        credRead: opts.credRead,
        readbackEnabled: opts.readbackEnabled,
        shopDomainFor: opts.shopDomainFor,
      });
      if (outcome.status === "live")
        return createShopifyGroundingAdapter(outcome.creds, opts.shopifyFetch).getShell(tenantId);
      if (outcome.status === "refuse") throw new GroundingCredentialUnreadableError(outcome.reason);
      return fixtures.getShell(tenantId);
    },
  };
  return createCachingGroundingPort(router, store);
}

// Commerce source: mock orders/policy/subscription for now; the Shopify adapter swaps in behind the port.
// `isLive` (ADR-0017 T7 capability marker) tells the ADR-0016 fail-closed guard (commerce-guard.ts)
// whether this IS a real/live adapter — false here, so the guard is a tested no-op for this slice. A
// future live-adapter PR sets isLive:true and the guard's fail-closed check activates automatically.
export function createCommercePort(): { port: CommercePort; isLive: boolean } {
  // `fixtureData: true` is what stops the support path from stating DEMO order/account facts to real
  // shoppers. Without it this composition root was serving "I've confirmed order #1042 is on your
  // account" — a confident false claim about a real person's account — because the brain's fallback
  // shopper id is the very id that owns the fixtures, so the ownership check passed.
  //
  // KEEP THIS SET for as long as this returns the mock. A live adapter should simply not pass the flag
  // (it is not fixture data), at which point the guard in support.ts stops firing on its own.
  // Regression-locked by widget-backend/test/commerce-fixture-marker.test.ts.
  return { port: new MockCommerceAdapter({ fixtureData: true }), isLive: false };
}
