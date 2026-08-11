# Storefront-Token Read-Back (D2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serving reads the delegate token install already custodies (`MerchantCredentialStore.read`) so one OAuth-installed merchant serves their own Shopify catalog into `/chat` — behind existing ports, dark until a live proof.

**Architecture:** A flag-gated three-way credential resolver (`live` / `fixtures` / `refuse`) replaces the two-way `resolveShopifyStore` at two call sites: the grounding router (catalog) and a new `/chat` pre-flight (the refusal surface). Read-back builds its own full `MerchantCredentialStore` handle; `SecretsPort` is demoted to a `missing`-only fallback. An operator harness proves the live Shopify path; a cache-invalidate CLI is the go-live hygiene step.

**Tech Stack:** TypeScript via tsx (no build step), vitest (root config, mock path), Fastify. Spec: `docs/superpowers/specs/2026-08-10-storefront-token-readback-design.md`.

## Global Constraints

- **Flag `MERCHANT_CRED_READBACK_ENABLED`** — `process.env.MERCHANT_CRED_READBACK_ENABLED === "true"`, **default OFF**, warn-at-boot when ON (repo precedent: `server.ts:295`). OFF ⇒ serving behavior byte-unchanged (SecretsPort only; no `refuse` outcome).
- **`absent → fixtures` is deliberate** (demo tenant + rollout). A `refuse` fires **only** on `unreadable` (present-but-undecryptable / malformed), **never** on `missing`.
- **Read handle, not the Sink.** Build the read handle as `createMerchantCredentialStore(store, createAesGcmCrypto(secrets))` (a full `MerchantCredentialStore`). Do **not** read through the composition-root `merchantCredentials` (typed `MerchantCredentialSink`, put-only) nor through `opts.merchantCredentials` (a test double that may implement only `put`).
- **Server-derived tenant only** — the tenantId at every credential/grounding call is threaded from the verified widget token, never client input. Preserve.
- **Portability (ADR-0001):** no new port, no Shopify SDK in feature code. The credential store is behind `CryptoPort`+`RuntimeStatePort`; grounding behind `GroundingPort`.
- **Secrets (NN#6):** never log/echo any token (`accessToken`, `parentAccessToken`, `clientSecret`, `code`). The per-tenant crypto secret is `MEMORY_ENCRYPTION_KEY__merchant-cred` in `PALUP_SECRETS`.
- **Tests run on the mock path:** always `env -u GOOGLE_CLOUD_PROJECT` for `pnpm test` / `pnpm typecheck`. Never set `GOOGLE_CLOUD_PROJECT`.

---

### Task 1: Three-way storefront-credential resolver

**Files:**
- Modify: `packages/widget-backend/src/merchant-store.ts`
- Test: `packages/widget-backend/test/merchant-store.test.ts` (add cases; do not modify existing `resolveShopifyStore` tests)

**Interfaces:**
- Consumes: `resolveShopifyStore` (unchanged behavior), `SecretsPort`, `ShopifyStoreCreds`, `SHOPIFY_TOKEN_SECRET`, `parseStoreDomains`; `MerchantCredentialRead` (type import from `@palup/state-postgres`).
- Produces: `type CredentialOutcome = { status: "live"; creds: ShopifyStoreCreds } | { status: "fixtures" } | { status: "refuse"; reason: "undecryptable" | "malformed-record" }` and `async function resolveStorefrontCredential(tenantId: string, deps: StorefrontCredentialDeps): Promise<CredentialOutcome>` where `interface StorefrontCredentialDeps { secrets: SecretsPort; credRead?: (tenantId: string) => Promise<MerchantCredentialRead>; readbackEnabled?: boolean; domains?: Record<string, string>; shopDomainFor?: (tenantId: string) => Promise<string | undefined>; }`.

- [ ] **Step 1: Write the failing tests**

```ts
// in packages/widget-backend/test/merchant-store.test.ts
import { resolveStorefrontCredential } from "../src/merchant-store.js";
import type { MerchantCredentialRead } from "@palup/state-postgres";

const secretsWith = (map: Record<string, string>) => ({
  get: async (tenantId: string, name: string) => map[`${tenantId}:${name}`],
}) as any;
const credReadReturning = (r: MerchantCredentialRead) => async (_t: string) => r;
const domains = { demo: "demo-store.myshopify.com", acme: "acme.myshopify.com" };

it("readback ON + found → live creds from the custodied token", async () => {
  const out = await resolveStorefrontCredential("acme", {
    secrets: secretsWith({}), readbackEnabled: true,
    credRead: credReadReturning({ status: "found", token: "shpat_live" }), domains,
  });
  expect(out).toEqual({ status: "live", creds: { shopDomain: "acme.myshopify.com", accessToken: "shpat_live" } });
});

it("readback ON + unreadable → refuse (never fixtures, never fallback)", async () => {
  const out = await resolveStorefrontCredential("acme", {
    secrets: secretsWith({ "acme:shopify_storefront_token": "shpat_fallback" }), // present, must be ignored
    readbackEnabled: true, credRead: credReadReturning({ status: "unreadable", reason: "undecryptable" }), domains,
  });
  expect(out).toEqual({ status: "refuse", reason: "undecryptable" });
});

it("readback ON + missing → SecretsPort fallback (demo tenant keeps serving)", async () => {
  const out = await resolveStorefrontCredential("demo", {
    secrets: secretsWith({ "demo:shopify_storefront_token": "shpat_demo" }),
    readbackEnabled: true, credRead: credReadReturning({ status: "missing" }), domains,
  });
  expect(out).toEqual({ status: "live", creds: { shopDomain: "demo-store.myshopify.com", accessToken: "shpat_demo" } });
});

it("readback ON + missing + no fallback token → fixtures", async () => {
  const out = await resolveStorefrontCredential("acme", {
    secrets: secretsWith({}), readbackEnabled: true, credRead: credReadReturning({ status: "missing" }), domains,
  });
  expect(out).toEqual({ status: "fixtures" });
});

it("readback OFF → SecretsPort only, byte-behavior unchanged (never consults credRead, never refuses)", async () => {
  let credReadCalled = false;
  const out = await resolveStorefrontCredential("acme", {
    secrets: secretsWith({ "acme:shopify_storefront_token": "shpat_x" }),
    readbackEnabled: false, credRead: async () => { credReadCalled = true; return { status: "unreadable", reason: "undecryptable" }; }, domains,
  });
  expect(out).toEqual({ status: "live", creds: { shopDomain: "acme.myshopify.com", accessToken: "shpat_x" } });
  expect(credReadCalled).toBe(false);
});

it("readback ON + found but NO shop domain → fixtures (can't ground; not a refusal)", async () => {
  const out = await resolveStorefrontCredential("unknown", {
    secrets: secretsWith({}), readbackEnabled: true,
    credRead: credReadReturning({ status: "found", token: "shpat_live" }), domains,
  });
  expect(out).toEqual({ status: "fixtures" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm test -- merchant-store`
Expected: FAIL — `resolveStorefrontCredential` is not exported.

- [ ] **Step 3: Implement**

Add to `packages/widget-backend/src/merchant-store.ts` (import the type at top: `import type { MerchantCredentialRead } from "@palup/state-postgres";`). Reuse a small domain resolver so `resolveShopifyStore` stays behavior-identical:

```ts
/** Resolve a tenant's shop domain (registry-first when shopDomainFor is given, else the SHOPIFY_STORES map). */
async function resolveShopDomain(
  tenantId: string,
  domains: Record<string, string> = parseStoreDomains(),
  shopDomainFor?: (tenantId: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (shopDomainFor) return shopDomainFor(tenantId);
  return Object.hasOwn(domains, tenantId) ? domains[tenantId] : undefined;
}

export type CredentialOutcome =
  | { status: "live"; creds: ShopifyStoreCreds }
  | { status: "fixtures" }
  | { status: "refuse"; reason: "undecryptable" | "malformed-record" };

export interface StorefrontCredentialDeps {
  secrets: SecretsPort;
  /** The credential store's read(). Present ⇒ read-back is possible; consulted only when readbackEnabled. */
  credRead?: (tenantId: string) => Promise<MerchantCredentialRead>;
  readbackEnabled?: boolean;
  domains?: Record<string, string>;
  shopDomainFor?: (tenantId: string) => Promise<string | undefined>;
}

/**
 * D2: the token source. When read-back is ON we read the custodied delegate credential first; an
 * `unreadable` credential REFUSES (never fixtures, never fallback), a `missing` one falls back to the
 * hand-provisioned SecretsPort token (keeps the demo/staging tenant serving), and `found` yields live
 * creds. When OFF, this delegates to the unchanged `resolveShopifyStore` (SecretsPort only) — no refusal.
 */
export async function resolveStorefrontCredential(
  tenantId: string,
  deps: StorefrontCredentialDeps,
): Promise<CredentialOutcome> {
  if (!tenantId) return { status: "fixtures" };
  if (deps.readbackEnabled && deps.credRead) {
    const r = await deps.credRead(tenantId);
    if (r.status === "unreadable") return { status: "refuse", reason: r.reason };
    if (r.status === "found") {
      const shopDomain = await resolveShopDomain(tenantId, deps.domains, deps.shopDomainFor);
      if (!shopDomain) return { status: "fixtures" };
      return { status: "live", creds: { shopDomain, accessToken: r.token } };
    }
    // r.status === "missing" → fall through to the SecretsPort fallback.
  }
  const creds = await resolveShopifyStore(
    tenantId,
    deps.secrets,
    deps.domains,
    deps.shopDomainFor ? { shopDomainFor: deps.shopDomainFor } : {},
  );
  return creds ? { status: "live", creds } : { status: "fixtures" };
}
```

Refactor `resolveShopifyStore`'s domain block to call `resolveShopDomain(tenantId, domains, opts.shopDomainFor)` (behavior-preserving — the existing tests must stay green unchanged).

- [ ] **Step 4: Run to verify pass**

Run: `env -u GOOGLE_CLOUD_PROJECT pnpm test -- merchant-store` → PASS (new + existing).

- [ ] **Step 5: Commit** — `feat(widget-backend): three-way storefront-credential resolver (D2 read-back core)`

---

### Task 2: Grounding router uses the resolver

**Files:**
- Modify: `packages/widget-backend/src/model.ts`
- Test: `packages/widget-backend/test/grounding-router.test.ts` (new)

**Interfaces:**
- Consumes: `resolveStorefrontCredential`, `CredentialOutcome` (Task 1).
- Produces: `createGroundingPort(store, secrets, opts)` gains `opts.credRead?: (tenantId) => Promise<MerchantCredentialRead>` and `opts.readbackEnabled?: boolean`. Router maps `live` → Shopify adapter, `fixtures` → StaticGroundingAdapter, `refuse` → throw `new GroundingCredentialUnreadableError(reason)` (a distinct exported error class; the caching wrapper degrades it to safe-empty defensively — the graceful surface is Task 4's pre-flight).

- [ ] **Step 1: Write the failing test**

```ts
// packages/widget-backend/test/grounding-router.test.ts
// @vitest-environment node
import { createGroundingPort, GroundingCredentialUnreadableError } from "../src/model.js";
import { createInMemoryRuntimeStore } from "@palup/state-postgres"; // in-memory RuntimeStatePort for the cache

const store = () => createInMemoryRuntimeStore();
const secrets = { get: async () => undefined } as any;

it("readback ON + found → serves the merchant's real catalog via the injected fetch", async () => {
  const g = createGroundingPort(store(), secrets, {
    readbackEnabled: true,
    credRead: async () => ({ status: "found", token: "shpat_live" }),
    shopDomainFor: async () => "acme.myshopify.com",
    shopifyFetch: async (creds) => ({ shop: { name: "Acme" }, products: { nodes: [{ id: "1", title: "Widget" }] } }),
  });
  const ctx = await g.getContext("acme");
  expect(ctx.brandName).toBe("Acme");
  expect(ctx.products.map((p) => p.title)).toContain("Widget");
});

it("readback ON + unreadable → throws GroundingCredentialUnreadableError (router does NOT serve fixtures)", async () => {
  // Bypass the caching wrapper's safe-empty by asserting on the inner router: use a store whose get/put throw so
  // the wrapper can't cache, and assert the thrown type escapes one refresh. Simpler: call the exported inner.
  const g = createGroundingPort(store(), secrets, {
    readbackEnabled: true,
    credRead: async () => ({ status: "unreadable", reason: "undecryptable" }),
    shopDomainFor: async () => "acme.myshopify.com",
  });
  // The caching wrapper degrades a cold failure to safe-empty (empty products) — assert it did NOT serve fixtures.
  const ctx = await g.getContext("acme");
  expect(ctx.products).toEqual([]);          // safe-empty, NOT the AURIA/NORTHWIND fixture catalog
  expect(ctx.brandName).toBe("this store");  // safeEmpty brandName
});

it("readback OFF → unchanged SecretsPort path (missing token → fixtures for demo)", async () => {
  const g = createGroundingPort(store(), { get: async (_t: string, n: string) => (n === "shopify_storefront_token" ? undefined : undefined) } as any, {
    readbackEnabled: false, credRead: async () => ({ status: "unreadable", reason: "undecryptable" }),
    shopDomainFor: async () => "demo-store.myshopify.com",
  });
  const ctx = await g.getContext("demo");
  expect(ctx.brandName).not.toBe("this store"); // demo resolves the AURIA fixture, credRead never consulted
});
```

- [ ] **Step 2: Run to verify it fails** — `env -u GOOGLE_CLOUD_PROJECT pnpm test -- grounding-router` → FAIL (`GroundingCredentialUnreadableError` / new opts absent).

- [ ] **Step 3: Implement** in `model.ts`:

```ts
export class GroundingCredentialUnreadableError extends Error {
  constructor(public readonly reason: "undecryptable" | "malformed-record") {
    super(`grounding credential unreadable: ${reason}`);
    this.name = "GroundingCredentialUnreadableError";
  }
}
```

Extend `createGroundingPort`'s `opts` with `credRead?: (tenantId: string) => Promise<MerchantCredentialRead>` and `readbackEnabled?: boolean`, and replace the router body's `resolveShopifyStore` call + branch with:

```ts
const outcome = await resolveStorefrontCredential(tenantId, {
  secrets,
  credRead: opts.credRead,
  readbackEnabled: opts.readbackEnabled,
  shopDomainFor: opts.shopDomainFor,
});
if (outcome.status === "live")
  return createShopifyGroundingAdapter(outcome.creds, opts.shopifyFetch).getContext(tenantId);
if (outcome.status === "refuse") throw new GroundingCredentialUnreadableError(outcome.reason);
return fixtures.getContext(tenantId);
```

Import `resolveStorefrontCredential` (and `type MerchantCredentialRead`) from the respective modules.

- [ ] **Step 4: Run to verify pass** — `env -u GOOGLE_CLOUD_PROJECT pnpm test -- grounding-router` → PASS.

- [ ] **Step 5: Commit** — `feat(widget-backend): grounding router resolves credentials three-way (live/fixtures/refuse)`

---

### Task 3: Server composition — read handle + flag + wiring

**Files:**
- Modify: `packages/widget-backend/src/server.ts`
- Test: `packages/widget-backend/test/server-readback.test.ts` (new; uses `buildServer` with injected `store`/registry and a real `createMerchantCredentialStore` write, then asserts `/chat` grounding path)

**Interfaces:**
- Consumes: `createMerchantCredentialStore`, `createAesGcmCrypto`, `createGroundingPort` (Task 2), the flag.
- Produces: a `credRead` handle wired into `createGroundingPort`; `MERCHANT_CRED_READBACK_ENABLED` read once near the other flags.

- [ ] **Step 1: Write the failing test** — boot `buildServer` with an injected in-memory `store`, write a credential via `createMerchantCredentialStore(store, createAesGcmCrypto(secretsWithMergeKey)).put(...)`, set the flag ON, and assert a `/chat` (or the grounding port) serves the custodied token's catalog (via an injected `shopifyFetch`). Assert flag-OFF still serves fixtures. (Mirror the existing `buildServer` integration tests for the boot/inject pattern.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** in `buildServer`:

Read the flag near the other flags (`~:295`):
```ts
const MERCHANT_CRED_READBACK_ENABLED = process.env.MERCHANT_CRED_READBACK_ENABLED === "true";
if (MERCHANT_CRED_READBACK_ENABLED) console.warn("[boot] MERCHANT_CRED_READBACK_ENABLED=true — serving reads custodied delegate tokens (D2 read-back).");
```

Build a **full read handle** (NOT the put-only `merchantCredentials`, NOT `opts.merchantCredentials`) — only when read-back is enabled and there is a real store to read from:
```ts
// D2 read handle: a full MerchantCredentialStore over the same store+crypto install writes through.
// Deliberately NOT `merchantCredentials` (typed put-only) and NOT `opts.merchantCredentials` (test double).
const credReadHandle =
  MERCHANT_CRED_READBACK_ENABLED
    ? createMerchantCredentialStore(store, createAesGcmCrypto(secrets))
    : undefined;
```

Thread it into the grounding wiring (`~:389`):
```ts
const grounding = createGroundingPort(store, secrets, {
  shopDomainFor: (t) => merchants.shopDomainFor(t),
  readbackEnabled: MERCHANT_CRED_READBACK_ENABLED,
  credRead: credReadHandle ? (t) => credReadHandle.read(t) : undefined,
});
```

Keep the `credReadHandle` in scope for Task 4's pre-flight.

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(widget-backend): wire D2 read handle + MERCHANT_CRED_READBACK_ENABLED into grounding`

---

### Task 4: `/chat` pre-flight refusal (graceful "temporarily unavailable")

**Files:**
- Modify: `packages/widget-backend/src/server.ts` (the `/chat` handler, next to the servability pre-flight `~:1893`)
- Test: `packages/widget-backend/test/chat-grounding-refusal.test.ts` (new)

**Interfaces:**
- Consumes: `credReadHandle` (Task 3), `resolveStorefrontCredential` or a direct `credReadHandle.read`.
- Produces: a pre-flight that, when read-back is ON and the tenant's credential is `unreadable`, returns HTTP **503** with `{ reply: "This store's assistant is temporarily unavailable. Please try again shortly.", mode: "support", pitch: "none", escalate: false, flags: ["grounding_unavailable"], … }` (mirror the servability-403 response shape + copy discipline: promise nothing).

- [ ] **Step 1: Write the failing test** — POST `/chat` with the flag ON and a `credReadHandle` whose `read` returns `{ status: "unreadable", reason: "undecryptable" }`; assert 503 + `flags` contains `grounding_unavailable` + the graceful copy; and that a `found`/`missing` tenant proceeds normally (200). Assert flag-OFF never refuses (no 503).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — after the servability check (`server.ts:1893-1918`), add (only when `MERCHANT_CRED_READBACK_ENABLED && credReadHandle`):
```ts
if (MERCHANT_CRED_READBACK_ENABLED && credReadHandle) {
  const cred = await credReadHandle.read(tenantId);
  if (cred.status === "unreadable") {
    reply.code(503); // transient/operator-fixable, not a deliberate revocation (mirror /consent, /forget)
    return {
      reply: "This store's assistant is temporarily unavailable. Please try again shortly.",
      mode: "support", pitch: "none", escalate: false,
      flags: ["grounding_unavailable"],
      memoryEnabled: memoryServiceEnabled, consentMode: UNRESOLVED_CONSENT_MODE,
    };
  }
}
```
(`tenantId` here is the server-derived request tenant already established by the servability block.)

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(widget-backend): /chat pre-flight refuses gracefully on an unreadable credential (503)`

---

### Task 5: Grounding-cache invalidation (go-live hygiene)

**Files:**
- Modify: `packages/platform-ports/src/grounding-cache.ts` (export a standalone invalidator) + `packages/platform-ports/src/index.ts` (barrel)
- Modify: `packages/widget-backend/src/jobs/merchant.ts` (add a `invalidate-grounding <tenant>` subcommand) + root `package.json` (`grounding:invalidate` script)
- Test: `packages/platform-ports/test/grounding-cache.test.ts` (add a case)

**Interfaces:**
- Produces: `export async function invalidateGroundingCache(store: RuntimeStatePort, tenantId: string): Promise<void>` — deletes exactly the one cache row `getContext` writes (`store.delete({ tenantId }, COLLECTION, KEY)`), reusing the private `COLLECTION`/`KEY` consts (do not export the raw key strings).

- [ ] **Step 1: Write the failing test** — populate a tenant's cache via `createCachingGroundingPort(inner, store).getContext("t")` (fresh hit cached), then `invalidateGroundingCache(store, "t")`, then assert the next `getContext` re-invokes `inner` (miss). Assert it only affects the named tenant.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**
```ts
// grounding-cache.ts — reuse the existing private COLLECTION/KEY consts.
export async function invalidateGroundingCache(store: RuntimeStatePort, tenantId: string): Promise<void> {
  if (!tenantId) throw new Error("invalidateGroundingCache: a non-blank tenantId is required");
  await store.delete({ tenantId }, COLLECTION, KEY);
}
```
Barrel: `export { createCachingGroundingPort, invalidateGroundingCache } from "./grounding-cache.js";`. Add the CLI subcommand in `jobs/merchant.ts` (mirror the existing subcommands; construct a store via the job's existing store factory) and the `"grounding:invalidate": "tsx packages/widget-backend/src/jobs/merchant.ts invalidate-grounding"` script in root `package.json`.

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(platform-ports): grounding-cache per-tenant invalidator + operator CLI (go-live hygiene)`

---

### Task 6: Live-verification harness

**Files:**
- Create: `packages/widget-backend/src/shopify-verify-smoke.ts`
- Modify: root `package.json` (`"shopify:verify": "tsx packages/widget-backend/src/shopify-verify-smoke.ts"`)
- Test: `packages/widget-backend/test/shopify-verify-smoke.test.ts` (unit-test the chain with an injected `fetch`; no network)

**Interfaces:**
- Consumes: `exchangeInstallCode(args, fetchFn)`, `createDelegateAccessToken(args, fetchFn)`, `storefrontFetch(fetchFn, opts)` (all from existing modules — see their exact signatures in the spec/extraction).

- [ ] **Step 1: Write the failing test** — export a testable `runShopifyVerify({ shopDomain, code, clientId, clientSecret, delegateScopes }, fetchFn)` from the harness; with an injected `fetchFn` that returns a canned OAuth token, a canned delegate token, and a canned Storefront products response, assert it resolves `{ ok: true, productCount: N }`; with a fetch that fails the Storefront call, assert `{ ok: false, stage: "storefront" }`. Assert it never returns/echoes any token.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — `runShopifyVerify` chains `exchangeInstallCode` (pass `globalThis.fetch` explicitly — no default) → `createDelegateAccessToken` (explicit fetch) → `storefrontFetch(fetchFn)({ shopDomain, accessToken: delegate.accessToken })`, returning a stage-tagged result with a product count, **never a token**. Add a `main()` mirroring `packages/model-vertex/src/smoke.ts`: a top-of-file doc comment with the exact invocation + how to obtain the OAuth `code`; read `shopDomain`/`code` from `process.argv`, `clientId`/`clientSecret` from `process.env` (or the secrets convention); `exit(2)` if unconfigured, print PASS + product count and `exit(0)`, `exit(1)` on failure; `main().catch(...)`. Shop domain must be a bare `*.myshopify.com`.

- [ ] **Step 4: Run to verify pass** — `env -u GOOGLE_CLOUD_PROJECT pnpm test -- shopify-verify` and `env -u GOOGLE_CLOUD_PROJECT pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(widget-backend): live-verification harness (OAuth → delegate mint → Storefront fetch)`

---

### Task 7: Docs — read-back runbook + go-live

**Files:** Modify `docs/DEPLOY.md`

- [ ] **Step 1: Document the D2 read-back + go-live path.** Add a section covering: the per-tenant secret `MEMORY_ENCRYPTION_KEY__merchant-cred` in `PALUP_SECRETS`; `MERCHANT_CRED_READBACK_ENABLED` (default OFF; ON = serving reads custodied delegate tokens); the ordered go-live for one merchant — (a) `shopify app deploy` + install env vars, (b) merchant installs on the dev store (custodies the token), (c) run `pnpm shopify:verify <shop> <code>` to prove the delegate token authenticates a Storefront read, (d) `pnpm grounding:invalidate <tenant>` to clear any cached fixture context, (e) flip `MERCHANT_CRED_READBACK_ENABLED=true`; the refusal behavior (`grounding_unavailable` 503 on an unreadable credential); and the **deferred** items (embed-key delivery, merchant-console self-serve + its HITL-POLICY entry, per-merchant enablement, policy-scope widening, embedded install). State honestly: the harness/live steps are operator-run; the build ships dark.

- [ ] **Step 2: Full local gate** — `env -u GOOGLE_CLOUD_PROJECT pnpm typecheck && env -u GOOGLE_CLOUD_PROJECT pnpm test`.

- [ ] **Step 3: Commit** — `docs(deploy): D2 read-back go-live runbook + secret + flag`

---

## Governance / review (owner-coordinated, after the tasks)

- **`security-reviewer`** on the branch — the credential read-back + refusal touch merchant-credential custody and a shopper-facing serving decision. Verify: read-back builds its own full handle (never the put-only Sink / test double); `unreadable` never degrades to fixtures; `absent → fixtures` preserved; server-derived tenant only; no token logged; the flag is inert-by-default.
- **Final whole-branch review** (most capable model), then merge via `merge-gate.sh` (human-owner authorizes — credential/serving change).
- **The live flip is the operator's step** and is NOT part of the merge (NN#2: ships dark).

## Deferred (not in this plan) — tracked

Embed-key delivery; merchant-console self-serve go-live (+ HITL-POLICY entry + App-Bridge auth); per-merchant read-back enablement; returns/shipping policy-scope widening; embedded/iframe install; the 7 install-boot preconditions in staging; memoizing the credential read across the pre-flight + router (a double decrypt per grounded turn — correct but optimizable).
