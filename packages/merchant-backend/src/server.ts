import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { type RuntimeStatePort, type MerchantIdentityPort, createEnvSecrets, createInMemoryMerchantRegistry } from "@palup/platform-ports";
import { createRuntimeStore, PostgresMerchantRegistry } from "@palup/state-postgres";
import { requireMerchant, shopifyEmbedFrameAncestors, createShopifyAppBridgeIdentity, createInMemoryJtiGuard } from "@palup/identity-shopify";
import { registerMeRoutes } from "./routes/me.js";
import "./types.js";

// Task 4 composition root: `store`/`identity` stay injectable (every existing test suite injects fakes
// — InMemoryRuntimeStore + a deterministic MerchantIdentityPort double — so no unit test needs a real
// Postgres connection or a real Shopify secret). Omitting them wires the REAL deps, mirroring
// control-plane's `opts?.store ?? (await createRuntimeStore()).store` pattern (control-plane/src/server.ts):
//   • store    -> `createRuntimeStore()` (@palup/state-postgres): real Cloud SQL Postgres when
//                 DATABASE_URL is set, else the same in-memory fallback every other service uses locally.
//   • identity -> `createShopifyAppBridgeIdentity` (@palup/identity-shopify): the real Shopify App
//                 Bridge session-token/exchange adapter. Its app client secret and PalUp session-signing
//                 secret are read via the SECRETS PORT (`createEnvSecrets()`, the same adapter and the
//                 same secret names widget-backend already reads — server.ts:416) — never env-inline.
//                 The registry it resolves a shop domain against is `PostgresMerchantRegistry` when a
//                 durable store is available (sharing the SAME pool `createRuntimeStore()` opened, per
//                 the "one pg.Pool per process" rule state-postgres documents), else the in-memory
//                 registry — this deployment has no merchants registered until F5+ writes to it, so a
//                 real shop can't resolve until then; that is fail-closed by construction, not a bypass.
//   • SHOPIFY_APP_CLIENT_ID is the OAuth client id (NOT a secret — it ships in the URL, same convention
//     widget-backend uses at server.ts:1196) so it is read directly from the environment.
export async function buildServer(opts?: { store?: RuntimeStatePort; identity?: MerchantIdentityPort }): Promise<FastifyInstance> {
  const runtimeResult = opts?.store ? undefined : await createRuntimeStore();
  const store: RuntimeStatePort = opts?.store ?? runtimeResult!.store;
  void store; // wired into routes as W1-W7 land; unused for now beyond proving the injectable seam.
  const identity: MerchantIdentityPort =
    opts?.identity ??
    createShopifyAppBridgeIdentity({
      clientId: process.env.SHOPIFY_APP_CLIENT_ID ?? "",
      secrets: createEnvSecrets(),
      registry: runtimeResult?.sql ? new PostgresMerchantRegistry(runtimeResult.sql) : createInMemoryMerchantRegistry(),
      jtiGuard: createInMemoryJtiGuard(),
    });

  const app = Fastify({ logger: false });

  // Structural-safety backstop (coordinator review, W1-API is about to add many routes): collect
  // EVERY route Fastify actually registers, regardless of which context (root `app` vs the
  // encapsulated `merchantPlane` below) it's registered in — `onRoute` fires for child-context routes
  // too. `route-protection.test.ts` walks this list and asserts every non-/health route 401s with no
  // token, so a future route registered outside `merchantPlane` fails that test instead of shipping
  // unprotected with green tests and no signal.
  const registeredRoutes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) registeredRoutes.push({ method, url: route.url });
  });
  app.decorate("registeredRoutes", registeredRoutes);

  // /health is the ONLY unauthenticated route — registered directly on `app`, outside the encapsulated
  // merchant-plane context below, so it can never accidentally pick up the auth preHandler that context
  // scopes to everything registered inside it.
  app.get("/health", async () => ({ ok: true }));

  // CSP `frame-ancestors` pin (F2, anti-clickjacking): the embedded merchant console may only be framed
  // by Shopify admin. Per-shop widening needs the authenticated merchant's shop domain, which the
  // identity port doesn't surface yet (Task 4 composition) — until then every response gets the safe
  // admin-only default rather than staying unset.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("content-security-policy", shopifyEmbedFrameAncestors(""));
    return payload;
  });

  // Every merchant-plane route (everything except /health) lives inside this encapsulated context so
  // Fastify's own scoping — not string-matching request URLs — is what keeps /health open: the
  // fail-closed session-token preHandler (F2's `requireMerchant`) applies to every route registered
  // inside here and nowhere else. An absent/invalid bearer -> 401 from the preHandler itself; a valid
  // one attaches `req.principal` for the handler + any `requirePermission` preHandler mounted per-route.
  await app.register(async (merchantPlane) => {
    merchantPlane.addHook("preHandler", requireMerchant(identity));
    registerMeRoutes(merchantPlane);
  });

  return app;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
  const port = Number(process.env.PORT ?? 8991);
  // Cloud Run needs 0.0.0.0 to accept traffic (control-plane's HOST default is loopback-only, which is
  // the deploy gotcha that broke its first Cloud Run rollout — see project memory). Default open here so
  // an ops env doesn't have to remember to set HOST for merchant-backend's health check to pass.
  const host = process.env.HOST ?? "0.0.0.0";
  buildServer()
    .then((app) => app.listen({ port, host }))
    .then(() => console.log(`merchant-backend on http://${host}:${port}`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
