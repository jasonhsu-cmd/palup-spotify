import type { RuntimeStatePort } from "@palup/platform-ports";
import { clearCostCap, costCapStatus, matchedCostCap, setCostCap, type CostCapEntry, type CostCapScope } from "@palup/state-postgres";
import { resolveKillStore } from "./kill-switch.js";

// Operator CLI for basic-mode-at-cap (§8a invariant 14).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS — a defect in the PR that introduced the registry (#176), caught on review.
//
// #176 added `POST /api/cost-cap` and `POST /api/cost-cap/clear` to the CONTROL PLANE, and wrote
// `reversalPath: "POST /api/cost-cap/clear"` into the immutable audit record. But
// `.github/workflows/deploy-staging.yml` deploys ONLY `palup-widget-staging` (the container entrypoint is
// `pnpm backend` → widget-backend), and no workflow deploys the control plane at all. So that reversal
// path named a route an operator CANNOT REACH — precisely the defect #166 had already found and fixed for
// the kill switch's own `reversalPath`, reintroduced one registry later.
//
// #176's test asserted the recorded string matched a route that exists in CODE. That was the wrong
// question: a reversal path in an immutable record has to be one an operator can actually RUN against the
// deployment that exists (NN#5). Being reachable in the repo is not being reachable in production.
//
// So this CLI is the path that works today, exactly as `kill-switch.ts` is for the kill registry, and the
// registry's `reversalPath` now names it FIRST with the HTTP route second (for when the control plane is
// deployed). Same reasoning, same shape, same store — `resolveKillStore` is reused verbatim rather than
// duplicating the DATABASE_URL guard, so the two tools cannot drift on the one thing that matters: they
// must talk to the SAME shared store the serving backend reads, never a per-process one.
//
// AUTHORIZATION is the DATABASE_URL credential, as with the kill CLI: whoever can reach the run-time state
// store can already do this by hand-writing SQL. This makes the safe, audited, reversible form available.
//
// DIRECTION OF SAFETY. `set` only ever REMOVES autonomy (no proactive initiation) and cannot spend money,
// so it is safe for a machine to apply. `clear` RESTORES autonomy, so the registry audits it as
// `operator`. Adjusting the COGS cap NUMBER is a Policy change and is not done here at all
// (`docs/design/cost-margin-telemetry.md:21`).
//
// NOT the kill switch: at cap the shopper is STILL SERVED. If you want to halt the agent, use
// `pnpm kill:arm` — that is a different, louder action with a different meaning.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type CapAction = "set" | "status" | "clear";

export interface CapCommand {
  action: CapAction;
  /** Required for set. Required for clear unless `all`. Never defaulted to `global` — see parseCapArgv. */
  scope?: CostCapScope;
  /** Set ONLY by an explicit `clear --scope all`. */
  all?: boolean;
  reason?: string;
}

export class CapArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapArgsError";
  }
}

export interface CapReport {
  action: CapAction;
  target?: string;
  /** Registry state READ BACK after the action — evidence, not intent. */
  capped: CostCapEntry[];
  confirmed: boolean;
  elapsedMs: number;
}

export const CAP_USAGE = `usage:
  pnpm cap:set    --scope global|tenant:<id> [--reason "..."]
  pnpm cap:status
  pnpm cap:clear  --scope global|tenant:<id>|all

At cap the agent stops INITIATING (no proactive nudges) but live chat continues to be answered, and the
shopper is never shown the merchant's billing state. To HALT the agent entirely, use pnpm kill:arm.`;

/**
 * Parse argv. NO IMPLICIT SCOPE: an absent, empty or unparseable `--scope` is refused rather than
 * defaulting to `global`, because a forgotten flag would put EVERY merchant into basic mode. (The HTTP
 * route defaults to global, which is defensible for a deliberate console action; a CLI flag is too easy
 * to omit.) Widening a clear to every scope needs an explicit `--scope all`, and `set --scope all` does
 * not exist — the same asymmetry `kill-switch.ts` uses.
 */
export function parseCapArgv(argv: string[]): CapCommand {
  const action = argv[0];
  if (action !== "set" && action !== "status" && action !== "clear") {
    throw new CapArgsError(`unknown subcommand ${JSON.stringify(action ?? "")}`);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const reason = flag("reason");
  if (action === "status") return { action };

  const raw = flag("scope");
  if (!raw || !raw.trim()) {
    throw new CapArgsError(`--scope is required for ${action} (never defaults to global)`);
  }
  const scope = raw.trim();
  if (scope === "all") {
    if (action === "set") throw new CapArgsError("`set --scope all` does not exist — name global or a tenant explicitly");
    return { action, all: true, reason };
  }
  if (scope !== "global" && !/^tenant:[A-Za-z0-9._-]+$/.test(scope)) {
    throw new CapArgsError(`unparseable --scope ${JSON.stringify(scope)} (expected global, tenant:<id>, or all)`);
  }
  return { action, scope: scope as CostCapScope, reason };
}

/**
 * Apply the command and READ THE REGISTRY BACK, asserting the intended end state — so "capped" is a
 * confirmed observation, never an assumption. Throws rather than returning `confirmed: false`, so a caller
 * holding a report can trust it.
 */
export async function runCostCap(deps: { store: RuntimeStatePort }, cmd: CapCommand): Promise<CapReport> {
  const { store } = deps;
  const started = Date.now();

  if (cmd.action === "status") {
    return { action: "status", capped: await costCapStatus(store), confirmed: true, elapsedMs: Date.now() - started };
  }

  if (cmd.action === "set") {
    const scope = cmd.scope!;
    await setCostCap(store, scope, cmd.reason ?? "cost cap reached", undefined, "operator");
    const tenantId = scope === "global" ? "__probe__" : scope.slice("tenant:".length);
    const hit = await matchedCostCap(store, { tenantId });
    if (!hit) throw new Error(`set ${scope} did not take effect — the registry read back with no match`);
    return { action: "set", target: scope, capped: await costCapStatus(store), confirmed: true, elapsedMs: Date.now() - started };
  }

  const target = cmd.all ? "all" : cmd.scope!;
  await clearCostCap(store, cmd.all ? undefined : cmd.scope);
  const remaining = await costCapStatus(store);
  if (cmd.all && remaining.length > 0) throw new Error("clear all did not take effect — scopes remain capped");
  if (!cmd.all && remaining.some((e) => e.scope === cmd.scope)) throw new Error(`clear ${cmd.scope} did not take effect`);
  return { action: "clear", target, capped: remaining, confirmed: true, elapsedMs: Date.now() - started };
}

async function main(): Promise<void> {
  let cmd: CapCommand;
  try {
    cmd = parseCapArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[cap] ${(e as Error).message}\n\n${CAP_USAGE}`);
    return exit(2);
  }

  try {
    // Reused verbatim: the same DATABASE_URL guard, for the same reason. Without it this process gets its
    // OWN in-memory store and an operator would see "capped" while the deployed backend kept initiating.
    const { store, kind } = await resolveKillStore();
    const report = await runCostCap({ store }, cmd);

    if (report.action === "status") {
      console.log(`[cap] store=${kind} capped=${report.capped.length}`);
      for (const e of report.capped) console.log(`[cap]   ${e.scope}  reason="${e.reason}"  at=${e.at}`);
      if (report.capped.length === 0) console.log("[cap]   (no cap — the agent may initiate normally)");
    } else {
      const verb = report.action === "set" ? "BASIC MODE" : "NORMAL MODE";
      console.log(`[cap] ${verb}: ${report.action} ${report.target} — CONFIRMED in ${report.elapsedMs}ms (store=${kind})`);
      console.log(`[cap] capped now: ${report.capped.length === 0 ? "(none)" : report.capped.map((e) => e.scope).join(", ")}`);
      if (report.action === "set") {
        console.log(`[cap] reverse with: pnpm cap:clear --scope ${report.target}`);
        console.log("[cap] NOTE: live chat is still being answered. To HALT the agent, use pnpm kill:arm.");
      }
    }
    return exit(0);
  } catch (e) {
    console.error(`[cap] FAILED: ${(e as Error).message}`);
    console.error("[cap] the agent's state is UNCHANGED by a failed run — verify with: pnpm cap:status");
    return exit(1);
  }
}

/** Flush stdout then exit — `createRuntimeStore` opens a pg.Pool with no close hook. Mirrors kill-switch.ts. */
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
