import type { MerchantRegistryPort, RuntimeStatePort, VectorPort } from "@palup/platform-ports";
import { createRuntimeStore, createVectorStore, matchedKill, PostgresMerchantRegistry, RUNTIME_AGENT_TYPE } from "@palup/state-postgres";
import { sweepAllSubjects, type SweepAllResult } from "@palup/widget-memory";
import { listActiveTenantIds, parseStoreDomains } from "../merchant-store.js";

// B4 — the SCHEDULED half of ADR-0015 Inv 4 ("expiry is enforced, not aspirational").
//
// WHAT THIS EXISTS FOR. `sweepExpired`'s only production caller is the opportunistic per-turn sweep on
// /chat, scoped to the subject being served that turn. A shopper who returns cleans up after themselves;
// one who never comes back is never reclaimed. This job walks each tenant's subject index
// (widget-memory/src/subject-index.ts) and sweeps the subjects the serving path can never reach.
//
// WHY A JOB AND NOT AN ADMIN ENDPOINT. retention.ts previously speculated this would arrive as
// "Cloud Scheduler → an admin-only endpoint". It ships as a scheduled PROCESS instead, deliberately:
// widget-backend has NO admin authentication of any kind today, so an HTTP route would have meant
// introducing a new network-reachable endpoint whose whole purpose is mass deletion, plus a new shared
// secret to guard it — new attack surface for an operation that never needs to be reachable from the
// internet. A Cloud Run Job / Kubernetes CronJob invoking `pnpm sweep` needs neither, and stays portable
// (ADR-0001) because it goes through the same ports the server does.
//
// SAFETY PROPERTIES, each covered by a test in test/retention-sweep-job.test.ts:
//  - THE KILL SWITCH IS HONORED, per tenant, BEFORE any deletion for that tenant. An operator halting a
//    tenant (or globally) stops this job, exactly like it stops the serving path. `sweepAllSubjects`
//    itself cannot check this — the kill registry lives in @palup/state-postgres and widget-memory does
//    not depend on it — so the check MUST live here, in the caller. That is stated on `sweepAllSubjects`
//    too, so a future second caller does not silently skip it.
//  - EXPIRY IS THE ONLY PREDICATE. Live facts are untouched. This reclaims storage; it never decides
//    what may be remembered, and it is not an erasure path.
//  - ONE TENANT'S FAILURE DOES NOT ABORT THE RUN. Neither does one subject's (sweepAllSubjects).
//  - BOUNDED per run via `maxSubjects`, and leftover work is REPORTED (`remaining`) rather than a
//    truncated pass silently reading as "everything reclaimed".
//  - Every deletion is audited by `sweepExpired` (audit-before-delete), so a scheduled mass delete is
//    just as legible in the immutable log as a shopper-initiated one.

export interface RetentionSweepDeps {
  store: RuntimeStatePort;
  vector: VectorPort;
  /** Mirrors server.ts's `AUDIT_HMAC_SECRET` so this job's audit `subjectRef`s correlate with the
   * serving path's. Without it a ref is a plain sha256 — see audit.ts. */
  hmacKey?: string;
}

export interface TenantSweepReport extends Partial<SweepAllResult> {
  tenantId: string;
  /** "swept" | "halted" (kill switch) | "failed" (threw — the run continued past it). */
  outcome: "swept" | "halted" | "failed";
  /** Present only when `outcome === "failed"`. The error's CLASS only, never its message — an
   * operator-visible signal must stay PII-free (retention.ts's codified rule). */
  errorClass?: string;
}

/**
 * Sweeps every listed tenant. Returns one report per tenant rather than throwing, so a scheduler gets a
 * complete picture of a partially-successful run instead of only its first failure.
 */
export async function runRetentionSweep(
  deps: RetentionSweepDeps,
  tenantIds: string[],
  opts?: { maxSubjects?: number; now?: Date },
): Promise<TenantSweepReport[]> {
  const reports: TenantSweepReport[] = [];

  for (const tenantId of tenantIds) {
    try {
      // NN#4 parity with the serving path: an operator halt stops memory actions, and a bulk delete is
      // emphatically one. Checked per tenant and BEFORE any work, so a global kill halts everything.
      if (await matchedKill(deps.store, { tenantId, agentType: RUNTIME_AGENT_TYPE })) {
        reports.push({ tenantId, outcome: "halted" });
        continue;
      }
      const result = await sweepAllSubjects(
        { vector: deps.vector, audit: deps.store, hmacKey: deps.hmacKey },
        tenantId,
        opts,
      );
      reports.push({ tenantId, outcome: "swept", ...result });
    } catch (e) {
      reports.push({ tenantId, outcome: "failed", errorClass: e instanceof Error ? e.constructor.name : typeof e });
    }
  }

  return reports;
}

/** Tenants to sweep: the merchants this deployment is actually configured to serve (`SHOPIFY_STORES`,
 * the same env the server resolves storefronts from), plus any explicitly listed in `SWEEP_TENANTS` for
 * a deployment that serves tenants not present in that map. Deduped, order-stable. Deliberately NOT
 * "every tenant with data" — there is no tenant registry to enumerate, and inventing one so a deletion
 * job can discover targets for itself is the wrong direction.
 *
 * TASK 5 (credential-enrollment-unification): superseded by `tenantsToSweepViaRegistry` below now that
 * `MerchantRegistryPort.listActive` (Task 1) closes the "no registry to enumerate" gap this comment used
 * to name. `main()` no longer calls this — kept EXPORTED AND UNUSED, dormant, purely so a one-release
 * rollback (reverting `main()` to this function) is a revert, not a rewrite. Do not delete. */
export function tenantsToSweep(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromStores = Object.keys(parseStoreDomains(env.SHOPIFY_STORES));
  const explicit = (env.SWEEP_TENANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...fromStores, ...explicit])];
}

/**
 * Tenants to sweep (Task 5): every ACTIVE merchant discovered via `MerchantRegistryPort.listActive`'s
 * keyset cursor (`listActiveTenantIds`, merchant-store.ts) UNIONED with any tenant explicitly listed in
 * `SWEEP_TENANTS` — preserved alongside the registry walk for a deployment that must sweep a tenant the
 * registry does not (yet) have a row for. Deduped; registry tenants first, then any additional explicit
 * ones. `SHOPIFY_STORES` is no longer consulted here (see `tenantsToSweep` above). ADR-0023 F-E:
 * `listActive` is INTERNAL sync-plane only — this job is one of its two sanctioned callers, the other
 * being the catalog-sync scheduler (`catalog-sync-scheduler.ts`).
 */
export async function tenantsToSweepViaRegistry(
  registry: Pick<MerchantRegistryPort, "listActive">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const fromRegistry = await listActiveTenantIds(registry);
  const explicit = (env.SWEEP_TENANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...fromRegistry, ...explicit])];
}

async function main(): Promise<void> {
  const runtime = await createRuntimeStore();
  // Task 5: a durable registry (DATABASE_URL) is required to enumerate — mirrors `createRuntimeStore`'s
  // own "production must set DATABASE_URL" posture rather than silently falling back to the dormant
  // `tenantsToSweep()` env parse, which would make the live enumeration source ambiguous depending on
  // config nobody can see from this job's output.
  if (!runtime.sql) {
    console.error("[sweep] no durable registry available (DATABASE_URL not set) — nothing to do");
    process.exitCode = 1;
    return;
  }
  const registry = new PostgresMerchantRegistry(runtime.sql);
  await registry.migrate();
  const tenantIds = await tenantsToSweepViaRegistry(registry);
  if (tenantIds.length === 0) {
    console.error("[sweep] no active tenants in the registry and no SWEEP_TENANTS set — nothing to do");
    process.exitCode = 1;
    return;
  }

  const vector = await createVectorStore(runtime.sql);
  console.log(`[sweep] store=${runtime.kind} vector=${vector.kind} tenants=${tenantIds.length}`);

  const reports = await runRetentionSweep(
    { store: runtime.store, vector: vector.store, hmacKey: process.env.AUDIT_HMAC_SECRET ?? process.env.SHOPPER_TOKEN_SECRET },
    tenantIds,
    { maxSubjects: Number(process.env.SWEEP_MAX_SUBJECTS) || undefined },
  );

  for (const r of reports) {
    if (r.outcome === "halted") console.log(`[sweep] tenant=${r.tenantId} HALTED by kill switch — skipped`);
    else if (r.outcome === "failed") console.error(`[sweep] tenant=${r.tenantId} FAILED error=${r.errorClass}`);
    else
      console.log(
        `[sweep] tenant=${r.tenantId} visited=${r.visited} deleted=${r.deleted} retired=${r.retired} failed=${r.failed} remaining=${r.remaining}`,
      );
  }

  // Leftover work is a signal to the scheduler, not a silent condition. A non-zero exit on failures
  // lets a Cloud Run Job / CronJob surface the run as unhealthy rather than reporting success.
  const leftover = reports.reduce((n, r) => n + (r.remaining ?? 0), 0);
  if (leftover > 0) console.log(`[sweep] ${leftover} subject(s) left for the next run (maxSubjects reached)`);
  if (reports.some((r) => r.outcome === "failed" || (r.failed ?? 0) > 0)) process.exitCode = 1;
}

// Run only when invoked directly (`pnpm sweep`), never on import — the test imports this module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
