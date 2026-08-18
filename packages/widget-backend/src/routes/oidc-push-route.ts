import type { FastifyInstance } from "fastify";

// #126 W1.2 — the reusable OIDC-gated Pub/Sub push route core, extracted from pubsub-push.ts (P4) so a
// second push route (memory-write, W1.3) can share the EXACT same fail-closed steps without duplicating
// the security-critical gate. Steps 1-2 (rate-limit → OIDC → expected-SA) are unconditional and identical
// for every push route registered through here; step 3 on (envelope parse + domain action) is behind the
// injected `handle`, so each route only owns its own body shape and action, never the gate itself.
//
// THIS OIDC CHECK IS THE SOLE CONTROL for any route registered here (see pubsub-push.ts's header for the
// full rationale: the service runs `--allow-unauthenticated`, so Cloud Run IAM does not gate these routes).

/** Verifies a Pub/Sub push OIDC token. Returns the token's service-account email on success, or null on
 *  ANY failure (bad signature, wrong audience, expired). Injected so routes are testable without the
 *  network; the production impl wraps google-auth-library's OAuth2Client.verifyIdToken (see server.ts). */
export type OidcVerifier = (bearerToken: string) => Promise<{ email: string } | null>;

export interface OidcPushRouteDeps {
  /** The route path this push endpoint listens on. */
  routePath: string;
  verify: OidcVerifier;
  /** The exact service-account email Pub/Sub is configured to push as for THIS route. A verified token
   *  from ANY OTHER Google identity is refused — being Google-signed is necessary, not sufficient. */
  expectedServiceAccount: string;
  /** The domain action for this push route. Receives the Pub/Sub message's `attributes` (string-valued
   *  entries only) and its `data` field base64-decoded to a UTF-8 string (or undefined if absent/empty);
   *  parsing that string further (e.g. as JSON) is the caller's job, not the core's. Resolving normally
   *  (including a deliberate no-op drop) ⇒ 204; throwing ⇒ 500 (Pub/Sub retries, then dead-letters
   *  server-side). */
  handle: (attributes: Record<string, string>, data: string | undefined) => Promise<void>;
  /** Same per-IP limiter every public route uses. `false` ⇒ refuse (fail-closed). Optional. */
  checkRateLimit?: (ip: string) => Promise<boolean>;
}

interface PushEnvelope {
  message?: { attributes?: Record<string, unknown>; data?: string };
}

/** Registers an OIDC-gated Pub/Sub push route at `deps.routePath`. Ack semantics: `handle` resolves ⇒
 *  204; `handle` throws ⇒ 500 so Pub/Sub retries (and eventually dead-letters, server-side); bad/absent
 *  OIDC ⇒ 401. The response never distinguishes WHY (no oracle). */
export function registerOidcPushRoute(app: FastifyInstance, deps: OidcPushRouteDeps): void {
  app.post(deps.routePath, async (req, reply) => {
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

    // 3. Only now read the body. Attributes are coerced to string-valued entries only (Pub/Sub attributes
    // are always strings on the wire; this just protects `handle` from a malformed envelope's non-strings).
    const body = req.body as PushEnvelope | undefined;
    const attributes: Record<string, string> = {};
    const rawAttrs = body?.message?.attributes;
    if (rawAttrs && typeof rawAttrs === "object") {
      for (const [k, v] of Object.entries(rawAttrs)) {
        if (typeof v === "string") attributes[k] = v;
      }
    }

    // 4. `message.data` is base64 on the wire; decode to a UTF-8 string for `handle` to parse further.
    const raw = body?.message?.data;
    const data = typeof raw === "string" && raw.length > 0 ? Buffer.from(raw, "base64").toString("utf8") : undefined;

    // 5. Hand off to the domain action. A throw ⇒ 500 (Pub/Sub retries, then dead-letters server-side);
    // resolving (including a deliberate no-op drop) ⇒ 204.
    try {
      await deps.handle(attributes, data);
    } catch {
      reply.code(500);
      return { error: "handler failed" };
    }
    reply.code(204);
    return null;
  });
}
