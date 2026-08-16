import type { RuntimeStatePort } from "@palup/platform-ports";
import {
  createRuntimeStore,
  setCatalogRetrievalPlatformEnabled,
  setCatalogRetrievalTenantOptIn,
  readCatalogRetrievalPlatformEnabled,
  readCatalogRetrievalTenantOptIn,
  catalogRetrievalEnabledFor,
} from "@palup/state-postgres";

// S4 §B — the OPERATOR entry point for staged CATALOG_RETRIEVAL enablement. Mirrors kill-switch.ts:
// no implicit scope, requires the SAME DATABASE_URL the deployed backend reads (else the setting lands in
// a per-process in-memory store the server never sees), writes+audits atomically (via the registry), and
// reads the resulting state BACK so "enabled" is a confirmed observation, not an assumption. Turning a
// tenant on is a HITL-POLICY §5 named-owner promotion; --reason is where the human names themselves.

export type CatalogEnableScope = "platform" | `tenant:${string}`;

export interface CatalogEnableCommand {
  scope: CatalogEnableScope;
  on: boolean;
  reason?: string;
}

export class CatalogEnableArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogEnableArgsError";
  }
}

export const CATALOG_ENABLE_USAGE = [
  "usage:",
  '  pnpm catalog:enable --scope <platform|tenant:ID> --on|--off [--reason "why (your name)"]',
  "",
  "DATABASE_URL must point at the SAME run-time state store the deployed backend uses.",
  "There is no default scope, by design. Turning a tenant on is a HITL-POLICY §5 human promotion.",
].join("\n");

function parseScope(raw: string): CatalogEnableScope {
  if (raw === "platform") return "platform";
  const m = /^tenant:(.+)$/.exec(raw);
  if (!m || /\s/.test(m[1]!) || m[1]!.length > 128) {
    throw new CatalogEnableArgsError(`unparseable --scope "${raw}" — expected platform or tenant:<id>`);
  }
  return `tenant:${m[1]}` as CatalogEnableScope;
}

export function parseCatalogEnableArgv(argv: string[]): CatalogEnableCommand {
  let rawScope: string | undefined;
  let on: boolean | undefined;
  let reason: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--on") {
      if (on === false) throw new CatalogEnableArgsError("give exactly one of --on / --off");
      on = true;
    } else if (arg === "--off") {
      if (on === true) throw new CatalogEnableArgsError("give exactly one of --on / --off");
      on = false;
    } else if (arg === "--scope" || arg === "--reason") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new CatalogEnableArgsError(`${arg} requires a value`);
      if (arg === "--scope") rawScope = next;
      else reason = next;
      i++;
    } else {
      throw new CatalogEnableArgsError(`unknown argument "${arg}"`);
    }
  }
  if (rawScope === undefined) throw new CatalogEnableArgsError("--scope <platform|tenant:ID> is required — there is no default scope");
  if (on === undefined) throw new CatalogEnableArgsError("give exactly one of --on / --off");
  return { scope: parseScope(rawScope), on, ...(reason === undefined ? {} : { reason }) };
}

export interface CatalogEnableReport {
  scope: string;
  on: boolean;
  platformEnabled: boolean;
  tenantOptIn?: boolean;
  effective?: boolean;
}

export async function runCatalogEnable(deps: { store: RuntimeStatePort }, cmd: CatalogEnableCommand): Promise<CatalogEnableReport> {
  const opts = { actor: "operator", ...(cmd.reason === undefined ? {} : { reason: cmd.reason }) };
  if (cmd.scope === "platform") {
    await setCatalogRetrievalPlatformEnabled(deps.store, cmd.on, opts);
    return { scope: "platform", on: cmd.on, platformEnabled: await readCatalogRetrievalPlatformEnabled(deps.store) };
  }
  const tenantId = cmd.scope.slice("tenant:".length);
  await setCatalogRetrievalTenantOptIn(deps.store, tenantId, cmd.on, opts);
  const [platformEnabled, tenantOptIn, effective] = await Promise.all([
    readCatalogRetrievalPlatformEnabled(deps.store),
    readCatalogRetrievalTenantOptIn(deps.store, tenantId),
    catalogRetrievalEnabledFor(deps.store, tenantId),
  ]);
  return { scope: cmd.scope, on: cmd.on, platformEnabled, tenantOptIn, effective };
}

async function resolveStore(): Promise<{ store: RuntimeStatePort; kind: string }> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is unset — refusing to run. Without it this process gets its OWN in-memory store, so the " +
        "enablement would never reach the deployed backend. Point DATABASE_URL at the same Cloud SQL instance.",
    );
  }
  return createRuntimeStore();
}

async function main(): Promise<void> {
  let cmd: CatalogEnableCommand;
  try {
    cmd = parseCatalogEnableArgv(process.argv.slice(2));
  } catch (e) {
    console.error(`[catalog-enable] ${(e as Error).message}\n\n${CATALOG_ENABLE_USAGE}`);
    process.exit(2);
    return;
  }
  try {
    const { store, kind } = await resolveStore();
    const report = await runCatalogEnable({ store }, cmd);
    console.log(`[catalog-enable] store=${kind} scope=${report.scope} set=${report.on ? "ON" : "OFF"}`);
    console.log(`[catalog-enable]   platformEnabled=${report.platformEnabled}` +
      (report.tenantOptIn !== undefined ? ` tenantOptIn=${report.tenantOptIn} effective=${report.effective}` : ""));
    if (report.scope !== "platform" && report.effective) {
      console.log("[catalog-enable] retrieval is now EFFECTIVE for this tenant (HITL-POLICY §5 promotion — ensure recorded eval+shadow evidence + named sign-off).");
    }
    process.exit(0);
  } catch (e) {
    console.error(`[catalog-enable] FAILED: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
