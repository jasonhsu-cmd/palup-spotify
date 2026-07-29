// Secrets port (ADR-0001 names `secrets` as a planned platform port). The ONLY way feature code reads
// a per-tenant secret (a merchant's Shopify token, an API key, …). Feature code depends on this
// interface; adapters (env/in-memory now, a cloud secret-manager later) implement it and swap behind
// it. Secrets never live in code, prompts, or logs (CLAUDE.md §5, NN#6).

export interface SecretsPort {
  /**
   * Tenant-scoped secret lookup: the value for (tenantId, name), or undefined if unset. Implementations
   * MUST be tenant-isolated (tenant A can never read tenant B's secret) and MUST NOT log/echo the value.
   */
  get(tenantId: string, name: string): Promise<string | undefined>;
}

/**
 * Env-backed adapter. Reads a nested JSON map from `PALUP_SECRETS`:
 *   {"<tenantId>": {"<name>": "<value>", ...}, ...}
 * The nested shape keeps lookups tenant-scoped by construction (no flat-key delimiter collisions).
 * Null-prototype maps so a tenant/name of `__proto__`/`constructor` can't resolve an inherited value.
 * A cloud secret-manager adapter (same port) replaces this in prod — the value never enters the repo.
 */
export function createEnvSecrets(raw: string | undefined = process.env.PALUP_SECRETS): SecretsPort {
  const byTenant: Record<string, Record<string, string>> = Object.create(null);
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object") {
        for (const [tenant, secrets] of Object.entries(o)) {
          if (secrets && typeof secrets === "object") {
            const inner: Record<string, string> = Object.create(null);
            for (const [name, v] of Object.entries(secrets as Record<string, unknown>)) {
              if (typeof v === "string") inner[name] = v;
            }
            byTenant[tenant] = inner;
          }
        }
      }
    } catch {
      console.warn("[secrets] PALUP_SECRETS is not valid JSON — no env secrets loaded");
    }
  }
  return {
    async get(tenantId, name) {
      if (!tenantId || !name) return undefined;
      const inner = Object.hasOwn(byTenant, tenantId) ? byTenant[tenantId] : undefined;
      return inner && Object.hasOwn(inner, name) ? inner[name] : undefined;
    },
  };
}
