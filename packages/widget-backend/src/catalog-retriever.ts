import {
  canEmbed,
  requireEmbedAlignment,
  type ModelPort,
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
// This module IS composed now, by `server.ts`, but ONLY when `CATALOG_RETRIEVAL=true`; with the flag unset
// (every environment today) nothing here is constructed and no manifest is ever read.
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
    async retrieve({ tenantId, query, k }): Promise<CatalogRetrievalResult> {
      const text = query.trim();
      if (!text) throw new CatalogRetrievalUnavailable("catalog-retrieval: refusing to embed a blank query");
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

      const vector = res.vectors[0];
      if (!vector) throw new CatalogRetrievalUnavailable("catalog-retrieval: the embedder returned no query vector");

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
      return { hits, corpusProductCount };
    },
  };
}
