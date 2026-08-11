// Merchant registry port (ADR-0001; the `merchant` root tenant row of
// docs/design/data-model-and-tenancy.md §2). The ONLY way feature code resolves WHICH merchant a
// request belongs to, and whether that merchant may still be served. Adapters (this in-memory one now,
// a Postgres one behind the SAME contract next) implement it and swap behind it, so no engine- or
// commerce-vendor-specific API leaks into feature code (portability-guard, ADR-0001).
//
// NOTHING CALLS THIS YET. It is a Wave-0 definition: the first real caller is the Postgres adapter
// (work item B1) and then the OAuth install/uninstall routes (C1). Until those land, tenancy is still
// the env vars described below — this port does not fix that, it is the shape that lets it be fixed.
//
// WHAT A "TENANT" IS TODAY (env vars, all read at boot, all process-wide). The port's fields exist to
// carry exactly this, or it could not replace it:
//   - tenantId    — the value side of `WIDGET_EMBED_KEYS` (widget-backend/src/server.ts:249,545);
//                   falls back to the built-in "demo" tenant outside a real deployment (server.ts:53,125).
//   - embedKey    — the publishable key side of the same map, resolved to a tenant at token-mint time
//                   (server.ts:544-550) and on the widget HTML route (server.ts:628-629). NOT a secret.
//   - shopDomain  — `SHOPIFY_STORES`, a JSON `{tenant: "<shop>.myshopify.com"}` map
//                   (widget-backend/src/merchant-store.ts:20-33, forward lookup at :45-49). The REVERSE
//                   direction (shopDomain -> tenant) is rebuilt per request into a local object
//                   (server.ts:589-591) and handed to App-Proxy shopper verification
//                   (shopify-shopper-identity.ts:83,132).
//   - region      — `MERCHANT_REGION`, ONE value for the whole process, silently defaulting to "us"
//                   (server.ts:479-482). `consentMode` is DERIVED from it, not configured
//                   (server.ts:490) — so this port carries `region` and leaves that derivation with the
//                   consumer that owns the ADR-0015 policy, rather than duplicating it here.
//   - groundingMode — `MERCHANT_GROUNDING_MODE`, also process-wide (server.ts:491-494).
//   - status      — DOES NOT EXIST. There is no merchant lifecycle state anywhere in `packages/*/src`
//                   (searched for uninstall/revoke/suspend: the only hits are comms consent revocation
//                   and ADR-0018 per-SHOPPER OAuth grant revocation). A merchant who uninstalls stays
//                   servable forever. That is the gap `status` + the default-inert lookups below close.
//
// WHAT DELIBERATELY STAYS OUT: secret material. A merchant's Storefront/delegate token is read through
// `SecretsPort` (merchant-store.ts:16,47) and MUST keep being read there — the registry holds
// non-secret identity/config only, so a registry row is never a credential leak.
//
// WHY THIS IS NOT `RuntimeStatePort`. Every RuntimeStatePort method takes a `RuntimeStateCtx` whose sole
// member is `{tenantId}` (runtime-state-port.ts:15-18), and tenant isolation is that port's stated core
// guarantee. Merchant lookup is the one read that runs BEFORE a tenant is known — you arrive with a shop
// domain or an embed key and must find out whose it is. Expressing that on RuntimeStatePort would mean
// either a reserved pseudo-tenant holding a cross-tenant index (a hole punched straight through the
// isolation guarantee, and one an operator arming a per-tenant kill could not see) or a scan across
// tenants (which the port has no operation for, by design). So: a separate, deliberately narrow
// cross-tenant port whose whole surface is auditable, rather than a widened isolation boundary.
//
// AUDIT (NN#5): this port does NOT write the audit log — `RuntimeStatePort.audit` owns that chain, and
// it is tenant-scoped, which is right for a merchant-lifecycle event. `create`/`setStatus`/`update` are
// governance-relevant mutations, so the CALLER must audit them (a durable adapter should do it inside the
// same transaction). Stated here so the obligation is explicit rather than assumed.

/**
 * Merchant lifecycle state. The whole point of the field: `active` is the only state that gets served.
 * `suspended` (billing hold / abuse) and `uninstalled` (the merchant removed the app) are both INERT —
 * see `MerchantLookupOpts`.
 */
export type MerchantStatus = "active" | "suspended" | "uninstalled";

/** Data-residency / consent regime. Same value set as the brain's `Signals["region"]`. */
export type MerchantRegion = "us" | "eu" | "uk" | "other";

/** Merchant "discuss competitors / use catalog" mode. Same value set as `Signals["groundingMode"]`. */
export type MerchantGroundingMode = "off" | "general" | "full";

/** A merchant tenant. Non-secret by construction: no token, no key, nothing SecretsPort should own. */
export interface MerchantRecord {
  /** PalUp tenant id — the shard key every other port scopes by. */
  tenantId: string;
  /**
   * The merchant's storefront host, lowercased. A PLAIN STRING, never a commerce-vendor type
   * (CLAUDE.md §3 NN#3): `"acme.myshopify.com"` and `"shop.example.com"` are equally valid here, and
   * `*.myshopify.com` validation stays where it belongs — in the Shopify adapter that is about to make
   * a Shopify call (widget-backend/src/shopify-grounding.ts:88,117).
   */
  shopDomain: string;
  /** Publishable embed key that ships in the storefront snippet. Not a secret; unique across tenants. */
  embedKey: string;
  status: MerchantStatus;
  region: MerchantRegion;
  groundingMode: MerchantGroundingMode;
  /** Commercial plan, opaque to this port. */
  plan?: string;
  /**
   * The merchant's storefront domain as shoppers actually see it (Shopify calls this the "primary
   * domain"), if different from `shopDomain` (the `*.myshopify.com` host, which always keeps working
   * regardless of a custom domain). Non-secret identity/config, same class as `shopDomain` — a plain,
   * normalized (trim + lowercase) hostname, never a URL/scheme/path. Absent means "no custom domain
   * configured", which is a fact this port is authoritative about: a caller must never blend an absent
   * value with an env fallback (see `MerchantResolver.primaryDomainForShop`, widget-backend). Consumed
   * ONLY to widen the embeddable panel's `frame-ancestors` CSP so the widget renders on the merchant's
   * own storefront host — reached ONLY via a registry/env lookup keyed by an already-accepted shop
   * domain, never a second client-supplied parameter.
   */
  primaryDomain?: string;
  /** Operator-facing note for the CURRENT status (e.g. "app/uninstalled webhook"). Never secret. */
  statusReason?: string;
  /** ISO-8601. Set once at create and never rewritten. */
  createdAt: string;
  /** ISO-8601. Moves on every accepted mutation. */
  updatedAt: string;
}

/** Registration input. `region` is REQUIRED on purpose: today's silent `"us"` default (server.ts:481)
 *  is a residency decision made by an unset env var, which the legal review already flagged. A caller
 *  that does not know the region must find out, not inherit one. */
export interface NewMerchant {
  tenantId: string;
  shopDomain: string;
  embedKey: string;
  region: MerchantRegion;
  /** Defaults to `"full"` — the same default the env var it replaces has (server.ts:493). */
  groundingMode?: MerchantGroundingMode;
  plan?: string;
  /** See `MerchantRecord.primaryDomain`. Validated/normalized the same way on every write. */
  primaryDomain?: string;
  /** Defaults to `"active"`. Present so an adapter can seed a pre-provisioned/suspended row. */
  status?: MerchantStatus;
}

/** Mutable configuration. `status` is deliberately NOT here — revocation goes through `setStatus` so it
 *  is always a distinct, explicit, separately auditable call and can never be a field on a bulk patch. */
export interface MerchantUpdate {
  region?: MerchantRegion;
  groundingMode?: MerchantGroundingMode;
  plan?: string;
  /** See `MerchantRecord.primaryDomain`. Like `plan`, there is no flag that CLEARS it once set — set a
   *  new value to change it. */
  primaryDomain?: string;
}

export interface MerchantLookupOpts {
  /**
   * Default FALSE: a `suspended`/`uninstalled` merchant resolves to `null`. This is the fail-closed
   * default the repo keeps needing — a caller that never learned about `status` is INERT for a revoked
   * merchant instead of serving it, so revocation cannot be defeated by forgetting a check. Support,
   * audit, billing-reconciliation and erasure paths pass `true` and see the row plus its status.
   */
  includeInactive?: boolean;
}

export interface MerchantRegistryPort {
  /**
   * Register a merchant. Rejects a blank identifier, an unknown `region`, and any duplicate of
   * `tenantId` / `shopDomain` / `embedKey` — uniqueness on the latter two is what makes the reverse
   * lookups below sound (two tenants on one shop domain, or one embed key minting for two tenants, is a
   * cross-tenant isolation failure). A previously-uninstalled shop is reactivated with `setStatus`, not
   * re-created under a new tenant id.
   */
  create(input: NewMerchant): Promise<MerchantRecord>;
  /** By tenant id. `null` when absent or (by default) not `active`. Throws on a blank id. */
  lookupByTenantId(tenantId: string, opts?: MerchantLookupOpts): Promise<MerchantRecord | null>;
  /** The cross-tenant read: shop domain -> merchant, case-insensitively. Throws on a blank domain. */
  lookupByShopDomain(shopDomain: string, opts?: MerchantLookupOpts): Promise<MerchantRecord | null>;
  /** The other cross-tenant read: publishable embed key -> merchant, case-SENSITIVELY. */
  lookupByEmbedKey(embedKey: string, opts?: MerchantLookupOpts): Promise<MerchantRecord | null>;
  /**
   * The revocation path that does not exist today, and its reversal (NN#5): set lifecycle state, with an
   * operator-facing reason. Throws for an unknown tenant or an unknown status — it never creates a row
   * as a side effect. Reversible: `setStatus(t, "active")` restores servability.
   */
  setStatus(tenantId: string, status: MerchantStatus, opts?: { reason?: string }): Promise<MerchantRecord>;
  /** Patch configuration (region/groundingMode/plan). Throws for an unknown tenant or invalid value. */
  update(tenantId: string, patch: MerchantUpdate): Promise<MerchantRecord>;
}

const REGIONS: readonly MerchantRegion[] = ["us", "eu", "uk", "other"];
const GROUNDING_MODES: readonly MerchantGroundingMode[] = ["off", "general", "full"];
const STATUSES: readonly MerchantStatus[] = ["active", "suspended", "uninstalled"];

/** A blank identifier is a cross-tenant wildcard, not a query — reject it on every op (mirrors
 *  VectorPort's `requireNamespace` and RuntimeStatePort's tenant guard). Trims, so a stray space can
 *  never create a second row nothing can reach. */
function requireId(kind: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`MerchantRegistryPort: a non-blank ${kind} is required (a blank one is a cross-tenant wildcard)`);
  return value.trim();
}

/** Hosts are case-insensitive, so the registry stores and indexes one canonical form. Two rows differing
 *  only by case would be two tenants owning one store — the exact cross-tenant hazard the reverse index
 *  exists to prevent. */
function normalizeShopDomain(value: unknown): string {
  return requireId("shopDomain", value).toLowerCase();
}

/**
 * The exact hostname SHAPE the READ side requires immediately before CSP interpolation
 * (widget-backend/src/server.ts's `HOSTNAME_SHAPE`, restated here — `platform-ports` has no dependency on
 * `widget-backend`, and that file already re-applies its own copy as defense in depth, so duplicating the
 * pattern rather than importing it is deliberate, not an oversight). A bare, dotted hostname: each
 * label starts and ends with an alphanumeric (no leading/trailing hyphen), may hold internal hyphens, and
 * at least two labels are required (a dot) — no wildcard (`*`), no underscore, no scheme/path/port/query.
 *
 * Security follow-up (write/read alignment): before this existed, `normalizePrimaryDomain` was MORE
 * permissive than this shape — it rejected only whitespace/`/`/`;`/`:`, so `*.foo.com`, `foo_bar.com`,
 * `-foo.com`, `foo-.com`, or a bare single-label value like `localhost` would be ACCEPTED and STORED here,
 * then silently fail `HOSTNAME_SHAPE.test(custom)` at read time and never widen the CSP — a confusing,
 * deferred failure discovered on a support ticket instead of an immediate rejection at write/CLI time.
 * Applying the SAME regex on both sides closes that gap: a bad value now fails fast, here.
 */
const HOSTNAME_SHAPE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Custom-domain CSP support: validate + normalize a `primaryDomain` value (trim + lowercase, same as
 * `normalizeShopDomain`). Rejects anything that is not a bare, dotted hostname per `HOSTNAME_SHAPE` above
 * — which subsumes the original whitespace/`/`/`;`/`:` checks (none of those characters are in the
 * allowed label charset) and additionally rejects a wildcard, an underscore, a leading/trailing hyphen on
 * any label, and a bare single-label value. This is a SHARED gate, exported so every write path (this
 * port's in-memory adapter, the Postgres adapter's `create`/`update`) AND every read/interpolation path
 * (the merchant resolver, the panel route's CSP composition — widget-backend) apply the IDENTICAL check.
 * That second application is not redundant: a hand-edited `pl_merchant` row bypasses every TypeScript
 * writer, so the read side must not simply trust a stored string is still a bare hostname before it is
 * interpolated into a `Content-Security-Policy` header.
 */
export function normalizePrimaryDomain(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(
      "MerchantRegistryPort: primaryDomain must be a non-blank string (omit the field entirely to leave it unset)",
    );
  const trimmed = value.trim();
  if (!HOSTNAME_SHAPE.test(trimmed))
    throw new Error(
      `MerchantRegistryPort: primaryDomain ${JSON.stringify(trimmed)} is not a bare dotted hostname — it must ` +
        `not contain whitespace, "/", ";", ":", a wildcard ("*"), an underscore, or a leading/trailing hyphen on ` +
        `any label (no scheme, path, port, or query string) — this is the SAME shape the read side requires ` +
        `before CSP interpolation`,
    );
  return trimmed.toLowerCase();
}

function requireEnum<T extends string>(kind: string, allowed: readonly T[], value: unknown): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    throw new Error(
      `MerchantRegistryPort: ${kind} must be one of ${allowed.join(" | ")} — refusing to guess a default (fail closed)`,
    );
  return value as T;
}

function clone(rec: MerchantRecord): MerchantRecord {
  return { ...rec };
}

export interface InMemoryMerchantRegistryOpts {
  /** Injectable clock (ISO-8601) so createdAt/updatedAt are deterministic in tests. */
  now?: () => string;
}

/**
 * In-memory reference adapter — the DEV/TEST implementation and the behavioral oracle the Postgres
 * adapter (B1) must match, since both run `runMerchantRegistryPortContract`.
 *
 * Three null-prototype indexes (by tenantId, by normalized shopDomain, by embedKey) so an id like
 * `__proto__`/`constructor` cannot resolve an inherited value — the same hardening as the env
 * SecretsPort and the in-memory VectorPort. Records are copied on the way in and out, so a caller can
 * never mutate registry state by holding a returned object. A durable adapter gets the same guarantees
 * from UNIQUE constraints on (tenant_id), (lower(shop_domain)) and (embed_key).
 */
export function createInMemoryMerchantRegistry(opts: InMemoryMerchantRegistryOpts = {}): MerchantRegistryPort {
  const now = opts.now ?? (() => new Date().toISOString());
  const byTenant: Record<string, MerchantRecord> = Object.create(null);
  const tenantByDomain: Record<string, string> = Object.create(null);
  const tenantByEmbedKey: Record<string, string> = Object.create(null);

  const own = (map: Record<string, string>, key: string): string | undefined =>
    Object.hasOwn(map, key) ? map[key] : undefined;

  /** The one place the default-inert rule lives, so no lookup can accidentally skip it. */
  function visible(rec: MerchantRecord | undefined, lookupOpts?: MerchantLookupOpts): MerchantRecord | null {
    if (!rec) return null;
    if (!lookupOpts?.includeInactive && rec.status !== "active") return null;
    return clone(rec);
  }

  function mutate(tenantId: string, apply: (rec: MerchantRecord) => MerchantRecord): MerchantRecord {
    const id = requireId("tenantId", tenantId);
    const existing = Object.hasOwn(byTenant, id) ? byTenant[id] : undefined;
    if (!existing)
      throw new Error(`MerchantRegistryPort: no merchant "${id}" — refusing to create one as a side effect`);
    const next = { ...apply({ ...existing }), updatedAt: now() };
    byTenant[id] = next;
    return clone(next);
  }

  return {
    async create(input) {
      const tenantId = requireId("tenantId", input?.tenantId);
      const shopDomain = normalizeShopDomain(input?.shopDomain);
      const embedKey = requireId("embedKey", input?.embedKey);
      const region = requireEnum("region", REGIONS, input?.region);
      const groundingMode = requireEnum("groundingMode", GROUNDING_MODES, input?.groundingMode ?? "full");
      const status = requireEnum("status", STATUSES, input?.status ?? "active");
      // Validated BEFORE any row/index is touched (same discipline as every other field here) so a
      // rejected create is a pure no-op — no dangling tenant/domain/embedKey claim from a create that
      // failed on this field alone.
      const primaryDomain = input?.primaryDomain === undefined ? undefined : normalizePrimaryDomain(input.primaryDomain);

      if (Object.hasOwn(byTenant, tenantId))
        throw new Error(`MerchantRegistryPort: tenantId "${tenantId}" is already registered`);
      // A claimed domain stays claimed even while the merchant is uninstalled: handing the same shop to a
      // NEW tenantId would strand the first tenant's per-tenant state in namespaces nothing reads.
      const domainOwner = own(tenantByDomain, shopDomain);
      if (domainOwner !== undefined)
        throw new Error(
          `MerchantRegistryPort: shopDomain "${shopDomain}" is already registered to tenant "${domainOwner}" — ` +
            `reactivate it with setStatus("${domainOwner}", "active") rather than registering a second tenant for one shop`,
        );
      const keyOwner = own(tenantByEmbedKey, embedKey);
      if (keyOwner !== undefined)
        throw new Error(
          `MerchantRegistryPort: this embedKey is already registered to tenant "${keyOwner}" — a shared embed key ` +
            `would mint widget tokens for the wrong tenant`,
        );

      const at = now();
      const rec: MerchantRecord = {
        tenantId,
        shopDomain,
        embedKey,
        status,
        region,
        groundingMode,
        createdAt: at,
        updatedAt: at,
      };
      if (input?.plan !== undefined) rec.plan = input.plan;
      if (primaryDomain !== undefined) rec.primaryDomain = primaryDomain;
      byTenant[tenantId] = rec;
      tenantByDomain[shopDomain] = tenantId;
      tenantByEmbedKey[embedKey] = tenantId;
      return clone(rec);
    },

    async lookupByTenantId(tenantId, lookupOpts) {
      const id = requireId("tenantId", tenantId);
      return visible(Object.hasOwn(byTenant, id) ? byTenant[id] : undefined, lookupOpts);
    },

    async lookupByShopDomain(shopDomain, lookupOpts) {
      const domain = normalizeShopDomain(shopDomain);
      const tenantId = own(tenantByDomain, domain);
      return visible(tenantId !== undefined ? byTenant[tenantId] : undefined, lookupOpts);
    },

    async lookupByEmbedKey(embedKey, lookupOpts) {
      const key = requireId("embedKey", embedKey);
      const tenantId = own(tenantByEmbedKey, key);
      return visible(tenantId !== undefined ? byTenant[tenantId] : undefined, lookupOpts);
    },

    async setStatus(tenantId, status, statusOpts) {
      const next = requireEnum("status", STATUSES, status);
      return mutate(tenantId, (rec) => {
        rec.status = next;
        if (statusOpts?.reason !== undefined) rec.statusReason = statusOpts.reason;
        else delete rec.statusReason; // a new status without a reason must not inherit the old one's
        return rec;
      });
    },

    async update(tenantId, patch) {
      // Validate BEFORE mutating so a bad value leaves the row untouched.
      const region = patch?.region === undefined ? undefined : requireEnum("region", REGIONS, patch.region);
      const groundingMode =
        patch?.groundingMode === undefined ? undefined : requireEnum("groundingMode", GROUNDING_MODES, patch.groundingMode);
      const primaryDomain = patch?.primaryDomain === undefined ? undefined : normalizePrimaryDomain(patch.primaryDomain);
      return mutate(tenantId, (rec) => {
        if (region !== undefined) rec.region = region;
        if (groundingMode !== undefined) rec.groundingMode = groundingMode;
        if (patch?.plan !== undefined) rec.plan = patch.plan;
        if (primaryDomain !== undefined) rec.primaryDomain = primaryDomain;
        return rec;
      });
    },
  };
}
