import type { RuntimeStatePort, RuntimeStateCtx } from "@palup/platform-ports";

// semantic-memory-v1, PR2 (write path), T3 — the per-SUBJECT... actually per-TENANT memory corpus's own
// pin, mirroring the catalog corpus's `CatalogManifest` (widget-backend/src/jobs/catalog-index.ts:177-200)
// and its manifest-write pattern (`writeManifestAndAudit`, :824-833) — but keyed off RuntimeStatePort,
// like every other memory KV (subject-index.ts, retention.ts), NOT the vector port: a metadata-only
// record inside the vector corpus would score against a similarity query (and cosine can be negative),
// so it stays out-of-band exactly like the catalog manifest does for the same reason.
//
// Collection/key are the LITERAL strings a future ops runbook/migration tool can target by name — see
// this module's own test (manifest.test.ts) for why they are pinned as literals there too, independent
// of these constants.
export const MEMORY_MANIFEST_COLLECTION = "memory_index";
export const MEMORY_MANIFEST_KEY = "manifest";

/**
 * What this tenant's memory corpus was embedded with. `purpose` is always `"document"` — a memory FACT is
 * always the corpus side of retrieval (T4 never embeds a query through this path in PR2); recorded rather
 * than assumed for the same reason the catalog manifest records it (a corpus embedded with query
 * treatment reports the SAME model and dimension as a correct one — same shape, wrong space, no
 * downstream symptom).
 */
export interface MemoryManifest {
  /** Embedding model id reported by the port. The corpus is only extendable at this exact model… */
  model: string;
  /** …and this exact dimension. Mixing either produces silently meaningless similarity (#188). */
  dimension: number;
  /** Always `"document"` for a memory fact written by `remember()` (T4). */
  purpose: "document";
  /** ISO-8601 timestamp of the write that established (or last confirmed) this pin. */
  at: string;
}

/** Read this tenant's memory-corpus pin, or `null` if none has been written yet. */
export async function readMemoryManifest(store: RuntimeStatePort, ctx: RuntimeStateCtx): Promise<MemoryManifest | null> {
  return store.get<MemoryManifest>(ctx, MEMORY_MANIFEST_COLLECTION, MEMORY_MANIFEST_KEY);
}

/**
 * Persist this tenant's memory-corpus pin WITH an audit record (ADR-0015 Inv 6 — no silent write),
 * mirroring `writeManifestAndAudit`'s "manifest + audit in one commit" discipline. The audit's decision
 * carries only the pin's METADATA (model/dimension/purpose/at) — never any shopper fact text, matching
 * every other memory audit record in this package.
 */
export async function writeMemoryManifest(store: RuntimeStatePort, ctx: RuntimeStateCtx, manifest: MemoryManifest): Promise<void> {
  await store.tx(ctx, async (t) => {
    await t.put(MEMORY_MANIFEST_COLLECTION, MEMORY_MANIFEST_KEY, manifest);
    await t.audit({
      // Deliberately NOT audit.ts's own `agent:shopper-memory` actor: this write is corpus METADATA (the
      // {model, dimension} pin), never anything shopper-authored, so it gets its own actor id — mirrors
      // catalog-index.ts's own `CATALOG_INDEX_ACTOR` ("catalog-index-job", not the memory subsystem's
      // actor) for exactly the same reason: "the job performs the write", not the shopper-memory agent.
      actor: "memory-corpus-index",
      action: "memory.manifest.write",
      input: undefined,
      decision: { model: manifest.model, dimension: manifest.dimension, purpose: manifest.purpose, at: manifest.at },
      reversalPath: "n/a — the pin describes the corpus that already exists; re-run with a matching embedder to keep extending it, or --reindex-equivalent (erase + rebuild) to change it",
    });
  });
}

/**
 * Compare a recorded pin against what the embedder reports NOW — `true` on any disagreement (model OR
 * dimension), `false` when both match. Mirrors `catalog-index.ts`'s own `pinMismatch`, narrowed to the
 * two legs T4 actually needs (no `purpose` leg here: every write through this module's caller is always
 * `"document"`, so there is nothing to compare it against).
 */
export function memoryPinMismatch(manifest: MemoryManifest, embed: { model: string; dimension: number }): boolean {
  return manifest.model !== embed.model || manifest.dimension !== embed.dimension;
}
