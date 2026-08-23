import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { EventBus } from "../events.js";

// W1-API Task 7: `GET /events` — the Approval Center's SSE live-update channel. Same
// `console.view` floor permission + tenant-derived-from-principal-only isolation as every other
// read route in this package (`approvals.ts`/`audit.ts`/`kill.ts`'s GET). Best-effort by design: the
// store (`GET /approvals`, `GET /kill`) remains the source of truth, so a dropped connection never
// loses data — see `events.ts`'s module header.
//
// `reply.hijack()` tells Fastify this handler owns the raw response from here on (no `onSend` hooks,
// no automatic serialization/finalization of the reply) — required for a stream that never calls
// `reply.send()`. Ordering matters for auth: `merchantPlane`'s `requireMerchant` hook (registered via
// `addHook`, server.ts) and this route's own `requirePermission("console.view")` preHandler are BOTH
// Fastify preHandler hooks, and Fastify always runs preHandler hooks (parent-scope hooks, then
// route-level ones) to completion before invoking the route handler below — so an absent/invalid
// bearer token 401s and short-circuits before this handler (and therefore before `reply.hijack()`)
// ever runs. `route-protection.test.ts` asserts this holds for every non-/health route, including
// this one.

export interface EventsRoutesDeps {
  bus: EventBus;
}

export function registerEventsRoutes(app: FastifyInstance, deps: EventsRoutesDeps): void {
  app.get("/events", { preHandler: requirePermission("console.view") }, (req, reply) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    const tenantId = principal.merchantId;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Send the headers immediately rather than waiting for the first event — SSE clients (and the
    // test harness) need the connection to be observably open before anything is published.
    reply.raw.flushHeaders();

    const unsubscribe = deps.bus.subscribe(tenantId, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });
  });
}
