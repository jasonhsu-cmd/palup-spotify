import type { RuntimeStatePort, RuntimeStateTx } from "@palup/platform-ports";
import { CatalogRefusal, MANIFEST_COLLECTION } from "./catalog-index.js";

// S3 §B — the AUTHORITATIVE per-tenant id→contentHash ledger for a catalog corpus, in RuntimeState KV.
//
// WHY KV AND NOT THE VECTOR STORE. VectorPort deliberately exposes no listIds/count/enumerate
// (vector-port.ts) — adding one is non-portable (MEMORY-GO-LIVE-CHECKLIST). And the S1 pgvector engine
// THROWS on a text-modality "list everything" query (pgvector-store.ts: vector-query-only). So the set of
// indexed record ids and their content hashes lives HERE, in the same `catalog_index` collection as the
// manifest, and is written in the SAME `store.tx` as the manifest + audit so all three commit atomically.
//
// SHAPE. One or more chunk records keyed `ledger:<NNNN>`, each `{ version, at, entries }` where `entries`
// maps a corpus record id (`product:<gid>`) to its embedded-text contentHash. A 50k id+hash map is a few
// MB; chunking at LEDGER_CHUNK_SIZE keeps each KV value well under any value-size limit.

/** Chunk-key prefix within MANIFEST_COLLECTION. Distinct from MANIFEST_KEY ("manifest"). */
export const LEDGER_KEY_PREFIX = "ledger:";

/** Ids+hashes per chunk record. 10k * (~40-char id + 64-char hash) ≈ ~1MB/chunk — safe headroom. */
export const LEDGER_CHUNK_SIZE = 10_000;

/** One persisted ledger chunk. `version` lets a future migration recognise an old shape. */
export interface CorpusLedgerChunk {
  version: 1;
  at: string;
  /** recordId (`product:<gid>`) → contentHash. */
  entries: Record<string, string>;
  /** S4 §F — recordId → writtenAt (unix ms). OPTIONAL: absent on pre-S4 chunks (⇒ treated as 0, never
   *  spuriously protected by the concurrency guard). A --reindex rewrites every chunk in the new shape. */
  writtenAt?: Record<string, number>;
}

/** Deterministic chunk key: `ledger:0000`, `ledger:0001`, … (zero-padded so lexical order == numeric). */
export function ledgerChunkKey(index: number): string {
  return `${LEDGER_KEY_PREFIX}${String(index).padStart(4, "0")}`;
}

/** All chunk keys currently persisted for this tenant, oldest-index first. */
export async function listLedgerChunkKeys(store: RuntimeStatePort, tenantId: string): Promise<string[]> {
  const rows = await store.list<CorpusLedgerChunk>({ tenantId }, MANIFEST_COLLECTION);
  return rows
    .map((r) => r.key)
    .filter((k) => k.startsWith(LEDGER_KEY_PREFIX))
    .sort();
}

/**
 * Read the whole ledger, merged into one `recordId → contentHash` map. Never touches the vector store.
 * FOREIGN-GUARD IS INTRINSIC: the ledger only ever holds `product:*` ids this job wrote, so it asserts
 * that here — a non-product id in the ledger is corruption, not a delisted product, and reconcile must
 * refuse it rather than ever `deleteById` something it did not write (the `:542-549` guard, preserved).
 *
 * Throws `CatalogRefusal` (not a plain `Error`, review round-1 FIX 2) naming the offending id AND the
 * chunk key it was found in, so the id/chunk detail actually reaches the operator: `runCatalogIndex`
 * surfaces a `CatalogRefusal`'s message as `reason` on the report, but a plain `Error` there is reduced to
 * `errorClass` only — an operator debugging ledger corruption needs to know WHICH id and chunk, not just
 * that something threw.
 */
export async function readCorpusLedger(store: RuntimeStatePort, tenantId: string): Promise<Map<string, string>> {
  const rows = await store.list<CorpusLedgerChunk>({ tenantId }, MANIFEST_COLLECTION);
  const out = new Map<string, string>();
  for (const { key, value } of rows) {
    if (!key.startsWith(LEDGER_KEY_PREFIX)) continue; // skip the manifest key
    for (const [id, hash] of Object.entries(value?.entries ?? {})) {
      if (!id.startsWith("product:")) {
        throw new CatalogRefusal(
          "failed",
          `corpus ledger for ${tenantId} contains a non-product id "${id}" in chunk "${key}" — refusing to ` +
            "reconcile a ledger it does not own (it must only ever hold product: ids this job wrote)",
        );
      }
      out.set(id, hash);
    }
  }
  return out;
}

/** S4 §F — recordId → writtenAt (unix ms). An id in a chunk with no `writtenAt` map (pre-S4) reads as 0,
 *  so the concurrency guard never protects it. Never touches the vector store. */
export async function readCorpusLedgerTimestamps(store: RuntimeStatePort, tenantId: string): Promise<Map<string, number>> {
  const rows = await store.list<CorpusLedgerChunk>({ tenantId }, MANIFEST_COLLECTION);
  const out = new Map<string, number>();
  for (const { key, value } of rows) {
    if (!key.startsWith(LEDGER_KEY_PREFIX)) continue;
    for (const id of Object.keys(value?.entries ?? {})) out.set(id, value?.writtenAt?.[id] ?? 0);
  }
  return out;
}

/** Split a `recordId → contentHash` map into persisted chunks. Ids are SORTED so the chunking is stable
 *  across runs (a given id lands in the same chunk unless the corpus size crosses a boundary). `writtenAtMs`
 *  is S4 §F: when given, every id in the chunk gets that `writtenAt`; omitted (2-arg call), the chunk shape
 *  is byte-identical to pre-S4 (no `writtenAt` key at all). */
export function chunkLedgerEntries(
  entries: Map<string, string>,
  at: string,
  writtenAtMs?: number,
  chunkSize: number = LEDGER_CHUNK_SIZE,
): CorpusLedgerChunk[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const ids = [...entries.keys()].sort();
  const chunks: CorpusLedgerChunk[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const slice = ids.slice(i, i + size);
    const e: Record<string, string> = Object.create(null);
    const w: Record<string, number> = Object.create(null);
    for (const id of slice) {
      e[id] = entries.get(id)!;
      if (writtenAtMs !== undefined) w[id] = writtenAtMs;
    }
    chunks.push({ version: 1, at, entries: e, ...(writtenAtMs !== undefined ? { writtenAt: w } : {}) });
  }
  return chunks;
}

/**
 * Write `chunks` and prune any prior chunk key not overwritten (so a corpus that shrank from 6 chunks to
 * 3 does not leave 3 orphan chunks). MUST be called inside the same `store.tx` as the manifest + audit.
 * `priorChunkKeys` is read (via `listLedgerChunkKeys`) BEFORE the tx opens — the tx handle has no `list`.
 */
export async function writeLedgerInTx(
  t: RuntimeStateTx,
  chunks: CorpusLedgerChunk[],
  priorChunkKeys: string[],
): Promise<void> {
  const written = new Set<string>();
  for (let i = 0; i < chunks.length; i++) {
    const key = ledgerChunkKey(i);
    await t.put(MANIFEST_COLLECTION, key, chunks[i]);
    written.add(key);
  }
  for (const key of priorChunkKeys) {
    if (!written.has(key)) await t.delete(MANIFEST_COLLECTION, key);
  }
}

/** Erasure (ADR-0015): drop every ledger chunk for this tenant. Call inside the clear's `store.tx`. */
export async function deleteLedgerInTx(t: RuntimeStateTx, priorChunkKeys: string[]): Promise<void> {
  for (const key of priorChunkKeys) await t.delete(MANIFEST_COLLECTION, key);
}
