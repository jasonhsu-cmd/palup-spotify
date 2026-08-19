import type { RuntimeStatePort } from "@palup/platform-ports";
import { readHoldoutConfig, writeHoldoutConfig, type HoldoutConfig } from "../holdout.js";
import { resolveKillStore } from "./kill-switch.js";

// Operator CLI for the business HOLDOUT (Wave 2 / W2-B, ADR-0007 "attribution is incrementality-based,
// measured against a holdout/control" — see `../holdout.ts`'s own header for the full design).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS — the same gap `kill-switch.ts` and `cost-cap.ts` closed for their registries.
// `writeHoldoutConfig` (`../holdout.ts`) is the only writer for a tenant's holdout config, but nothing
// in this repo's deployed surface calls it: `deploy-staging.yml` deploys only `palup-widget-staging`,
// and no workflow deploys the control plane where an HTTP route for this would otherwise live. Without
// this CLI, flipping a tenant's holdout on/off would mean hand-writing a row into Cloud SQL — exactly
// the failure mode #166/#176 already fixed for the kill switch and the cost cap. `resolveKillStore` is
// reused verbatim (not re-implemented) so this tool can never drift from those two on the one thing that
// matters: it must talk to the SAME shared store the serving backend reads, never a per-process one.
//
// AUTHORIZATION is the DATABASE_URL credential, as with the other two CLIs: whoever can reach the
// run-time state store can already do this by hand-writing SQL. This makes the safe, audited, reversible
// form available instead.
//
// ENABLING A HOLDOUT IS AN OWNER/LEGAL DECISION, NOT THIS CLI'S. An un-treated control arm means some
// real shoppers deliberately get a less-capable, un-evolved baseline (`resolveControlPolicy` in
// `../holdout.ts`) purely for measurement — a business-model / experiment-design decision
// (`docs/adr/0007-attribution-and-metering.md`: "a small holdout is un-monetized by design" and "the
// honesty cost") that plausibly also needs shopper-facing consent/disclosure review, mirroring
// `docs/MEMORY-GO-LIVE-CHECKLIST.md`'s human-only go-live gate for `widget-memory`. This file does not
// make that call — it is the audited operator SURFACE for whoever has already made it, exactly as
// `cap:set` does not decide the COGS cap number, only records that a decision was applied.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type HoldoutAction = "set" | "status";

export interface HoldoutSetCommand {
  action: "set";
  tenantId: string;
  enabled: boolean;
  /** 0..1. Omitted ⇒ KEEP the tenant's current fraction (0 if never set) — see `parseHoldoutArgv`'s doc
   * for why "keep current" was chosen over defaulting to 0.5. */
  fraction?: number;
  reason?: string;
}
export interface HoldoutStatusCommand {
  action: "status";
  tenantId: string;
}
export type HoldoutCommand = HoldoutSetCommand | HoldoutStatusCommand;

/** Bad operator input (unknown subcommand, missing tenantId, unparseable bool/fraction/flag). */
export class HoldoutArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoutArgsError";
  }
}

export interface HoldoutReport {
  action: HoldoutAction;
  tenantId: string;
  /** Registry state READ BACK after the action — evidence, not intent (mirrors kill/cap's own reports). */
  config: HoldoutConfig;
  confirmed: boolean;
}

export const HOLDOUT_USAGE = [
  "usage:",
  '  pnpm holdout:set    <tenantId> <true|false> [fraction] [--reason "why (your name)"]',
  "  pnpm holdout:status <tenantId>",
  "",
  "fraction is the CONTROL-arm share, 0..1 (clamped). Omit it to KEEP the tenant's current fraction",
  "(0 if this tenant has never been configured) — a bare `holdout:set <id> true` never silently",
  "invents a split. DATABASE_URL must point at the SAME run-time state store the deployed backend",
  "uses. Enabling a holdout is an owner/legal decision (ADR-0007) — this CLI is the audited operator",
  "surface for that decision, not the approval itself.",
].join("\n");

/**
 * Parse `[set|status] <tenantId> ...`. Positional, not `--scope`-flag-shaped like kill/cap: a holdout is
 * always exactly one tenant (there is no `global` holdout — ADR-0007's method is per-merchant), so there
 * is no "implicit widest scope" footgun to guard against the way kill/cap's parsers do.
 */
export function parseHoldoutArgv(argv: string[]): HoldoutCommand {
  const [action, ...rest] = argv;
  if (action !== "set" && action !== "status") {
    throw new HoldoutArgsError(
      action ? `unknown subcommand "${action}" — expected set or status` : "no subcommand — expected set or status",
    );
  }

  const tenantId = rest[0];
  if (!tenantId || tenantId.startsWith("--")) {
    throw new HoldoutArgsError(`${action} requires a <tenantId> as its first argument`);
  }

  if (action === "status") {
    if (rest.length > 1) throw new HoldoutArgsError("status takes only <tenantId> — no other arguments");
    return { action, tenantId };
  }

  const enabledRaw = rest[1];
  if (enabledRaw !== "true" && enabledRaw !== "false") {
    throw new HoldoutArgsError(`set requires <true|false> as its second argument (got ${JSON.stringify(enabledRaw ?? "")})`);
  }
  const enabled = enabledRaw === "true";

  let i = 2;
  let fraction: number | undefined;
  if (rest[i] !== undefined && rest[i] !== "--reason") {
    if (rest[i]!.startsWith("--")) throw new HoldoutArgsError(`unknown argument "${rest[i]}"`);
    const parsed = Number(rest[i]);
    if (!Number.isFinite(parsed)) throw new HoldoutArgsError(`unparseable fraction "${rest[i]}" — expected a number in [0,1]`);
    fraction = parsed;
    i++;
  }

  let reason: string | undefined;
  if (rest[i] === "--reason") {
    const value = rest[i + 1];
    if (!value) throw new HoldoutArgsError("--reason requires a value");
    reason = value;
    i += 2;
  }
  if (rest[i] !== undefined) throw new HoldoutArgsError(`unknown argument "${rest[i]}"`);

  return { action: "set", tenantId, enabled, ...(fraction === undefined ? {} : { fraction }), ...(reason === undefined ? {} : { reason }) };
}

/**
 * Apply the command and READ THE REGISTRY BACK, so "set" is a confirmed observation, never an
 * assumption (mirrors `runKillSwitch`/`runCostCap`). Throws rather than returning `confirmed: false`.
 */
export async function runHoldout(deps: { store: RuntimeStatePort }, cmd: HoldoutCommand): Promise<HoldoutReport> {
  const { store } = deps;

  if (cmd.action === "status") {
    return { action: "status", tenantId: cmd.tenantId, config: await readHoldoutConfig(store, cmd.tenantId), confirmed: true };
  }

  const current = await readHoldoutConfig(store, cmd.tenantId);
  const fraction = cmd.fraction === undefined ? current.fraction : cmd.fraction;
  const next: HoldoutConfig = {
    enabled: cmd.enabled,
    fraction,
    ...(current.controlPolicyId === undefined ? {} : { controlPolicyId: current.controlPolicyId }),
  };

  await writeHoldoutConfig(store, cmd.tenantId, next, { actor: "operator", reason: cmd.reason });

  const confirmed = await readHoldoutConfig(store, cmd.tenantId);
  const clampedFraction = Math.max(0, Math.min(1, fraction));
  if (confirmed.enabled !== cmd.enabled || confirmed.fraction !== clampedFraction) {
    throw new Error(
      `holdout config for tenant "${cmd.tenantId}" did NOT take effect — the registry read back with a ` +
        "different value. Do not treat the write as applied; check DATABASE_URL, then retry.",
    );
  }
  return { action: "set", tenantId: cmd.tenantId, config: confirmed, confirmed: true };
}

async function main(): Promise<void> {
  let cmd: HoldoutCommand;
  try {
    cmd = parseHoldoutArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[holdout] ${(e as Error).message}\n\n${HOLDOUT_USAGE}`);
    return exit(2);
  }

  try {
    // Reused verbatim: the same DATABASE_URL guard kill-switch.ts/cost-cap.ts use, for the same reason.
    // Without it this process gets its OWN in-memory store and an operator would see "enabled" while the
    // deployed backend's /chat path kept reading a different, empty registry.
    const { store, kind } = await resolveKillStore();
    const report = await runHoldout({ store }, cmd);

    if (report.action === "status") {
      console.log(`[holdout] store=${kind} tenant=${report.tenantId}`);
      console.log(
        `[holdout]   enabled=${report.config.enabled} fraction=${report.config.fraction}` +
          (report.config.controlPolicyId ? ` controlPolicyId=${report.config.controlPolicyId}` : ""),
      );
    } else {
      const verb = report.config.enabled ? "ENABLED" : "DISABLED";
      console.log(`[holdout] ${verb}: tenant=${report.tenantId} fraction=${report.config.fraction} — CONFIRMED (store=${kind})`);
      console.log(`[holdout] reverse with: pnpm holdout:set ${report.tenantId} ${!report.config.enabled}`);
      if (report.config.enabled) {
        console.log(
          "[holdout] NOTE: some real shoppers in this tenant's CONTROL arm will now get the un-evolved " +
            "baseline policy (`resolveControlPolicy`), on purpose, for measurement. Confirm this was an " +
            "owner/legal-approved go-live (ADR-0007), not a default.",
        );
      }
    }
    return exit(0);
  } catch (e) {
    console.error(`[holdout] FAILED: ${(e as Error).message}`);
    console.error(`[holdout] the config is UNCHANGED by a failed run — verify with: pnpm holdout:status ${(cmd as { tenantId?: string }).tenantId ?? "<tenantId>"}`);
    return exit(1);
  }
}

/** Flush stdout, then exit — mirrors kill-switch.ts/cost-cap.ts (`createRuntimeStore` opens a pg.Pool
 * with no close hook). */
function exit(code: number): Promise<never> {
  return new Promise<never>((resolve) => {
    process.stdout.write("", () => {
      process.exit(code);
      resolve(undefined as never);
    });
  });
}

// Run only when invoked directly (`pnpm holdout:set` etc.), never on import — the test imports this module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
