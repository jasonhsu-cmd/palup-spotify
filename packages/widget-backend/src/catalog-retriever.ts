import {
  canEmbed,
  requireEmbedAlignment,
  type ModelPort,
  type Product,
  type RuntimeStatePort,
  type VectorPort,
} from "@palup/platform-ports";
import type { CatalogRetrievalResult, CatalogRetrieverPort, RetrievedProduct } from "@palup/widget-brain";
import {
  CATALOG_CORPUS_PURPOSE,
  MANIFEST_COLLECTION,
  MANIFEST_KEY,
  catalogNamespace,
  type CatalogManifest,
} from "./jobs/catalog-index.js";

// E1 — THE QUERY SIDE of the catalog corpus the index job (C3, #190) writes.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// READ THIS FIRST — WHAT THIS IS AND IS NOT WIRED TO.
//
// This module IS composed by `server.ts` per shopper turn when catalog retrieval is enabled for the tenant
// via the two-gate registry (platform master + per-tenant opt-in — `catalog-retrieval-enablement.ts`,
// `catalogRetrievalEnabledFor`). The process-global `CATALOG_RETRIEVAL` env was RETIRED in S4; enablement is
// a per-tenant HITL §5 promotion (`pnpm catalog:enable`), on for at least one staging tenant today.
//
// An earlier version of this header said "COMPOSED BY NOBODY TODAY … leaving the composition step out is
// deliberate: a flag alone cannot turn this on." That was true and it was the wrong trade. Enabling a
// change to what the shopper agent sees and says IS a run-time behaviour change needing an eval gate,
// shadow, canary and a NAMED HUMAN'S approval (docs/HITL-POLICY.md §5) — but shadow and canary route a
// FRACTION OF REAL TRAFFIC through the candidate, which is impossible when no code path can build a
// flag-on brain. Withholding the wire did not add a gate; it made the gates unreachable. The safety comes
// from the eval gate plus a human promotion, exactly as it does for SUBSCRIPTION_SELFSERVE and
// SHOPPER_AUTH, which are equally governed and equally env-read in that same composition root.
//
// WHAT IT DOES. Given a shopper's turn, it embeds that turn as a QUERY through the `model` port, scores
// it against the tenant's own catalog corpus through the `vector` port, and returns each hit's PRODUCT ID
// plus the corpus's own render `metadata` (title/variantId, S2) and the corpus's total product count
// (`corpusProductCount`, for the "N of M" line). It never returns price or description: the corpus
// deliberately stores no such text ("a relevance index over product IDS, not a second copy of the
// catalog" — catalog-index.ts), so a stale price is physically unquotable from it — that overlay comes
// from the live `ProductFactsPort`, by id, at serve time (brain.ts's `retrieveViaShell`).
//
// WHAT IT REFUSES. Every refusal below has the same shape: rather than rank against a corpus it cannot
// trust, it THROWS, and the brain falls back to the full catalog (a worse prompt, never a wrong answer).
// The purpose check is the one B3 (#192) said had to exist before any query-side embedding shipped.
//
// COST + AUDIT. This is metered provider spend on a shopper turn, so the composition root MUST wrap the
// model port in `createMeteringModelPort(..., { agentType: CATALOG_RETRIEVAL_AGENT_TYPE })` exactly as
// the index job does — that is the ONE choke point where embedding spend becomes visible (ADR-0013).
// There is no separate audit row per retrieval: the outcome reaches the immutable audit log through the
// `retrieval:applied` / `retrieval:unavailable` flags on the turn's own Decision, which is the record of
// the action that actually affected a shopper.
//
// KILL SWITCH. Nothing here needs its own halt check: the brain's kill rung returns before the clean
// sales path is ever reached, so a halted tenant/agent/global scope never gets this far (NN#4).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Agent type this spend is metered under. Distinct from `catalog-index`: one is a background batch
 *  write, the other is per-shopper-turn read spend, and a cost review must be able to tell them apart. */
export const CATALOG_RETRIEVAL_AGENT_TYPE = "catalog-retrieval";

export interface CatalogRetrieverDeps {
  /** Holds the corpus manifest — the `{model, dimension, purpose}` pin this query must match. */
  store: RuntimeStatePort;
  /** Holds the corpus itself, namespaced per tenant. */
  vector: VectorPort;
  /** Whatever adapter this deployment composed. MUST already be metered (see the note above). */
  model: ModelPort;
  /**
   * Task 8b (durable-catalog-sync, spec §4.1) — LOCAL DESCRIPTIVE HYDRATION for a backfilled tenant. The
   * corpus row (`RetrievedProduct.metadata`) carries only the S2 render fields (title/variantId/imageUrl);
   * for a tenant Task 7 has backfilled, the render path can additionally show description/tags straight
   * from that tenant's own durable `catalog_product` corpus — the WHOLE catalog record, not a second copy
   * of it inside the vector store. When present AND `hasLocalCatalog(tenantId)` resolves true, each hit's
   * `metadata` is enriched with exactly two DESCRIPTIVE fields — `description`, `tags` — read via
   * `getProductsByIds` (e.g. `createLocalCatalogGroundingPort(...).getProductsByIds`, Task 8's own
   * no-Shopify local `GroundingPort`).
   *
   * MONEY SURFACE UNCHANGED (NN#1) — load-bearing. `price`/`availableForSale`/`priceConfirmed` are NEVER
   * copied into `metadata` here, even though the `Product`s `getProductsByIds` returns carry a (locally
   * computed) price: the ONE money-truth channel for the retrieval render path remains the A1b
   * `ProductFactsPort` overlay applied later in `brain.ts` (`hydrateProductFacts`), and this task adds no
   * second one. Deliberately excluding those keys here — rather than trusting the render path to ignore
   * them — means a future brain change that widens which metadata keys it reads can never accidentally
   * start quoting a price from this seam.
   *
   * FAIL-OPEN, gated, additive:
   *  - `hasLocalCatalog` reuses Task 8's own memoized per-tenant decision (model.ts's
   *    `createLocalCatalogDecision`) — this file does NOT invent a second backfilled-tenant check.
   *  - Absent dep, `hasLocalCatalog` resolving false, or either call throwing ⇒ hits are returned exactly
   *    as before this task (metadata-only) — a hydration failure can only fail to enrich, never break or
   *    change the underlying retrieval result.
   *  - No Shopify call on this path: `getProductsByIds` here is always the LOCAL (`catalog_product` +
   *    `product_facts`) implementation, never the Shopify-or-fixtures router — the composition root
   *    (server.ts) is responsible for supplying the local one, not the general `GroundingPort`.
   */
  localHydration?: {
    hasLocalCatalog: (tenantId: string) => Promise<boolean>;
    getProductsByIds: (tenantId: string, ids: string[]) => Promise<Product[]>;
  };
}

/** A refusal this module authored: a static, PII-free sentence. Never carries the shopper's own text. */
export class CatalogRetrievalUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogRetrievalUnavailable";
  }
}

/**
 * Read one record's product id, or `undefined` when the record is not one this system wrote. Guarded
 * against a crafted/foreign record exactly like the index job's own reconciliation guard: a record we do
 * not understand is DROPPED, never coerced into a product reference the brain would then try to resolve.
 */
function productIdOf(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  if ((metadata as { kind?: unknown }).kind !== "product") return undefined;
  const id = (metadata as { productId?: unknown }).productId;
  return typeof id === "string" && id.trim() !== "" ? id : undefined;
}

/**
 * Build the query-side retriever over the ports it needs.
 *
 * PORTABILITY: this file names no provider. Embedding goes through `ModelPort.embed` with the portable
 * `purpose: "query"`; the mapping to a provider task type lives in the adapter (ADR-0001, NN#3).
 */
export function createCatalogRetriever(deps: CatalogRetrieverDeps): CatalogRetrieverPort {
  return {
    async retrieve({ tenantId, query, k, queryVector, pin }): Promise<CatalogRetrievalResult> {
      const limit = Math.max(0, Math.floor(k));

      // ── the manifest first: every check it can answer costs nothing ──
      const manifest = await deps.store.get<CatalogManifest>({ tenantId }, MANIFEST_COLLECTION, MANIFEST_KEY);
      if (!manifest) {
        throw new CatalogRetrievalUnavailable(
          "catalog-retrieval: no catalog corpus is indexed for this tenant (run `pnpm catalog:index --tenant <id>`)",
        );
      }
      const corpusProductCount = manifest.products;
      if (limit === 0) return { hits: [], corpusProductCount };
      if (manifest.purpose !== CATALOG_CORPUS_PURPOSE) {
        // THE B3 (#192) GAP, now catchable. A corpus embedded on the QUERY side reports the same model and
        // the same dimension as a correct one, so `{model, dimension}` cannot see it — and the resulting
        // scores are plausible-looking and wrong. Detected here from the recorded pin, before any spend.
        // An ABSENT purpose (a manifest predating the pin) lands here too, on purpose: unknown provenance
        // is not evidence of a document corpus.
        throw new CatalogRetrievalUnavailable(
          `catalog-retrieval: this corpus records embedding purpose ${JSON.stringify(manifest.purpose ?? null)}, ` +
            `not ${JSON.stringify(CATALOG_CORPUS_PURPOSE)} — a query cannot be scored against it; rebuild it ` +
            "with `pnpm catalog:index --tenant <id> --reindex`",
        );
      }

      // semantic-memory-v1, PR3, T8 — turn-embed reuse: a PRE-COMPUTED query vector is trusted for
      // ranking ONLY when its `pin` matches THIS corpus's own manifest exactly (model AND dimension) —
      // never a cross-space vector, and never a vector with no pin to check it against at all. When
      // trusted, this SKIPS the internal `model.embed` call entirely (the whole point: one shared turn
      // embed instead of one per consumer). Anything else falls back to embedding the query here,
      // byte-identical to before this PR.
      let vector: number[];
      if (queryVector && pin && pin.model === manifest.model && pin.dimension === manifest.dimension) {
        vector = queryVector;
      } else {
        const text = query.trim();
        if (!text) throw new CatalogRetrievalUnavailable("catalog-retrieval: refusing to embed a blank query");
        if (!canEmbed(deps.model)) {
          // A capability ABSENCE, static and free to check (#188) — never confused with a failed call.
          throw new CatalogRetrievalUnavailable(
            "catalog-retrieval: this deployment's model adapter cannot embed, so a query cannot be vectorised",
          );
        }

        // ── the one metered call ──
        const req = { texts: [text], purpose: "query" as const, tenantId };
        const res = await deps.model.embed(req);
        // The port's own validator, including the purpose ECHO: an adapter that answered with a document
        // embedding produced the right shape in the wrong space, and nothing downstream would notice.
        requireEmbedAlignment(req, res);

        if (res.model !== manifest.model || res.dimension !== manifest.dimension) {
          throw new CatalogRetrievalUnavailable(
            `catalog-retrieval: the corpus is pinned to ${manifest.model}/${manifest.dimension}d but this query ` +
              `embedded as ${res.model}/${res.dimension}d — similarity across two vector spaces is meaningless; ` +
              "rebuild the corpus with `--reindex` when the embedding model change is intended",
          );
        }

        const v = res.vectors[0];
        if (!v) throw new CatalogRetrievalUnavailable("catalog-retrieval: the embedder returned no query vector");
        vector = v;
      }

      const matches = await deps.vector.query(catalogNamespace(tenantId), { vector, k: limit });
      const hits: RetrievedProduct[] = [];
      for (const m of matches) {
        const productId = productIdOf(m.metadata);
        if (!productId) continue; // a record this system did not write is data we do not understand
        // Cosine is in [-1, 1] and CAN be negative. Dropping non-positive scores is a sign boundary, not a
        // calibrated relevance floor — a real floor needs real embeddings and the eval gate to set, and
        // inventing one here would be a number with nothing behind it.
        if (!(m.score > 0)) continue;
        hits.push({ productId, score: m.score, ...(m.metadata ? { metadata: m.metadata } : {}) });
      }

      // Task 8b — local DESCRIPTIVE hydration for a backfilled tenant (see `localHydration`'s own doc
      // comment for the full contract). Purely additive and fail-open: any failure here is swallowed and
      // the hits already built above are returned unchanged, exactly as they were before this task.
      if (deps.localHydration && hits.length > 0) {
        try {
          const isLocal = await deps.localHydration.hasLocalCatalog(tenantId);
          if (isLocal) {
            const rich = await deps.localHydration.getProductsByIds(tenantId, hits.map((h) => h.productId));
            const byId = new Map(rich.map((p) => [p.id, p]));
            for (const hit of hits) {
              const p = byId.get(hit.productId);
              if (!p) continue;
              const extra: Record<string, unknown> = {};
              if (p.description) extra.description = p.description;
              if (p.tags && p.tags.length > 0) extra.tags = p.tags;
              // NEVER merge price/availableForSale/priceConfirmed here — see the doc comment above.
              if (Object.keys(extra).length > 0) hit.metadata = { ...hit.metadata, ...extra };
            }
          }
        } catch {
          /* fail-open: hydration can only enrich a hit, never withhold or break the retrieval result */
        }
      }

      return { hits, corpusProductCount };
    },
  };
}
