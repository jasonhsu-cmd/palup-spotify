import type { MerchantRegistryPort, RuntimeStatePort } from "@palup/platform-ports";
import { CATALOG_SYNC_AGENT_TYPE, catalogRetrievalEnabledFor, matchedKill } from "@palup/state-postgres";
import { listActiveTenantIds } from "../merchant-store.js";
import type { BackfillReport } from "./catalog-backfill.js";
import type { TenantIndexReport } from "./catalog-index.js";

// Task 11 (durable-catalog-sync, ADR-0022 F5) — the FLEET CATALOG-SYNC SCHEDULER: for each configured
// tenant, honor the sync-plane kill switch and run the Task 7 rich-catalog backfill, then — for a tenant
// with catalog retrieval enabled — ALSO run the Task 6 embed poll (`runCatalogIndex`) so the pgvector
// retrieval corpus stays populated.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY BOTH JOBS, NOT JUST BACKFILL (the load-bearing carry-forward from Task 7).
//
// `runCatalogBackfill` populates the rich `catalog_product` + `product_facts` stores from Shopify's Bulk
// Operations API, but its file header says outright: "DOES NOT touch the vector corpus." A
// retrieval-enabled tenant is served by `createCatalogRetriever` reading the `${tenantId}::catalog`
// pgvector namespace that ONLY `runCatalogIndex` (catalog-index.ts) writes. Running backfill alone for
// such a tenant would leave `catalog_product` freshly populated while retrieval keeps returning nothing —
// a fail-CLOSED outcome for the shopper (no hallucinated products), but a silent capability regression an
// operator would have every reason to believe backfill already fixed. So this scheduler treats "sync a
// retrieval-enabled tenant" as BOTH jobs, never backfill as a substitute for the embed poll.
//
// A tenant with retrieval NOT enabled gets backfill only — running the embed job for a tenant nothing
// reads the corpus for would just spend embedding-provider money for zero benefit (mirrors
// `indexOneTenant`'s own capability-gating discipline).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// F5 (kill, NN#4): `CATALOG_SYNC_AGENT_TYPE` is the sync plane's OWN kill scope, distinct from
// `RUNTIME_AGENT_TYPE` ("shopper", the live serving path) — see runtime-kill-registry.ts's doc comment.
// Checked HERE, before starting each tenant (so a killed tenant's backfill function is never even
// invoked — test seam: `deps.backfill` a plain mock), AND threaded as a `shouldAbort` closure INTO
// `runCatalogBackfill` (Task 11's extension to that job — see catalog-backfill.ts) so an in-flight bulk
// operation aborts BETWEEN poll steps rather than running to completion on a kill that just armed.
//
// CONCURRENCY IS BOUNDED via a small fixed-size worker pool (`mapWithConcurrency` below) rather than
// `Promise.all` over every tenant — a fleet-wide run against N merchants must not open N simultaneous
// Shopify Bulk Operations / embed calls at once (rate limits, and this deployment's own outbound
// concurrency budget). ONE tenant's failure never aborts the run for the rest (mirrors
// `runRetentionSweep`/`runCatalogIndex`'s per-tenant try/catch discipline).
//
// NOT WIRED INTO ANY LIVE CRON/SERVER HERE — per the Task 11 brief, that composition (a Cloud Run Job /
// CronJob invoking this, the same shape `retention-sweep.ts`/`catalog-index.ts` already use) is
// operator/Task-13 territory. This file exports a plain, dependency-injected function only.
//
// TASK 5 (credential-enrollment-unification, ADR-0023 F-E) — TENANT DISCOVERY. `opts.tenantIds` used to
// be the ONLY way to tell this scheduler which tenants to run: a caller assembled the list itself, today
// from `SHOPIFY_STORES` (see `merchant-store.ts`'s `parseStoreDomains`), tomorrow from wherever Task 13's
// composition gets it. `opts.tenantIds` is now OPTIONAL: when omitted, the scheduler discovers every
// ACTIVE tenant itself via `deps.registry.listActive`'s keyset cursor (`listActiveTenantIds`,
// merchant-store.ts) — the same registry-enumeration capability `retention-sweep.ts` now uses. An
// explicit `opts.tenantIds` still WINS when supplied (mirrors `catalog-index.ts`'s
// `cmd.tenantId ? [cmd.tenantId] : tenantsToIndex()` override pattern), so a single-tenant CLI/backfill
// invocation never needs a registry at all. `listActive` is INTERNAL sync-plane only (ADR-0023 F-E) —
// this scheduler is one of its two sanctioned callers, the other being `retention-sweep.ts`.

const DEFAULT_MAX_CONCURRENT = 3;

/** One tenant's outcome from a scheduler run. */
export interface CatalogSyncTenantResult {
  tenantId: string;
  /**
   * "skipped"  — the sync plane was killed for this tenant before backfill was even invoked.
   * "synced"   — backfill ran (see `backfill.outcome` for whether it actually wrote anything, or
   *              itself halted mid-run on a kill that armed after the pre-check); `index` is present
   *              only when this tenant also has catalog retrieval enabled.
   * "failed"   — backfill or index threw. The run continues for every other tenant regardless.
   */
  outcome: "skipped" | "synced" | "failed";
  backfill?: BackfillReport;
  index?: TenantIndexReport;
  /** Present only when `outcome === "failed"`. Class only, never the message (PII/credential-free —
   *  mirrors `runRetentionSweep`/`runCatalogIndex`'s operator-output discipline). */
  errorClass?: string;
}

export interface CatalogSyncSchedulerReport {
  /** Tenant ids skipped outright because `agent:catalog-sync` (or a broader scope) was armed for them. */
  skipped: string[];
  /** One entry per tenant in the requested `tenantIds`, in the order results settle (NOT necessarily
   *  input order, since tenants run through a concurrency-bounded pool). */
  results: CatalogSyncTenantResult[];
}

export interface CatalogSyncSchedulerOpts {
  /**
   * Explicit tenant list — an override. When omitted, the scheduler discovers every ACTIVE tenant itself
   * via `deps.registry.listActive` (Task 5); `deps.registry` is then required (an omitted `tenantIds`
   * with no `registry` is a caller error, not a silent no-op — see `runCatalogSyncScheduler`).
   */
  tenantIds?: string[];
  /** Max tenants synced concurrently. Defaults to `DEFAULT_MAX_CONCURRENT` (3) — a deliberately small
   *  fixed pool; this is a background fleet job, not a latency-sensitive path. */
  maxConcurrent?: number;
}

export interface CatalogSyncSchedulerDeps {
  store: RuntimeStatePort;
  /**
   * Test/composition seam wrapping `runCatalogBackfill` — injected rather than the job's own
   * `CatalogBackfillDeps` so a caller (Task 13's real composition, or a test) supplies whatever shape it
   * needs without this scheduler knowing about Shopify credentials, clients, or stores directly. MUST
   * honor `opts.shouldAbort` the way `runCatalogBackfill` does (Task 11's extension to that job) — the
   * real implementation is `(tenantId, opts) => runCatalogBackfill(backfillDeps, tenantId, opts)`.
   */
  backfill: (tenantId: string, opts?: { shouldAbort?: () => Promise<boolean> }) => Promise<BackfillReport>;
  /**
   * Test/composition seam wrapping `runCatalogIndex` for ONE tenant (the embed poll that maintains the
   * pgvector retrieval corpus). Only invoked for a tenant with `catalogRetrievalEnabledFor` true — see
   * the file header's CARRY-FORWARD note. The real implementation is
   * `(tenantId) => runCatalogIndex(indexDeps, [tenantId]).then((rs) => rs[0]!)`.
   */
  index: (tenantId: string) => Promise<TenantIndexReport>;
  /**
   * Task 5 — tenant-discovery dep, consulted ONLY when `opts.tenantIds` is omitted. `Pick`ed to
   * `listActive` alone (not the full `MerchantRegistryPort`) so this scheduler cannot accidentally reach
   * a mutating registry method — the narrowest capability that does the job (least privilege, CLAUDE.md
   * §3 NN#6). ADR-0023 F-E: `listActive` is INTERNAL sync-plane only.
   */
  registry?: Pick<MerchantRegistryPort, "listActive">;
}

/**
 * Run `fn` over `items` through a fixed-size worker pool of at most `limit` concurrent invocations. Each
 * of `limit` workers pulls the next item off a shared cursor as soon as it finishes its current one, so
 * the pool never has more than `limit` calls to `fn` in flight regardless of how long any one call takes.
 * `fn` is expected to never throw (the caller wraps its own per-item try/catch) — this helper does not
 * add error handling of its own.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Sync ONE tenant: kill pre-check, backfill (with the sync-plane `shouldAbort` threaded in), and — only
 *  for a retrieval-enabled tenant — the embed poll. Never throws: a failure from either job is caught and
 *  reported per-tenant so one merchant's error can never abort the fleet run. */
async function syncTenant(deps: CatalogSyncSchedulerDeps, tenantId: string): Promise<CatalogSyncTenantResult> {
  if (await matchedKill(deps.store, { tenantId, agentType: CATALOG_SYNC_AGENT_TYPE })) {
    return { tenantId, outcome: "skipped" };
  }

  // F5 — re-checks the SAME sync-plane scope on every call, so a kill that arms mid-run (after this
  // pre-check passed) is honored between `runCatalogBackfill`'s poll/page steps rather than only at entry.
  const shouldAbort = async (): Promise<boolean> =>
    (await matchedKill(deps.store, { tenantId, agentType: CATALOG_SYNC_AGENT_TYPE })) !== null;

  try {
    const backfill = await deps.backfill(tenantId, { shouldAbort });

    let index: TenantIndexReport | undefined;
    if (await catalogRetrievalEnabledFor(deps.store, tenantId)) {
      index = await deps.index(tenantId);
    }

    return { tenantId, outcome: "synced", backfill, ...(index ? { index } : {}) };
  } catch (e) {
    return { tenantId, outcome: "failed", errorClass: e instanceof Error ? e.constructor.name : typeof e };
  }
}

/**
 * Run the fleet catalog-sync scheduler over `opts.tenantIds`: per tenant, honor the sync-plane kill
 * switch, run the rich-catalog backfill, and — for a tenant with catalog retrieval enabled — ALSO run the
 * embed poll that maintains the pgvector retrieval corpus (see the file header's carry-forward note).
 * Bounded concurrency; one tenant's failure never aborts the run for the rest.
 */
export async function runCatalogSyncScheduler(
  deps: CatalogSyncSchedulerDeps,
  opts: CatalogSyncSchedulerOpts = {},
): Promise<CatalogSyncSchedulerReport> {
  const tenantIds = opts.tenantIds ?? (await discoverTenantIds(deps));
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
  const results = await mapWithConcurrency(tenantIds, maxConcurrent, (tenantId) => syncTenant(deps, tenantId));
  return {
    skipped: results.filter((r) => r.outcome === "skipped").map((r) => r.tenantId),
    results,
  };
}

/** Task 5 — resolves the fleet when `opts.tenantIds` was omitted. Fails loudly rather than silently
 *  syncing nothing: an omitted `tenantIds` with no `registry` supplied is a caller wiring mistake, not a
 *  legitimate "sync zero tenants" request. */
async function discoverTenantIds(deps: CatalogSyncSchedulerDeps): Promise<string[]> {
  if (!deps.registry) {
    throw new Error(
      "runCatalogSyncScheduler: opts.tenantIds was omitted and deps.registry was not supplied — nothing to enumerate",
    );
  }
  return listActiveTenantIds(deps.registry);
}
