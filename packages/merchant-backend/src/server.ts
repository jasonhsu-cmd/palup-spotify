import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import {
  type RuntimeStatePort,
  type MerchantIdentityPort,
  type CampaignCommsPort,
  type CustomerListingCommerce,
  type MerchantRulesStore,
  type ProposalStore,
  createEnvSecrets,
  createInMemoryMerchantRegistry,
  InMemoryMerchantRulesStore,
  InMemoryProposalStore,
  SandboxCommsAdapter,
  SandboxCustomerDirectory,
} from "@palup/platform-ports";
import { createRuntimeStore, PostgresMerchantRegistry } from "@palup/state-postgres";
import { requireMerchant, shopifyEmbedFrameAncestors, createShopifyAppBridgeIdentity, createInMemoryJtiGuard } from "@palup/identity-shopify";
import { registerMeRoutes } from "./routes/me.js";
import { registerInternalWinBackRoutes } from "./routes/internal-winback.js";
import { registerApprovalsRoutes } from "./routes/approvals.js";
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
export async function buildServer(opts?: {
  store?: RuntimeStatePort;
  identity?: MerchantIdentityPort;
  // Task 5 (WB win-back staging trigger route) — every one of these stays injectable so its tests
  // (and every other suite in this package) never need a real DB/comms provider. Absent opts default
  // to sandbox/in-memory adapters wrapping `store` — the exact same "inject for tests, sandbox/mock
  // for real deploys until a governed live adapter is wired" convention `identity`/`registry` above
  // already follow.
  commerce?: CustomerListingCommerce;
  comms?: CampaignCommsPort;
  proposalStore?: ProposalStore;
  rulesStore?: MerchantRulesStore;
}): Promise<FastifyInstance> {
  const runtimeResult = opts?.store ? undefined : await createRuntimeStore();
  const store: RuntimeStatePort = opts?.store ?? runtimeResult!.store;
  const commerce: CustomerListingCommerce = opts?.commerce ?? new SandboxCustomerDirectory({});
  // SandboxCommsAdapter records every send and NEVER delivers — the only comms adapter this service
  // may default to until a real (still consent/DLP-gated) provider adapter is wired + prod-enabled.
  const comms: CampaignCommsPort = opts?.comms ?? new SandboxCommsAdapter();
  const proposalStore: ProposalStore = opts?.proposalStore ?? new InMemoryProposalStore(store);
  const rulesStore: MerchantRulesStore = opts?.rulesStore ?? new InMemoryMerchantRulesStore(store);
  const identity: MerchantIdentityPort =
    opts?.identity ??
    createShopifyAppBridgeIdentity({
      clientId: process.env.SHOPIFY_APP_CLIENT_ID ?? "",
      secrets: createEnvSecrets(),
      registry: runtimeResult?.sql ? new PostgresMerchantRegistry(runtimeResult.sql) : createInMemoryMerchantRegistry(),
      // PER-INSTANCE, not shared — see DEPLOY.md "Shared state" ⚠️ for the multi-instance replay-window
      // caveat and the --max-instances 1 mitigation until a durable JtiReplayGuard adapter exists.
      jtiGuard: createInMemoryJtiGuard(),
    });

  const app = Fastify({ logger: false });

  // C1 hardening (found while fixing the approve/reject routes' error mapping — coordinator review):
  // Fastify's OWN default error handler echoes the raw `err.message` of any uncaught error in the
  // JSON response body (verified empirically: `throw new Error("x")` from a route -> HTTP 500 body
  // `{..., message: "x"}`) — a real info leak for a genuine bug or infra failure (e.g.
  // `deps.state.audit()` throwing after a transition already committed) once approve/reject stop
  // catching every `Error` into a 409. Every typed §3 error (`VersionConflictError`/`KillSwitchError`/
  // `ProposalNotFoundError`/`TerminalStateError`) is already mapped to a specific status code INSIDE
  // the route before it would ever reach here — this handler is the redacted fallback for everything
  // else: log the real message server-side, return a fixed, message-free 500 to the client.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "unhandled error");
    // No route in this package throws a Fastify SCHEMA-validation error with a legitimate,
    // non-sensitive 4xx message (no `schema` option is used anywhere yet) — so redacting
    // unconditionally to a fixed 500 is safe today; every intentional non-500 response (400/401/403/
    //404/409/423) is sent explicitly by the route itself via `reply.code(...).send(...)` and never
    // reaches this handler at all.
    reply.code(500).send({ statusCode: 500, error: "Internal Server Error" });
  });

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
    registerInternalWinBackRoutes(merchantPlane, { state: store, commerce, comms, proposalStore, rulesStore });
    registerApprovalsRoutes(merchantPlane, { proposalStore, state: store, rulesStore, comms });
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
