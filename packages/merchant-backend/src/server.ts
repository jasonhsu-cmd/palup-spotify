import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { type RuntimeStatePort, type MerchantIdentityPort, InMemoryRuntimeStore } from "@palup/platform-ports";
import "./types.js";

// F3 skeleton (F4 real composition): `store`/`identity` are injectable so tests can supply fakes
// (per F2's ports) without a live Postgres/Shopify session behind them. The real composition —
// `createRuntimeStore` (@palup/state-postgres) + `createShopifyAppBridgeIdentity`
// (@palup/identity-shopify) — lands in Task 4; until then these defaults are deliberately minimal and
// fail-closed (an unauthenticated caller is always denied), never a silent bypass.
export async function buildServer(opts?: { store?: RuntimeStatePort; identity?: MerchantIdentityPort }): Promise<FastifyInstance> {
  const store: RuntimeStatePort = opts?.store ?? new InMemoryRuntimeStore();
  void store; // wired into routes as W1-W7 land; unused for now beyond proving the injectable seam.

  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true }));

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
