import type { GroundingContext, GroundingPort, GroundingShell } from "@palup/platform-ports";

// The ISOLATED, non-serving tenant a CATALOG_RETRIEVAL shadow indexes AND queries under.
//
// WHY THIS EXISTS: shadow:retrieval used to index the demo catalog under the literal "demo" tenant and let
// the brain query the same "demo" default (signals.tenantId ?? "demo", brain.ts). With VECTOR_ANN=true + a
// real DATABASE_URL that pointed the eval's WRITE at the real serving "demo" corpus: buildIndexedRetriever
// indexes WITHOUT --reindex, so runCatalogIndex's non-reindex path treated the real corpus's ids as "stale"
// and DELETED them, rewriting the manifest to the 13-product fixture (the incident). The index tenant and
// the query tenant MUST stay equal or the shadow is a silent no-op — so this ONE value is threaded into both
// the index call and every case's signals.tenantId, and it is a tenant real serving never uses.
export const EVAL_TENANT_DEFAULT = "shadow-eval";

/** The eval/shadow tenant: RETRIEVAL_TENANT if set (non-blank), else the non-serving default. Never the
 *  bare "demo". `env` is injectable so a test can drive it without touching the process environment. */
export function resolveEvalTenant(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.RETRIEVAL_TENANT?.trim();
  return t && t.length > 0 ? t : EVAL_TENANT_DEFAULT;
}

/**
 * A GroundingPort wrapper that ALIASES one tenant id onto another tenant's fixture.
 *
 * shadow:retrieval indexes and queries under an isolated eval tenant, but the fixture grounding
 * (StaticGroundingAdapter) only knows "demo"/"northwind": an unknown eval tenant resolves to the SAFE-EMPTY
 * context, so the CHAMPION (which grounds via getContext) would have no catalog to narrow and the shadow
 * would compare two empty catalogs — a silent no-op. This maps `alias` → `source`'s products / brand /
 * policy while KEEPING `alias` as the returned tenantId, so:
 *   • the corpus is indexed under the eval tenant (never "demo"),
 *   • the champion's getContext(evalTenant) sees the full catalog, and
 *   • the candidate's getShell(evalTenant) + retriever.retrieve({tenantId: evalTenant}) hit that same corpus.
 * Every other tenant id passes through to the base adapter unchanged.
 */
export class AliasGroundingAdapter implements GroundingPort {
  constructor(
    private readonly base: GroundingPort,
    private readonly alias: string,
    private readonly source: string,
  ) {}

  async getContext(tenantId: string): Promise<GroundingContext> {
    const ctx = await this.base.getContext(tenantId === this.alias ? this.source : tenantId);
    return { ...ctx, tenantId };
  }

  async getShell(tenantId: string): Promise<GroundingShell> {
    const shell = await this.base.getShell(tenantId === this.alias ? this.source : tenantId);
    return { ...shell, tenantId };
  }
}
