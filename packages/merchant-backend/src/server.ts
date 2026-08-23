import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { type RuntimeStatePort, type MerchantIdentityPort, InMemoryRuntimeStore } from "@palup/platform-ports";
import { requireMerchant, shopifyEmbedFrameAncestors } from "@palup/identity-shopify";
import { registerMeRoutes } from "./routes/me.js";
import "./types.js";

// F3 skeleton (F4 real composition): `store`/`identity` are injectable so tests can supply fakes
// (per F2's ports) without a live Postgres/Shopify session behind them. The real composition —
// `createRuntimeStore` (@palup/state-postgres) + `createShopifyAppBridgeIdentity`
// (@palup/identity-shopify) — lands in Task 4; until then these defaults are deliberately minimal and
// fail-closed (an unauthenticated caller is always denied), never a silent bypass.
const NOOP_IDENTITY: MerchantIdentityPort = {
  authenticate: async () => ({ kind: "anonymous" }),
  authorize: () => false,
};

export async function buildServer(opts?: { store?: RuntimeStatePort; identity?: MerchantIdentityPort }): Promise<FastifyInstance> {
  const store: RuntimeStatePort = opts?.store ?? new InMemoryRuntimeStore();
  void store; // wired into routes as W1-W7 land; unused for now beyond proving the injectable seam.
  const identity: MerchantIdentityPort = opts?.identity ?? NOOP_IDENTITY;

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
