import type {
  MerchantGroundingMode,
  MerchantRecord,
  MerchantRegion,
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
// D2 CLOSED THE REGION GAP THIS HEADER USED TO NAME. `region` and `groundingMode` are now resolved PER
// TENANT here, alongside identity and servability — see "THE SERVING CONFIG" below. The env values keep
// exactly the rank `WIDGET_EMBED_KEYS` has: a named fallback for a tenant the registry has no row for.
//
// WHAT IT STILL DOES NOT DO — the line, drawn explicitly rather than implied:
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
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// D2 — THE SERVING CONFIG (`region` + `groundingMode`), AND WHY REGION IS THE ONE FIELD THAT REFUSES.
//
// Before D2 both came from process-wide env, so every merchant on an instance shared one jurisdiction.
// That is not a cosmetic defect. `region` decides the CONSENT REGIME:
// `consentPermits(region, "ordinary", value)` is `region === "us" ? value !== "out" : value === "in"`
// (widget-brain/src/consent-rules.ts). Serving an EU merchant under `"us"` therefore does not mislabel
// anything — it silently converts an OPT-IN regime into an OPT-OUT one and writes cross-visit facts about
// EU shoppers who never consented. One process serves every merchant, so the defect was guaranteed the
// moment two jurisdictions shared an instance.
//
//   1. an ACTIVE row with a VALID region  ⇒ that row's `region` + `groundingMode`. Registry wins.
//   2. NO row for this tenant (or no registry) ⇒ `envRegion` / `envGroundingMode`, the named fallback —
//      the SAME rank `WIDGET_EMBED_KEYS` has for identity. This is how staging's `demo` tenant works.
//   3. an ACTIVE row whose `region` is MISSING or NOT IN THE ENUM ⇒ REFUSE. Never the env value.
//   4. an UNREADABLE registry ⇒ REFUSE (D1's rule, unchanged).
//
// WHY (3) REFUSES INSTEAD OF FALLING BACK — the decision, argued rather than asserted. The env fallback is
// legitimate for IDENTITY because an absent row is an unambiguous fact: nobody claims this key, so the
// operator's map is the only claim there is. An ACTIVE row with no usable region is not an absence — it is
// a merchant we HAVE, whose jurisdiction we do not know. Substituting `MERCHANT_REGION` there is a
// residency decision made by an env var that was never set for this merchant, which is exactly what the
// legal review flagged and exactly why `NewMerchant.region` is required with no default
// (merchant-registry-port.ts) and why `SHOPIFY_INSTALL_REGION` has "no silent default" (server.ts). It is
// also the direction the consent engine itself already leans: `consentPermits` gives an UNKNOWN region the
// STRICTER treatment (ADR-0015 Inv 3). The cost is bounded and loud — one merchant, not the instance;
// visible as a 401/403 rather than as silent over-collection; reversible in one command
// (`jobs/merchant.ts set --tenant <t> --region …`). A wrong region is not detectable after the fact; a
// refused merchant is detectable within one page load. Fail closed.
//
// WHY `groundingMode` DOES **NOT** REFUSE. It decides whether the agent may use the merchant's catalog and
// discuss competitors — a product-policy setting, not a legal one, and nothing downstream reads it as a
// permission to process personal data. Taking a storefront offline over it would be a bigger harm than the
// setting can cause, so an unusable value degrades to the MOST RESTRICTIVE mode (`"off"`) with a log,
// rather than to the env value or to the permissive `"full"` default. Restrictive-and-serving beats
// refusing here, and refusing beats guessing there; the asymmetry is the point.
//
// NEITHER CASE IS REACHABLE THROUGH THE PORT'S OWN WRITERS. `create` and `update` both `requireEnum` these
// fields, and the Postgres DDL adds `NOT NULL CHECK (region IN (…))`. What IS reachable: `toRecord` casts
// (`row.region as MerchantRegion`, postgres-merchant-registry.ts) and that adapter's own `migrate()` doc
// comment notes a table left over from a different, older DDL would not retroactively gain the CHECK. So
// this is a runtime guard on a hand-inserted or migrated row, not a guard against the adapter.
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
export type ResolutionSurface = "embed-key-mint" | "chat" | "shopper-session" | "customer-login" | "grounding";

/** The consent regime a region implies (ADR-0015). Same value set the `/chat` response has always used. */
export type ConsentMode = "opt_in" | "opt_out";

/**
 * ADR-0015's region split, in ONE place: the US gets an opt-out NOTICE (memory defaults on, the shopper
 * may decline); EVERY other region gets an opt-in PROMPT (memory defaults off, the shopper must accept).
 *
 * `undefined` — "we could not resolve a merchant for this response" — deliberately maps to the STRICTER
 * regime, matching what `consentPermits` itself does with an absent region (ADR-0015 Inv 3). It is the one
 * safe answer: telling a widget `opt_out` for a merchant we have not identified is how a European shopper
 * would be shown a US notice, whereas the reverse merely over-asks.
 */
export function consentModeFor(region: MerchantRegion | undefined): ConsentMode {
  return region === "us" ? "opt_out" : "opt_in";
}

/** The per-tenant serving policy D2 resolves alongside identity. */
export interface ServingConfig {
  /** Data-residency / consent regime. See the header for why this one refuses rather than defaulting. */
  region: MerchantRegion;
  groundingMode: MerchantGroundingMode;
  /** `"registry"` when the tenant's own row supplied these; `"env"` when the named fallback did. */
  source: MerchantSource;
}

/** The outcome of resolving an embed key or a shop domain to a tenant. */
export type TenantResolution =
  | { kind: "ok"; tenantId: string; source: MerchantSource; record?: MerchantRecord }
  /** A row exists and it is not `active`. Distinct from `unknown` so a caller cannot conflate "revoked"
   *  with "never heard of them" and reach for the env map. */
  | { kind: "revoked"; tenantId: string; status: MerchantStatus }
  /** D2 — the row is active but carries no usable `region`. A THIRD kind, not folded into `revoked`:
   *  they are different operator problems with different fixes (`set --region` vs `status --status`), and
   *  D1's own comment on the /chat flags makes the same argument. */
  | { kind: "region-unset"; tenantId: string }
  | { kind: "unknown" }
  /** The registry threw. NOT `unknown` — see the header on why an unreadable registry fails closed. */
  | { kind: "error" };

/** The outcome of the per-request revocation check, which since D2 also carries the serving config. */
export type Servability =
  | { kind: "servable"; source: MerchantSource; record?: MerchantRecord; config: ServingConfig }
  | { kind: "revoked"; tenantId: string; status: MerchantStatus }
  | { kind: "region-unset"; tenantId: string }
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
  /**
   * `MERCHANT_REGION` — the process-wide value, which since D2 is a NAMED FALLBACK for a tenant the
   * registry has no row for, at exactly the rank `WIDGET_EMBED_KEYS` holds for identity.
   *
   * REQUIRED, with no default here on purpose. A default would put the silent `"us"` back one layer down,
   * where nobody reviewing a call site would see it — the same argument `NewMerchant.region` makes for
   * being required ("a caller that does not know the region must find out, not inherit one",
   * merchant-registry-port.ts). server.ts parses it once and passes it; a future caller must do the same
   * or the compiler stops them.
   */
  envRegion: MerchantRegion;
  /** `MERCHANT_GROUNDING_MODE`, same rank and same reason for being required. */
  envGroundingMode: MerchantGroundingMode;
}

export interface MerchantResolver {
  /** `"registry+env"` / `"registry"` / `"env"` — surfaced on `GET /health` so an operator can see whether
   *  the env fallback is armed at all without reading the deploy workflow. */
  readonly resolutionMode: "registry+env" | "registry" | "env";
  /** Publishable embed key → tenant, by the ALLOWLIST rule in the header. */
  resolveEmbedKey(key: unknown, surface: ResolutionSurface): Promise<TenantResolution>;
  /** The per-request DENY-LIST check: is this already-identified tenant still servable, and under WHICH
   *  jurisdiction? Both answers come from the ONE registry read, so /chat still costs one lookup a turn. */
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

// D2 — the two closed sets, duplicated here because the port keeps its own copies module-private
// (merchant-registry-port.ts defines `REGIONS`/`GROUNDING_MODES` without `export`). Narrow, pure, and
// checked against the port's exported TYPES, so a value added to `MerchantRegion` without being added here
// is a compile error at `isRegion`'s predicate, not a silent runtime refusal.
const REGIONS: readonly MerchantRegion[] = ["us", "eu", "uk", "other"];
const GROUNDING_MODES: readonly MerchantGroundingMode[] = ["off", "general", "full"];
const isRegion = (v: unknown): v is MerchantRegion =>
  typeof v === "string" && (REGIONS as readonly string[]).includes(v);
const isGroundingMode = (v: unknown): v is MerchantGroundingMode =>
  typeof v === "string" && (GROUNDING_MODES as readonly string[]).includes(v);

export function createMerchantResolver(deps: MerchantResolverDeps): MerchantResolver {
  const { store, registry, embedKeys, storeDomains, envRegion, envGroundingMode } = deps;
  // Fail fast at CONSTRUCTION, not per request — the same posture as `resolveEmbedKeys` and
  // `assertMemoryAuthCoupling`, and for the same reason: this runs in the composition root, so a bad value
  // makes the process refuse to boot instead of quietly serving every fallback tenant under a region
  // nobody chose. The type already says these are required, but `packages/*/tsconfig.json` includes only
  // `src`, so no compiler check reaches a test or a script that constructs this — this is what does.
  if (!isRegion(envRegion) || !isGroundingMode(envGroundingMode))
    throw new Error(
      `createMerchantResolver: envRegion must be one of ${REGIONS.join(" | ")} and envGroundingMode one of ` +
        `${GROUNDING_MODES.join(" | ")} — refusing to construct a resolver that would serve every ` +
        `registry-less tenant under an undeclared jurisdiction`,
    );
  const envHasKeys = Object.keys(embedKeys).length > 0;
  /** The named D2 fallback, built once: what a tenant with NO registry row is served under. */
  const envConfig: ServingConfig = { region: envRegion, groundingMode: envGroundingMode, source: "env" };

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

  /**
   * Audited ONLY when a durable registry is actually wired.
   *
   * The distinction is the difference between noise and a governance fact. With NO registry (local dev,
   * `pnpm backend`, the e2e suite, any deployment without `DATABASE_URL`) env is not a "fallback" at all —
   * it is the ONLY tenancy mechanism that exists, and recording "resolved from env" on the first turn of
   * every such process says nothing an operator did not already know from `GET /health` reporting
   * `merchants: "env"`. WITH a registry wired, the same event means something specific and worth a durable
   * row: *this deployment has a merchant registry and is still serving somebody from config* — the exact
   * state that needs either a real install or a deliberate decision to keep the config entry.
   *
   * Requirement 3 ("never silent") is satisfied independently of this, by the `[merchant]` log line and the
   * `/health` mode — both of which fire in BOTH postures. This narrowing removes audit noise; it does not
   * remove observability. It is also what keeps `widget-tenant.test.ts`'s exact per-tenant audit counts
   * (`:38`, `:75`) meaningful rather than adjusted to fit a new writer.
   */
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

  /**
   * D2 — the refusal for an active row with no usable `region`. A DISTINCT action from
   * `merchant.serving_refused` so an operator can alert on it separately: the fix is a config command, not
   * a reactivation, and conflating the two would send whoever is paged to the wrong runbook.
   */
  const auditRegionUnset = (tenantId: string, surface: ResolutionSurface): Promise<void> =>
    auditOnce(tenantId, `region-unset:${surface}`, () => ({
      actor: "system:merchant-resolver",
      action: "merchant.region_unset",
      input: { tenantId, surface },
      decision: {
        served: false,
        reason:
          `the pl_merchant row for this tenant is active but carries no valid region ` +
          `(one of ${REGIONS.join(" | ")}). region decides the CONSENT REGIME (ADR-0015), so it is ` +
          `refused rather than inherited from MERCHANT_REGION — an inherited "us" would convert an ` +
          `opt-in jurisdiction into opt-out silently, which nothing downstream could detect`,
      },
      reversalPath:
        `${MERCHANT_CLI} set --tenant ${tenantId} --region us|eu|uk|other ` +
        `(declare this merchant's actual residency and serving resumes on the next request; the row, its ` +
        `embedKey and its status are untouched, so a storefront snippet that is already deployed starts ` +
        `working again. Do NOT guess the value — the wrong one is undetectable after the fact.)`,
    }));

  /**
   * D2 — a row's own serving config, or `null` when its `region` is unusable (the caller then refuses).
   * `audit: false` for reads that are not themselves a serving decision (grounding), so a catalog lookup
   * cannot append a governance row for a refusal /chat and the mint already record.
   */
  const configFor = (rec: MerchantRecord, surface: ResolutionSurface, audit = true): ServingConfig | null => {
    if (!isRegion(rec.region)) {
      logOnce(`region-unset:${rec.tenantId}`, () =>
        console.error(
          `[merchant] tenant "${rec.tenantId}" has an ACTIVE pl_merchant row with no valid region — ` +
            `REFUSING to serve it. region decides the consent regime, so it is never inherited from ` +
            `MERCHANT_REGION. Fix: ${MERCHANT_CLI} set --tenant ${rec.tenantId} --region us|eu|uk|other`,
        ),
      );
      if (audit) void auditRegionUnset(rec.tenantId, surface);
      return null;
    }
    // Not a legal boundary (see the header): degrade to the MOST RESTRICTIVE mode rather than take the
    // merchant offline or inherit a permissive env default.
    if (!isGroundingMode(rec.groundingMode)) {
      logOnce(`grounding-unset:${rec.tenantId}`, () =>
        console.warn(
          `[merchant] tenant "${rec.tenantId}" has an unusable groundingMode; serving with "off" (the most ` +
            `restrictive) rather than a default. Fix: ${MERCHANT_CLI} set --tenant ${rec.tenantId} ` +
            `--grounding-mode off|general|full`,
        ),
      );
      return { region: rec.region, groundingMode: "off", source: "registry" };
    }
    return { region: rec.region, groundingMode: rec.groundingMode, source: "registry" };
  };

  /** The one registry read for a tenant id, with the fail-closed error posture applied once. */
  const rowFor = async (
    tenantId: string,
    surface: ResolutionSurface,
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
    // No row ⇒ env-configured ⇒ unchanged, and it takes the NAMED env region/groundingMode (D2 rule 2).
    if (!row.record) return { kind: "servable", source: "env", config: envConfig };
    if (row.record.status !== "active") {
      void auditRefusal(tenantId, row.record.status, surface);
      return { kind: "revoked", tenantId, status: row.record.status };
    }
    const config = configFor(row.record, surface);
    if (!config) return { kind: "region-unset", tenantId };
    return { kind: "servable", source: "registry", record: row.record, config };
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
          // D2 — refuse HERE, not only at /chat. D1 already made this argument for revocation (a mint that
          // succeeds and a turn that always 403s is a worse, later, more confusing failure); a merchant
          // whose jurisdiction we cannot determine is the same shape of problem.
          if (!configFor(row, surface)) return { kind: "region-unset", tenantId: row.tenantId };
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
      // A stale env entry cannot rescue a row we refuse for residency either — same rule, same reason.
      if (s.kind === "region-unset") return { kind: "region-unset", tenantId: envTenant };

      logOnce(`env:${surface}:${envTenant}`, () =>
        console.warn(
          `[merchant] tenant "${envTenant}" resolved from the WIDGET_EMBED_KEYS ENV FALLBACK for ` +
            `${surface} — no pl_merchant row claims this embed key. This is the named D1 fallback, not an ` +
            `error: it is how the built-in demo tenant and any hand-configured merchant keep serving. It is ` +
            `logged because a fallback nobody can see is how #169 happened.`,
        ),
      );
      if (registry) void auditEnvFallback(envTenant, surface, "WIDGET_EMBED_KEYS");
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
        // entry would keep pulling a revoked merchant's live catalog into prompts. D2 extends that to a
        // merchant we refuse for residency: no catalog is fetched for a store we will not serve. NOT
        // audited here (`audit: false`) — /chat and the mint already record the refusal, and a grounding
        // read is not itself a serving decision.
        if (row.record.status !== "active") return undefined;
        return configFor(row.record, "grounding", false) ? row.record.shopDomain : undefined;
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
          if (!configFor(row, "shopper-session")) return { kind: "region-unset", tenantId: row.tenantId };
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
      if (s.kind === "region-unset") return { kind: "region-unset", tenantId: envTenant };
      return { kind: "ok", tenantId: envTenant, source: "env" };
    },
  };
}
