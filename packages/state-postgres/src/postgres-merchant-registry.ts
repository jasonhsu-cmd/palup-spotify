import { normalizePrimaryDomain } from "@palup/platform-ports";
import type {
  MerchantGroundingMode,
  MerchantLookupOpts,
  MerchantRecord,
  MerchantRegion,
  MerchantRegistryPort,
  MerchantStatus,
  MerchantUpdate,
  NewMerchant,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Postgres adapter for MerchantRegistryPort (work item B1; ADR-0001 portability, ADR-0004 engine
// choice). The durable twin of `createInMemoryMerchantRegistry`, which is the behavioral ORACLE: both run
// `runMerchantRegistryPortContract`, so the engine stays swappable and feature code never learns which
// adapter it got.
//
// NOTHING CALLS THIS YET — and that matters, so it is written here rather than only in a PR body. The port
// (merchant-registry-port.ts) shipped uncalled; this adapter ships uncalled too. Production tenancy is
// STILL the env vars the port's header enumerates (`WIDGET_EMBED_KEYS`, `SHOPIFY_STORES`,
// `MERCHANT_REGION`, `MERCHANT_GROUNDING_MODE`), and a merchant who uninstalls is STILL servable forever,
// because nothing reads `pl_merchant`. The first real caller is the OAuth install/uninstall routes (C1).
// Do not read this file as "merchant lifecycle is handled now"; read it as "the storage for it exists".
// Deliberately NOT included: an env-driven composition root (`createMerchantRegistry`, the sibling of
// factory.ts / vector-factory.ts). Picking between env-var tenancy and this table is C1's cutover
// decision, and a factory with no caller would be one more piece of unreachable machinery.
//
// WHY A DEDICATED TABLE AND NOT `rs_kv`: the whole point of this port is the read that happens BEFORE a
// tenant is known (shopDomain/embedKey -> tenantId), and every RuntimeStatePort statement is scoped by
// `tenant_id` by design (postgres-runtime-store.ts:20-24). Squeezing a cross-tenant index into `rs_kv`
// would mean a reserved pseudo-tenant row holding other tenants' identities — a hole through the one
// isolation guarantee that port makes. So: its own narrow table, whose entire surface is this file.
//
// THIS IS A CROSS-TENANT READER, ON PURPOSE. Two properties therefore get engine-level (not just
// app-level) enforcement, because "returns the wrong merchant" here is a cross-tenant breach, not a bug:
//
//   1. UNIQUENESS of the reverse keys. The app-level pre-check in `create` is NOT sufficient on its own:
//      check-then-insert is racy, and two concurrent installs of the same shop (a retried Shopify
//      redirect, a double-clicked install) can both pass the check. Only `UNIQUE` in the engine is sound
//      under concurrency, and only the engine can also stop a writer that never went through this
//      adapter (a migration script, a support fix, a future caller that forgot to lowercase). The domain
//      index is on `lower(shop_domain)` — the FUNCTIONAL form the port's own note asks for
//      (merchant-registry-port.ts:192) — so a case-variant row is refused even when the writer skipped
//      normalisation. `embed_key` is unique case-SENSITIVELY, matching the port's case-sensitive lookup.
//      Cost of being wrong in the other direction (no constraint): `lookupByShopDomain` would return
//      whichever duplicate row the planner happened to emit first — a silent, non-deterministic
//      wrong-tenant resolution on a shopper request. That asymmetry is why the constraint is not
//      optional.
//   2. AMBIGUITY FAILS CLOSED. Even with the index, a reverse lookup reads `LIMIT 2` and THROWS if two
//      rows come back, instead of returning `rows[0]`. If the invariant is ever violated (a table created
//      by older/hand-rolled DDL, an index that was never built), the honest outcome is a loud error, not
//      an arbitrary tenant. `migrate()` inherits the same posture: it cannot build the unique index over
//      duplicate rows, so it surfaces that instead of continuing as if the invariant held.
//
// SQL INJECTION: every VALUE below — including `shopDomain`, which arrives from a Shopify redirect in C1
// and is therefore externally influenced — is a BOUND `$n` parameter. Being exact rather than sweeping:
// the statements DO template-substitute one thing, the module-level `COLUMNS` constant (a fixed column
// list, defined in this file, never derived from input — the same shape of substitution
// postgres-runtime-store.ts:220-224 already uses for its `base` query text). No caller-supplied string
// ever reaches query text: the only per-call input is the parameter array. Same discipline as
// postgres-runtime-store.ts / postgres-vector-store.ts.
//
// NO SECRETS IN THIS TABLE. `pl_merchant` holds non-secret identity/config only. A merchant's
// Storefront/delegate token stays in `SecretsPort` (widget-backend/src/merchant-store.ts:16,47) and must
// never be added as a column here; `embed_key` is the PUBLISHABLE key that ships in the storefront
// snippet (merchant-registry-port.ts:74), not a credential. The column set is asserted as an exact
// allowlist in the tests so a later "just stash the token here" change fails a test instead of quietly
// turning a plain table into a credential store.
//
// AUDIT (NN#5): this adapter writes NO audit records, exactly as the port specifies
// (merchant-registry-port.ts:45-48) — `RuntimeStatePort.audit` owns that chain and is tenant-scoped.
// `create`/`setStatus`/`update` are governance-relevant mutations, so C1 (the first caller) MUST audit
// them, ideally inside the same transaction. Recording that obligation here so it is not assumed
// discharged by this file.
//
// TIMESTAMPS come from the app clock (injectable for tests), like the in-memory oracle, so `createdAt`/
// `updatedAt` are exactly the ISO-8601 strings the port promises and round-trip byte-identically. That
// accepts app/DB clock skew — acceptable because these two fields are informational: nothing orders,
// expires or gates on them. Contrast `rs_kv.expires_at`, which the runtime store computes on the DB clock
// precisely because TTL correctness depends on it (postgres-runtime-store.ts:84-90).

/**
 * The port's own enum value lists are module-private (merchant-registry-port.ts:147-149), so an adapter
 * must restate them. Stated as `Record<Union, true>` rather than an array so TypeScript FAILS TO COMPILE
 * here if the port's union ever gains a member — a silently-stale list in a cross-tenant resolver is the
 * kind of divergence that ends up serving the wrong merchant. The DDL's CHECK constraints spell the same
 * values out literally (never interpolated), and a test asserts the two agree for every member.
 */
const STATUSES: Record<MerchantStatus, true> = { active: true, suspended: true, uninstalled: true };
const REGIONS: Record<MerchantRegion, true> = { us: true, eu: true, uk: true, other: true };
const GROUNDING_MODES: Record<MerchantGroundingMode, true> = { off: true, general: true, full: true };

/** Mirrors the port's private `requireId` (merchant-registry-port.ts:154-158) exactly, INCLUDING the trim:
 *  a blank identifier is a cross-tenant wildcard, not a query, and a stray space must not create a second
 *  row nothing can reach. Parity with the oracle is asserted by test, since the guard cannot be shared. */
function requireId(kind: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`MerchantRegistryPort: a non-blank ${kind} is required (a blank one is a cross-tenant wildcard)`);
  return value.trim();
}

/** Mirrors the port's private `normalizeShopDomain`: trim + lowercase, nothing else.
 *
 *  KNOWN GAP, DELIBERATELY NOT PAPERED OVER HERE: a trailing DNS root dot is not stripped, so
 *  `"acme.myshopify.com."` and `"acme.myshopify.com"` are two distinct keys and can be registered by two
 *  different tenants even though DNS treats them as one host. Normalising it in THIS adapter would fork
 *  behaviour from the in-memory oracle (the contract's own reference), which is worse than the gap — one
 *  adapter silently accepting/refusing what the other does not is exactly the class of divergence the
 *  shared contract exists to catch. If trailing-dot equivalence is wanted it belongs in the port's
 *  `normalizeShopDomain`, where every adapter inherits it; reported for follow-up rather than fixed
 *  locally. (Whether a Shopify redirect can even deliver such a host is C1's input-validation problem.) */
function normalizeShopDomain(value: unknown): string {
  return requireId("shopDomain", value).toLowerCase();
}

/** Mirrors the port's private `requireEnum`. `Object.hasOwn` (not `in`) so `"constructor"`/`"__proto__"`
 *  cannot resolve an inherited member — the same hardening the in-memory adapter's null-prototype maps
 *  give it. */
function requireEnum<T extends string>(kind: string, allowed: Record<T, true>, value: unknown): T {
  if (typeof value !== "string" || !Object.hasOwn(allowed, value))
    throw new Error(
      `MerchantRegistryPort: ${kind} must be one of ${Object.keys(allowed).join(" | ")} — refusing to guess a default (fail closed)`,
    );
  return value as T;
}

interface MerchantRow {
  tenant_id: string;
  shop_domain: string;
  embed_key: string;
  status: string;
  region: string;
  grounding_mode: string;
  plan: string | null;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
  /** Custom-domain CSP support (merchant-registry-port.ts's `primaryDomain`). Nullable, non-secret. */
  primary_domain: string | null;
}

const COLUMNS =
  "tenant_id, shop_domain, embed_key, status, region, grounding_mode, plan, status_reason, created_at, updated_at, primary_domain";

/** The ONE row -> record mapping, used by every read AND by `create`'s `RETURNING` — so what a caller gets
 *  back from `create` is byte-identical to what a later lookup returns (no second, drifting projection).
 *  NULL columns become ABSENT keys, not `null`, matching the oracle's shape under `toStrictEqual`. */
function toRecord(row: MerchantRow): MerchantRecord {
  const rec: MerchantRecord = {
    tenantId: row.tenant_id,
    shopDomain: row.shop_domain,
    embedKey: row.embed_key,
    // The write path validates these, and the CHECK constraints hold the line in the engine. A row that
    // still carried something else would be inert anyway: `visible()` serves ONLY `active`.
    status: row.status as MerchantStatus,
    region: row.region as MerchantRegion,
    groundingMode: row.grounding_mode as MerchantGroundingMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.plan !== null) rec.plan = row.plan;
  if (row.status_reason !== null) rec.statusReason = row.status_reason;
  if (row.primary_domain !== null) rec.primaryDomain = row.primary_domain;
  return rec;
}

/** The ONE place the default-inert rule lives, mirroring the oracle's `visible()` (merchant-registry-
 *  port.ts:203-208), so no lookup below can accidentally skip it. Applied in JS AFTER the row is fetched,
 *  not folded into the SQL predicate, on purpose: a `status='active'` predicate would also hide a
 *  duplicate-key row whose twin is inactive, and the ambiguity check must see EVERY row for the key. */
function visible(row: MerchantRow | undefined, opts?: MerchantLookupOpts): MerchantRecord | null {
  if (!row) return null;
  if (!opts?.includeInactive && row.status !== "active") return null;
  return toRecord(row);
}

export interface PostgresMerchantRegistryOpts {
  /** Injectable clock (ISO-8601), same knob as the in-memory adapter, so timestamps are deterministic. */
  now?: () => string;
}

export class PostgresMerchantRegistry implements MerchantRegistryPort {
  private readonly now: () => string;

  constructor(
    private readonly sql: Sql,
    opts: PostgresMerchantRegistryOpts = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /**
   * Create the table + its unique indexes if absent. Idempotent; run at startup / in a migration step,
   * exactly like `PostgresRuntimeStore.migrate()` and `PostgresVectorStore.migrate()`. NOT a new cloud
   * resource — one more table in the existing database.
   *
   * One statement per call so it works on node-postgres and the in-process test engine alike. The CHECK
   * constraints ride along in `CREATE TABLE`; Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so a table
   * left over from a DIFFERENT, older DDL would not retroactively gain them — there is no such table
   * today (no code in this repo has ever created `pl_merchant` before this file), and the reverse-key
   * indexes, which are the security-relevant part, ARE applied retroactively by
   * `CREATE UNIQUE INDEX IF NOT EXISTS`. If duplicate rows already made the invariant false, that index
   * creation FAILS and `migrate()` throws — the intended outcome: a boot that cannot guarantee
   * one-shop-one-tenant should be loud, not quietly serve ambiguous lookups.
   */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS pl_merchant (
         tenant_id text PRIMARY KEY CHECK (btrim(tenant_id) <> ''),
         shop_domain text NOT NULL CHECK (btrim(shop_domain) <> ''),
         embed_key text NOT NULL CHECK (btrim(embed_key) <> ''),
         status text NOT NULL CHECK (status IN ('active','suspended','uninstalled')),
         region text NOT NULL CHECK (region IN ('us','eu','uk','other')),
         grounding_mode text NOT NULL CHECK (grounding_mode IN ('off','general','full')),
         plan text,
         status_reason text,
         created_at text NOT NULL,
         updated_at text NOT NULL)`,
    );
    // The two reverse-lookup invariants, enforced by the engine (see the file-level note). `lower()` is
    // functional so a writer that skipped normalisation still cannot claim a second case-variant of a
    // shop that is already taken.
    await this.sql.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS pl_merchant_shop_domain_uq ON pl_merchant (lower(shop_domain))",
    );
    await this.sql.query("CREATE UNIQUE INDEX IF NOT EXISTS pl_merchant_embed_key_uq ON pl_merchant (embed_key)");
    // Custom-domain CSP support, added AFTER this table already shipped — `CREATE TABLE IF NOT EXISTS`
    // above does NOT retroactively add a column to a table that already exists (this file's own
    // limitation note, above), so an existing `pl_merchant` needs an explicit `ALTER TABLE`. Idempotent
    // (`ADD COLUMN IF NOT EXISTS`), so re-running this on every boot is free, exactly like the rest of
    // `migrate()`. Nullable + no CHECK: absent means "no custom domain configured" (the port's own rule),
    // and the app-level `normalizePrimaryDomain` — applied on every write AND read — is the actual guard;
    // this column only needs to exist.
    await this.sql.query("ALTER TABLE pl_merchant ADD COLUMN IF NOT EXISTS primary_domain text");
  }

  async create(input: NewMerchant): Promise<MerchantRecord> {
    // Validate EVERYTHING before touching the database, in the oracle's order, so a rejected create is a
    // pure no-op and its message does not depend on which constraint the engine happened to hit first.
    const tenantId = requireId("tenantId", input?.tenantId);
    const shopDomain = normalizeShopDomain(input?.shopDomain);
    const embedKey = requireId("embedKey", input?.embedKey);
    const region = requireEnum("region", REGIONS, input?.region);
    const groundingMode = requireEnum("groundingMode", GROUNDING_MODES, input?.groundingMode ?? "full");
    const status = requireEnum("status", STATUSES, input?.status ?? "active");
    const primaryDomain = input?.primaryDomain === undefined ? null : normalizePrimaryDomain(input.primaryDomain);
    const at = this.now();

    // Pre-check + insert in ONE transaction. The transaction is what makes check-then-insert consistent;
    // the UNIQUE indexes are what make it SOUND under concurrency (a racing duplicate surfaces as a
    // serialization failure or a unique violation — an error either way, never a second row). The
    // pre-check exists for the error MESSAGE quality the port describes, not for the guarantee.
    return this.sql.tx(async (tx) => {
      const { rows } = await tx.query<{ tenant_id: string; shop_domain: string; embed_key: string }>(
        `SELECT tenant_id, lower(shop_domain) AS shop_domain, embed_key FROM pl_merchant
          WHERE tenant_id = $1 OR lower(shop_domain) = $2 OR embed_key = $3`,
        [tenantId, shopDomain, embedKey],
      );
      if (rows.some((r) => r.tenant_id === tenantId))
        throw new Error(`MerchantRegistryPort: tenantId "${tenantId}" is already registered`);
      // A claimed domain stays claimed even while the merchant is uninstalled (the oracle's rule): handing
      // the same shop to a NEW tenantId would strand the first tenant's per-tenant state in namespaces
      // nothing reads.
      const domainOwner = rows.find((r) => r.shop_domain === shopDomain);
      if (domainOwner)
        throw new Error(
          `MerchantRegistryPort: shopDomain "${shopDomain}" is already registered to tenant "${domainOwner.tenant_id}" — ` +
            `reactivate it with setStatus("${domainOwner.tenant_id}", "active") rather than registering a second tenant for one shop`,
        );
      const keyOwner = rows.find((r) => r.embed_key === embedKey);
      if (keyOwner)
        throw new Error(
          `MerchantRegistryPort: this embedKey is already registered to tenant "${keyOwner.tenant_id}" — a shared embed key ` +
            `would mint widget tokens for the wrong tenant`,
        );

      const inserted = await tx.query<MerchantRow>(
        `INSERT INTO pl_merchant (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$8,$9)
         RETURNING ${COLUMNS}`,
        [tenantId, shopDomain, embedKey, status, region, groundingMode, input?.plan ?? null, at, primaryDomain],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error(`MerchantRegistryPort: INSERT of tenant "${tenantId}" returned no row`);
      return toRecord(row);
    });
  }

  async lookupByTenantId(tenantId: string, opts?: MerchantLookupOpts): Promise<MerchantRecord | null> {
    const id = requireId("tenantId", tenantId);
    const { rows } = await this.sql.query<MerchantRow>(
      `SELECT ${COLUMNS} FROM pl_merchant WHERE tenant_id = $1`,
      [id],
    );
    return visible(rows[0], opts); // tenant_id is the PRIMARY KEY: at most one row, no ambiguity possible
  }

  async lookupByShopDomain(shopDomain: string, opts?: MerchantLookupOpts): Promise<MerchantRecord | null> {
    const domain = normalizeShopDomain(shopDomain);
    // `lower(shop_domain) = $1` — bound equality against the functional unique index, never LIKE/prefix
    // matching, so a `%`/`_` in the input is data. LIMIT 2 so the ambiguity guard can see a violation.
    const { rows } = await this.sql.query<MerchantRow>(
      `SELECT ${COLUMNS} FROM pl_merchant WHERE lower(shop_domain) = $1 LIMIT 2`,
      [domain],
    );
    return visible(this.exactlyOne(rows, "shopDomain", domain), opts);
  }

  async lookupByEmbedKey(embedKey: string, opts?: MerchantLookupOpts): Promise<MerchantRecord | null> {
    const key = requireId("embedKey", embedKey);
    // Case-SENSITIVE bound equality: an embed key is an opaque publishable identifier, not a host.
    const { rows } = await this.sql.query<MerchantRow>(
      `SELECT ${COLUMNS} FROM pl_merchant WHERE embed_key = $1 LIMIT 2`,
      [key],
    );
    return visible(this.exactlyOne(rows, "embedKey", key), opts);
  }

  /** Fail closed on an ambiguous reverse key rather than returning an arbitrary tenant — see the
   *  file-level note. Reached only if the unique index is missing or was never built. */
  private exactlyOne(rows: MerchantRow[], kind: string, key: string): MerchantRow | undefined {
    if (rows.length > 1)
      throw new Error(
        `MerchantRegistryPort: ${kind} "${key}" resolves to MULTIPLE merchants (${rows
          .map((r) => r.tenant_id)
          .join(", ")}) — refusing to guess which tenant owns it. The pl_merchant unique index is missing.`,
      );
    return rows[0];
  }

  async setStatus(tenantId: string, status: MerchantStatus, opts?: { reason?: string }): Promise<MerchantRecord> {
    const id = requireId("tenantId", tenantId);
    const next = requireEnum("status", STATUSES, status); // before the write: a bad value leaves the row untouched
    // `status_reason = $3` unconditionally, so a new status NEVER inherits the previous one's
    // justification (the oracle deletes it when no reason is given).
    return this.mutate(
      id,
      `UPDATE pl_merchant SET status = $2, status_reason = $3, updated_at = $4 WHERE tenant_id = $1 RETURNING ${COLUMNS}`,
      [id, next, opts?.reason ?? null, this.now()],
    );
  }

  async update(tenantId: string, patch: MerchantUpdate): Promise<MerchantRecord> {
    const id = requireId("tenantId", tenantId);
    // Validate BEFORE mutating so a bad value leaves the row untouched (oracle's rule).
    const region = patch?.region === undefined ? null : requireEnum("region", REGIONS, patch.region);
    const groundingMode =
      patch?.groundingMode === undefined ? null : requireEnum("groundingMode", GROUNDING_MODES, patch.groundingMode);
    const primaryDomain = patch?.primaryDomain === undefined ? null : normalizePrimaryDomain(patch.primaryDomain);
    // COALESCE: a NULL parameter means "not in the patch", so the stored value stands. `status` is
    // deliberately not patchable here — revocation goes through setStatus only (port's rule).
    return this.mutate(
      id,
      `UPDATE pl_merchant
          SET region = COALESCE($2, region),
              grounding_mode = COALESCE($3, grounding_mode),
              plan = COALESCE($4, plan),
              primary_domain = COALESCE($6, primary_domain),
              updated_at = $5
        WHERE tenant_id = $1
        RETURNING ${COLUMNS}`,
      [id, region, groundingMode, patch?.plan ?? null, this.now(), primaryDomain],
    );
  }

  /** Shared mutation tail: an UPDATE that matches no row must THROW, never insert — the port forbids
   *  creating a merchant as a side effect of `setStatus`/`update`. */
  private async mutate(tenantId: string, text: string, params: unknown[]): Promise<MerchantRecord> {
    const { rows } = await this.sql.query<MerchantRow>(text, params);
    const row = rows[0];
    if (!row)
      throw new Error(`MerchantRegistryPort: no merchant "${tenantId}" — refusing to create one as a side effect`);
    return toRecord(row);
  }
}
