import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import {
  LEDGER_CHUNK_SIZE,
  ledgerChunkKey,
  readCorpusLedger,
  listLedgerChunkKeys,
  chunkLedgerEntries,
  writeLedgerInTx,
  deleteLedgerInTx,
  type CorpusLedgerChunk,
} from "../src/jobs/catalog-ledger.js";
import { MANIFEST_COLLECTION, MANIFEST_KEY, runCatalogClear, catalogNamespace, catalogRecordId } from "../src/jobs/catalog-index.js";

const AT = "2026-08-16T00:00:00.000Z";

function ledgerOf(n: number): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < n; i++) m.set(`product:gid://shopify/Product/${i}`, `hash-${i}`);
  return m;
}

describe("corpus-state ledger — chunked KV round-trip in the catalog_index collection", () => {
  it("chunkLedgerEntries splits at the chunk size, deterministically (sorted ids)", () => {
    const chunks = chunkLedgerEntries(ledgerOf(LEDGER_CHUNK_SIZE + 5), AT);
    expect(chunks).toHaveLength(2);
    expect(Object.keys(chunks[0]!.entries)).toHaveLength(LEDGER_CHUNK_SIZE);
    expect(Object.keys(chunks[1]!.entries)).toHaveLength(5);
    expect(chunks[0]!.version).toBe(1);
    expect(chunks[0]!.at).toBe(AT);
  });

  it("writes chunks and reads them back merged into one map (>chunk-size)", async () => {
    const store = new InMemoryRuntimeStore();
    const entries = ledgerOf(LEDGER_CHUNK_SIZE + 3);
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(entries, AT), []);
    });
    const read = await readCorpusLedger(store, "acme");
    expect(read.size).toBe(entries.size);
    expect(read.get("product:gid://shopify/Product/0")).toBe("hash-0");
    expect(read.get(`product:gid://shopify/Product/${LEDGER_CHUNK_SIZE + 2}`)).toBe(`hash-${LEDGER_CHUNK_SIZE + 2}`);
  });

  it("a rewrite that SHRINKS prunes the now-unused chunk keys", async () => {
    const store = new InMemoryRuntimeStore();
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(ledgerOf(LEDGER_CHUNK_SIZE + 3), AT), []);
    });
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([ledgerChunkKey(0), ledgerChunkKey(1)]);
    const priorKeys = await listLedgerChunkKeys(store, "acme");
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(ledgerOf(2), AT), priorKeys);
    });
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([ledgerChunkKey(0)]);
    expect((await readCorpusLedger(store, "acme")).size).toBe(2);
  });

  it("readCorpusLedger ignores the manifest key and refuses a non-product id (foreign-guard intrinsic)", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, MANIFEST_KEY, { model: "m", dimension: 4 });
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, ledgerChunkKey(0), {
      version: 1,
      at: AT,
      entries: { "subject:leak": "x" },
    } satisfies CorpusLedgerChunk);
    await expect(readCorpusLedger(store, "acme")).rejects.toThrow(/non-product id/);
  });

  it("deleteLedgerInTx removes exactly the given chunk keys", async () => {
    const store = new InMemoryRuntimeStore();
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(ledgerOf(3), AT), []);
    });
    const keys = await listLedgerChunkKeys(store, "acme");
    await store.tx({ tenantId: "acme" }, async (t) => {
      await deleteLedgerInTx(t, keys);
    });
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([]);
  });
});

describe("erasure — runCatalogClear drops the tenant ledger chunks (ADR-0015)", () => {
  it("removes the ledger records along with the corpus and manifest", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const ns = catalogNamespace("acme");
    await vector.upsert(ns, [{ id: catalogRecordId("gid://shopify/Product/1"), vector: [1, 0, 0, 0] }]);
    await store.put({ tenantId: "acme" }, MANIFEST_COLLECTION, MANIFEST_KEY, {
      model: "fake-embed-4d",
      dimension: 4,
      purpose: "document",
      products: 1,
      at: AT,
      ceiling: 50000,
    });
    await store.tx({ tenantId: "acme" }, async (t) => {
      await writeLedgerInTx(t, chunkLedgerEntries(ledgerOf(3), AT), []);
    });

    const report = await runCatalogClear({ store, vector }, "acme");

    expect(report.confirmed).toBe(true);
    expect(await listLedgerChunkKeys(store, "acme")).toEqual([]);
    expect(await store.get({ tenantId: "acme" }, MANIFEST_COLLECTION, MANIFEST_KEY)).toBeNull();
  });
});
