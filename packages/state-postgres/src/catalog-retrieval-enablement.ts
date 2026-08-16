import type { RuntimeStatePort, RuntimeStateCtx } from "@palup/platform-ports";

// S4 §B (ADR-0020) — the two gates that decide, PER TENANT, whether CATALOG_RETRIEVAL serves this
// merchant. BOTH default OFF so a fresh deployment is dark, mirroring autopromote-optin.ts:
//   • platform master  `catalog_retrieval`/`platform`  under the reserved __system__ tenant;
//   • per-tenant opt-in `catalog_retrieval`/`optin`     under the merchant's own partition.
// Retrieval is enabled for a tenant IFF both are on (the master wins when off). Set via the audited
// `pnpm catalog:enable` CLI, written + AUDITED atomically inside one store.tx (armKill's shape). The
// value is server-sourced — read only from this store, never from a client/agent field. This replaces
// the retired process-global `process.env.CATALOG_RETRIEVAL` boot flag (S4 §B; server.ts).

const COLLECTION = "catalog_retrieval";
const OPTIN_KEY = "optin";
const PLATFORM_KEY = "platform";

/** Reserved platform partition for the global master (not a real merchant). */
export const CATALOG_RETRIEVAL_PLATFORM_TENANT = "__system__";

export async function readPlatformEnabled(store: RuntimeStatePort): Promise<boolean> {
  return (
    (await store.get<{ enabled: boolean }>({ tenantId: CATALOG_RETRIEVAL_PLATFORM_TENANT }, COLLECTION, PLATFORM_KEY))
      ?.enabled === true
  );
}

export async function readTenantOptIn(store: RuntimeStatePort, tenantId: string): Promise<boolean> {
  return (await store.get<{ enabled: boolean }>({ tenantId }, COLLECTION, OPTIN_KEY))?.enabled === true;
}

/** The single serving read: is retrieval enabled for this tenant right now? Default OFF for everyone. */
export async function catalogRetrievalEnabledFor(store: RuntimeStatePort, tenantId: string): Promise<boolean> {
  const [master, optin] = await Promise.all([readPlatformEnabled(store), readTenantOptIn(store, tenantId)]);
  return master && optin;
}

export interface SetEnablementOpts {
  /** Recorded audit actor (the human names themselves via the CLI --reason; default "operator"). */
  actor?: string;
  reason?: string;
  now?: number;
}

async function setFlag(
  store: RuntimeStatePort,
  ctx: RuntimeStateCtx,
  key: string,
  action: string,
  enabled: boolean,
  opts: SetEnablementOpts,
): Promise<void> {
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const actor = opts.actor || "operator";
  await store.tx(ctx, async (t) => {
    await t.put(COLLECTION, key, { enabled });
    await t.audit(
      {
        actor,
        action: enabled ? `${action}.enable` : `${action}.disable`,
        input: { tenantId: ctx.tenantId, enabled, reason: opts.reason },
        decision: `catalog_retrieval ${key} set to ${enabled}`,
        reversalPath:
          key === PLATFORM_KEY
            ? `pnpm catalog:enable --scope platform --${enabled ? "off" : "on"}`
            : `pnpm catalog:enable --scope tenant:${ctx.tenantId} --${enabled ? "off" : "on"}`,
      },
      at,
    );
  });
}

/** SET the platform master (audited). */
export async function setPlatformEnabled(store: RuntimeStatePort, enabled: boolean, opts: SetEnablementOpts = {}): Promise<void> {
  await setFlag(store, { tenantId: CATALOG_RETRIEVAL_PLATFORM_TENANT }, PLATFORM_KEY, "catalog_retrieval.platform", enabled, opts);
}

/** SET a merchant's opt-in (audited). Refuses the reserved system tenant. */
export async function setTenantOptIn(store: RuntimeStatePort, tenantId: string, enabled: boolean, opts: SetEnablementOpts = {}): Promise<void> {
  if (!tenantId || tenantId === CATALOG_RETRIEVAL_PLATFORM_TENANT) {
    throw new Error("setTenantOptIn requires a real merchant tenantId (not the reserved __system__ partition)");
  }
  await setFlag(store, { tenantId }, OPTIN_KEY, "catalog_retrieval.tenant_optin", enabled, opts);
}
