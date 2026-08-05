import type { MerchantGroundingMode, MerchantRecord, MerchantRegion, MerchantRegistryPort, MerchantStatus, RuntimeStatePort } from "@palup/platform-ports";
import { createRuntimeStore, PostgresMerchantRegistry } from "@palup/state-postgres";

// The OPERATOR ENTRY POINT for merchant lifecycle — the reversal path C1's install audit names.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. C1 (`routes/shopify-install.ts`) writes `pl_merchant` rows and audits them, and NN#5
// requires each of those records to carry a reversal path an operator can actually RUN. #166 and then #179
// both found the same defect twice: a `reversalPath` naming a control-plane HTTP route that nothing
// deploys. `.github/workflows/deploy-staging.yml` deploys ONLY `palup-widget-staging`, and no workflow
// deploys the control plane at all — so for merchant status there is no route, no console, and (before this
// file) no tool. The honest reversal would have been "hand-write an UPDATE against Cloud SQL", which is
// exactly the state `kill-switch.ts` was written to end for the kill registry.
//
// So this is the same tool, for the same reason, in the same shape as `jobs/kill-switch.ts` and
// `jobs/cost-cap.ts`, over the same ports.
//
// WHY A CLI AND NOT AN HTTP ROUTE — widget-backend has NO admin authentication of any kind, so an admin
// route would mean a new internet-reachable endpoint that can revoke (or un-revoke) any merchant, plus a
// new shared secret to guard it. AUTHORIZATION here is the DATABASE_URL credential itself: whoever can
// reach the run-time state store can already do this by hand-editing rows, so this adds no privilege — it
// makes the safe, audited, reversible form of that power available instead.
//
// REVOCATION IS A STATUS, NEVER A DELETE. `uninstalled` makes the merchant INERT because every
// `MerchantRegistryPort` lookup is default-inert (merchant-registry-port.ts:112-120) — the row stays, so the
// tenant's per-tenant state (sessions, consent records, audit chain, memory namespaces) is still reachable
// for support, billing reconciliation and erasure, and reactivation is one command. Deleting the row would
// strand all of that in namespaces nothing can resolve.
//
// SAFETY PROPERTIES, each covered by a test in test/merchant-cli.test.ts:
//  - NO IMPLICIT TARGET AND NO IMPLICIT STATUS. `--tenant` and `--status` are both required; neither
//    defaults. There is no `--all`: unlike a kill switch, there is no incident in which revoking EVERY
//    merchant at once is the reasonable operator action, so the flag does not exist.
//  - NEVER A SILENT NO-OP. Every action READS THE REGISTRY BACK and asserts the intended end state, so the
//    reported outcome is a confirmed observation rather than an assumption.
//  - AUDIT BEFORE WRITE (NN#5). `MerchantRegistryPort` writes no audit of its own and exposes no
//    transaction handle, so an atomic write+audit is not achievable through it (the same limitation
//    routes/shopify-install.ts documents). The audit is therefore written FIRST: an audit failure aborts and
//    the row is untouched, so an UNAUDITED governed write cannot happen. A committed audit followed by a
//    failed write leaves a visible, reconcilable record of an action that did not land — the lesser of the
//    two, and the direction the repo already chose (customer-account-flow.ts:148-152).
//  - IT REFUSES A STORE NOBODY ELSE CAN SEE. Without DATABASE_URL, `createRuntimeStore()` hands back a
//    PER-PROCESS in-memory store and the operator would see "uninstalled" while the deployed backend served
//    on. Hard-fail instead, exactly as `resolveKillStore` does.
//
// NOT A KILL SWITCH. `uninstalled` stops a merchant being RESOLVED; it does not halt a running agent for a
// merchant that is still active. To halt, use `pnpm kill:arm --scope tenant:<id>`.
//
// NO PACKAGE.JSON SCRIPT YET (`pnpm merchant:*`), so the runnable form is the explicit `pnpm exec tsx …`
// invocation below — that is what the audit records name, because it is what works. Adding the script
// aliases is reported as a follow-up rather than done here (package.json is outside this change's lane).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type MerchantAction = "show" | "status" | "set";

export interface MerchantCommand {
  action: MerchantAction;
  tenantId: string;
  /** Required for `status`. Never defaulted. */
  status?: MerchantStatus;
  region?: MerchantRegion;
  groundingMode?: MerchantGroundingMode;
  plan?: string;
  reason?: string;
}

export class MerchantArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MerchantArgsError";
  }
}

export interface MerchantReport {
  action: MerchantAction;
  /** Registry state READ BACK after the action — evidence, not intent. */
  merchant: MerchantRecord | null;
  confirmed: boolean;
  elapsedMs: number;
}

const STATUSES: readonly MerchantStatus[] = ["active", "suspended", "uninstalled"];
const REGIONS: readonly MerchantRegion[] = ["us", "eu", "uk", "other"];
const GROUNDING_MODES: readonly MerchantGroundingMode[] = ["off", "general", "full"];

const RUN = "pnpm exec tsx packages/widget-backend/src/jobs/merchant.ts";

export const MERCHANT_USAGE = `usage:
  ${RUN} show   --tenant <tenantId>
  ${RUN} status --tenant <tenantId> --status active|suspended|uninstalled [--reason "..."]
  ${RUN} set    --tenant <tenantId> [--region us|eu|uk|other] [--grounding-mode off|general|full] [--plan <plan>]

"uninstalled"/"suspended" make the merchant INERT — every registry lookup resolves to null — without
deleting the row, so support/billing/erasure can still reach it and reactivation is one command. This does
NOT halt a running agent: for that use pnpm kill:arm --scope tenant:<tenantId>.`;

/** Parse argv. Nothing is implicit: no default tenant, no default status, and no `--all`. */
export function parseMerchantArgv(argv: string[]): MerchantCommand {
  const action = argv[0];
  if (action !== "show" && action !== "status" && action !== "set")
    throw new MerchantArgsError(`unknown subcommand ${JSON.stringify(action ?? "")}`);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tenantRaw = flag("tenant");
  if (!tenantRaw || !tenantRaw.trim())
    throw new MerchantArgsError(`--tenant is required for ${action} (there is no default merchant, and no --all)`);
  const tenantId = tenantRaw.trim();
  const reason = flag("reason");

  if (action === "show") return { action, tenantId };

  if (action === "status") {
    const raw = flag("status");
    if (!raw || !STATUSES.includes(raw.trim() as MerchantStatus))
      throw new MerchantArgsError(`--status is required and must be one of ${STATUSES.join(" | ")} (never defaults)`);
    const cmd: MerchantCommand = { action, tenantId, status: raw.trim() as MerchantStatus };
    if (reason !== undefined) cmd.reason = reason;
    return cmd;
  }

  const cmd: MerchantCommand = { action, tenantId };
  const regionRaw = flag("region");
  if (regionRaw !== undefined) {
    if (!REGIONS.includes(regionRaw.trim() as MerchantRegion))
      throw new MerchantArgsError(`--region must be one of ${REGIONS.join(" | ")}`);
    cmd.region = regionRaw.trim() as MerchantRegion;
  }
  const gmRaw = flag("grounding-mode");
  if (gmRaw !== undefined) {
    if (!GROUNDING_MODES.includes(gmRaw.trim() as MerchantGroundingMode))
      throw new MerchantArgsError(`--grounding-mode must be one of ${GROUNDING_MODES.join(" | ")}`);
    cmd.groundingMode = gmRaw.trim() as MerchantGroundingMode;
  }
  const planRaw = flag("plan");
  if (planRaw !== undefined) cmd.plan = planRaw;
  if (cmd.region === undefined && cmd.groundingMode === undefined && cmd.plan === undefined)
    throw new MerchantArgsError("`set` needs at least one of --region / --grounding-mode / --plan");
  return cmd;
}

/**
 * Apply the command, then READ THE REGISTRY BACK and assert the intended end state — so the report is a
 * confirmed observation. Throws rather than returning `confirmed:false`, so a caller holding a report can
 * trust it. `region` is deliberately NOT changed as a side effect of anything: moving a merchant's
 * residency is an explicit `set --region`, because it is a legal decision.
 */
export async function runMerchant(
  deps: { store: RuntimeStatePort; registry: MerchantRegistryPort },
  cmd: MerchantCommand,
): Promise<MerchantReport> {
  const { store, registry } = deps;
  const started = Date.now();
  const done = (merchant: MerchantRecord | null): MerchantReport => ({
    action: cmd.action,
    merchant,
    confirmed: true,
    elapsedMs: Date.now() - started,
  });

  if (cmd.action === "show") {
    // `includeInactive` so an operator investigating a revoked merchant can actually see it — that is one
    // of the exact cases the flag exists for (merchant-registry-port.ts:117-118).
    return done(await registry.lookupByTenantId(cmd.tenantId, { includeInactive: true }));
  }

  // The merchant must already exist. `setStatus`/`update` throw for an unknown tenant rather than creating a
  // row (the port's rule), but checking first means the failure names the real problem and no audit record
  // is written for an action that could never have applied.
  const before = await registry.lookupByTenantId(cmd.tenantId, { includeInactive: true });
  if (!before) throw new Error(`no merchant "${cmd.tenantId}" in the registry — refusing to create one as a side effect`);

  if (cmd.action === "status") {
    const next = cmd.status!;
    // Audit BEFORE the write (see the header). The reversal is the same command with the previous status,
    // which is precisely a reversal an operator can run.
    await store.audit(
      { tenantId: cmd.tenantId },
      {
        actor: "operator",
        action: "merchant.status_changed",
        input: { tenantId: cmd.tenantId, status: next, previousStatus: before.status, reason: cmd.reason },
        decision: next === "active" ? "restored" : "made inert",
        reversalPath: `${RUN} status --tenant ${cmd.tenantId} --status ${before.status}` + (next === "active" ? "" : " (or --status active to restore servability)"),
      },
    );
    const after = await registry.setStatus(cmd.tenantId, next, cmd.reason === undefined ? undefined : { reason: cmd.reason });
    if (after.status !== next) throw new Error(`status ${next} did not take effect — the registry read back "${after.status}"`);
    return done(after);
  }

  const patch = {
    ...(cmd.region === undefined ? {} : { region: cmd.region }),
    ...(cmd.groundingMode === undefined ? {} : { groundingMode: cmd.groundingMode }),
    ...(cmd.plan === undefined ? {} : { plan: cmd.plan }),
  };
  await store.audit(
    { tenantId: cmd.tenantId },
    {
      actor: "operator",
      action: "merchant.updated",
      input: { tenantId: cmd.tenantId, ...patch },
      decision: { previous: { region: before.region, groundingMode: before.groundingMode, plan: before.plan } },
      // The reversal restores exactly the fields this command changed, to the values it changed them from.
      reversalPath:
        `${RUN} set --tenant ${cmd.tenantId}` +
        (cmd.region === undefined ? "" : ` --region ${before.region}`) +
        (cmd.groundingMode === undefined ? "" : ` --grounding-mode ${before.groundingMode}`) +
        (cmd.plan === undefined ? "" : ` --plan ${before.plan ?? "(unset — no flag can clear a plan; see MERCHANT_USAGE)"}`),
    },
  );
  const after = await registry.update(cmd.tenantId, patch);
  if (cmd.region !== undefined && after.region !== cmd.region) throw new Error("region did not take effect");
  if (cmd.groundingMode !== undefined && after.groundingMode !== cmd.groundingMode) throw new Error("groundingMode did not take effect");
  return done(after);
}

/**
 * The SHARED store + registry, or a hard failure. Mirrors `resolveKillStore` (jobs/kill-switch.ts:265) and
 * exists separately only because this tool additionally needs the `Sql` handle to build the registry, which
 * that helper does not return.
 */
export async function resolveMerchantStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ store: RuntimeStatePort; registry: MerchantRegistryPort; kind: string }> {
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is unset — refusing to run. Without it this process gets its OWN in-memory store and an " +
        "EMPTY pl_merchant, so a status change would never reach the deployed backend and 'no such merchant' " +
        "would be a lie about an empty table. Point DATABASE_URL at the same Cloud SQL instance the backend uses.",
    );
  }
  const { store, kind, sql } = await createRuntimeStore();
  if (!sql) throw new Error("the runtime store did not expose a SQL handle — pl_merchant is unreachable from this process");
  const registry = new PostgresMerchantRegistry(sql);
  // Idempotent, and the same DDL the server runs at boot; safe to run from an operator tool so the table is
  // never missing just because the server has not booted since the migration landed.
  await registry.migrate();
  return { store, registry, kind };
}

function describe(m: MerchantRecord): string {
  return `${m.tenantId}  shop=${m.shopDomain}  status=${m.status}${m.statusReason ? ` ("${m.statusReason}")` : ""}  region=${m.region}  grounding=${m.groundingMode}${m.plan ? `  plan=${m.plan}` : ""}  updated=${m.updatedAt}`;
}

async function main(): Promise<void> {
  let cmd: MerchantCommand;
  try {
    cmd = parseMerchantArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[merchant] ${(e as Error).message}\n\n${MERCHANT_USAGE}`);
    return exit(2);
  }
  try {
    const { store, registry, kind } = await resolveMerchantStore();
    const report = await runMerchant({ store, registry }, cmd);
    if (!report.merchant) {
      console.log(`[merchant] store=${kind} — no merchant "${cmd.tenantId}"`);
      return exit(1);
    }
    console.log(`[merchant] ${report.action} CONFIRMED in ${report.elapsedMs}ms (store=${kind})`);
    console.log(`[merchant]   ${describe(report.merchant)}`);
    if (report.merchant.status !== "active") {
      console.log(`[merchant] this merchant is INERT: every registry lookup now resolves to null.`);
      console.log(`[merchant] restore with: ${RUN} status --tenant ${cmd.tenantId} --status active`);
    }
    return exit(0);
  } catch (e) {
    console.error(`[merchant] FAILED: ${(e as Error).message}`);
    console.error(`[merchant] the registry is UNCHANGED by a failed run — verify with: ${RUN} show --tenant ${cmd.tenantId}`);
    return exit(1);
  }
}

/** Flush stdout then exit — `createRuntimeStore` opens a pg.Pool with no close hook. Mirrors cost-cap.ts. */
function exit(code: number): Promise<never> {
  return new Promise<never>((resolve) => {
    process.stdout.write("", () => {
      process.exit(code);
      resolve(undefined as never);
    });
  });
}

// Run only when invoked directly, never on import (the test imports this module).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
