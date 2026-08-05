import type {
  MerchantRecord,
  MerchantRegistryPort,
  MerchantStatus,
  RuntimeStatePort,
} from "@palup/platform-ports";

// D1 — THE CUTOVER. The ONE place the serving path decides (a) which merchant a request belongs to and
// (b) whether that merchant may still be served.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT CHANGED, PLAINLY. Before this file, `pl_merchant` (B1/#184) held rows that NOTHING on the serving
// path read. C1 (#189) chose option (a) — "C1 records the install. No merchant becomes servable" — so
// `/widget/token` resolved a tenant from `WIDGET_EMBED_KEYS` and `/chat` from a signed widget token, and
// C2's `app/uninstalled` (#191) wrote `status = "uninstalled"` faithfully **to a column nothing consulted**.
// A merchant who uninstalled stayed servable forever. That is what this file ends.
//
// WHAT IT STILL DOES NOT DO — the line, drawn explicitly rather than implied:
//   • `region` / `groundingMode` STAY PROCESS-WIDE ENV (`MERCHANT_REGION`, `MERCHANT_GROUNDING_MODE`,
//     server.ts:501-516). `MerchantRecord` carries both, so the data is right here in hand — but
//     `CONSENT_MODE` is derived from `MERCHANT_REGION` once at boot and returned on EVERY /chat response,
//     including the three early returns that fire BEFORE a tenant is known (oversize input, rate limit,
//     unauthenticated). Making it per-merchant means either a response field that disagrees with itself
//     across those paths or restructuring them. That is a separate, reviewable change (D2). What IS done
//     here instead: server.ts warns at boot when `SHOPIFY_INSTALL_REGION` (the residency an installing
//     merchant is recorded with) disagrees with `MERCHANT_REGION` (the residency they are SERVED with),
//     so the gap is observable rather than silent.
//   • THE STOREFRONT TOKEN STAYS IN `SecretsPort` (merchant-store.ts:16,47). This file resolves the shop
//     DOMAIN through the registry; the CREDENTIAL is still the hand-provisioned `shopify_storefront_token`.
//     B2's encrypted credential store (#186) is NOT read by serving. There is exactly ONE source of truth
//     for the token today and it is `SecretsPort` — see merchant-store.ts's own header for the consequence
//     (a merchant who installs through C1 gets FIXTURE grounding until an operator provisions their token).
//   • EVERY "for each tenant" JOB still enumerates `SHOPIFY_STORES` (jobs/catalog-index.ts:703,
//     jobs/retention-sweep.ts:91). Not an oversight and not a deferral by preference: `MerchantRegistryPort`
//     has NO enumeration operation at all (merchant-registry-port.ts:122-145 — create, three lookups,
//     setStatus, update). Migrating those jobs requires a new port method, which is a different change in a
//     different package. C3's finding therefore stands unfixed, and stands NAMED.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// THE PRECEDENCE RULE, STATED ONCE. Two different questions, two different postures — this asymmetry is
// the whole design, so it is spelled out rather than left to be inferred from the code:
//
//   RESOLUTION (an ALLOWLIST, at mint time — `resolveEmbedKey` / `tenantForShopDomain`)
//     1. the registry has an ACTIVE row for this key/domain            ⇒ that tenant. Registry wins.
//     2. the registry has a row and it is NOT active                   ⇒ REFUSE. Never fall through to env.
//     3. the registry could not be READ (it threw)                     ⇒ REFUSE. Never fall through to env.
//     4. the registry has NO row for this key/domain (or none is wired) ⇒ the env map, LOGGED + AUDITED.
//     5. neither                                                        ⇒ unknown ⇒ 401.
//
//   SERVABILITY (a DENY-LIST, per request — `servability`)
//     • a row exists for this tenant and is NOT active ⇒ refuse the request.
//     • no row (or no registry) ⇒ proceed, exactly as before D1.
//
// WHY SERVABILITY IS A DENY-LIST AND NOT AN ALLOWLIST. The servable set is already bounded at mint: a
// widget token only exists for a key the registry or the env map named. Making `/chat` ALSO demand a
// registry row would revoke every env-configured merchant the instant this shipped — including the `demo`
// tenant that the eval corpus, the e2e suite and the staging smoke gate (`deploy-staging.yml`: it mints
// `?key=demo-embed-key` and asserts a live `/chat`) all run against. So `/chat` asks the narrower question
// that is actually the point: "does the registry say this tenant must NOT be served?"
//
// WHY STEP 3 REFUSES INSTEAD OF FALLING BACK, and the cost of that choice. An unreadable registry is not
// an absent row — the same distinction `MerchantCredentialRead` draws between `unreadable` and `missing`
// ("NEVER treat this as `missing`", merchant-credential-store.ts:91-95). If a transient database fault fell
// through to env, a revoked merchant whose key an operator forgot to strip from `WIDGET_EMBED_KEYS` would be
// SERVED AGAIN by a database blip. THE COST, stated rather than buried: during a registry outage every mint
// fails, including merchants who were never revoked. That is a real availability regression on the happy
// path, and it is the same direction the rest of this path already leans — `allowRequest`'s per-tenant
// ceiling "fails-CLOSED" on a store error (rate-limit.ts:43-44,60-61) and `matchedKill` has no catch at all
// (runtime-kill-registry.ts:37-50), so a store fault already refuses turns today.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// #169 IS NOT REINTRODUCED. That PR fixed a fail-open where a typo'd `WIDGET_EMBED_KEYS` silently
// substituted `{"demo-embed-key":"demo"}` and collapsed every merchant's shoppers, sessions, audit log,
// telemetry, consent records and catalog onto the `demo` tenant. Its guard (`resolveEmbedKeys`, server.ts)
// is untouched and still refuses to BOOT on a malformed value. This file only ever makes resolution
// STRICTER: the env map is consulted last, and never at all for a key the registry has already claimed.
// A silent fallback is how #169 happened, so the fallback here is not silent — it emits a `[merchant]` log
// line naming the tenant and the variable, it appends ONE audit record per tenant per hour, and the mode is
// reported on `GET /health` as `merchants`.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// AUDIT (NN#5), AND THE ATOMICITY THIS DOES NOT CLAIM. C1 found that `MerchantRegistryPort` exposes no
// transaction handle, so an atomic audit-with-write is unreachable through the port; it used audit-first and
// documented both failure modes (routes/shopify-install.ts:57-68). The same limitation applies here, but the
// ORDERING TRADE IS THE OPPOSITE WAY ROUND, on purpose:
//
//   C1 audits a governed WRITE, so an audit failure must ABORT (an unaudited governed write is forbidden).
//   This file audits a governed DENIAL. A denial that could be defeated by an audit failure would be a
//   fail-open — so here the refusal ALWAYS stands and an audit failure is logged and swallowed. Refusing
//   without a record is strictly safer than serving with one.
//
// Both audited events are DEDUPED to one row per (tenant, surface) per hour through a TTL'd marker in the
// tenant-scoped KV — the same mechanism C2's webhook `markHandled` uses. `/widget/token` and `/chat` are
// unauthenticated and attacker-reachable, and the audit chain is immutable and non-trimmable, so an
// undeduped record here would be an append primitive. The tenant set is itself bounded (a tenant id only
// ever arrives from a registry row, the operator's env map, or a signed widget token), so the total row rate
// is bounded by (merchants × surfaces) per hour, not by request volume.
//
// NO PII, NO SECRETS. A tenant id, a merchant status and a closed-set surface literal are the entire audit
// input. `embedKey` is publishable (merchant-registry-port.ts:74) but is still NEVER logged or audited here:
// it is not needed to act on the record, and the tenant id is.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/** KV collection holding the TTL'd audit-dedup markers. Non-secret; one row per (tenant, surface). */
export const MERCHANT_RESOLUTION_COLLECTION = "merchant_resolution_seen";
/** One audit row per tenant per surface per hour. Long enough to bound an attacker, short enough that a
 *  genuine, persisting misconfiguration keeps re-appearing in the chain instead of being recorded once. */
export const MERCHANT_RESOLUTION_AUDIT_TTL_SECONDS = 3_600;

/** The operator entry point every reversal path below names — `jobs/merchant.ts` (#179's rule: a
 *  reversalPath must name something that EXISTS and that an operator can run). Kept byte-identical to the
 *  string C2's own revocation audit uses, so an operator sees ONE command, not two dialects. */
export const MERCHANT_CLI = "pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts";

/** Where a tenant id came from. Reported so a refusal or a fallback is attributable. */
export type MerchantSource = "registry" | "env";

/**
 * Which serving surface asked. A CLOSED set of literals, never caller-supplied text: these values reach a
 * log line and an audit record, so nothing attacker-influenced may appear among them (the same discipline
 * as `Refusal` in routes/shopify-install.ts:143-156).
 */
export type ResolutionSurface = "embed-key-mint" | "chat" | "shopper-session" | "customer-login";

/** The outcome of resolving an embed key or a shop domain to a tenant. */
export type TenantResolution =
  | { kind: "ok"; tenantId: string; source: MerchantSource; record?: MerchantRecord }
  /** A row exists and it is not `active`. Distinct from `unknown` so a caller cannot conflate "revoked"
   *  with "never heard of them" and reach for the env map. */
  | { kind: "revoked"; tenantId: string; status: MerchantStatus }
  | { kind: "unknown" }
  /** The registry threw. NOT `unknown` — see the header on why an unreadable registry fails closed. */
  | { kind: "error" };

/** The outcome of the per-request revocation check. */
export type Servability =
  | { kind: "servable"; source: MerchantSource; record?: MerchantRecord }
  | { kind: "revoked"; tenantId: string; status: MerchantStatus }
  | { kind: "error" };

export interface MerchantResolverDeps {
  /** For the audit chain + the TTL'd dedup marker. Tenant-scoped, as every RuntimeStatePort call is. */
  store: RuntimeStatePort;
  /**
   * The durable registry, when one is wired. ABSENT in local/dev/test and in any deployment without
   * `DATABASE_URL` — server.ts only constructs a `PostgresMerchantRegistry` when the runtime store opened a
   * pool. Absent ⇒ this resolver is pure env and behaves exactly as the code did before D1, which is what
   * keeps `pnpm backend`, the e2e suite and the eval corpus unchanged.
   */
  registry?: MerchantRegistryPort;
  /** `WIDGET_EMBED_KEYS`, already validated + null-prototyped by `resolveEmbedKeys` (server.ts). */
  embedKeys: Record<string, string>;
  /** `SHOPIFY_STORES`, read per call (not captured) so it stays a function like `parseStoreDomains`. */
  storeDomains: () => Record<string, string>;
}

export interface MerchantResolver {
  /** `"registry+env"` / `"registry"` / `"env"` — surfaced on `GET /health` so an operator can see whether
   *  the env fallback is armed at all without reading the deploy workflow. */
  readonly resolutionMode: "registry+env" | "registry" | "env";
  /** Publishable embed key → tenant, by the ALLOWLIST rule in the header. */
  resolveEmbedKey(key: unknown, surface: ResolutionSurface): Promise<TenantResolution>;
  /** The per-request DENY-LIST check: is this already-identified tenant still servable? */
  servability(tenantId: string, surface: ResolutionSurface): Promise<Servability>;
  /** Tenant → its storefront host. `undefined` covers BOTH "revoked" and "not configured", because every
   *  caller treats both the same way (404 / fixtures) and neither may be served. */
  shopDomainFor(tenantId: string): Promise<string | undefined>;
  /** Shop host → tenant, case-insensitively (hosts are case-insensitive; the registry indexes
   *  `lower(shop_domain)` — postgres-merchant-registry.ts:220-222). */
  tenantForShopDomain(shopDomain: unknown): Promise<TenantResolution>;
}

/** Own-property read against a null-prototype map, so `__proto__`/`constructor` can never resolve a
 *  tenant. Mirrors `resolveEmbedKeys`'s own hardening (server.ts) and the in-memory registry's. */
function own(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** A non-blank string, or `undefined`. Guards the registry calls, which THROW on a blank identifier
 *  ("a blank one is a cross-tenant wildcard", merchant-registry-port.ts:154-158) — so a blank key is
 *  rejected here, before it can become an exception that a caller might read as `error`. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createMerchantResolver(deps: MerchantResolverDeps): MerchantResolver {
  const { store, registry, embedKeys, storeDomains } = deps;
  const envHasKeys = Object.keys(embedKeys).length > 0;

  /** Log-once-per-process de-dup, so a busy fallback cannot flood the log (the audit chain has its own,
   *  durable, TTL'd dedup). Per process is right for a LOG: a restart should say it again. */
  const logged = new Set<string>();
  const logOnce = (dedupKey: string, emit: () => void): void => {
    if (logged.has(dedupKey)) return;
    logged.add(dedupKey);
    emit();
  };

  /**
   * A registry read that failed. The driver's message is NEVER echoed: it can carry a connection string,
   * a shop domain or an operator-configured value, and this text lands in a boot/serving log. The surface
   * and the operation are enough to act on.
   */
  const logRegistryFailure = (op: string, surface: string): void => {
    console.error(
      `[merchant] registry lookup (${op}) FAILED while resolving for ${surface} — refusing to resolve. ` +
        `An unreadable registry is NOT an absent row, so the ${surface} request fails closed rather than ` +
        `falling through to WIDGET_EMBED_KEYS/SHOPIFY_STORES (a revoked merchant must not be resurrected ` +
        `by a database fault).`,
    );
  };

  /**
   * Append one audit row per (tenant, surface, kind) per TTL. Never throws: see the header on why a
   * governed DENIAL must not be defeated by an audit failure. Best-effort ordering — the marker is written
   * AFTER the audit, so a crash between them re-audits (a duplicate row) rather than losing the record.
   */
  const auditOnce = async (
    tenantId: string,
    dedupKey: string,
    build: () => Parameters<RuntimeStatePort["audit"]>[1],
  ): Promise<void> => {
    const ctx = { tenantId };
    try {
      if ((await store.get(ctx, MERCHANT_RESOLUTION_COLLECTION, dedupKey)) !== null) return;
      await store.audit(ctx, build());
      await store.put(ctx, MERCHANT_RESOLUTION_COLLECTION, dedupKey, { at: new Date().toISOString() }, {
        ttlSeconds: MERCHANT_RESOLUTION_AUDIT_TTL_SECONDS,
      });
    } catch {
      // Swallowed deliberately, and it is the whole point of `auditOnce` being fire-and-forget: the caller
      // has ALREADY decided to refuse (or to fall back). Letting this throw would turn an unavailable audit
      // chain into either a 500 or — worse, if a caller caught it and continued — a served revoked merchant.
      console.error(
        `[merchant] could not record the resolution decision for tenant "${tenantId}" in the audit chain ` +
          `(${dedupKey}); the decision itself STANDS and is unaffected.`,
      );
    }
  };

  const auditRefusal = (tenantId: string, status: MerchantStatus, surface: ResolutionSurface): Promise<void> =>
    auditOnce(tenantId, `refused:${surface}`, () => ({
      actor: "system:merchant-resolver",
      action: "merchant.serving_refused",
      input: { tenantId, status, surface },
      decision: {
        served: false,
        reason: `the merchant registry reports status "${status}"; only "active" is servable`,
      },
      reversalPath:
        `${MERCHANT_CLI} status --tenant ${tenantId} --status active ` +
        `(restores servability; the row, its embedKey and its createdAt were never deleted, so a storefront ` +
        `snippet that is already deployed starts working again. A genuine re-install through ` +
        `/shopify/callback reactivates it the same way. Never delete the row.)`,
    }));

  const auditEnvFallback = (tenantId: string, surface: ResolutionSurface, variable: string): Promise<void> =>
    auditOnce(tenantId, `env:${surface}`, () => ({
      actor: "system:merchant-resolver",
      action: "merchant.resolved_from_env",
      input: { tenantId, surface, variable },
      decision: {
        served: true,
        source: "env",
        reason: `no pl_merchant row names this tenant, so ${variable} resolved it (the named D1 fallback)`,
      },
      reversalPath:
        `Remove this tenant from ${variable} in the deployment env to stop serving it from config, or ` +
        `register it durably by completing the Shopify app install (GET /shopify/install), after which the ` +
        `registry takes precedence and ${MERCHANT_CLI} status --tenant ${tenantId} --status uninstalled ` +
        `revokes it.`,
    }));

  /** The one registry read for a tenant id, with the fail-closed error posture applied once. */
  const rowFor = async (
    tenantId: string,
    surface: string,
  ): Promise<{ ok: true; record: MerchantRecord | null } | { ok: false }> => {
    if (!registry) return { ok: true, record: null };
    try {
      // `includeInactive: true` ON PURPOSE, and it is load-bearing: the DEFAULT-inert lookup would return
      // `null` for a revoked merchant, which this resolver could not tell apart from "no row" — and "no row"
      // is exactly the case that falls through to the env map. Reading the row and branching on `status`
      // here is what makes revocation beat the fallback (the same reason C2's webhook handlers pass it:
      // routes/shopify-webhooks.ts:252-263).
      return { ok: true, record: await registry.lookupByTenantId(tenantId, { includeInactive: true }) };
    } catch {
      logRegistryFailure("lookupByTenantId", surface);
      return { ok: false };
    }
  };

  const servability = async (tenantIdRaw: string, surface: ResolutionSurface): Promise<Servability> => {
    const tenantId = nonBlank(tenantIdRaw);
    // A blank tenant is a cross-tenant wildcard, not a query. It cannot arrive from a signed widget token
    // or a registry row, so this is a guard against a future caller, not a live path.
    if (!tenantId) return { kind: "error" };
    const row = await rowFor(tenantId, surface);
    if (!row.ok) return { kind: "error" };
    if (!row.record) return { kind: "servable", source: "env" }; // no row ⇒ env-configured ⇒ unchanged
    if (row.record.status !== "active") {
      void auditRefusal(tenantId, row.record.status, surface);
      return { kind: "revoked", tenantId, status: row.record.status };
    }
    return { kind: "servable", source: "registry", record: row.record };
  };

  return {
    resolutionMode: registry ? (envHasKeys ? "registry+env" : "registry") : "env",

    async resolveEmbedKey(keyRaw, surface) {
      const key = nonBlank(keyRaw);
      if (!key) return { kind: "unknown" };

      if (registry) {
        let row: MerchantRecord | null;
        try {
          // Case-SENSITIVE by contract: an embed key is an opaque publishable identifier, not a host
          // (merchant-registry-port.ts:136). `includeInactive` for the same reason as `rowFor`.
          row = await registry.lookupByEmbedKey(key, { includeInactive: true });
        } catch {
          logRegistryFailure("lookupByEmbedKey", surface);
          return { kind: "error" };
        }
        if (row) {
          if (row.status !== "active") {
            void auditRefusal(row.tenantId, row.status, surface);
            return { kind: "revoked", tenantId: row.tenantId, status: row.status };
          }
          return { kind: "ok", tenantId: row.tenantId, source: "registry", record: row };
        }
      }

      const envTenant = own(embedKeys, key);
      if (!envTenant) return { kind: "unknown" };
      // The env map named a tenant — but the registry may still have revoked THAT TENANT under a different
      // embed key (a merchant who re-installed, got a fresh key, then uninstalled, while an operator left
      // the old key in `WIDGET_EMBED_KEYS`). Without this second check the mint would succeed and only
      // `/chat` would refuse, which is a worse, later, more confusing failure.
      const s = await servability(envTenant, surface);
      if (s.kind === "error") return { kind: "error" };
      if (s.kind === "revoked") return { kind: "revoked", tenantId: envTenant, status: s.status };

      logOnce(`env:${surface}:${envTenant}`, () =>
        console.warn(
          `[merchant] tenant "${envTenant}" resolved from the WIDGET_EMBED_KEYS ENV FALLBACK for ` +
            `${surface} — no pl_merchant row claims this embed key. This is the named D1 fallback, not an ` +
            `error: it is how the built-in demo tenant and any hand-configured merchant keep serving. It is ` +
            `logged because a fallback nobody can see is how #169 happened.`,
        ),
      );
      void auditEnvFallback(envTenant, surface, "WIDGET_EMBED_KEYS");
      const out: TenantResolution = { kind: "ok", tenantId: envTenant, source: "env" };
      if (s.kind === "servable" && s.record) out.record = s.record;
      return out;
    },

    servability,

    async shopDomainFor(tenantIdRaw) {
      const tenantId = nonBlank(tenantIdRaw);
      if (!tenantId) return undefined;
      const row = await rowFor(tenantId, "grounding");
      if (!row.ok) return undefined; // fail closed: an unreadable registry must not fall back to env
      if (row.record) {
        // A revoked merchant resolves to NOTHING — never to the env host. Otherwise a stale `SHOPIFY_STORES`
        // entry would keep pulling a revoked merchant's live catalog into prompts.
        return row.record.status === "active" ? row.record.shopDomain : undefined;
      }
      return own(storeDomains(), tenantId);
    },

    async tenantForShopDomain(shopDomainRaw) {
      const raw = nonBlank(shopDomainRaw);
      if (!raw) return { kind: "unknown" };
      const shopDomain = raw.toLowerCase();

      if (registry) {
        let row: MerchantRecord | null;
        try {
          row = await registry.lookupByShopDomain(shopDomain, { includeInactive: true });
        } catch {
          logRegistryFailure("lookupByShopDomain", "shop-domain");
          return { kind: "error" };
        }
        if (row) {
          if (row.status !== "active") return { kind: "revoked", tenantId: row.tenantId, status: row.status };
          return { kind: "ok", tenantId: row.tenantId, source: "registry", record: row };
        }
      }

      // The reverse env map, rebuilt per call from the forward one (the same thing server.ts's
      // `/shopper/session` did inline before D1), lowercased on BOTH sides so a case-variant host in
      // `SHOPIFY_STORES` still matches. Null-proto so no `__proto__` key can resolve a tenant.
      const reverse: Record<string, string> = Object.create(null);
      for (const [tenant, domain] of Object.entries(storeDomains())) {
        if (typeof domain === "string" && domain) reverse[domain.toLowerCase()] = tenant;
      }
      const envTenant = own(reverse, shopDomain);
      if (!envTenant) return { kind: "unknown" };
      const s = await servability(envTenant, "shopper-session");
      if (s.kind === "error") return { kind: "error" };
      if (s.kind === "revoked") return { kind: "revoked", tenantId: envTenant, status: s.status };
      return { kind: "ok", tenantId: envTenant, source: "env" };
    },
  };
}
