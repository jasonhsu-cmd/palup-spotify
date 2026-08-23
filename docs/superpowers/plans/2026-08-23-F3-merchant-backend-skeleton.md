# Merchant-Backend Service Skeleton (F3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `packages/merchant-backend` — the new Cloud Run **Fastify service** for the merchant plane — as a deployable skeleton that authenticates every request into a `MerchantPrincipal` (via F2), enforces RBAC per route, exposes `/health`, and proves the auth chain end-to-end with a `GET /me` and a permission-gated probe. Every workstream API (W1–W7) mounts its routes onto this service.

**Architecture:** F3 is deliberately thin: it **composes** F2 (the identity port + Shopify App-Bridge adapter + the Fastify auth/RBAC/CSP preHandlers) and the shared `RuntimeStatePort` (`@palup/state-postgres` `createRuntimeStore`, same `DATABASE_URL` as `widget-backend`/`control-plane` so a kill propagates), following the `control-plane` service shape (`buildServer(opts?)`, injectable deps for tests). Unlike `control-plane` (IAM-gated, operator-only), `merchant-backend` has **public ingress** and authenticates via the **App Bridge session token** on each request — merchants' browsers call it directly. No business logic here; this is the service chassis + auth wiring + deploy scaffold.

**Tech Stack:** TypeScript, Fastify, vitest. Depends on `@palup/platform-ports` (`RuntimeStatePort`, `MerchantIdentityPort`, `MerchantPrincipal`, `Permission`, `can`), `@palup/state-postgres` (`createRuntimeStore`), and the F2 adapter (`@palup/identity-shopify`). ATDD. `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm exec vitest run`.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` — §5 (architecture, "new Cloud Run service"), §7 (F3), §8 (cross-cutting), §12 (§3/security). Depends on plan **F2** (`docs/superpowers/plans/2026-08-23-F2-identity-app-bridge.md`).

## Global Constraints

- **Consume F2, don't re-implement auth.** The auth preHandler (session token → `MerchantPrincipal`), the `requirePermission(perm)` preHandler (using `can`), and the CSP `frame-ancestors` preHandler come from F2. F3 mounts them.
- **Fail-closed.** Every route except `/health` requires an authenticated `MerchantPrincipal`; anonymous → **401**. Missing permission → **403**. (Mirror `control-plane`'s `onRequest` fail-closed hook.)
- **Bind `0.0.0.0` in the container.** The Cloud Run health-check gotcha: `control-plane` defaults `HOST` to `127.0.0.1` (loopback) — a container must set `HOST=0.0.0.0` or Cloud Run's health check fails. F3 defaults `HOST` to `0.0.0.0` (dev can override to loopback).
- **Public ingress, session-token auth — NOT IAM-gated.** Merchants' browsers reach it; the session token is the auth, not `run.invoker`.
- **Tenant from verified claims only** (F2 guarantees this) — no route trusts a client-supplied tenant/merchant id.
- **Portability (ADR-0001)** — storage via `RuntimeStatePort`; no provider SDK in feature code.
- **Build-time dev against an APPROVED, owned spec** — self-merge on gate-green after §4 reviews; **security-reviewer required** (auth/authz surface).

## File Structure

- Create `packages/merchant-backend/{package.json,tsconfig.json}` — new package `@palup/merchant-backend`, mirror `packages/control-plane`.
- Create `packages/merchant-backend/src/server.ts` — `buildServer(opts?)`, `/health`, mounts F2 preHandlers, the composition root (`createRuntimeStore` + the Shopify identity adapter), the `main()` bootstrap (`0.0.0.0`).
- Create `packages/merchant-backend/src/routes/me.ts` — `GET /me` (any authed principal) + `GET /_probe/money` (requires `approve_money`) — proves the chain; the probe route is removed once W1 lands (note it).
- Create `packages/merchant-backend/src/types.ts` — the Fastify request decoration (`req.principal: MerchantPrincipal`) type augmentation.
- Create `Dockerfile.merchant-backend` (repo root) — mirror `Dockerfile.control-plane`; `ENV HOST=0.0.0.0`.
- Create `docs/DEPLOY.md` addendum OR `packages/merchant-backend/DEPLOY.md` — the staging deploy recipe (service `palup-merchant-staging`, public ingress, shared `DATABASE_URL`, Shopify app secret via secrets port). Deploy itself is an enablement step, not run here.
- Tests: `packages/merchant-backend/test/*.test.ts`.

## Interfaces (consumed from F2 — do not redefine)

```ts
import type { MerchantIdentityPort, MerchantPrincipal, MerchantAuthResult, Permission } from "@palup/platform-ports";
import { can } from "@palup/platform-ports";
// F2 exports (from @palup/identity-shopify — confirm names in its src/index.ts once F2 lands):
//   createShopifyAppBridgeIdentity(deps): MerchantIdentityPort   // the adapter factory
//   requireMerchant: FastifyPreHandler                            // auth → sets request.principal, else 401
//   requirePermission(perm): FastifyPreHandler                    // 403 if !can(request.principal, perm)
//   (an embedded-console CSP helper for frame-ancestors)
```

`buildServer(opts?: { store?: RuntimeStatePort; identity?: MerchantIdentityPort }): Promise<FastifyInstance>` — opts inject fakes in tests; defaults construct the real store + Shopify adapter.

> **Coordination note:** the names above are F2's as of its plan (`createShopifyAppBridgeIdentity`, `requireMerchant`, `requirePermission`). Verify against `packages/identity-shopify/src/index.ts` after F2 lands and adapt if they drifted. Do not fork a second auth path.

---

### Task 1: Scaffold `@palup/merchant-backend` + `buildServer` + `/health`

**Files:** Create `packages/merchant-backend/{package.json,tsconfig.json}`, `src/server.ts`, `src/types.ts`, `test/health.test.ts`.

**Interfaces:** Produces `buildServer(opts?)`, the `req.principal` type augmentation.

- [ ] **Step 1: Write the failing test** `test/health.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
describe("merchant-backend health", () => {
  it("serves /health without auth", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false } });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });
});
```

- [ ] **Step 2:** Run `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm exec vitest run packages/merchant-backend/test/health.test.ts` — expect FAIL.

- [ ] **Step 3: Implement** `package.json` (`@palup/merchant-backend`, deps: fastify, `@palup/platform-ports`, `@palup/state-postgres`, `@palup/identity-shopify`; mirror `packages/control-plane/package.json`), `tsconfig.json`, `src/types.ts` (`declare module "fastify" { interface FastifyRequest { principal: MerchantPrincipal } }`), `src/server.ts` with `buildServer(opts?)` creating a Fastify app + `GET /health` → `{ ok: true }`, and a `main()` that `listen({ port: Number(process.env.PORT ?? 8991), host: process.env.HOST ?? "0.0.0.0" })` guarded by `import.meta`/entrypoint check (mirror control-plane's bootstrap).

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): service skeleton + /health, binds 0.0.0.0"`

---

### Task 2: Mount F2's auth preHandler — fail-closed 401

**Files:** Modify `packages/merchant-backend/src/server.ts`; create `test/auth.test.ts`.

**Interfaces:** Consumes F2 `authPreHandler(identity)` + `MerchantIdentityPort`. Produces `req.principal` on authed requests.

- [ ] **Step 1: Write the failing test** — anonymous → 401, valid principal passes, /health stays open. Use a fake identity port:
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
const owner: MerchantPrincipal = { kind:"merchant_user", merchantId:"t1", userId:"shopify:t1:u1", role:"owner", authLevel:"session", sessionId:"s1" };
const idFor = (p: MerchantPrincipal | null): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" && p ? p : { kind:"anonymous" }),
  authorize: () => true,
});
const mk = (p: MerchantPrincipal | null) => buildServer({ store: new InMemoryRuntimeStore(), identity: idFor(p) });
describe("auth preHandler", () => {
  it("401s an unauthenticated protected request", async () => {
    const app = await mk(owner);
    expect((await app.inject({ method:"GET", url:"/me" })).statusCode).toBe(401);
    await app.close();
  });
  it("attaches the principal when the session token is valid", async () => {
    const app = await mk(owner);
    const res = await app.inject({ method:"GET", url:"/me", headers:{ authorization:"Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ merchantId:"t1", role:"owner" });
    await app.close();
  });
});
```
(`/me` is added in Task 3 — this test drives both; if splitting, gate Task 2 on the 401 for a temporary `/me` stub.)

- [ ] **Step 2:** Run — expect FAIL.

- [ ] **Step 3: Implement** — register F2's `authPreHandler(identity)` as an `onRequest`/`preHandler` hook scoped to everything except `/health` (mirror control-plane's `onRequest` fail-closed gate: extract the bearer/session token, `identity.authenticate(token)` → if `anonymous`, `reply.code(401)`; else set `req.principal`). Also register F2's `cspFrameAncestorsPreHandler`.

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): fail-closed session-token auth via the identity port"`

---

### Task 3: `GET /me` + RBAC-gated probe — prove the chain (401/403/200)

**Files:** Create `packages/merchant-backend/src/routes/me.ts`; modify `src/server.ts` (register); create `test/rbac.test.ts`.

**Interfaces:** Consumes F2 `requirePermission("approve_money")`.

- [ ] **Step 1: Write the failing test** — `/me` returns the principal; a viewer is 403 on the money probe; an owner is 200:
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
const principal = (role: MerchantPrincipal["role"]): MerchantPrincipal => ({ kind:"merchant_user", merchantId:"t1", userId:"u", role, authLevel:"session", sessionId:"s" });
const mk = (role: MerchantPrincipal["role"]) => buildServer({ store:new InMemoryRuntimeStore(),
  identity:{ authenticate: async () => principal(role), authorize: () => true } });
describe("rbac probe", () => {
  it("viewer is forbidden from the money-gated probe", async () => {
    const app = await mk("viewer");
    expect((await app.inject({ method:"GET", url:"/_probe/money", headers:{authorization:"Bearer x"} })).statusCode).toBe(403);
    await app.close();
  });
  it("owner passes the money-gated probe", async () => {
    const app = await mk("owner");
    expect((await app.inject({ method:"GET", url:"/_probe/money", headers:{authorization:"Bearer x"} })).statusCode).toBe(200);
    await app.close();
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.

- [ ] **Step 3: Implement** `routes/me.ts` — `GET /me` returns `{ merchantId, userId, role, authLevel }` from `req.principal`; `GET /_probe/money` with `{ preHandler: requirePermission("approve_money") }` returns `{ ok: true }`. Register in `server.ts`. Add a `// TODO(W1): remove /_probe/money once real money routes exist` marker.

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): /me + RBAC-gated probe proving the auth chain"`

---

### Task 4: Composition root — real store + Shopify identity by default

**Files:** Modify `packages/merchant-backend/src/server.ts`; create `test/compose.test.ts`.

**Interfaces:** `buildServer()` with no opts constructs `createRuntimeStore()` + `createShopifyMerchantIdentity({ secrets, registry })` (F2 factory), reading the Shopify app secret via the secrets port (never env-inline).

- [ ] **Step 1: Write the failing test** — no-opts `buildServer` builds without throwing on the mock path (inject nothing; assert `/health` works), and it does NOT read a client-supplied tenant anywhere (grep-style guard is manual; the test asserts construction + that `/me` still requires auth). Follow the control-plane `opts?.store ?? (await createRuntimeStore()).store` pattern; in tests always inject to avoid a real DB.
```ts
// buildServer() with defaults should construct; but to avoid a real DATABASE_URL in unit tests,
// assert the DEFAULT wiring path is exercised via a spy/fake secrets+registry, and that omitting
// `identity` falls through to createShopifyMerchantIdentity (mock secrets → deterministic).
```

- [ ] **Step 2:** Run — expect FAIL.

- [ ] **Step 3: Implement** the composition root: `const store = opts?.store ?? (await createRuntimeStore()).store; const identity = opts?.identity ?? createShopifyMerchantIdentity({ secrets: getSecretsPort(), registry: merchantRegistryOver(store) });`. Wire the Shopify app secret via the secrets port. Keep both injectable.

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): composition root wiring real store + Shopify identity"`

---

### Task 5: Deploy scaffold — `Dockerfile.merchant-backend` + staging recipe

**Files:** Create `Dockerfile.merchant-backend` (root); create `packages/merchant-backend/DEPLOY.md`.

**Interfaces:** none (infra artifact).

- [ ] **Step 1:** Copy `Dockerfile.control-plane` structure (multi-stage pnpm build of the workspace, run `@palup/merchant-backend`), set `ENV HOST=0.0.0.0` and `ENV PORT=8991`, entrypoint the service `main()`. (Confirm the control-plane Dockerfile path first: `ls Dockerfile.control-plane`.)
- [ ] **Step 2:** Write `DEPLOY.md`: `gcloud run deploy palup-merchant-staging` — **public ingress** (`--allow-unauthenticated`; auth is the session token, NOT IAM), region/project per `docs/DEPLOY.md` staging coords, `--set-env-vars HOST=0.0.0.0`, shared `DATABASE_URL` (same Cloud SQL as widget-backend so kills propagate), Shopify app secret via Secret Manager mounted through the secrets port. State clearly: **the deploy is a human/enablement step, not run by this plan** (staging-first; prod deferred).
- [ ] **Step 3:** No test (infra). Verify `docker build -f Dockerfile.merchant-backend .` is referenced in DEPLOY.md as the build step. **Commit:** `git commit -am "chore(merchant-backend): Dockerfile + staging deploy recipe (public ingress, session-token auth)"`

---

## Final: gate + PR
- [ ] Full gate green (`.claude/scripts/merge-gate.sh`); **security-reviewer pass** (auth/authz/ingress surface); open PR (governance/security-touching); auto-merge on green per the ownership rule. Inert until deployed (a human enablement step) and until W1–W7 mount routes.

## Self-Review
- **Spec coverage:** new Cloud Run merchant-plane service (§5) ✓; consumes F2 principal + preHandlers (§7 F2/F3) ✓; fail-closed 401 / RBAC 403 (§9 W7, §12) ✓; public ingress + session-token auth, distinct from IAM-gated control-plane (§4) ✓; shared `RuntimeStatePort`/`DATABASE_URL` so kills propagate (§6.3) ✓; binds `0.0.0.0` (deploy gotcha) ✓; secrets via port (§8) ✓.
- **Reuse check:** service shape mirrors `control-plane` (`buildServer(opts?)`); auth/RBAC/CSP preHandlers are F2's, not re-implemented; Dockerfile mirrors `Dockerfile.control-plane`.
- **Type consistency:** `MerchantPrincipal`/`Permission`/`MerchantIdentityPort` imported from F2 unchanged; `req.principal` augmentation is the single decoration W1–W7 routes read.
- **Dependency ordering:** F3 depends on F2 landing first (the `@palup/identity-shopify` exports + preHandler names) — the coordination note instructs adapting imports to F2's actual export names.
- **Placeholder scan:** Task 4's test is described (composition-root construction) rather than fully coded — the one spot to finalize at authoring time, because its exact shape depends on F2's factory signature; every other task has real red/green code.
- **Scope:** no business logic — chassis + auth + deploy only; the `/_probe/money` route is explicitly marked for removal when W1 lands.
