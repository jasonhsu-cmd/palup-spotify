import type { CommercePort, GroundingContext, GroundingPort, ModelPort, RuntimeStatePort, SecretsPort } from "@palup/platform-ports";
import { createRedactingModelPort, createCachingGroundingPort } from "@palup/platform-ports";
import { MockModelAdapter, StaticGroundingAdapter, MockCommerceAdapter } from "@palup/widget-brain";
import { createVertexAdapter, isVertexConfigured } from "@palup/model-vertex";
import { resolveShopifyStore } from "./merchant-store.js";
import { createShopifyGroundingAdapter, type StorefrontFetch } from "./shopify-grounding.js";

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
export function createGroundingPort(
  store: RuntimeStatePort,
  secrets: SecretsPort,
  opts: { shopifyFetch?: StorefrontFetch } = {}, // injectable for tests; defaults to the live Storefront call
): GroundingPort {
  const fixtures = new StaticGroundingAdapter();
  const router: GroundingPort = {
    async getContext(tenantId: string): Promise<GroundingContext> {
      // tenantId here is the SERVER-DERIVED request tenant (threaded from the verified widget token via
      // the brain) — never client input, so one merchant can never resolve another's store creds.
      const creds = await resolveShopifyStore(tenantId, secrets);
      if (creds) return createShopifyGroundingAdapter(creds, opts.shopifyFetch).getContext(tenantId);
      return fixtures.getContext(tenantId);
    },
  };
  return createCachingGroundingPort(router, store);
}

// Commerce source: mock orders/policy/subscription for now; the Shopify adapter swaps in behind the port.
export function createCommercePort(): CommercePort {
  return new MockCommerceAdapter();
}
