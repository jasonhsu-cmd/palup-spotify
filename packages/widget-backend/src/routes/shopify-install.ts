import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuditInput, MerchantRecord, MerchantRegion, MerchantRegistryPort, RuntimeStatePort } from "@palup/platform-ports";
import type { AdminTokenStore } from "@palup/state-postgres";
import { randomToken } from "../shopify-customer-account-identity.js";
import { clientIpKey } from "../rate-limit.js";
import {
  buildInstallAuthorizeUrl,
  createDelegateAccessToken,
  exchangeInstallCode,
  grantedScopesCover,
  isValidShopDomain,
  normalizeOauthQuery,
  registerWebhookSubscriptions,
  timestampWithinTolerance,
  verifyOauthHmac,
  type WebhookSubscriptionSpec,
} from "../shopify-install-identity.js";

// C1 — `GET /shopify/install` → `GET /shopify/callback` → `delegateAccessTokenCreate`. The first real
// caller of the MerchantRegistryPort (B1/#184) and of the encrypted merchant-credential custody (B2/#186).
// The Shopify wire format lives entirely in ../shopify-install-identity.ts (with its primary-source
// citations); this file is the FLOW and its governance: CSRF state, kill switch, audit, fail-closed
// ordering.
//
// ****************************************************************************************************
// SUPERSEDED BY D1 — this block used to read "INSTALLING THROUGH THIS FLOW DOES NOT MAKE A MERCHANT
// SERVABLE … nothing in the serving path reads `pl_merchant`". Both halves are now FALSE, and a stale
// disclaimer that under-claims is still a wrong claim, so here is the corrected state.
//
// WHAT D1 CUT OVER (merchant-resolver.ts is the single place the rule lives):
//   • `/widget/token` resolves an embed key through the REGISTRY first; `WIDGET_EMBED_KEYS` is a named,
//     logged, audited FALLBACK that applies only when no row claims that key.
//   • `/chat` re-reads `pl_merchant.status` EVERY TURN, so `setStatus(…, "uninstalled")` — this file's own
//     documented reversal path, and what C2's `app/uninstalled` webhook writes — actually stops serving,
//     rather than being recorded and ignored.
//   • `/shopper/session` and `/auth/customer/login` honour the same status check, and the shop domain for
//     grounding comes from the row.
//
// WHAT IS STILL NOT TRUE, so nobody over-corrects the other way. A merchant who completes this flow
// CANNOT YET BE SERVED THEIR OWN STORE, for two independent reasons:
//   1. NOBODY HANDS THEM THEIR EMBED KEY. This file generates one (`newEmbedKey` below) and writes it to
//      the registry, but — verified by grepping `packages/widget-backend/src` + `packages/control-plane/src`
//      — no route, page or console returns it. The only way out is an operator running
//      `jobs/merchant.ts show --tenant <id>`, which prints it since D1. Without that key their storefront
//      snippet has nothing to mint with. `OK_PAGE` below therefore still says "not live yet", and that
//      remains ACCURATE — it is deliberately not reworded.
//   2. THEIR STOREFRONT TOKEN IS NOT READ. Serving takes `shopify_storefront_token` from `SecretsPort`
//      (merchant-store.ts), NOT the encrypted delegate credential this flow custodies, so even once they
//      have their key their shoppers get the FIXTURE catalog rather than their products. That is D2.
// Also unchanged: `MERCHANT_REGION`/`MERCHANT_GROUNDING_MODE` remain process-wide, so a merchant recorded
// with `SHOPIFY_INSTALL_REGION` is SERVED with `MERCHANT_REGION` (server.ts warns at boot when they differ).
//
// The `demo` question this block used to pose is answered: env survives as an explicit fallback, so
// `demo` → `palup-skincare-jason.myshopify.com` keeps working, while that same shop installed through THIS
// flow would land on tenant `palup-skincare-jason` — a DIFFERENT tenant, which is why the collision case
// below fails loudly instead of merging.
//
// WHAT IT DOES DO, AND IT IS REAL. `deps.credentials` is REQUIRED, and it is B2's
// `createMerchantCredentialStore` (#186), wired in server.ts: the delegate token is encrypted at rest under
// a per-(tenant, `merchant-cred` scope) key and its write is audited atomically inside B2's own
// transaction. Requiring custody rather than treating it as optional is deliberate — an install that
// obtained a delegate token and then had nowhere to put it would have created a live Shopify credential
// with no custody, no audit and no revocation path. So: no custody ⇒ the routes are not registered at all.
// The routes go live in a deployment the moment its five preconditions are set (see server.ts); they are
// absent, not half-working, until then.
// ****************************************************************************************************
//
// WHERE PENDING INSTALLS LIVE. An APP-SCOPED RuntimeState collection, the same mechanism and the same
// reserved sentinel tenant `customer-account-flow.ts:24-29` uses, and for the same reason: the callback is
// a top-level Shopify redirect with no widget Bearer and no tenant of its own, so there is no tenant to
// scope the pending record by. The tenant is derived AFTER verification, from the shop the pending record
// itself names.
//
// AUDIT (NN#5) AND THE ONE THING THIS CANNOT DO. `MerchantRegistryPort` promises no audit of its own and
// says the caller must write it "ideally inside the same transaction"
// (merchant-registry-port.ts:45-48). That is NOT ACHIEVABLE through the port as it stands: the port exposes
// no transaction handle, and `PostgresMerchantRegistry.create` opens and commits its own `Sql` transaction,
// while the audit chain lives behind `RuntimeStatePort.audit`. Two ports, two transactions. So this file
// takes the repo's existing second-best ordering — AUDIT FIRST, THEN WRITE
// (customer-account-flow.ts:148-152 makes the same trade for the same reason) — and the two failure modes,
// stated rather than glossed: an audit failure aborts the install and leaves no row (fail closed, tested);
// an audit that commits and a registry write that then fails leaves a record of a registration that did not
// happen. The second is visible, harmless and self-evidently reconcilable against `pl_merchant`; the
// reverse ordering would leave an UNAUDITED governed write, which NN#5 forbids. A port-level transaction
// spanning both is reported as a follow-up, not faked here.

/** The reserved sentinel tenant holding pending installs (mirrors `CAA_APP_SCOPE`). */
export const INSTALL_APP_SCOPE = "__shopify_app__";
/** KV collection of pending installs, keyed by the single-use `state` nonce. */
export const INSTALL_PENDING_COLLECTION = "shopify_install_pending";
/** The `state` cookie name. [S1] requires a cookie whose value equals `state` — see `sameStateCookie`. */
export const INSTALL_STATE_COOKIE = "palup_shopify_install_state";
/** Default Admin OAuth `scope` — the scopes we ask a merchant to grant. Kept equal to the delegate scopes
 *  because [S2] only lets us delegate what we were granted; asking for more would be scope we never use. */
export const INSTALL_SCOPES_DEFAULT = "unauthenticated_read_product_listings";
/** Pending installs are short-lived: a merchant clicks through the grant screen in seconds, not hours. */
const PENDING_TTL_SECONDS_DEFAULT = 600;

const APP_CTX = { tenantId: INSTALL_APP_SCOPE } as const;

/**
 * What C1 needs from credential custody, expressed as the NARROWEST possible interface rather than by
 * importing B2's `MerchantCredentialStore` type: this flow needs only `put`. It never reads a credential
 * back, so a dependency that could read every merchant's token would be more privilege than the install
 * flow requires (least privilege, NN#6) — and a narrower type means a future change that starts reading
 * credentials here has to widen this interface deliberately rather than inheriting the capability.
 * B2's store satisfies this STRUCTURALLY, so the composition-root wiring is an assignment, no adapter.
 */
export interface MerchantCredentialSink {
  put(tenantId: string, token: string, opts: { actor: string }): Promise<void>;
}

export interface ShopifyInstallDeps {
  store: RuntimeStatePort;
  registry: MerchantRegistryPort;
  /** REQUIRED. See the header: no custody ⇒ the routes are not registered at all. */
  credentials: MerchantCredentialSink;
  /**
   * Task 5 (ADR-0022 F2/F7) — OPTIONAL custody for the PARENT Admin offline token (`grant.accessToken`),
   * narrowed to `put` ONLY, for the identical least-privilege reason `MerchantCredentialSink` is narrowed
   * above: this flow never reads an Admin token back, so a dependency that could read every merchant's
   * token would be more privilege than install requires. OPTIONAL (not required, unlike `credentials`):
   * the Admin token is a NEW custody surface (Task 4) layered onto an already-shipped flow, and its absence
   * must be byte-identical to today's behaviour (no custody attempted, no test broken) rather than a second
   * gate that disables installs. When present, it is only ever called AFTER the shop-binding check that
   * `completeInstallInner` already performs against the signed `state`'s pending record (F7 — see the call
   * site), so a state minted for shop A can never result in shop B's Admin token — or any Admin token —
   * being custodied under the wrong tenant.
   */
  adminTokens?: Pick<AdminTokenStore, "put">;
  /** Resolves the APP-scoped OAuth client secret. Called per request so a rotation takes effect without a
   *  redeploy, and so the secret is never captured in a closure at boot. */
  clientSecret: () => Promise<string | undefined>;
  fetchFn: typeof globalThis.fetch;
  clientId: string;
  redirectUri: string;
  /** Comma-separated Admin OAuth `scope`. */
  requestedScopes: string;
  /** Scopes for the delegate token. Must be covered by what the merchant actually granted. */
  delegateScopes: readonly string[];
  /**
   * Data-residency for a NEWLY registered merchant. Explicit and REQUIRED, because `NewMerchant.region` is
   * required on purpose: "today's silent `us` default (server.ts:481) is a residency decision made by an
   * unset env var, which the legal review already flagged" (merchant-registry-port.ts:89-91). Shopify's
   * callback carries no residency signal, so an operator declares it; an undeclared region disables the
   * whole feature rather than inheriting one.
   */
  region: MerchantRegion;
  /** True when a kill is armed for this tenant/agent/globally (NN#4). */
  killCheck: (tenantId: string) => Promise<boolean>;
  /** Unix seconds. */
  now: () => number;
  /**
   * Shop-specific webhook subscriptions to register at install, under the legacy install flow (which
   * forbids declarative `[webhooks]`). Built by the composition root from OPERATOR CONFIG ONLY (the
   * redirect URI's origin + `WEBHOOK_ROUTES`), never from the shop or the request (SSRF defence).
   * ADDITIVE: absent/empty ⇒ no registration is attempted and behaviour is byte-identical to before.
   * Registration is BEST-EFFORT / NON-FATAL — see the call site — so a webhook failure never changes the
   * install outcome.
   */
  webhookSubscriptions?: readonly WebhookSubscriptionSpec[];
  /**
   * Per-IP rate limit for these PUBLIC, unauthenticated routes — `false` ⇒ refuse with 429. Every sibling
   * public route in server.ts caps itself the same way (`/widget/token`, `/shopper/session`, the CAA
   * routes, `/consent`). Without it, an anonymous caller can make this process compute an unbounded number
   * of HMACs, and the audit chain that a completed install appends to is immutable and non-trimmable.
   */
  checkRateLimit?: (ipKey: string) => Promise<boolean>;
  pendingTtlSeconds?: number;
  /** Injectable only so a test can pin the generated embed key; production uses the CSPRNG default. */
  newEmbedKey?: () => string;
}

interface PendingInstall {
  /** The shop this `state` was minted for. The callback's own `shop` must equal it. */
  shopDomain: string;
  createdAt: number;
}

/** A refusal reason, for the SERVER-SIDE log only. The HTTP response never distinguishes these — a
 *  distinguishable refusal would turn the callback into an oracle for which check failed. */
type Refusal =
  | "bad_hmac"
  | "bad_shop"
  | "stale_timestamp"
  | "no_state"
  | "no_cookie"
  | "cookie_mismatch"
  | "unknown_state"
  | "shop_mismatch"
  | "no_code"
  | "halted"
  | "rate_limited"
  | "internal_error"
  | "no_app_secret";

/** An upstream/internal failure: the request was legitimate, we could not complete it. */
type Failure = "exchange_failed" | "scopes_not_granted" | "delegate_failed" | "custody_failed" | "registry_failed";

export type InstallStart = { ok: true; authorizeUrl: string; state: string; ttlSeconds: number } | { ok: false; refused: Refusal };
export type InstallComplete = { ok: true; shopDomain: string } | { ok: false; refused: Refusal } | { ok: false; failed: Failure };

/**
 * `tenantId` for a shop, derived from its own subdomain: `acme-store.myshopify.com` → `acme-store`. The
 * derivation is deterministic (a re-install of the same shop derives the same id) and total on the
 * validated input (SHOP_HOST guarantees exactly one `[a-z0-9][a-z0-9-]*` label). It is only ever used for a
 * shop that has NO row yet — a shop already in the registry keeps whatever tenantId it was first given
 * (`lookupByShopDomain` decides), so this can never re-home an existing merchant.
 *
 * COLLISION, stated: a store literally named `demo.myshopify.com` would derive `demo`, which is the
 * built-in fallback tenant id (server.ts:53,125). `create` REFUSES a duplicate tenantId
 * (merchant-registry-port.ts:229) and this flow surfaces that as a failure rather than merging into it, so
 * the collision is loud, not a cross-tenant merge. Lowercased because the registry indexes a canonical
 * lowercase host and a tenant id is compared case-sensitively everywhere else.
 */
export function tenantIdForShop(shopDomain: string): string {
  return shopDomain.toLowerCase().replace(/\.myshopify\.com$/, "");
}

/**
 * Constant-time comparison of the `state` parameter against the cookie set at install time — [S1]'s
 * required check: "the signed cookie that you set when asking for permission is present and its value
 * equals the nonce value in the state parameter".
 *
 * WHY BOTH A COOKIE AND A SERVER-SIDE RECORD, since either alone is tempting. They prove DIFFERENT things.
 * The server-side pending record (keyed by the nonce) proves THIS SERVER minted this state, that it has not
 * been used before, and which shop it was for — a cookie cannot prove single-use, because a browser will
 * happily resend it. The cookie proves the callback arrives in the SAME BROWSER that started the install —
 * a server record cannot prove that, so without the cookie an attacker who observed a victim's `state`
 * (e.g. from a shared machine's history) could complete the install from their own browser. C1 requires
 * both, and this is the comparison that must not leak timing.
 *
 * CONSEQUENCE, disclosed rather than discovered later: requiring the cookie means C1 supports the
 * NON-EMBEDDED install path only. [S1] Step 2 describes an embedded app escaping the Shopify admin iframe
 * (App Bridge) before redirecting; a `SameSite=Lax` cookie set from inside a third-party iframe may be
 * blocked by the browser, so an embedded install would fail this check. Failing closed on a missing cookie
 * is the correct trade — the alternative is a check that silently passes whenever the cookie is absent,
 * which is no check at all. Iframe escape is a follow-up.
 */
function sameStateCookie(state: string, cookieHeader: unknown): boolean {
  try {
    if (typeof cookieHeader !== "string" || !cookieHeader) return false;
    let found: string | undefined;
    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== INSTALL_STATE_COOKIE) continue;
      found = part.slice(eq + 1).trim();
      break; // first occurrence wins; a duplicated cookie name must not let an attacker append a second
    }
    if (!found) return false;
    const a = Buffer.from(found);
    const b = Buffer.from(state);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** `Secure` unconditionally: Shopify requires an HTTPS redirect URI, so a plaintext install flow is not a
 *  real configuration and a conditional `Secure` would be a security downgrade driven by a typo. */
function stateCookie(state: string, ttlSeconds: number): string {
  return `${INSTALL_STATE_COOKIE}=${state}; Path=/shopify; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

/**
 * A refusal is logged with its REASON CODE ONLY — no `shop`, no `code`, no `hmac`, no `state`. The reason
 * codes are a closed set of literals defined in this file, so nothing attacker-controlled can reach a log
 * line (log injection via a newline in `shop`, or a credential in a "helpful" error string). The audit log
 * is deliberately NOT written for a refusal either: the callback is unauthenticated and reachable by
 * anyone, so auditing refusals would hand an attacker an append primitive against an immutable,
 * non-trimmable chain.
 */
function logRefusal(where: "install" | "callback", reason: Refusal | Failure): void {
  console.warn(`[shopify-install] ${where} refused: ${reason}`);
}

/**
 * Step 1 of [S1] — verify the installation request, then 302 to the grant screen.
 *
 * Verifying the INSTALL request (not only the callback) matters: without it anyone could aim an install at
 * an arbitrary `shop`, causing this server to mint state and emit an authorize URL for a store that never
 * asked. Everything is checked before anything is written.
 */
export async function startInstall(deps: ShopifyInstallDeps, rawQuery: Record<string, unknown>): Promise<InstallStart> {
  try {
    return await startInstallInner(deps, rawQuery);
  } catch {
    // An outer catch so NO exception can reach the HTTP layer. Two reasons, both load-bearing: Fastify's
    // default error handler puts `err.message` in the response body, and this function calls a SecretsPort,
    // a kill registry and a state store — any of which could throw a message built from operator config. A
    // uniform refusal is the only safe rendering. The swallowed error is deliberate: see `logRefusal`.
    logRefusal("install", "internal_error");
    return { ok: false, refused: "internal_error" };
  }
}

async function startInstallInner(deps: ShopifyInstallDeps, rawQuery: Record<string, unknown>): Promise<InstallStart> {
  const params = normalizeOauthQuery(rawQuery);
  const secret = await deps.clientSecret();
  if (!secret) return { ok: false, refused: "no_app_secret" };
  // 1. HMAC FIRST — nothing below may read a parameter that has not been proven to come from Shopify.
  if (!verifyOauthHmac(secret, params)) return { ok: false, refused: "bad_hmac" };
  // 2. The allowlist, independent of the signature: a valid signature over a hostile host is still hostile.
  const shop = params.shop;
  if (!isValidShopDomain(shop)) return { ok: false, refused: "bad_shop" };
  const shopDomain = (shop as string).toLowerCase();
  // 3. Anti-replay: a captured install link must not be reusable tomorrow.
  if (!timestampWithinTolerance(params.timestamp, deps.now())) return { ok: false, refused: "stale_timestamp" };
  // 4. NN#4 — no new credential custody may BEGIN during a halt, at any scope.
  if (await deps.killCheck(tenantIdForShop(shopDomain))) return { ok: false, refused: "halted" };

  const state = randomToken();
  const ttlSeconds = deps.pendingTtlSeconds ?? PENDING_TTL_SECONDS_DEFAULT;
  const pending: PendingInstall = { shopDomain, createdAt: deps.now() };
  await deps.store.put(APP_CTX, INSTALL_PENDING_COLLECTION, state, pending, { ttlSeconds });
  return {
    ok: true,
    state,
    ttlSeconds,
    authorizeUrl: buildInstallAuthorizeUrl({
      shopDomain,
      clientId: deps.clientId,
      redirectUri: deps.redirectUri,
      scopes: deps.requestedScopes,
      state,
    }),
  };
}

/**
 * Steps 3-4 of [S1] plus [S2] — validate the callback, exchange the code, mint a delegate token, custody
 * it, and register the merchant.
 *
 * THE ORDER IS THE SECURITY PROPERTY, so it is spelled out:
 *   1-3. HMAC → shop allowlist → timestamp. No parameter is trusted before its signature is.
 *   4.   `state` + cookie, constant-time.
 *   5.   Consume the pending record (DELETE BEFORE ANY NETWORK CALL, so a failure later cannot be replayed)
 *        and require that it names THIS shop — a state minted for shop A cannot complete for shop B.
 *   6.   NN#4 kill re-check: a halt armed between install and callback must still stop custody.
 *   7-8. Exchange the code; verify the merchant actually granted the scopes the delegate token needs
 *        ([S1] "Confirm the requested scopes") BEFORE spending the mutation.
 *   9.   Mint the delegate token.
 *   10.  CUSTODY BEFORE SERVABILITY: store the credential first, then create/reactivate the row. A merchant
 *        must never be `active` with no readable credential — that state serves fixtures while looking
 *        configured. The reverse failure (a stored credential with no row) is inert and self-healing: the
 *        next install overwrites it, and nothing reads a credential for a tenant with no row.
 *   11.  Audit, then the registry write (see the header for why this cannot be one transaction).
 */
export async function completeInstall(
  deps: ShopifyInstallDeps,
  rawQuery: Record<string, unknown>,
  cookieHeader: unknown,
): Promise<InstallComplete> {
  try {
    return await completeInstallInner(deps, rawQuery, cookieHeader);
  } catch {
    // Same reasoning as `startInstall`'s outer catch, with more at stake: the values in scope inside this
    // function include the app client secret, the authorization code, the parent access token and the
    // delegate token. No exception may carry any of them (or a stack referencing them) to a response.
    logRefusal("callback", "internal_error");
    return { ok: false, refused: "internal_error" };
  }
}

async function completeInstallInner(
  deps: ShopifyInstallDeps,
  rawQuery: Record<string, unknown>,
  cookieHeader: unknown,
): Promise<InstallComplete> {
  const params = normalizeOauthQuery(rawQuery);
  const secret = await deps.clientSecret();
  if (!secret) return { ok: false, refused: "no_app_secret" };
  if (!verifyOauthHmac(secret, params)) return { ok: false, refused: "bad_hmac" };
  const shop = params.shop;
  if (!isValidShopDomain(shop)) return { ok: false, refused: "bad_shop" };
  const shopDomain = (shop as string).toLowerCase();
  if (!timestampWithinTolerance(params.timestamp, deps.now())) return { ok: false, refused: "stale_timestamp" };

  const state = params.state;
  if (typeof state !== "string" || !state) return { ok: false, refused: "no_state" };
  // The cookie is checked BEFORE the pending record is consumed, so a request that fails the browser-
  // binding check cannot burn the legitimate merchant's single-use state.
  if (!sameStateCookie(state, cookieHeader)) return { ok: false, refused: "cookie_mismatch" };

  const code = params.code;
  if (typeof code !== "string" || !code) return { ok: false, refused: "no_code" };

  let pending: PendingInstall | null;
  try {
    pending = await deps.store.get<PendingInstall>(APP_CTX, INSTALL_PENDING_COLLECTION, state);
    // Single-use: delete unconditionally, before any outbound call, so no later failure leaves a replayable
    // state behind (the same discipline as customer-account-flow.ts:116-117).
    await deps.store.delete(APP_CTX, INSTALL_PENDING_COLLECTION, state);
  } catch {
    return { ok: false, failed: "registry_failed" };
  }
  if (!pending || typeof pending.shopDomain !== "string") return { ok: false, refused: "unknown_state" };
  if (pending.shopDomain !== shopDomain) return { ok: false, refused: "shop_mismatch" };

  // The tenant: an existing row for this shop keeps its own id (never re-homed); a new shop derives one.
  let existing: MerchantRecord | null;
  try {
    existing = await deps.registry.lookupByShopDomain(shopDomain, { includeInactive: true });
  } catch {
    return { ok: false, failed: "registry_failed" };
  }
  const tenantId = existing?.tenantId ?? tenantIdForShop(shopDomain);

  if (await deps.killCheck(tenantId)) return { ok: false, refused: "halted" };

  const grant = await exchangeInstallCode(
    { shopDomain, clientId: deps.clientId, clientSecret: secret, code },
    deps.fetchFn,
  );
  if (!grant) return { ok: false, failed: "exchange_failed" };
  if (!grantedScopesCover(deps.delegateScopes, grant.grantedScopes)) return { ok: false, failed: "scopes_not_granted" };

  const delegate = await createDelegateAccessToken(
    { shopDomain, parentAccessToken: grant.accessToken, delegateScopes: deps.delegateScopes },
    deps.fetchFn,
  );
  if (!delegate) return { ok: false, failed: "delegate_failed" };

  // Custody first (see the ordering note). B2's `put` audits itself, atomically with its own write.
  try {
    await deps.credentials.put(tenantId, delegate.accessToken, { actor: "system:shopify-install" });
  } catch {
    // The error is swallowed on purpose: it is raised by a component holding the token, and this function's
    // result is rendered to an attacker-reachable response.
    return { ok: false, failed: "custody_failed" };
  }

  // Task 5 (ADR-0022 F2/F6/F7) — capture the PARENT Admin offline token too, once one's caller has opted
  // in. THE F7 PROPERTY: this line is reached only after `pending.shopDomain !== shopDomain` was already
  // checked and found EQUAL, above — `pending.shopDomain` came from the SERVER-SIDE record keyed by the
  // signed, single-use `state` nonce, and `shopDomain` is the callback's own (HMAC-verified) `shop`. So a
  // callback whose shop disagrees with the shop `state` was minted for is refused (`shop_mismatch`) long
  // before this point, and `deps.adminTokens.put` — like `deps.credentials.put` above it — is simply never
  // reached for it. There is no SEPARATE "grant shop" to re-check: Shopify's token-exchange response
  // carries no shop field ([S1]/`exchangeInstallCode`), and the exchange itself was made against the
  // already-verified `shopDomain`, not an attacker-suppliable one. OPTIONAL and ADDITIVE: absent
  // `adminTokens` ⇒ zero behaviour change from before this task (the surrounding `try` for the delegate
  // token above deliberately does NOT also cover this — an Admin-token custody failure must not undo a
  // delegate token that is already safely stored, so it maps to its own outcome instead of `custody_failed`).
  // Task 12 (ADR-0022 F3) — this call custodies whatever Admin scopes the SAME OAuth grant above already
  // obtained (a delegate-token exchange); it does not itself request Admin scopes, so there is nothing here
  // yet to pin against `ADMIN_SYNC_SCOPES` (shopify-webhook-identity.ts) — the least-privilege
  // (`read_products`,`read_inventory`) scope set a PRODUCTION catalog-sync admin-token request should use.
  // Noted here as the landing spot: whichever task wires a real production Admin-token scope request
  // (Task 13) requests exactly `ADMIN_SYNC_SCOPES`, never a write scope (F3's own pin,
  // order-attribution-scope-pinning.test.ts).
  if (deps.adminTokens) {
    try {
      await deps.adminTokens.put(tenantId, grant.accessToken, { actor: "system:shopify-install", expiresAt: grant.expiresAt });
    } catch {
      // Never let an Admin-token custody failure surface the parent token in a response/log; same leak
      // boundary as every other catch in this function. A merchant who reaches here already has a working
      // delegate credential (servable for catalog reads), so this refuses the WHOLE install rather than
      // silently leaving Admin-token custody half-done and reporting success.
      return { ok: false, failed: "custody_failed" };
    }
  }

  // Shop-specific webhook registration — BEST-EFFORT / NON-FATAL, and only when the composition root
  // configured any subscriptions (absent ⇒ zero fetches; back-compat). Under the legacy install flow this
  // is how Shopify learns to push to `/shopify/webhooks/*`; but webhooks are only a freshness optimisation
  // with the scheduled poll as the backstop, so a failure here must NOT strand a merchant who already has
  // valid custody. `registerWebhookSubscriptions` never throws and re-validates the host before any fetch,
  // so the parent Admin token never egresses to a non-myshopify host. `grant.accessToken` is the PARENT
  // offline token (the one that can create subscriptions), not the delegate. The result is TALLIES ONLY —
  // closed-set topic names, never the token or a raw `userErrors` message — so folding it into the audit
  // record below records what happened without leaking anything (NN#5).
  const webhooks = deps.webhookSubscriptions?.length
    ? await registerWebhookSubscriptions(
        { shopDomain, parentAccessToken: grant.accessToken, subscriptions: deps.webhookSubscriptions },
        deps.fetchFn,
      )
    : { registered: [], failed: [] };

  // The audit input. PII/secret-free by construction and asserted as an EXACT key allowlist by test, so a
  // later "just record the code / the token / the hmac for debugging" change fails a test rather than
  // shipping. `delegateScopes` is recorded because WHAT privilege was granted is the governance-relevant
  // fact; the credential itself is not, and neither is anything derived from it.
  const auditInput = { tenantId, shopDomain, region: existing?.region ?? deps.region, delegateScopes: [...deps.delegateScopes] };
  // #179 — a reversalPath must name something that EXISTS and that an operator can run. It names the CLI
  // (jobs/merchant.ts) FIRST, exactly as armKill does (runtime-kill-registry.ts:66-70) and for the same
  // reason: deploy-staging.yml deploys `palup-widget-staging` only, and the control plane is deployed
  // nowhere, so no HTTP route or console may be named here. Revocation is a STATUS change, never a delete:
  // deleting the row would strand the tenant's per-tenant state in namespaces nothing reads.
  const reversalPath =
    'pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts status --tenant <tenantId> --status uninstalled ' +
    "(sets pl_merchant.status; the merchant becomes inert because every lookup is default-inert. " +
    "Re-run with --status active to restore. Never delete the row.)";

  const record: AuditInput = existing
    ? {
        actor: "system:shopify-install",
        action: "merchant.reactivated",
        input: auditInput,
        decision: { status: "active", previousStatus: existing.status, webhooks: { registered: webhooks.registered, failed: webhooks.failed } },
        reversalPath,
      }
    : {
        actor: "system:shopify-install",
        action: "merchant.registered",
        input: auditInput,
        decision: {
          status: "active",
          servable: false,
          reason: "serving still resolves tenancy from env vars (C1 is record-only)",
          webhooks: { registered: webhooks.registered, failed: webhooks.failed },
        },
        reversalPath,
      };

  try {
    // Audit BEFORE the write: an unauditable governed write must never persist (header note).
    await deps.store.audit({ tenantId }, record);
    if (existing) {
      // Reactivation, not re-creation — the port's own rule (merchant-registry-port.ts:127-128). The
      // embedKey and createdAt are preserved, so a storefront snippet that was already deployed keeps
      // working across an uninstall/re-install cycle.
      await deps.registry.setStatus(tenantId, "active", { reason: "app install (Shopify OAuth callback)" });
    } else {
      await deps.registry.create({
        tenantId,
        shopDomain,
        embedKey: deps.newEmbedKey ? deps.newEmbedKey() : `pk_${randomToken(24)}`,
        region: deps.region,
        // Left at the port's default (`full`) rather than threaded from `MERCHANT_GROUNDING_MODE`: that env
        // var is process-wide (server.ts:491-494) and adopting it here would let one process's setting
        // become a per-merchant durable decision for every merchant that installs while it is set.
      });
    }
  } catch {
    return { ok: false, failed: "registry_failed" };
  }
  return { ok: true, shopDomain };
}

/**
 * The merchant-facing landing page. It states plainly that the install is RECORDED and NOT SERVING —
 * #157's rule (stop shipping copy that promises something the system does not do) applies to a merchant
 * exactly as it does to a shopper. No parameter from the request is interpolated, so there is no injection
 * surface and no way for an attacker-supplied `shop` to be reflected.
 */
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>PalUp</title><body style="font-family:system-ui;padding:24px;max-width:34rem;color:#111"><h1 style="font-size:1.1rem">${title}</h1><p>${body}</p></body>`;
}

const OK_PAGE = page(
  "Install recorded",
  "Your store is registered with PalUp and your access has been stored securely. " +
    "<strong>The shopping assistant is not live on your storefront yet</strong> — serving is switched on " +
    "separately by PalUp. Nothing is shown to your shoppers until then.",
);
// One uniform refusal, with no hint about WHICH check failed: a distinguishable refusal would let an
// attacker probe HMAC vs state vs cookie vs timestamp independently.
const REFUSED_PAGE = page("We couldn't verify this request", "Please start the installation again from your Shopify admin.");
const FAILED_PAGE = page("We couldn't finish the installation", "Nothing was changed. Please try installing again in a few minutes.");

/**
 * Register the two routes. Called by the composition root ONLY when the feature is fully configured, which
 * includes credential custody being available — see the header. Both routes are GET, both are reachable by
 * anyone, and both validate before they trust.
 */
export function registerShopifyInstallRoutes(app: FastifyInstance, deps: ShopifyInstallDeps): void {
  /**
   * Per-IP cap, checked before any HMAC work. FAIL CLOSED, unlike `/widget/token`'s limiter, which
   * deliberately fails OPEN ("minting is cheap"): these routes accrue durable, audited credential custody,
   * so if the limiter itself is broken the right answer is to refuse, not to proceed uncapped.
   */
  const limited = async (req: { headers: Record<string, unknown>; ip: string }): Promise<boolean> => {
    if (!deps.checkRateLimit) return false;
    try {
      const xff = req.headers["x-forwarded-for"];
      const ipKey = clientIpKey(Array.isArray(xff) ? (xff[0] as string) : (xff as string | undefined), req.ip);
      return !(await deps.checkRateLimit(ipKey));
    } catch {
      return true;
    }
  };

  app.get("/shopify/install", async (req, reply) => {
    if (await limited(req)) {
      logRefusal("install", "rate_limited");
      reply.code(429).type("text/html");
      return REFUSED_PAGE;
    }
    const r = await startInstall(deps, (req.query ?? {}) as Record<string, unknown>);
    if (!r.ok) {
      logRefusal("install", r.refused);
      reply.code(400).type("text/html");
      return REFUSED_PAGE;
    }
    reply
      .header("set-cookie", stateCookie(r.state, r.ttlSeconds))
      // Never cache a redirect that carries a one-time nonce.
      .header("cache-control", "no-store")
      .header("location", r.authorizeUrl)
      .code(302)
      .send();
  });

  app.get("/shopify/callback", async (req, reply) => {
    if (await limited(req)) {
      logRefusal("callback", "rate_limited");
      reply.code(429).type("text/html");
      return REFUSED_PAGE;
    }
    const r = await completeInstall(deps, (req.query ?? {}) as Record<string, unknown>, req.headers.cookie);
    reply.type("text/html").header("cache-control", "no-store");
    // Clear the state cookie on every outcome: it is single-use, and leaving it set would keep a stale
    // nonce in the browser for its whole Max-Age.
    reply.header("set-cookie", `${INSTALL_STATE_COOKIE}=; Path=/shopify; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    if (r.ok) return OK_PAGE;
    if ("refused" in r) {
      logRefusal("callback", r.refused);
      reply.code(400);
      return REFUSED_PAGE;
    }
    logRefusal("callback", r.failed);
    reply.code(502);
    return FAILED_PAGE;
  });
}
