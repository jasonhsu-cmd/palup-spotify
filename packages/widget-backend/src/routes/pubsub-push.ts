import type { FastifyInstance } from "fastify";
import { registerOidcPushRoute, type OidcVerifier } from "./oidc-push-route.js";

// P4 — the Pub/Sub PUSH endpoint for catalog reconciles. Pub/Sub POSTs each queued message here as an
// HTTPS request bearing a Google-signed OIDC token; this route is the ONLY consumer of the durable queue
// (the QueuePort adapter is publish-only — see pubsub-queue.ts). It is INTERNET-REACHABLE and triggers a
// re-index, so the security property is: NOTHING runs unless the request carries a valid OIDC token whose
// audience is this endpoint AND whose service account is the one Pub/Sub is configured to push as. That is
// the same "verify-before-you-trust-the-body" discipline as the Shopify webhook routes, with OIDC in place
// of HMAC.
//
// THIS OIDC CHECK IS THE SOLE CONTROL. The service runs `--allow-unauthenticated` (it must — /chat is
// public), so Cloud Run IAM does NOT gate this route: anyone on the internet can POST here. The verify →
// expected-SA gate below is the only thing between a stranger's request and a tenant re-index, so it is
// fail-closed at every step (bad/absent token, wrong SA, verifier throw ⇒ 401, no body read). The
// production verifier also requires email_verified (server.ts) as defence in depth.
//
// **UNVERIFIED-LIVE.** The OIDC-verify + envelope-parse + fail-closed logic is unit-tested with an injected
// verifier; a real Pub/Sub push is verified in STAGING before CATALOG_WEBHOOKS is enabled (go-live P4).
//
// W1.2 — this is now a thin wrapper over the shared `registerOidcPushRoute` core (oidc-push-route.ts): the
// rate-limit → OIDC → expected-SA gate lives there (byte-for-byte the same as before this refactor); this
// module only supplies the route path and the catalog-specific `handle` (tenantKey attribute → tenantId,
// 204-drop if absent, decode `{productIds,reason}` for targeting, call `reconcile`).

export const PUBSUB_PUSH_ROUTE = "/internal/pubsub/catalog-reconcile" as const;

export type { OidcVerifier };

export interface PubSubPushDeps {
  verify: OidcVerifier;
  /** The exact service-account email Pub/Sub is configured to push as. A verified token from ANY OTHER
   *  Google identity is refused — being Google-signed is necessary, not sufficient. */
  expectedServiceAccount: string;
  /** Re-derive this tenant's current state. `opts.productIds` (S3 §C) targets a `reconcileProducts` refresh
   *  of just those SKUs; absent/`reason:"full"` runs the whole-catalog `runCatalogIndex`. The tenantKey
   *  attribute is trusted (Pub/Sub-set, per NN#3); `message.data` is only ever used to pick WHICH ids to
   *  re-FETCH — the worker re-derives current content, never trusting the body for product CONTENT. */
  reconcile: (tenantId: string, opts?: { productIds?: string[]; reason?: "product" | "inventory" | "full" }) => Promise<void>;
  /** Same per-IP limiter every public route uses. `false` ⇒ refuse (fail-closed). Optional. */
  checkRateLimit?: (ip: string) => Promise<boolean>;
}

/** Registers the OIDC-gated Pub/Sub push route. Ack semantics: a valid delivery that reconciles ⇒ 204; a
 *  reconcile failure ⇒ 500 so Pub/Sub retries (then dead-letters, server-side); a well-formed but
 *  tenant-less message ⇒ 204 (ack + drop; retrying will never make it valid); bad/absent OIDC ⇒ 401. The
 *  response never distinguishes WHY (no oracle), mirroring the Shopify routes. */
export function registerPubSubPushRoute(app: FastifyInstance, deps: PubSubPushDeps): void {
  registerOidcPushRoute(app, {
    routePath: PUBSUB_PUSH_ROUTE,
    verify: deps.verify,
    expectedServiceAccount: deps.expectedServiceAccount,
    checkRateLimit: deps.checkRateLimit,
    handle: async (attributes, data) => {
      // The tenant rides as a signed-gated attribute (set by the publish adapter); no product data is
      // trusted — the worker re-fetches current state.
      const tenantId = attributes["tenantKey"];
      if (typeof tenantId !== "string" || !tenantId.trim()) {
        return; // ack + drop: a message with no usable tenant can never succeed; don't retry forever
      }

      // Decode `data` for TARGETING only (S3 §C) — which ids to re-fetch, never trusted for product
      // CONTENT. A malformed/absent body is fail-safe: `opts` stays `undefined`, so `reconcile` takes its
      // no-opts (full-catalog) path rather than silently doing nothing or acting on unparsed data.
      let opts: { productIds?: string[]; reason?: "product" | "inventory" | "full" } | undefined;
      try {
        if (typeof data === "string" && data.length > 0) {
          const p = JSON.parse(data) as { productIds?: unknown; reason?: unknown };
          const productIds = Array.isArray(p.productIds) ? p.productIds.filter((x): x is string => typeof x === "string") : undefined;
          const reason = p.reason === "product" || p.reason === "inventory" || p.reason === "full" ? p.reason : undefined;
          opts = { ...(productIds && productIds.length > 0 ? { productIds } : {}), ...(reason ? { reason } : {}) };
        }
      } catch {
        opts = undefined; // fall back to a full reconcile
      }

      // Reconcile. A failure propagates so the core returns 500 (Pub/Sub retries, then dead-letters).
      try {
        await deps.reconcile(tenantId, opts);
      } catch (e) {
        console.error(`[pubsub-push] ALERT catalog_reconcile_failed tenant=${tenantId} error=${e instanceof Error ? e.constructor.name : typeof e} msg=${(e as Error).message}`);
        throw e;
      }
    },
  });
}
