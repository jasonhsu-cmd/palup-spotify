# F2 · `identity` Port + Shopify App Bridge Adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the merchant-console authenticated principal `{merchantId, userId, role, authLevel}` behind a portable identity port, plus a Shopify App Bridge adapter that cryptographically validates a session token, single-use-exchanges it, binds the tenant from verified claims, maps a PalUp 5-role RBAC role, and mints a PalUp session — the contract every merchant-plane API (F3, W1–W7) imports.

**Architecture:** Two layers, split on the portability boundary (ADR-0001). (1) A **port + RBAC model** in `packages/platform-ports` — pure TypeScript types and pure decision functions, zero Shopify knowledge: `MerchantPrincipal`, `MerchantRole`, `AuthLevel`, `Permission`, `DEFAULT_ROLE_PERMISSIONS`, `can`/`canApproveMoney`, `MerchantIdentityPort`, and a reusable port contract test. (2) A **Shopify-only adapter** in a new package `packages/identity-shopify` — session-token JWT validation (HS256/app-secret), a single-use `jti` replay guard, the token-exchange call, Shopify→PalUp role mapping, a PalUp session-token mint/verify (typ-separated HMAC, reusing the shared codec), the `createShopifyAppBridgeIdentity` factory that satisfies the port, and the Fastify preHandlers (`requireMerchant`, `requirePermission`) + embedded-console CSP helper that turn a request into `request.principal`. No Shopify SDK anywhere; `node:crypto` + injected `fetch` only, mirroring the existing `shopify-install-identity.ts`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:crypto`, Fastify (preHandlers), Vitest. Reuses `packages/platform-ports/src/token-codec.ts` (base64url + HMAC-SHA256) and `MerchantRegistryPort.lookupByShopDomain` for tenant resolution. No external JWT library (parity with `widget-token-identity.ts` / `shopify-install-identity.ts`).

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` (§7 F2, §4 two-plane boundary, §5 architecture, §8 cross-cutting, §9 W7 RBAC/`can_approve_money`, §12 §3/security). Governing decision: `docs/adr/0011-merchant-auth-model.md` (Accepted). Detailed identity/RBAC design: `docs/design/identity-and-access.md` (§1 authN, §2 authZ/PDP, §8 port, §9 invariants — esp. invariant 9).

## Global Constraints

Every task's requirements implicitly include this section. Binding items copied verbatim from the governing docs:

- **ADR-0011 Decision 1 (verbatim):** "The console runs embedded in Shopify admin via **App Bridge**; the browser gets a short-lived **Shopify session token**, which PalUp exchanges (token exchange) for a **PalUp session** scoped to that `merchant_id` + user + role… The token is **cryptographically validated** (signature, `aud`, `exp`/`nbf`, `dest`/`iss`) and the tenant binds **from the verified claims, never client input**; the exchange is single-use and framing is CSP-restricted to Shopify admin."
- **ADR-0011 Decision 3 (verbatim):** "Feature code depends on an authenticated `{merchantId, userId, role, authLevel}` principal, never on Shopify/App-Bridge/IdP specifics."
- **ADR-0011 Decision 4 (verbatim):** "Role is PalUp's, not Shopify's… PalUp's RBAC (5 merchant roles) decides *what* — mapped from Shopify staff role / invite / SSO group, and editable in PalUp with audit. PalUp never inherits Shopify permissions wholesale."
- **IAM §9 invariant 9 (verbatim):** "Embedded Shopify session tokens are signature/audience/expiry-validated and tenant-bound from verified claims, never client input; exchange is single-use and framing is CSP-restricted to Shopify."
- **IAM §2 (verbatim):** "**Default-deny**; the API never returns or mutates what the principal's role+scope disallows."
- **Portability (ADR-0001, CLAUDE.md §3.3):** the port interface lives in `platform-ports`; all Shopify/App-Bridge specifics live ONLY in the adapter. No provider SDK in feature code — `node:crypto` + injected `fetch` only. No Shopify type crosses out of the adapter (only plain strings/records).
- **Secrets via the port (CLAUDE.md §5, NN#6):** the Shopify app client secret and the PalUp session-signing secret come via `SecretsPort` / the composition root, never hardcoded, never logged, never echoed. The app client secret is APP-scoped — reuse the existing sentinel `SHOPIFY_APP_SECRET_SCOPE = "__shopify_app__"` / name `SHOPIFY_APP_CLIENT_SECRET_NAME = "shopify_app_client_secret"` from `shopify-install-identity.ts`.
- **Least-privilege default (CLAUDE.md §6, spec W7):** "invited teammates default to least-privilege (view + operate, no money-approval) until the owner elevates."
- **`can_approve_money` (spec W1/W7, §10):** distinct, **owner+admin default**, delegable; the W1 money-approval gate.
- **TypeScript everywhere; ATDD (CLAUDE.md §4/§5):** every task is failing-test-first → red → minimal impl → green → commit. Never throw on an unauthenticated caller — absent/invalid credential ⇒ `anonymous`, fail closed (parity with the existing `IdentityPort.authenticate` contract).
- **Non-goals — DEFERRED, state as such, do not build (spec §3, ADR-0011 Dec 2/5):** standalone accounts, Enterprise SSO (SAML/OIDC) + SCIM, passkey/WebAuthn step-up enrollment, API keys, the full session-revocation store (refresh-reuse detection / sign-out-all), and agent-credential issuance. F2 builds the **embedded** path only; the contract is shaped so those adapters slot behind the same port later.

### Shopify wire format (PRIMARY SOURCES — retrieved 2026-08-23; re-verify a live triple before go-live)

Session token = App Bridge **ID token**, a JWT. Source: shopify.dev "Session tokens" / "ID token claims". Token exchange source: shopify.dev "Token exchange".

- **Session-token JWT:** algorithm **HS256**, signed with the **app client secret**. Claims: `iss` = `https://{shop}.myshopify.com/admin`; `dest` = `https://{shop}.myshopify.com`; `aud` = the app's client ID; `sub` = staff user id (string, e.g. `"42"`); `exp`/`nbf`/`iat` = UNIX seconds; `jti` = secure random UUID; `sid` = session id (unique per user+app). Validation checklist (verbatim): "check the token's signature against your client secret using HS256"; verify `exp` in the future; verify `nbf` in the past; confirm `aud` matches the app's client ID; ensure `iss` and `dest` hostnames match each other; reject with 401 if any check fails.
- **Token exchange:** `POST https://{shop}.myshopify.com/admin/oauth/access_token`, body `application/x-www-form-urlencoded`: `client_id`, `client_secret`, `grant_type = urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token = <session token>`, `subject_token_type = urn:ietf:params:oauth:token-type:id_token`, `requested_token_type = urn:shopify:params:oauth:token-type:online-access-token` (F2 requests **online**, to read `associated_user` for the role bootstrap) or `…:offline-access-token`. Online response includes `access_token`, `scope`, and `associated_user` `{ id, account_owner, collaborator, email_verified, email }`.

---

## File Structure

**`packages/platform-ports/` (the port + RBAC model — pure, portable):**
- Create `src/merchant-identity-port.ts` — `MerchantPrincipal`, `AnonymousPrincipal`, `MerchantAuthResult`, `MerchantRole`, `AuthLevel`, `Permission`, `DEFAULT_ROLE_PERMISSIONS`, `can`, `canApproveMoney`, `MerchantIdentityPort`. The contract F3/W1–W7 import. Zero Shopify knowledge.
- Create `src/contract/merchant-identity-port.contract.ts` — `runMerchantIdentityPortContract(make)`: the ADR-0011 "identity port needs a contract test" (default-deny, tenant-scoping, no-escalation) every adapter must pass.
- Modify `src/index.ts` — barrel-export the new types + value functions.

**`packages/identity-shopify/` (the Shopify adapter — new package, all Shopify specifics):**
- Create `package.json`, `tsconfig.json` — mirror `packages/model-vertex`; deps `@palup/platform-ports` (workspace), devDeps `fastify`, `vitest`.
- Create `src/session-token.ts` — `verifyShopifySessionToken(...)`: HS256 JWT validation (structure, signature, `aud`, `exp`, `nbf`, `iss`/`dest` match + `*.myshopify.com`), returns claims + parsed `shopDomain` or a reason. Never throws.
- Create `src/jti-guard.ts` — `JtiReplayGuard` interface + `createInMemoryJtiGuard()`: single-use `jti` enforcement (ADR-0011 "single-use exchange"); TTL-bounded.
- Create `src/token-exchange.ts` — `exchangeSessionToken(...)`: the token-exchange POST, injected `fetch`, online `associated_user` parse. Never throws / never partial (returns `null`).
- Create `src/role-map.ts` — `mapShopifyRole(...)`: `account_owner ⇒ "owner"`, else least-privilege `"operator"`; an injected per-tenant override wins (ADR-0011 Dec 4 "editable in PalUp").
- Create `src/palup-session.ts` — `mintMerchantSession` / `verifyMerchantSession`: PalUp session token, typ-separated HMAC over `token-codec.ts`, carries `{merchantId, userId, role, authLevel, sid, exp}`.
- Create `src/identity.ts` — `createShopifyAppBridgeIdentity(deps)`: the factory satisfying `MerchantIdentityPort`; `authenticate` verifies a PalUp session; `establishSession` runs the full first-hit flow (validate → single-use → exchange → resolve tenant from `dest` via `MerchantRegistryPort` → map role → mint session → `MerchantPrincipal`).
- Create `src/fastify-plugin.ts` — `requireMerchant(port)`, `requirePermission(perm)` preHandlers (decorate `request.principal`; 401 anonymous / 403 forbidden), `shopifyEmbedFrameAncestors(shopDomain)` CSP helper.
- Create `src/index.ts` — barrel.
- Create `test/*.test.ts` — one per module + `contract.test.ts` wiring `runMerchantIdentityPortContract`.

---

## Interfaces (the pinned contract — F3 and W1–W7 import these verbatim)

```typescript
// packages/platform-ports/src/merchant-identity-port.ts

/** The 5 PalUp merchant-console RBAC roles (ADR-0011 §4). PalUp's own roles — mapped from the Shopify
 *  staff role / invite, editable in PalUp with audit. Ordered least → most privilege. NOTE: the 5 role
 *  NAMES are not enumerated in the source docs; this set is derived from the spec's signals
 *  (least-privilege "view + operate" default, owner+admin `can_approve_money`) — see Open Questions. */
export type MerchantRole = "viewer" | "operator" | "manager" | "admin" | "owner";

/** Session assurance level. Embedded App Bridge sessions are always "session" in v1. "elevated" is
 *  reserved for the DEFERRED passkey/SSO step-up path (IAM §1) — no embedded action mints it in v1. */
export type AuthLevel = "session" | "elevated";

/** The authenticated merchant-console principal (ADR-0011 §3). Consumed by F3 + every merchant-plane
 *  API. Every field derives from a VERIFIED credential, never from client input (ADR-0011 §1, IAM §9). */
export interface MerchantPrincipal {
  readonly kind: "merchant_user";
  /** PalUp tenant id, resolved from the verified `dest` shop domain via the merchant registry. */
  readonly merchantId: string;
  /** Stable per-store user id: the Shopify staff `sub` claim, namespaced `shopify:<merchantId>:<sub>`. */
  readonly userId: string;
  readonly role: MerchantRole;
  readonly authLevel: AuthLevel;
  /** PalUp session id (carries the Shopify `sid` lineage) — the handle a future revocation store keys on. */
  readonly sessionId: string;
}

/** Unauthenticated caller. `authenticate` NEVER throws; absent/invalid credential ⇒ this. */
export interface AnonymousPrincipal { readonly kind: "anonymous"; }

export type MerchantAuthResult = MerchantPrincipal | AnonymousPrincipal;

/** Console permissions (default-deny). Each merchant-plane route declares the permission it needs; the
 *  F3 middleware (the PDP, IAM §2) enforces it. `approve_money` is the distinct, owner+admin-default,
 *  delegable `can_approve_money` gate (ADR-0011 §4, spec W1/W7). */
export type Permission =
  | "console.view"     // read any console screen (W2/W5 read surfaces)
  | "agent.operate"    // trigger/queue reversible agent actions, respond in chat
  | "rules.edit"       // edit the Automation Rules money envelope (W4)
  | "learned.edit"     // teach / edit voice + learned config (W3)
  | "approve_money"    // approve a money/marketing/autonomy proposal (W1) — the can_approve_money gate
  | "team.manage"      // invite teammates, assign roles (W7)
  | "settings.edit"    // store/brand/residency/integrations (W7)
  | "billing.manage";  // plan/cap changes routed to Shopify (W6)

/** Default role → permission grants (ADR-0011 §4; least-privilege default, spec W7). A per-tenant
 *  override layer (W7, stored + audited) composes ON TOP of this at F3; F2 pins the defaults only. */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<MerchantRole, readonly Permission[]>>;

/** Pure default-deny check: does this principal hold `permission`? Anonymous ⇒ always false. */
export function can(principal: MerchantAuthResult, permission: Permission): boolean;

/** The W1 money gate. Sugar for `can(p, "approve_money")`. */
export function canApproveMoney(principal: MerchantAuthResult): boolean;

export interface MerchantIdentityPort {
  /** Verify an inbound PalUp session token → a principal. NEVER throws; absent/invalid ⇒ anonymous. */
  authenticate(credential: string | undefined): Promise<MerchantAuthResult>;
  /** Default-deny PDP: may this principal perform `permission`? Unknown/anonymous ⇒ false. */
  authorize(principal: MerchantAuthResult, permission: Permission): boolean;
}
```

```typescript
// packages/identity-shopify — adapter surface

export interface ShopifySessionClaims {
  iss: string; dest: string; aud: string; sub: string;
  exp: number; nbf: number; iat: number; jti: string; sid: string;
}
export type SessionVerifyResult =
  | { ok: true; claims: ShopifySessionClaims; shopDomain: string }  // shopDomain parsed from `dest`
  | { ok: false; reason: string };

/** HS256 JWT validation against the app client secret. Order: structure → signature → aud → exp → nbf
 *  → iss/dest host match + *.myshopify.com. Fails closed; never throws. `nowSec` injected for tests. */
export function verifyShopifySessionToken(args: {
  token: string | undefined;
  clientSecret: string | undefined;
  clientId: string;
  nowSec: number;
}): SessionVerifyResult;

/** Single-use `jti` guard (ADR-0011 "exchange is single-use"). Injected; in-memory now, a
 *  RuntimeStatePort/Postgres adapter later. */
export interface JtiReplayGuard {
  /** Record `jti` (with its exp for TTL cleanup). Returns false if already seen ⇒ reject the exchange. */
  useOnce(jti: string, expEpochSec: number): Promise<boolean>;
}
export function createInMemoryJtiGuard(nowSec?: () => number): JtiReplayGuard;

export interface AssociatedUser {
  id: string; accountOwner: boolean; collaborator: boolean; email?: string;
}
export type TokenExchangeResult = { accessToken: string; scope: string[]; associatedUser?: AssociatedUser };

export function exchangeSessionToken(
  args: { shopDomain: string; clientId: string; clientSecret: string; sessionToken: string;
          tokenType: "online" | "offline" },
  fetchFn: typeof fetch,
): Promise<TokenExchangeResult | null>;

/** Per-tenant role override source (ADR-0011 "editable in PalUp"). F3 backs it with the W7 team store;
 *  F2 defaults to none. Keyed by (merchantId, userId). */
export interface RoleOverrideSource {
  lookup(merchantId: string, userId: string): Promise<MerchantRole | undefined>;
}
export function mapShopifyRole(args: { associatedUser?: AssociatedUser; override?: MerchantRole }): MerchantRole;

export function mintMerchantSession(secret: string, p: {
  merchantId: string; userId: string; role: MerchantRole; authLevel: AuthLevel; sid: string;
}, ttlSeconds: number, nowSec?: number): string;
export function verifyMerchantSession(secret: string | undefined, token: string | undefined,
  nowSec?: number): MerchantPrincipal | AnonymousPrincipal;

export interface ShopifyIdentityDeps {
  clientId: string;
  secrets: SecretsPort;                 // app client secret + PalUp session secret, via the port
  registry: MerchantRegistryPort;       // tenant resolution from the verified `dest`
  jtiGuard: JtiReplayGuard;
  roleOverrides?: RoleOverrideSource;
  fetchFn?: typeof fetch;
  sessionTtlSeconds?: number;           // PalUp session TTL (default 1800)
  nowSec?: () => number;
}
export type EstablishResult =
  | { ok: true; principal: MerchantPrincipal; palupSessionToken: string }
  | { ok: false; reason: string };

/** The factory. `authenticate`/`authorize` satisfy MerchantIdentityPort; `establishSession` is the
 *  first-hit App Bridge exchange flow. */
export function createShopifyAppBridgeIdentity(
  deps: ShopifyIdentityDeps,
): MerchantIdentityPort & { establishSession(shopifySessionToken: string | undefined): Promise<EstablishResult> };
```

---

## Task 1: The port + RBAC model (pure, portable)

**Files:**
- Create: `packages/platform-ports/src/merchant-identity-port.ts`
- Modify: `packages/platform-ports/src/index.ts`
- Test: `packages/platform-ports/test/merchant-identity-port.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `MerchantRole`, `AuthLevel`, `MerchantPrincipal`, `AnonymousPrincipal`, `MerchantAuthResult`, `Permission`, `DEFAULT_ROLE_PERMISSIONS`, `can`, `canApproveMoney`, `MerchantIdentityPort` (exact signatures in the Interfaces block above).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/platform-ports/test/merchant-identity-port.test.ts
import { describe, it, expect } from "vitest";
import {
  can, canApproveMoney, DEFAULT_ROLE_PERMISSIONS,
  type MerchantPrincipal, type MerchantRole,
} from "../src/merchant-identity-port.js";

const P = (role: MerchantRole): MerchantPrincipal => ({
  kind: "merchant_user", merchantId: "acme", userId: "shopify:acme:1",
  role, authLevel: "session", sessionId: "sid1",
});

describe("merchant RBAC model", () => {
  it("owner + admin approve money; manager/operator/viewer do NOT (least-privilege default, spec W1/W7)", () => {
    expect(canApproveMoney(P("owner"))).toBe(true);
    expect(canApproveMoney(P("admin"))).toBe(true);
    expect(canApproveMoney(P("manager"))).toBe(false);
    expect(canApproveMoney(P("operator"))).toBe(false);
    expect(canApproveMoney(P("viewer"))).toBe(false);
  });

  it("invited-teammate default (operator) = view + operate, nothing else (spec W7)", () => {
    expect(can(P("operator"), "console.view")).toBe(true);
    expect(can(P("operator"), "agent.operate")).toBe(true);
    expect(can(P("operator"), "rules.edit")).toBe(false);
    expect(can(P("operator"), "approve_money")).toBe(false);
    expect(can(P("operator"), "settings.edit")).toBe(false);
  });

  it("viewer is read-only; manager can edit rules+learned but not money/team/billing", () => {
    expect(can(P("viewer"), "console.view")).toBe(true);
    expect(can(P("viewer"), "agent.operate")).toBe(false);
    expect(can(P("manager"), "rules.edit")).toBe(true);
    expect(can(P("manager"), "learned.edit")).toBe(true);
    expect(can(P("manager"), "team.manage")).toBe(false);
    expect(can(P("manager"), "billing.manage")).toBe(false);
  });

  it("only owner manages billing (plan/cap → Shopify, W6)", () => {
    expect(can(P("owner"), "billing.manage")).toBe(true);
    expect(can(P("admin"), "billing.manage")).toBe(false);
  });

  it("default-deny for anonymous — every permission is false", () => {
    const anon = { kind: "anonymous" } as const;
    for (const perm of ["console.view", "agent.operate", "approve_money", "billing.manage"] as const) {
      expect(can(anon, perm)).toBe(false);
    }
    expect(canApproveMoney(anon)).toBe(false);
  });

  it("permission sets are monotonic up the role ladder (no privilege inversion)", () => {
    const ladder: MerchantRole[] = ["viewer", "operator", "manager", "admin", "owner"];
    for (let i = 1; i < ladder.length; i++) {
      const lower = new Set(DEFAULT_ROLE_PERMISSIONS[ladder[i - 1]]);
      const higher = new Set(DEFAULT_ROLE_PERMISSIONS[ladder[i]]);
      for (const p of lower) expect(higher.has(p)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/platform-ports/test/merchant-identity-port.test.ts`
Expected: FAIL — "Cannot find module '../src/merchant-identity-port.js'".

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/platform-ports/src/merchant-identity-port.ts
// Merchant-console identity contract (ADR-0011 / IAM §8). DISTINCT from the storefront/operator
// `Principal` union in identity-port.ts: that `merchant` variant is a STOREFRONT TENANT (no user, no
// role); this is a console USER carrying a role + authLevel — the two planes must not be conflated
// (spec §4). Pure types + pure decision functions; ZERO Shopify knowledge (the adapter owns that).

export type MerchantRole = "viewer" | "operator" | "manager" | "admin" | "owner";
export type AuthLevel = "session" | "elevated";

export interface MerchantPrincipal {
  readonly kind: "merchant_user";
  readonly merchantId: string;
  readonly userId: string;
  readonly role: MerchantRole;
  readonly authLevel: AuthLevel;
  readonly sessionId: string;
}
export interface AnonymousPrincipal { readonly kind: "anonymous"; }
export type MerchantAuthResult = MerchantPrincipal | AnonymousPrincipal;

export type Permission =
  | "console.view" | "agent.operate" | "rules.edit" | "learned.edit"
  | "approve_money" | "team.manage" | "settings.edit" | "billing.manage";

// Least-privilege default (spec W7). `operator` is the invited-teammate default (view + operate, no
// money). `approve_money` is owner+admin only (spec W1/§10). Grants are additive up the ladder.
const VIEWER: readonly Permission[] = ["console.view"];
const OPERATOR: readonly Permission[] = [...VIEWER, "agent.operate"];
const MANAGER: readonly Permission[] = [...OPERATOR, "rules.edit", "learned.edit"];
const ADMIN: readonly Permission[] = [...MANAGER, "approve_money", "team.manage", "settings.edit"];
const OWNER: readonly Permission[] = [...ADMIN, "billing.manage"];

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<MerchantRole, readonly Permission[]>> = {
  viewer: VIEWER, operator: OPERATOR, manager: MANAGER, admin: ADMIN, owner: OWNER,
};

export function can(principal: MerchantAuthResult, permission: Permission): boolean {
  if (principal.kind !== "merchant_user") return false; // default-deny: anonymous ⇒ false
  return DEFAULT_ROLE_PERMISSIONS[principal.role].includes(permission);
}
export function canApproveMoney(principal: MerchantAuthResult): boolean {
  return can(principal, "approve_money");
}

export interface MerchantIdentityPort {
  authenticate(credential: string | undefined): Promise<MerchantAuthResult>;
  authorize(principal: MerchantAuthResult, permission: Permission): boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/platform-ports/test/merchant-identity-port.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add barrel exports**

In `packages/platform-ports/src/index.ts`, after the existing `identity-port.js` export line, add:

```typescript
export type {
  MerchantIdentityPort, MerchantPrincipal, AnonymousPrincipal, MerchantAuthResult,
  MerchantRole, AuthLevel, Permission,
} from "./merchant-identity-port.js";
export { DEFAULT_ROLE_PERMISSIONS, can, canApproveMoney } from "./merchant-identity-port.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/platform-ports/src/merchant-identity-port.ts packages/platform-ports/src/index.ts packages/platform-ports/test/merchant-identity-port.test.ts
git commit -m "feat(identity): F2 merchant-console principal + 5-role RBAC model (ADR-0011)"
```

---

## Task 2: Adapter package scaffold + session-token JWT validation

**Files:**
- Create: `packages/identity-shopify/package.json`, `packages/identity-shopify/tsconfig.json`
- Create: `packages/identity-shopify/src/session-token.ts`
- Test: `packages/identity-shopify/test/session-token.test.ts`

**Interfaces:**
- Consumes: `token-codec.ts` (`hmacSign`, `b64urlDecode`) via `@palup/platform-ports` internals — import the raw HMAC by re-implementing HS256 with `node:crypto` directly here (the session token is HS256 hex/JWT-base64url, not the PalUp codec's format), so this module uses `node:crypto` `createHmac`.
- Produces: `ShopifySessionClaims`, `SessionVerifyResult`, `verifyShopifySessionToken` (see Interfaces block).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/identity-shopify/test/session-token.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifySessionToken } from "../src/session-token.js";

const SECRET = "app-client-secret";
const CLIENT_ID = "client-id-123";
const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sign = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function tokenWith(overrides: Record<string, unknown> = {}, secret = SECRET): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const claims = {
    iss: "https://acme.myshopify.com/admin", dest: "https://acme.myshopify.com",
    aud: CLIENT_ID, sub: "42", exp: 2000, nbf: 500, iat: 500,
    jti: "f8912129-1af6-4cad-9ca3-76b0f7621087", sid: "sess-abc", ...overrides,
  };
  const body = `${header}.${b64url(claims)}`;
  const sig = createHmac("sha256", secret).update(body).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${sig}`;
}
const base = { clientSecret: SECRET, clientId: CLIENT_ID, nowSec: 1000 };

describe("verifyShopifySessionToken", () => {
  it("accepts a valid token and parses the shop domain from dest", () => {
    const r = verifyShopifySessionToken({ token: tokenWith(), ...base });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.shopDomain).toBe("acme.myshopify.com"); expect(r.claims.sub).toBe("42"); }
  });
  it("rejects a tampered signature", () => {
    const good = tokenWith();
    const tampered = good.slice(0, -2) + (good.endsWith("aa") ? "bb" : "aa");
    expect(verifyShopifySessionToken({ token: tampered, ...base }).ok).toBe(false);
  });
  it("rejects a token signed with the wrong secret", () => {
    expect(verifyShopifySessionToken({ token: tokenWith({}, "wrong"), ...base }).ok).toBe(false);
  });
  it("rejects an expired token (exp in the past)", () => {
    expect(verifyShopifySessionToken({ token: tokenWith({ exp: 900 }), ...base }).ok).toBe(false);
  });
  it("rejects a not-yet-valid token (nbf in the future)", () => {
    expect(verifyShopifySessionToken({ token: tokenWith({ nbf: 1500 }), ...base }).ok).toBe(false);
  });
  it("rejects a wrong audience (token minted for another app)", () => {
    expect(verifyShopifySessionToken({ token: tokenWith({ aud: "other-app" }), ...base }).ok).toBe(false);
  });
  it("rejects when iss and dest hosts disagree (cross-shop stitching)", () => {
    const r = verifyShopifySessionToken({ token: tokenWith({ iss: "https://evil.myshopify.com/admin" }), ...base });
    expect(r.ok).toBe(false);
  });
  it("rejects a non-*.myshopify.com dest host", () => {
    const r = verifyShopifySessionToken({
      token: tokenWith({ iss: "https://acme.evil.test/admin", dest: "https://acme.evil.test" }), ...base });
    expect(r.ok).toBe(false);
  });
  it("fails closed on missing token / unconfigured secret / malformed JWT", () => {
    expect(verifyShopifySessionToken({ token: undefined, ...base }).ok).toBe(false);
    expect(verifyShopifySessionToken({ token: tokenWith(), clientSecret: undefined, clientId: CLIENT_ID, nowSec: 1000 }).ok).toBe(false);
    expect(verifyShopifySessionToken({ token: "not.a.jwt.at.all", ...base }).ok).toBe(false);
    expect(verifyShopifySessionToken({ token: "onlyonesegment", ...base }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/identity-shopify/test/session-token.test.ts`
Expected: FAIL — package/module not found.

- [ ] **Step 3: Write the scaffold + implementation**

`packages/identity-shopify/package.json`:
```json
{
  "name": "@palup/identity-shopify",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@palup/platform-ports": "workspace:*" },
  "devDependencies": { "fastify": "^4.0.0", "vitest": "^1.0.0" }
}
```
(Match the `fastify`/`vitest` versions already resolved in the workspace root lockfile — read `packages/widget-backend/package.json` for the exact `fastify` version and reuse it; do not introduce a new major.)

`packages/identity-shopify/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../platform-ports/tsconfig.json" }]
}
```

`packages/identity-shopify/src/session-token.ts`:
```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify App Bridge SESSION TOKEN (ID token) validator — a NAMED Shopify adapter behind the portable
// merchant-identity port (ADR-0001). node:crypto only, NO Shopify SDK (parity with
// shopify-install-identity.ts). PRIMARY SOURCE (retrieved 2026-08-23): shopify.dev "Session tokens" /
// "ID token claims" + "Token exchange". HS256 signed with the app client secret; claims iss/dest/aud/
// sub/exp/nbf/iat/jti/sid. Validation (verbatim): signature (HS256, client secret); exp future; nbf
// past; aud === client id; iss & dest hosts must match; else reject. Fails CLOSED, never throws (a bad
// token is an unauthenticated request, and an exception would be an error-message oracle).
//
// NOT VERIFIED: no golden token captured from a live App Bridge session yet — this checks our reading
// of the spec for internal consistency; a real (secret, token) pair is still required before go-live
// (same caveat shopify-install-identity.ts records for install HMACs).

export interface ShopifySessionClaims {
  iss: string; dest: string; aud: string; sub: string;
  exp: number; nbf: number; iat: number; jti: string; sid: string;
}
export type SessionVerifyResult =
  | { ok: true; claims: ShopifySessionClaims; shopDomain: string }
  | { ok: false; reason: string };

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i; // byte-identical to shopify-install-identity.ts

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function hs256(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function ctEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
/** Host from `https://<host>[/...]`; undefined if not an https URL. */
function hostOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try { const u = new URL(v); return u.protocol === "https:" ? u.host.toLowerCase() : undefined; }
  catch { return undefined; }
}

export function verifyShopifySessionToken(args: {
  token: string | undefined; clientSecret: string | undefined; clientId: string; nowSec: number;
}): SessionVerifyResult {
  const { token, clientSecret, clientId, nowSec } = args;
  if (!clientSecret) return { ok: false, reason: "app client secret not configured (fail-closed)" };
  if (!token) return { ok: false, reason: "session token required" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed session token (want 3 JWT segments)" };
  const [h, p, sig] = parts;
  // Signature BEFORE parsing/trusting the payload.
  if (!ctEqual(sig, hs256(clientSecret, `${h}.${p}`))) return { ok: false, reason: "bad session-token signature" };
  let raw: Partial<ShopifySessionClaims>;
  try { raw = JSON.parse(b64urlDecode(p).toString("utf8")); }
  catch { return { ok: false, reason: "unparseable session-token payload" }; }
  if (raw.aud !== clientId) return { ok: false, reason: "aud mismatch (token minted for another app)" };
  if (typeof raw.exp !== "number" || raw.exp <= nowSec) return { ok: false, reason: "session token expired" };
  if (typeof raw.nbf !== "number" || raw.nbf > nowSec) return { ok: false, reason: "session token not yet valid" };
  const issHost = hostOf(raw.iss), destHost = hostOf(raw.dest);
  if (!issHost || !destHost || issHost !== destHost) return { ok: false, reason: "iss/dest host mismatch" };
  if (!SHOP_HOST.test(destHost)) return { ok: false, reason: "dest is not a *.myshopify.com host" };
  if (typeof raw.sub !== "string" || !raw.sub) return { ok: false, reason: "missing sub" };
  if (typeof raw.jti !== "string" || !raw.jti) return { ok: false, reason: "missing jti" };
  if (typeof raw.sid !== "string" || !raw.sid) return { ok: false, reason: "missing sid" };
  return { ok: true, claims: raw as ShopifySessionClaims, shopDomain: destHost };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/identity-shopify/test/session-token.test.ts`
Expected: PASS (9 tests). If pnpm cannot resolve the new workspace package, run `pnpm install` once first to link it.

- [ ] **Step 5: Commit**

```bash
git add packages/identity-shopify/package.json packages/identity-shopify/tsconfig.json packages/identity-shopify/src/session-token.ts packages/identity-shopify/test/session-token.test.ts
git commit -m "feat(identity): F2 Shopify App Bridge session-token JWT validation (sig/aud/exp/nbf/iss-dest)"
```

---

## Task 3: Single-use `jti` replay guard

**Files:**
- Create: `packages/identity-shopify/src/jti-guard.ts`
- Test: `packages/identity-shopify/test/jti-guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JtiReplayGuard`, `createInMemoryJtiGuard` (see Interfaces block).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/identity-shopify/test/jti-guard.test.ts
import { describe, it, expect } from "vitest";
import { createInMemoryJtiGuard } from "../src/jti-guard.js";

describe("createInMemoryJtiGuard (single-use exchange, ADR-0011)", () => {
  it("accepts a jti once and rejects its replay", async () => {
    const g = createInMemoryJtiGuard(() => 1000);
    expect(await g.useOnce("jti-1", 2000)).toBe(true);
    expect(await g.useOnce("jti-1", 2000)).toBe(false); // replay within window ⇒ rejected
  });
  it("distinct jtis are independent", async () => {
    const g = createInMemoryJtiGuard(() => 1000);
    expect(await g.useOnce("a", 2000)).toBe(true);
    expect(await g.useOnce("b", 2000)).toBe(true);
  });
  it("prunes expired entries so memory does not grow unbounded", async () => {
    let now = 1000;
    const g = createInMemoryJtiGuard(() => now);
    expect(await g.useOnce("old", 1100)).toBe(true);
    now = 5000; // "old" has expired; a fresh, different jti still works and the store stays small
    expect(await g.useOnce("new", 6000)).toBe(true);
    // Reusing an EXPIRED jti is still refused if within store — but once pruned a re-mint is impossible
    // anyway (Shopify never reissues a jti); the invariant that matters is unbounded-growth prevention.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/identity-shopify/test/jti-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/identity-shopify/src/jti-guard.ts
// Single-use enforcement for the session-token `jti` (ADR-0011 "the exchange is single-use"). A
// validly-signed session token, if captured, must not be exchangeable twice inside its short lifetime.
// In-memory now; a RuntimeStatePort/Postgres adapter (durable, multi-instance) later behind this SAME
// interface. Prunes on write, keyed by exp, so a busy service does not accumulate dead jtis.

export interface JtiReplayGuard {
  useOnce(jti: string, expEpochSec: number): Promise<boolean>;
}

export function createInMemoryJtiGuard(nowSec: () => number = () => Math.floor(Date.now() / 1000)): JtiReplayGuard {
  const seen = new Map<string, number>(); // jti -> exp
  return {
    async useOnce(jti, expEpochSec) {
      const now = nowSec();
      for (const [k, exp] of seen) if (exp <= now) seen.delete(k); // prune expired
      if (!jti) return false;                 // an empty jti is never single-use-safe → refuse
      if (seen.has(jti)) return false;        // replay
      seen.set(jti, expEpochSec);
      return true;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/identity-shopify/test/jti-guard.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/identity-shopify/src/jti-guard.ts packages/identity-shopify/test/jti-guard.test.ts
git commit -m "feat(identity): F2 single-use jti replay guard for session-token exchange"
```

---

## Task 4: Token-exchange call

**Files:**
- Create: `packages/identity-shopify/src/token-exchange.ts`
- Test: `packages/identity-shopify/test/token-exchange.test.ts`

**Interfaces:**
- Consumes: nothing (injected `fetch`).
- Produces: `AssociatedUser`, `TokenExchangeResult`, `exchangeSessionToken` (see Interfaces block).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/identity-shopify/test/token-exchange.test.ts
import { describe, it, expect, vi } from "vitest";
import { exchangeSessionToken } from "../src/token-exchange.js";

const ARGS = {
  shopDomain: "acme.myshopify.com", clientId: "client-id-123", clientSecret: "secret",
  sessionToken: "sess.tok.en", tokenType: "online" as const,
};

function fetchOk(json: unknown) {
  return vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true, json: async () => json, __init: init,
  })) as unknown as typeof fetch;
}

describe("exchangeSessionToken", () => {
  it("POSTs the documented token-exchange grant to the shop's oauth endpoint", async () => {
    const f = fetchOk({ access_token: "at", scope: "read_orders,read_products",
      associated_user: { id: 42, account_owner: true, collaborator: false, email: "o@acme.test" } });
    await exchangeSessionToken(ARGS, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://acme.myshopify.com/admin/oauth/access_token");
    expect((init as RequestInit).method).toBe("POST");
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange");
    expect(body).toContain("subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token");
    expect(body).toContain("requested_token_type=urn%3Ashopify%3Aparams%3Aoauth%3Atoken-type%3Aonline-access-token");
    expect(body).toContain("subject_token=sess.tok.en");
    expect(body).toContain("client_id=client-id-123");
  });
  it("parses associated_user for the role bootstrap (online token)", async () => {
    const f = fetchOk({ access_token: "at", scope: "read_orders",
      associated_user: { id: 42, account_owner: true, collaborator: false, email: "o@acme.test" } });
    const r = await exchangeSessionToken(ARGS, f);
    expect(r?.accessToken).toBe("at");
    expect(r?.scope).toEqual(["read_orders"]);
    expect(r?.associatedUser).toEqual({ id: "42", accountOwner: true, collaborator: false, email: "o@acme.test" });
  });
  it("returns null on a non-2xx / missing access_token (never throws)", async () => {
    const bad = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await exchangeSessionToken(ARGS, bad)).toBeNull();
    const empty = fetchOk({ scope: "x" });
    expect(await exchangeSessionToken(ARGS, empty)).toBeNull();
  });
  it("refuses a non-myshopify host WITHOUT calling fetch (no secret egress)", async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(await exchangeSessionToken({ ...ARGS, shopDomain: "acme.evil.test" }, f)).toBeNull();
    expect((f as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
  it("swallows a transport throw into null (no code/secret leak upward)", async () => {
    const f = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    expect(await exchangeSessionToken(ARGS, f)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/identity-shopify/test/token-exchange.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/identity-shopify/src/token-exchange.ts
// Shopify OAuth 2.0 TOKEN EXCHANGE (RFC 8693 profile). PRIMARY SOURCE (retrieved 2026-08-23):
// shopify.dev "Token exchange". POST https://{shop}/admin/oauth/access_token, x-www-form-urlencoded.
// Requests an ONLINE token so the response carries `associated_user` (the role bootstrap, ADR-0011 §4).
// NEVER throws / NEVER returns a partial value — every refusal is `null` (same leak-boundary posture as
// shopify-install-identity.ts:exchangeInstallCode: client_secret + session token + access_token all
// pass through here, and an exception would carry them into an attacker-reachable response). Nothing logs.

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const REQUESTED = {
  online: "urn:shopify:params:oauth:token-type:online-access-token",
  offline: "urn:shopify:params:oauth:token-type:offline-access-token",
} as const;

export interface AssociatedUser { id: string; accountOwner: boolean; collaborator: boolean; email?: string; }
export type TokenExchangeResult = { accessToken: string; scope: string[]; associatedUser?: AssociatedUser };

export async function exchangeSessionToken(
  args: { shopDomain: string; clientId: string; clientSecret: string; sessionToken: string;
          tokenType: "online" | "offline" },
  fetchFn: typeof fetch,
): Promise<TokenExchangeResult | null> {
  try {
    if (!SHOP_HOST.test(args.shopDomain)) return null; // never POST the secret to an unrecognised host
    if (!args.clientId || !args.clientSecret || !args.sessionToken) return null;
    const body = new URLSearchParams({
      client_id: args.clientId, client_secret: args.clientSecret, grant_type: GRANT,
      subject_token: args.sessionToken, subject_token_type: SUBJECT_TYPE,
      requested_token_type: REQUESTED[args.tokenType],
    });
    const res = await fetchFn(`https://${args.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: unknown; scope?: unknown;
      associated_user?: { id?: unknown; account_owner?: unknown; collaborator?: unknown; email?: unknown } | null;
    } | null;
    const accessToken = typeof json?.access_token === "string" ? json.access_token : "";
    if (!accessToken) return null;
    const scope = typeof json?.scope === "string" ? json.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
    let associatedUser: AssociatedUser | undefined;
    const au = json?.associated_user;
    if (au && (typeof au.id === "string" || typeof au.id === "number")) {
      associatedUser = {
        id: String(au.id), accountOwner: au.account_owner === true, collaborator: au.collaborator === true,
        email: typeof au.email === "string" ? au.email : undefined,
      };
    }
    return { accessToken, scope, associatedUser };
  } catch {
    return null; // a transport fault is a refusal, never an exception carrying the secret upward
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/identity-shopify/test/token-exchange.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/identity-shopify/src/token-exchange.ts packages/identity-shopify/test/token-exchange.test.ts
git commit -m "feat(identity): F2 Shopify token-exchange (online grant, associated_user role bootstrap)"
```

---

## Task 5: Shopify → PalUp role mapping

**Files:**
- Create: `packages/identity-shopify/src/role-map.ts`
- Test: `packages/identity-shopify/test/role-map.test.ts`

**Interfaces:**
- Consumes: `AssociatedUser` (Task 4), `MerchantRole`, `RoleOverrideSource` (defined here; see Interfaces block).
- Produces: `RoleOverrideSource`, `mapShopifyRole`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/identity-shopify/test/role-map.test.ts
import { describe, it, expect } from "vitest";
import { mapShopifyRole } from "../src/role-map.js";

describe("mapShopifyRole (ADR-0011 §4: PalUp's role, mapped from Shopify, editable in PalUp)", () => {
  it("Shopify store owner bootstraps to PalUp 'owner'", () => {
    expect(mapShopifyRole({ associatedUser: { id: "1", accountOwner: true, collaborator: false } })).toBe("owner");
  });
  it("a non-owner staff/collaborator bootstraps to least-privilege 'operator' (spec W7)", () => {
    expect(mapShopifyRole({ associatedUser: { id: "2", accountOwner: false, collaborator: true } })).toBe("operator");
    expect(mapShopifyRole({ associatedUser: { id: "3", accountOwner: false, collaborator: false } })).toBe("operator");
  });
  it("no associated_user (offline token) also defaults to least-privilege, never owner", () => {
    expect(mapShopifyRole({})).toBe("operator");
  });
  it("a PalUp-side override WINS over the Shopify bootstrap (editable in PalUp with audit)", () => {
    expect(mapShopifyRole({ associatedUser: { id: "1", accountOwner: true, collaborator: false }, override: "viewer" }))
      .toBe("viewer");
    expect(mapShopifyRole({ associatedUser: { id: "2", accountOwner: false, collaborator: false }, override: "admin" }))
      .toBe("admin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/identity-shopify/test/role-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/identity-shopify/src/role-map.ts
// Map a Shopify staff identity → a PalUp merchant role (ADR-0011 §4). PalUp NEVER inherits Shopify
// permissions wholesale: the bootstrap is deliberately conservative — the store OWNER seeds to `owner`,
// EVERYONE else (staff, collaborator, or an offline token with no associated_user) seeds to the
// least-privilege `operator` (spec W7), and the merchant elevates from there in W7. A stored per-tenant
// override (the W7 team table, injected via RoleOverrideSource) always WINS — that is the "editable in
// PalUp with audit" half of Decision 4.
import type { MerchantRole } from "@palup/platform-ports";
import type { AssociatedUser } from "./token-exchange.js";

export interface RoleOverrideSource {
  lookup(merchantId: string, userId: string): Promise<MerchantRole | undefined>;
}

export function mapShopifyRole(args: { associatedUser?: AssociatedUser; override?: MerchantRole }): MerchantRole {
  if (args.override) return args.override;                       // PalUp-side assignment wins
  if (args.associatedUser?.accountOwner === true) return "owner";
  return "operator";                                            // least-privilege default (never owner)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/identity-shopify/test/role-map.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/identity-shopify/src/role-map.ts packages/identity-shopify/test/role-map.test.ts
git commit -m "feat(identity): F2 Shopify->PalUp role map (owner bootstrap, least-privilege default, override wins)"
```

---

## Task 6: PalUp session token mint/verify (typ-separated HMAC)

**Files:**
- Create: `packages/identity-shopify/src/palup-session.ts`
- Test: `packages/identity-shopify/test/palup-session.test.ts`

**Interfaces:**
- Consumes: `token-codec.ts` (`b64url`, `b64urlDecode`, `hmacSign`, `constantTimeEqual`) — re-exported from `@palup/platform-ports`? They are NOT currently barrel-exported. Add `export { b64url, b64urlDecode, hmacSign, constantTimeEqual } from "./token-codec.js";` to `packages/platform-ports/src/index.ts` in this task's Step 3, then import from `@palup/platform-ports`. `MerchantPrincipal`, `AnonymousPrincipal`, `MerchantRole`, `AuthLevel` from `@palup/platform-ports`.
- Produces: `mintMerchantSession`, `verifyMerchantSession` (see Interfaces block).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/identity-shopify/test/palup-session.test.ts
import { describe, it, expect } from "vitest";
import { mintMerchantSession, verifyMerchantSession } from "../src/palup-session.js";
import { mintWidgetToken } from "@palup/platform-ports";

const SECRET = "palup-session-secret";
const claims = { merchantId: "acme", userId: "shopify:acme:42", role: "owner" as const,
  authLevel: "session" as const, sid: "sess-abc" };

describe("PalUp merchant session token", () => {
  it("round-trips a principal (mint → verify)", () => {
    const t = mintMerchantSession(SECRET, claims, 1800, 1000);
    const p = verifyMerchantSession(SECRET, t, 1100);
    expect(p.kind).toBe("merchant_user");
    if (p.kind === "merchant_user") {
      expect(p.merchantId).toBe("acme"); expect(p.role).toBe("owner");
      expect(p.userId).toBe("shopify:acme:42"); expect(p.sessionId).toBe("sess-abc");
      expect(p.authLevel).toBe("session");
    }
  });
  it("anonymous on tamper, wrong secret, or expiry (fail closed, never throws)", () => {
    const t = mintMerchantSession(SECRET, claims, 1800, 1000);
    expect(verifyMerchantSession(SECRET, t.slice(0, -2) + "zz", 1100).kind).toBe("anonymous");
    expect(verifyMerchantSession("other", t, 1100).kind).toBe("anonymous");
    expect(verifyMerchantSession(SECRET, t, 5000).kind).toBe("anonymous"); // exp 1000+1800=2800 < 5000
    expect(verifyMerchantSession(undefined, t, 1100).kind).toBe("anonymous");
    expect(verifyMerchantSession(SECRET, undefined, 1100).kind).toBe("anonymous");
  });
  it("REJECTS a widget token presented as a merchant session (typ separation, ADR-0017 F1 parity)", () => {
    const widget = mintWidgetToken(SECRET, "acme", 3600); // same secret, different typ
    expect(verifyMerchantSession(SECRET, widget, 1100).kind).toBe("anonymous");
  });
  it("REJECTS an unknown role value (a forged token cannot smuggle a non-RBAC role)", () => {
    // hand-mint a token with role:"superadmin" using the shared codec, same secret
    // (the verifier must whitelist the 5 roles)
    const t = mintMerchantSession(SECRET, { ...claims, role: "superadmin" as never }, 1800, 1000);
    expect(verifyMerchantSession(SECRET, t, 1100).kind).toBe("anonymous");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/identity-shopify/test/palup-session.test.ts`
Expected: FAIL — module not found (and, after Step 3 code exists, the codec re-exports must be present).

- [ ] **Step 3: Write minimal implementation**

First add the codec re-exports to `packages/platform-ports/src/index.ts`:
```typescript
export { b64url, b64urlDecode, hmacSign, constantTimeEqual } from "./token-codec.js";
```

Then `packages/identity-shopify/src/palup-session.ts`:
```typescript
import { b64url, b64urlDecode, hmacSign, constantTimeEqual } from "@palup/platform-ports";
import type { MerchantPrincipal, AnonymousPrincipal, MerchantRole, AuthLevel } from "@palup/platform-ports";

// The PalUp SESSION token (ADR-0011 Dec 1: "a PalUp session scoped to that merchant_id + user + role").
// Minted once, after a validated single-use session-token exchange; presented on every SUBSEQUENT
// console request so we never re-exchange. Domain-separated by a mandatory `typ` (ADR-0017 F1): a widget
// or shopper token signed with the same secret can NEVER verify here, and vice versa. HMAC-SHA256 over
// the shared codec — no external JWT lib (portable). Short TTL; the full revocation store (sign-out-all,
// refresh rotation) is DEFERRED (spec §3) — a token simply expires. Fails closed to `anonymous`.
//
// NOTE: this token embeds `role`. A W7 role CHANGE takes full effect at the next mint (≤ TTL); F3 may
// force an earlier re-mint on a role-change event. The short TTL bounds the staleness window.

const TYP = "palup-merchant-session";
const ROLES: ReadonlySet<string> = new Set(["viewer", "operator", "manager", "admin", "owner"]);
const anon: AnonymousPrincipal = { kind: "anonymous" };

interface SessionClaims { typ: string; m: string; u: string; r: MerchantRole; al: AuthLevel; sid: string; exp: number; }

export function mintMerchantSession(
  secret: string,
  p: { merchantId: string; userId: string; role: MerchantRole; authLevel: AuthLevel; sid: string },
  ttlSeconds: number, nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const claims: SessionClaims = {
    typ: TYP, m: p.merchantId, u: p.userId, r: p.role, al: p.authLevel, sid: p.sid, exp: nowSec + ttlSeconds,
  };
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  return `${body}.${hmacSign(secret, body)}`;
}

export function verifyMerchantSession(
  secret: string | undefined, token: string | undefined, nowSec: number = Math.floor(Date.now() / 1000),
): MerchantPrincipal | AnonymousPrincipal {
  if (!secret || !token) return anon;
  const dot = token.indexOf(".");
  if (dot <= 0) return anon;
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!constantTimeEqual(sig, hmacSign(secret, body))) return anon;
  try {
    const c = JSON.parse(b64urlDecode(body).toString("utf8")) as Partial<SessionClaims>;
    if (c.typ !== TYP) return anon;                          // typ separation
    if (typeof c.exp !== "number" || c.exp <= nowSec) return anon;
    if (typeof c.m !== "string" || !c.m) return anon;
    if (typeof c.u !== "string" || !c.u) return anon;
    if (typeof c.sid !== "string" || !c.sid) return anon;
    if (typeof c.r !== "string" || !ROLES.has(c.r)) return anon; // forged/unknown role ⇒ anonymous
    if (c.al !== "session" && c.al !== "elevated") return anon;
    return { kind: "merchant_user", merchantId: c.m, userId: c.u, role: c.r as MerchantRole,
             authLevel: c.al, sessionId: c.sid };
  } catch { return anon; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/identity-shopify/test/palup-session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/platform-ports/src/index.ts packages/identity-shopify/src/palup-session.ts packages/identity-shopify/test/palup-session.test.ts
git commit -m "feat(identity): F2 PalUp merchant session token (typ-separated HMAC, role whitelist)"
```

---

## Task 7: The `createShopifyAppBridgeIdentity` factory (establishSession + authenticate)

**Files:**
- Create: `packages/identity-shopify/src/identity.ts`
- Test: `packages/identity-shopify/test/identity.test.ts`

**Interfaces:**
- Consumes: `verifyShopifySessionToken` (T2), `JtiReplayGuard`/`createInMemoryJtiGuard` (T3), `exchangeSessionToken`/`AssociatedUser` (T4), `mapShopifyRole`/`RoleOverrideSource` (T5), `mintMerchantSession`/`verifyMerchantSession` (T6), and from `@palup/platform-ports`: `MerchantIdentityPort`, `MerchantPrincipal`, `MerchantAuthResult`, `Permission`, `can`, `SecretsPort`, `MerchantRegistryPort`, `buildShopifyShopperId` (reused to namespace the userId), `SHOPIFY_APP_SECRET_SCOPE`/`SHOPIFY_APP_CLIENT_SECRET_NAME` — NOTE those two live in `widget-backend/src/shopify-install-identity.ts`, not platform-ports; re-declare the two string constants locally in the adapter (they are app-wide config names, not logic) OR import from widget-backend. Prefer re-declaring to avoid a service→adapter dependency; add a comment cross-referencing the source.
- Produces: `ShopifyIdentityDeps`, `EstablishResult`, `createShopifyAppBridgeIdentity` (see Interfaces block).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/identity-shopify/test/identity.test.ts
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createShopifyAppBridgeIdentity } from "../src/identity.js";
import { createInMemoryJtiGuard } from "../src/jti-guard.js";
import { can } from "@palup/platform-ports";
import type { SecretsPort, MerchantRegistryPort, MerchantRecord } from "@palup/platform-ports";

const CLIENT_ID = "client-id-123";
const APP_SECRET = "app-secret";
const SESSION_SECRET = "palup-session-secret";
const SCOPE = "__shopify_app__";               // SHOPIFY_APP_SECRET_SCOPE
const APP_SECRET_NAME = "shopify_app_client_secret";
const SESSION_SECRET_NAME = "palup_merchant_session_secret";

const secrets: SecretsPort = {
  async get(tenant, name) {
    if (tenant === SCOPE && name === APP_SECRET_NAME) return APP_SECRET;
    if (tenant === SCOPE && name === SESSION_SECRET_NAME) return SESSION_SECRET;
    return undefined;
  },
};
const acme: MerchantRecord = {
  tenantId: "acme", shopDomain: "acme.myshopify.com", embedKey: "ek", status: "active",
  region: "us", groundingMode: "full", createdAt: "t", updatedAt: "t",
};
function registryWith(rec: MerchantRecord | null): MerchantRegistryPort {
  return {
    lookupByShopDomain: async () => rec, lookupByTenantId: async () => rec, lookupByEmbedKey: async () => rec,
    create: async () => acme, setStatus: async () => acme, update: async () => acme,
  } as unknown as MerchantRegistryPort;
}
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function sessionToken(over: Record<string, unknown> = {}): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = `${header}.${b64url({ iss: "https://acme.myshopify.com/admin", dest: "https://acme.myshopify.com",
    aud: CLIENT_ID, sub: "42", exp: 2000, nbf: 500, iat: 500, jti: "jti-xyz", sid: "sess-abc", ...over })}`;
  const sig = createHmac("sha256", APP_SECRET).update(body).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${body}.${sig}`;
}
function exchangeOk(accountOwner: boolean) {
  return vi.fn(async () => ({ ok: true, json: async () => ({
    access_token: "at", scope: "read_orders",
    associated_user: { id: 42, account_owner: accountOwner, collaborator: false, email: "u@acme.test" },
  }) })) as unknown as typeof fetch;
}
const deps = (over: Partial<Parameters<typeof createShopifyAppBridgeIdentity>[0]> = {}) =>
  createShopifyAppBridgeIdentity({
    clientId: CLIENT_ID, secrets, registry: registryWith(acme), jtiGuard: createInMemoryJtiGuard(() => 1000),
    fetchFn: exchangeOk(true), nowSec: () => 1000, ...over,
  });

describe("createShopifyAppBridgeIdentity.establishSession", () => {
  it("validates → exchanges → binds tenant from dest → maps role → mints a session (owner)", async () => {
    const id = deps();
    const r = await id.establishSession(sessionToken());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal.merchantId).toBe("acme");            // from VERIFIED dest, resolved via registry
      expect(r.principal.userId).toBe("shopify:acme:42");     // namespaced sub
      expect(r.principal.role).toBe("owner");                 // account_owner ⇒ owner
      expect(r.principal.authLevel).toBe("session");
      expect(can(r.principal, "approve_money")).toBe(true);
      // the minted token verifies back through authenticate()
      const p2 = await id.authenticate(r.palupSessionToken);
      expect(p2.kind).toBe("merchant_user");
    }
  });

  it("TENANT COMES FROM CLAIMS, NOT INPUT: a non-owner staff bootstraps to least-privilege operator", async () => {
    const id = deps({ fetchFn: exchangeOk(false) });
    const r = await id.establishSession(sessionToken());
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.principal.role).toBe("operator"); expect(can(r.principal, "approve_money")).toBe(false); }
  });

  it("SINGLE-USE: the same session token cannot be exchanged twice (jti replay refused)", async () => {
    const id = deps();
    const tok = sessionToken();
    expect((await id.establishSession(tok)).ok).toBe(true);
    const second = await id.establishSession(tok);
    expect(second.ok).toBe(false);                            // replayed jti
  });

  it("fail-closed on a suspended/uninstalled merchant (registry returns null with default lookup)", async () => {
    const id = deps({ registry: registryWith(null) });
    expect((await id.establishSession(sessionToken())).ok).toBe(false);
  });

  it("rejects an invalid session token before any exchange (no fetch, no mint)", async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    const id = deps({ fetchFn: spy });
    const bad = sessionToken({ aud: "other-app" });
    expect((await id.establishSession(bad)).ok).toBe(false);
    expect(spy as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("createShopifyAppBridgeIdentity.authenticate / authorize (the port surface)", () => {
  it("anonymous for a missing/garbage credential; default-deny authorize", async () => {
    const id = deps();
    const p = await id.authenticate(undefined);
    expect(p.kind).toBe("anonymous");
    expect(id.authorize(p, "console.view")).toBe(false);
  });
  it("a fresh operator principal may view+operate but NOT approve money", async () => {
    const id = deps({ fetchFn: exchangeOk(false) });
    const r = await id.establishSession(sessionToken());
    if (r.ok) {
      expect(id.authorize(r.principal, "agent.operate")).toBe(true);
      expect(id.authorize(r.principal, "approve_money")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/identity-shopify/test/identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/identity-shopify/src/identity.ts
// The Shopify App Bridge identity adapter — the factory that satisfies MerchantIdentityPort and owns the
// first-hit exchange flow (ADR-0011 Dec 1, IAM §1/§9). The full chain, fail-closed at every step:
//   establishSession(shopifySessionToken):
//     1. verifyShopifySessionToken (sig/aud/exp/nbf/iss-dest)          — else refuse (no exchange)
//     2. jtiGuard.useOnce(jti)                                          — single-use exchange
//     3. exchangeSessionToken(online)                                  — proves identity, reads role
//     4. registry.lookupByShopDomain(dest-derived host)                — TENANT FROM VERIFIED CLAIMS,
//        (default fail-closed: suspended/uninstalled ⇒ null ⇒ refuse)    NEVER client input
//     5. mapShopifyRole(associated_user, override)                     — PalUp's 5-role RBAC
//     6. mintMerchantSession(...)                                      — the PalUp session
//   authenticate(credential): verifyMerchantSession — the subsequent-request path.
import {
  can, buildShopifyShopperId,
  type MerchantIdentityPort, type MerchantPrincipal, type MerchantAuthResult, type Permission,
  type SecretsPort, type MerchantRegistryPort,
} from "@palup/platform-ports";
import { verifyShopifySessionToken } from "./session-token.js";
import { exchangeSessionToken } from "./token-exchange.js";
import { mapShopifyRole, type RoleOverrideSource } from "./role-map.js";
import { mintMerchantSession, verifyMerchantSession } from "./palup-session.js";
import type { JtiReplayGuard } from "./jti-guard.js";

// App-wide config names — cross-ref widget-backend/src/shopify-install-identity.ts (re-declared, not
// imported, to keep this adapter free of a service dependency). The app client secret is APP-scoped:
// one secret signs every merchant's session token.
const SHOPIFY_APP_SECRET_SCOPE = "__shopify_app__";
const SHOPIFY_APP_CLIENT_SECRET_NAME = "shopify_app_client_secret";
const PALUP_SESSION_SECRET_NAME = "palup_merchant_session_secret";
const DEFAULT_SESSION_TTL = 1800;

export interface ShopifyIdentityDeps {
  clientId: string;
  secrets: SecretsPort;
  registry: MerchantRegistryPort;
  jtiGuard: JtiReplayGuard;
  roleOverrides?: RoleOverrideSource;
  fetchFn?: typeof fetch;
  sessionTtlSeconds?: number;
  nowSec?: () => number;
}
export type EstablishResult =
  | { ok: true; principal: MerchantPrincipal; palupSessionToken: string }
  | { ok: false; reason: string };

export function createShopifyAppBridgeIdentity(
  deps: ShopifyIdentityDeps,
): MerchantIdentityPort & { establishSession(shopifySessionToken: string | undefined): Promise<EstablishResult> } {
  const now = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const fetchFn = deps.fetchFn ?? fetch;
  const ttl = deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL;
  const appSecret = () => deps.secrets.get(SHOPIFY_APP_SECRET_SCOPE, SHOPIFY_APP_CLIENT_SECRET_NAME);
  const sessionSecret = () => deps.secrets.get(SHOPIFY_APP_SECRET_SCOPE, PALUP_SESSION_SECRET_NAME);

  return {
    async authenticate(credential): Promise<MerchantAuthResult> {
      return verifyMerchantSession(await sessionSecret(), credential, now());
    },
    authorize(principal, permission: Permission): boolean {
      return can(principal, permission); // default-deny PDP (anonymous ⇒ false)
    },
    async establishSession(shopifySessionToken): Promise<EstablishResult> {
      const clientSecret = await appSecret();
      const v = verifyShopifySessionToken({ token: shopifySessionToken, clientSecret, clientId: deps.clientId, nowSec: now() });
      if (!v.ok) return { ok: false, reason: v.reason };
      // single-use exchange (ADR-0011): a captured, still-valid token cannot be exchanged twice
      if (!(await deps.jtiGuard.useOnce(v.claims.jti, v.claims.exp))) return { ok: false, reason: "session token already exchanged" };
      const exchanged = await exchangeSessionToken(
        { shopDomain: v.shopDomain, clientId: deps.clientId, clientSecret: clientSecret!, sessionToken: shopifySessionToken!, tokenType: "online" },
        fetchFn,
      );
      if (!exchanged) return { ok: false, reason: "token exchange failed" };
      // TENANT FROM VERIFIED CLAIMS: resolve the PalUp tenant from the dest-derived shop host (default
      // fail-closed lookup ⇒ suspended/uninstalled merchant resolves to null ⇒ refuse). Never a header.
      const merchant = await deps.registry.lookupByShopDomain(v.shopDomain);
      if (!merchant) return { ok: false, reason: "merchant not active for shop" };
      const userId = buildShopifyShopperId(merchant.tenantId, v.claims.sub) ?? `shopify:${merchant.tenantId}:${v.claims.sub}`;
      const override = deps.roleOverrides ? await deps.roleOverrides.lookup(merchant.tenantId, userId) : undefined;
      const role = mapShopifyRole({ associatedUser: exchanged.associatedUser, override });
      const secret = await sessionSecret();
      if (!secret) return { ok: false, reason: "session secret not configured (fail-closed)" };
      const principal: MerchantPrincipal = {
        kind: "merchant_user", merchantId: merchant.tenantId, userId, role,
        authLevel: "session", sessionId: v.claims.sid,
      };
      const palupSessionToken = mintMerchantSession(
        secret, { merchantId: principal.merchantId, userId, role, authLevel: "session", sid: v.claims.sid }, ttl, now(),
      );
      return { ok: true, principal, palupSessionToken };
    },
  };
}
```

Note on `buildShopifyShopperId`: it validates `sub` as `\d+`; a non-numeric Shopify `sub` would return `undefined`, so the `??` fallback namespaces it directly. Both forms are `shopify:<tenant>:<sub>`; keep the fallback so a future non-numeric `sub` still yields a stable id. (Confirm `buildShopifyShopperId` is exported from `@palup/platform-ports` — it is, per `index.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/identity-shopify/test/identity.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/identity-shopify/src/identity.ts packages/identity-shopify/test/identity.test.ts
git commit -m "feat(identity): F2 App Bridge identity factory (validate->single-use->exchange->tenant-from-claims->role->session)"
```

---

## Task 8: Port contract test (both adapters must pass)

ADR-0011 Consequences: "the `identity` port needs a contract test covering both [adapters]." F2 ships the embedded adapter; the SSO/standalone adapter (deferred) will be required to pass the SAME contract.

**Files:**
- Create: `packages/platform-ports/src/contract/merchant-identity-port.contract.ts`
- Modify: `packages/platform-ports/src/index.ts` (export the contract runner)
- Test: `packages/identity-shopify/test/contract.test.ts` (wire the Shopify adapter through it)

**Interfaces:**
- Consumes: `MerchantIdentityPort`, `MerchantPrincipal`, `Permission` from the port module.
- Produces: `runMerchantIdentityPortContract(makeAuthenticatedOwner, makeAuthenticatedOperator, port)`.

- [ ] **Step 1: Write the failing contract + its wiring test**

```typescript
// packages/platform-ports/src/contract/merchant-identity-port.contract.ts
import { describe, it, expect } from "vitest";
import type { MerchantIdentityPort, MerchantPrincipal } from "../merchant-identity-port.js";

// Every MerchantIdentityPort adapter (embedded now; SSO/standalone later) must pass this — the ADR-0011
// "contract test covering both adapters". It asserts the PLANE-INVARIANTS the PDP depends on, regardless
// of HOW the adapter authenticated: default-deny, tenant-scoping is present, `can_approve_money` gates
// money, and no principal escapes its granted permission set.
export function runMerchantIdentityPortContract(
  port: MerchantIdentityPort,
  ownerPrincipal: MerchantPrincipal,     // a fully-authenticated owner from this adapter
  operatorPrincipal: MerchantPrincipal,  // a least-privilege operator from this adapter
): void {
  describe("MerchantIdentityPort contract", () => {
    it("authenticate returns anonymous for an absent credential and NEVER throws", async () => {
      const p = await port.authenticate(undefined);
      expect(p.kind).toBe("anonymous");
    });
    it("default-deny: an anonymous principal is authorized for NOTHING", async () => {
      const anon = await port.authenticate(undefined);
      for (const perm of ["console.view", "agent.operate", "approve_money", "billing.manage"] as const) {
        expect(port.authorize(anon, perm)).toBe(false);
      }
    });
    it("owner may approve money; operator may not (can_approve_money gate)", () => {
      expect(port.authorize(ownerPrincipal, "approve_money")).toBe(true);
      expect(port.authorize(operatorPrincipal, "approve_money")).toBe(false);
    });
    it("operator is view+operate only — no rules/settings/team/billing (no escalation)", () => {
      expect(port.authorize(operatorPrincipal, "console.view")).toBe(true);
      expect(port.authorize(operatorPrincipal, "agent.operate")).toBe(true);
      for (const perm of ["rules.edit", "settings.edit", "team.manage", "billing.manage"] as const) {
        expect(port.authorize(operatorPrincipal, perm)).toBe(false);
      }
    });
    it("every authenticated principal carries a non-empty tenant + user (tenant-scoping present)", () => {
      for (const p of [ownerPrincipal, operatorPrincipal]) {
        expect(p.merchantId).toBeTruthy();
        expect(p.userId).toContain(p.merchantId); // userId is namespaced by tenant
      }
    });
  });
}
```

Add to `packages/platform-ports/src/index.ts`:
```typescript
export { runMerchantIdentityPortContract } from "./contract/merchant-identity-port.contract.js";
```

```typescript
// packages/identity-shopify/test/contract.test.ts
import { runMerchantIdentityPortContract } from "@palup/platform-ports";
import { createShopifyAppBridgeIdentity } from "../src/identity.js";
import { createInMemoryJtiGuard } from "../src/jti-guard.js";
// Reuse the harness from identity.test.ts: build `secrets`, `registryWith(acme)`, `sessionToken()`,
// `exchangeOk(...)` (copy the small helpers or export them from a shared test-util module), then:
//   const id = createShopifyAppBridgeIdentity({...});
//   const owner = (await id.establishSession(sessionToken())).principal   // account_owner=true
//   const operator = (await id.establishSession(sessionToken({jti:"j2"}))).principal  // account_owner=false
//   runMerchantIdentityPortContract(id, owner, operator);
// (Extract the T7 test helpers into packages/identity-shopify/test/_harness.ts so both files import them
//  — do this as the first edit of this step.)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/identity-shopify/test/contract.test.ts`
Expected: FAIL — contract module/harness not found.

- [ ] **Step 3: Implement**

Extract the T7 helpers into `packages/identity-shopify/test/_harness.ts` (export `secrets`, `acme`, `registryWith`, `sessionToken`, `exchangeOk`, `CLIENT_ID`, `APP_SECRET`, `SESSION_SECRET`). Import them from both `identity.test.ts` and `contract.test.ts`. Fill in `contract.test.ts` per the sketch (two `establishSession` calls with distinct `jti`s produce owner + operator principals).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/identity-shopify/test/`
Expected: PASS (all adapter suites incl. the contract).

- [ ] **Step 5: Commit**

```bash
git add packages/platform-ports/src/contract/merchant-identity-port.contract.ts packages/platform-ports/src/index.ts packages/identity-shopify/test/contract.test.ts packages/identity-shopify/test/_harness.ts packages/identity-shopify/test/identity.test.ts
git commit -m "test(identity): F2 MerchantIdentityPort contract test, Shopify adapter conforms (ADR-0011)"
```

---

## Task 9: Fastify preHandlers + embedded-console CSP

**Files:**
- Create: `packages/identity-shopify/src/fastify-plugin.ts`
- Create: `packages/identity-shopify/src/index.ts` (barrel — export everything public)
- Test: `packages/identity-shopify/test/fastify-plugin.test.ts`

**Interfaces:**
- Consumes: `MerchantIdentityPort`, `MerchantPrincipal`, `Permission`, `can` from `@palup/platform-ports`; the factory + helpers from earlier tasks.
- Produces: `requireMerchant(port)`, `requirePermission(perm)` (Fastify `preHandlerHookHandler`s that read the `Authorization: Bearer <palup-session>` header, set `request.principal`, and reply 401/403), `shopifyEmbedFrameAncestors(shopDomain)` (the CSP `frame-ancestors` value pinning framing to Shopify admin + the shop — ADR-0011 Dec 1 / IAM §1 anti-clickjacking).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/identity-shopify/test/fastify-plugin.test.ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { requireMerchant, requirePermission, shopifyEmbedFrameAncestors } from "../src/fastify-plugin.js";
import { mintMerchantSession } from "../src/palup-session.js";
import { verifyMerchantSession } from "../src/palup-session.js";
import type { MerchantIdentityPort } from "@palup/platform-ports";
import { can } from "@palup/platform-ports";

const SECRET = "s";
// a tiny port that authenticates our PalUp session tokens and authorizes via `can`
const port: MerchantIdentityPort = {
  async authenticate(c) { return verifyMerchantSession(SECRET, c, Math.floor(Date.now() / 1000)); },
  authorize(p, perm) { return can(p, perm); },
};
const ownerTok = mintMerchantSession(SECRET, { merchantId: "acme", userId: "shopify:acme:1", role: "owner", authLevel: "session", sid: "s1" }, 1800);
const operatorTok = mintMerchantSession(SECRET, { merchantId: "acme", userId: "shopify:acme:2", role: "operator", authLevel: "session", sid: "s2" }, 1800);

function app() {
  const f = Fastify();
  f.addHook("preHandler", requireMerchant(port));
  f.get("/home", async (req) => ({ merchantId: (req as any).principal.merchantId }));
  f.post("/approvals/:id/approve", { preHandler: requirePermission("approve_money") }, async () => ({ approved: true }));
  return f;
}

describe("Fastify merchant auth preHandlers", () => {
  it("401 with no bearer token", async () => {
    const r = await app().inject({ method: "GET", url: "/home" });
    expect(r.statusCode).toBe(401);
  });
  it("200 + principal.merchantId for a valid session", async () => {
    const r = await app().inject({ method: "GET", url: "/home", headers: { authorization: `Bearer ${ownerTok}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().merchantId).toBe("acme");
  });
  it("owner may approve money (200); operator is forbidden (403)", async () => {
    const ok = await app().inject({ method: "POST", url: "/approvals/1/approve", headers: { authorization: `Bearer ${ownerTok}` } });
    expect(ok.statusCode).toBe(200);
    const no = await app().inject({ method: "POST", url: "/approvals/1/approve", headers: { authorization: `Bearer ${operatorTok}` } });
    expect(no.statusCode).toBe(403);
  });
  it("CSP frame-ancestors pins framing to Shopify admin + the shop (anti-clickjacking)", () => {
    const v = shopifyEmbedFrameAncestors("acme.myshopify.com");
    expect(v).toBe("frame-ancestors https://admin.shopify.com https://acme.myshopify.com");
  });
  it("CSP helper refuses a non-myshopify host (returns admin-only, never reflects a bad host)", () => {
    expect(shopifyEmbedFrameAncestors("evil.test")).toBe("frame-ancestors https://admin.shopify.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/identity-shopify/test/fastify-plugin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/identity-shopify/src/fastify-plugin.ts
import type { preHandlerHookHandler } from "fastify";
import { can, type MerchantIdentityPort, type MerchantPrincipal, type Permission } from "@palup/platform-ports";

// The PDP mount point (IAM §2: authorization decided server-side, at one place, default-deny). Every
// merchant-plane route runs `requireMerchant` (→ request.principal) and declares the permission it needs
// via `requirePermission`. Bearer scheme carries the PalUp session token (Task 6). 401 = not
// authenticated; 403 = authenticated but not permitted.

declare module "fastify" {
  interface FastifyRequest { principal?: MerchantPrincipal; }
}

function bearer(req: { headers: Record<string, unknown> }): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return undefined;
  const m = /^Bearer (.+)$/i.exec(h.trim());
  return m?.[1];
}

export function requireMerchant(port: MerchantIdentityPort): preHandlerHookHandler {
  return async (req, reply) => {
    const p = await port.authenticate(bearer(req));
    if (p.kind !== "merchant_user") { await reply.code(401).send({ error: "unauthenticated" }); return; }
    req.principal = p;
  };
}

export function requirePermission(permission: Permission): preHandlerHookHandler {
  return async (req, reply) => {
    // authenticate first if a route mounts this standalone (idempotent with requireMerchant above)
    const p = req.principal;
    if (!p || p.kind !== "merchant_user") { await reply.code(401).send({ error: "unauthenticated" }); return; }
    if (!can(p, permission)) { await reply.code(403).send({ error: "forbidden", permission }); return; }
  };
}

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
/** CSP `frame-ancestors` pinning the embedded console to Shopify admin (+ the shop). A non-myshopify
 *  host is NEVER reflected — it degrades to admin-only rather than widening the frame to an attacker. */
export function shopifyEmbedFrameAncestors(shopDomain: string): string {
  const base = "frame-ancestors https://admin.shopify.com";
  return SHOP_HOST.test(shopDomain) ? `${base} https://${shopDomain.toLowerCase()}` : base;
}
```

Note: `requirePermission` assumes `requireMerchant` ran earlier in the hook chain (it sets `req.principal`); when mounted per-route, add `requireMerchant(port)` to that route's `preHandler` array before it, or compose both. The test mounts `requireMerchant` app-wide, so `req.principal` is set by the time `requirePermission` runs.

`packages/identity-shopify/src/index.ts`:
```typescript
export { verifyShopifySessionToken, type ShopifySessionClaims, type SessionVerifyResult } from "./session-token.js";
export { createInMemoryJtiGuard, type JtiReplayGuard } from "./jti-guard.js";
export { exchangeSessionToken, type AssociatedUser, type TokenExchangeResult } from "./token-exchange.js";
export { mapShopifyRole, type RoleOverrideSource } from "./role-map.js";
export { mintMerchantSession, verifyMerchantSession } from "./palup-session.js";
export { createShopifyAppBridgeIdentity, type ShopifyIdentityDeps, type EstablishResult } from "./identity.js";
export { requireMerchant, requirePermission, shopifyEmbedFrameAncestors } from "./fastify-plugin.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/identity-shopify/test/fastify-plugin.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/identity-shopify/src/fastify-plugin.ts packages/identity-shopify/src/index.ts packages/identity-shopify/test/fastify-plugin.test.ts
git commit -m "feat(identity): F2 Fastify PDP preHandlers (401/403) + embedded-console CSP frame-ancestors"
```

---

## Task 10: Typecheck, full suite, and root wiring

**Files:**
- Modify: root `tsconfig.json` — VERIFIED: the repo uses an explicit `references` array (not `tsc -b` globs), so add `{ "path": "packages/identity-shopify/tsconfig.json" }` to it or the new package is not built.
- `pnpm-workspace.yaml` — VERIFIED: the glob is `packages/*`, so the new package is auto-included; no edit needed. Run `pnpm install` once to link `@palup/identity-shopify` into the workspace.

- [ ] **Step 1: Add the project reference, then build the whole workspace**

Add `{ "path": "packages/identity-shopify/tsconfig.json" }` to the root `tsconfig.json` `references` array (alongside the existing `packages/*/tsconfig.json` entries), then run `pnpm install` and `pnpm build`.
Expected: PASS — `@palup/identity-shopify` compiles; `@palup/platform-ports` re-exports resolve. If it does not build, confirm the new package's `tsconfig.json` carries `references: [{ path: "../platform-ports/tsconfig.json" }]`.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all new suites plus the existing ones (no regression). Do NOT set `GOOGLE_CLOUD_PROJECT` (keeps backend tests on the mock path).

- [ ] **Step 3: Run the merge gate**

Run: `bash scripts/merge-gate.sh` (or the repo's documented gate command). This touches auth/credentials → `security-reviewer` is required before merge (CLAUDE.md §4.4, spec §12).
Expected: green.

- [ ] **Step 4: Commit any wiring fixes**

```bash
git add -A
git commit -m "chore(identity): F2 wire @palup/identity-shopify into workspace build + references"
```

---

## Self-Review

**1. Spec coverage — every governing requirement maps to a task:**

- ADR-0011 Dec 1 — App Bridge session token, cryptographic validation (**signature/aud/exp/nbf/dest/iss**): Task 2. **Single-use exchange**: Task 3 + Task 7 (jti guard across `establishSession`). **Token exchange → PalUp session**: Task 4 + Task 6 + Task 7. **Tenant from verified claims, never client input**: Task 7 (tenant resolved from `dest`-derived host via registry; no header/query path exists — the test asserts a forged input has nowhere to enter). **CSP-restricted framing**: Task 9 (`shopifyEmbedFrameAncestors`).
- ADR-0011 Dec 3 — feature code depends on `{merchantId, userId, role, authLevel}`: Task 1 (`MerchantPrincipal`, which adds `sessionId` for the revocation-store handle — a superset, still satisfying the decision).
- ADR-0011 Dec 4 — PalUp's 5-role RBAC, mapped from Shopify staff role/invite, editable in PalUp: Task 1 (roles/permissions), Task 5 (`mapShopifyRole` + injected `RoleOverrideSource` = the "editable in PalUp" hook), never inherits Shopify perms wholesale (only `account_owner` bootstraps; the rest is PalUp's mapping).
- ADR-0011 Dec 2 (SSO/standalone) & Dec 5 (API keys): **DEFERRED** — stated as non-goals in Global Constraints; the port + contract (Task 8) are shaped so those adapters slot in behind the same interface.
- IAM invariant 9: Task 2 + Task 3 + Task 7 + Task 9 (the full sentence).
- IAM §2 default-deny PDP: Task 1 (`can`), Task 7 (`authorize`), Task 8 (contract), Task 9 (401/403 middleware).
- Spec W1 `can_approve_money` gate: Task 1 (`canApproveMoney` / `approve_money` perm), Task 8, Task 9 (403 for operator).
- Spec W7 least-privilege invited default: Task 1 (operator = view+operate), Task 5 (non-owner → operator).
- Portability (ADR-0001): port in `platform-ports` (Task 1), all Shopify specifics in `identity-shopify` (Tasks 2–9), `node:crypto` + injected `fetch`, no SDK.
- Secrets via port: Task 7 (app secret + session secret via `SecretsPort`, app-scoped sentinel), never logged (every module's leak-boundary comments + `null`/`anonymous` refusals).
- ATDD: every task is red→green→commit with real test + impl code.

**Gaps intentionally left (documented, not silent):**
- **Audit of login / role-change (IAM invariant 8):** F2 produces the principal + `EstablishResult`; the **audit write** (actor, input, decision) is the F3 caller's job via `RuntimeStatePort.audit` (tenant-scoped) — consistent with `merchant-registry-port.ts`'s stance that the caller audits governance mutations. Flagged for F3.
- **Durable jti guard + full session-revocation store (sign-out-all, refresh rotation, IAM §1):** F2 ships the in-memory jti guard behind the `JtiReplayGuard` interface and a stateless short-TTL session; the durable RuntimeStatePort/Postgres guard and the revocation store are **DEFERRED** (spec §3 defers standalone/SSO which is where the richer session store lives) — the interface is the seam.
- **Step-up / `authLevel: "elevated"`:** reserved in the type, never minted in v1 embedded (passkey deferred with SSO). Money approval is gated on the `approve_money` **permission** in v1, not step-up.

**2. Placeholder scan:** No "TBD/TODO/implement later"; every code step carries real code; every test step carries real assertions. Task 8 and Task 9's harness-reuse notes point at concrete helpers to extract (`_harness.ts`), not vague "similar to above." One deliberate instruction-not-code spot: Task 10 says "read root `tsconfig.json` first" because whether an edit is needed depends on whether the repo uses explicit references or `tsc -b` globs — that is a real conditional, not a placeholder.

**3. Type consistency:** `MerchantPrincipal`/`MerchantRole`/`AuthLevel`/`Permission`/`can`/`canApproveMoney` are defined once (Task 1) and imported everywhere. `establishSession`/`authenticate`/`authorize` signatures match the Interfaces block across Tasks 7–9. `verifyShopifySessionToken` returns `{ok, claims, shopDomain}` (Task 2) and Task 7 consumes exactly those fields. `mintMerchantSession`/`verifyMerchantSession` param+return shapes match between Task 6, 7, and 9. `JtiReplayGuard.useOnce(jti, exp)` is identical in Tasks 3 and 7. `AssociatedUser`/`TokenExchangeResult` from Task 4 feed `mapShopifyRole` (Task 5) and Task 7 unchanged. The role whitelist in `verifyMerchantSession` (Task 6) is exactly the 5 `MerchantRole` values from Task 1.
