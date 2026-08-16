import type { FastifyInstance } from "fastify";

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

export const PUBSUB_PUSH_ROUTE = "/internal/pubsub/catalog-reconcile" as const;

/** Verifies a Pub/Sub push OIDC token. Returns the token's service-account email on success, or null on
 *  ANY failure (bad signature, wrong audience, expired). Injected so the route is testable without the
 *  network; the production impl wraps google-auth-library's OAuth2Client.verifyIdToken (see server.ts). */
export type OidcVerifier = (bearerToken: string) => Promise<{ email: string } | null>;

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

interface PushEnvelope {
  message?: { attributes?: Record<string, unknown>; data?: string };
}

/** Registers the OIDC-gated Pub/Sub push route. Ack semantics: a valid delivery that reconciles ⇒ 204; a
 *  reconcile failure ⇒ 500 so Pub/Sub retries (then dead-letters, server-side); a well-formed but
 *  tenant-less message ⇒ 204 (ack + drop; retrying will never make it valid); bad/absent OIDC ⇒ 401. The
 *  response never distinguishes WHY (no oracle), mirroring the Shopify routes. */
export function registerPubSubPushRoute(app: FastifyInstance, deps: PubSubPushDeps): void {
  app.post(PUBSUB_PUSH_ROUTE, async (req, reply) => {
    reply.header("cache-control", "no-store");

    // 1. Rate-limit before any crypto work (fail-closed if the limiter is unavailable).
    if (deps.checkRateLimit) {
      let ok = false;
      try {
        ok = await deps.checkRateLimit(req.ip);
      } catch {
        ok = false;
      }
      if (!ok) {
        reply.code(429);
        return { error: "rate limited" };
      }
    }

    // 2. OIDC OR NOTHING. Bearer token, verified signature+audience, and the SA must be the expected one.
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!bearer) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    let identity: { email: string } | null;
    try {
      identity = await deps.verify(bearer);
    } catch {
      identity = null;
    }
    if (!identity || identity.email !== deps.expectedServiceAccount) {
      reply.code(401);
      return { error: "unauthorized" };
    }

    // 3. Only now read the body. The tenant rides as a signed-gated attribute (set by the publish adapter);
    // no product data is trusted — the worker re-fetches current state.
    const body = req.body as PushEnvelope | undefined;
    const tenantId = body?.message?.attributes?.["tenantKey"];
    if (typeof tenantId !== "string" || !tenantId.trim()) {
      reply.code(204); // ack + drop: a message with no usable tenant can never succeed; don't retry forever
      return null;
    }

    // 4. Decode `message.data` for TARGETING only (S3 §C) — which ids to re-fetch, never trusted for
    // product CONTENT. A malformed/absent body is fail-safe: `opts` stays `undefined`, so `reconcile` takes
    // its no-opts (full-catalog) path rather than silently doing nothing or acting on unparsed data.
    let opts: { productIds?: string[]; reason?: "product" | "inventory" | "full" } | undefined;
    try {
      const raw = body?.message?.data;
      if (typeof raw === "string" && raw.length > 0) {
        const p = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { productIds?: unknown; reason?: unknown };
        const productIds = Array.isArray(p.productIds) ? p.productIds.filter((x): x is string => typeof x === "string") : undefined;
        const reason = p.reason === "product" || p.reason === "inventory" || p.reason === "full" ? p.reason : undefined;
        opts = { ...(productIds && productIds.length > 0 ? { productIds } : {}), ...(reason ? { reason } : {}) };
      }
    } catch {
      opts = undefined; // fall back to a full reconcile
    }

    // 5. Reconcile. A failure returns 500 so Pub/Sub retries (and eventually dead-letters, server-side).
    try {
      await deps.reconcile(tenantId, opts);
    } catch (e) {
      console.error(`[pubsub-push] ALERT catalog_reconcile_failed tenant=${tenantId} error=${e instanceof Error ? e.constructor.name : typeof e} msg=${(e as Error).message}`);
      reply.code(500);
      return { error: "reconcile failed" };
    }
    reply.code(204);
    return null;
  });
}
