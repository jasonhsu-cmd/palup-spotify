import type { MerchantPrincipal } from "@palup/platform-ports";

// The merchant-plane request augmentation. `@palup/identity-shopify`'s fastify-plugin already merges
// this same (optional) shape into the ambient `fastify` module the moment anything in this program
// imports from that package (module augmentations apply program-wide, not just to the importer) — this
// declaration is kept here too so `request.principal` is documented and type-checkable from THIS
// package's own module graph, not only as a side effect of importing identity-shopify. It MUST stay
// optional (`?`) to match identity-shopify's declaration exactly: TypeScript's declaration merging
// requires structurally-identical redeclarations of the same interface member, and a `principal:
// MerchantPrincipal` (required) here would conflict with identity-shopify's `principal?:
// MerchantPrincipal` and fail `tsc -b`. Every protected route can still rely on it being present at
// runtime because the fail-closed auth hook in server.ts either sets it or returns 401 first.
declare module "fastify" {
  interface FastifyRequest {
    principal?: MerchantPrincipal;
  }
  interface FastifyInstance {
    /** Every route this instance actually registered, collected via `onRoute` (server.ts) — the
     *  structural-safety backstop `route-protection.test.ts` walks so a future route registered
     *  outside the authenticated `merchantPlane` context can't ship unprotected without failing that
     *  test. Populated before `buildServer` returns; do not rely on it before `app.ready()`. */
    registeredRoutes: { method: string; url: string }[];
  }
}
