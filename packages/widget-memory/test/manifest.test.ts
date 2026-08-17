import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
// semantic-memory-v1, PR2 (write path), T3 — THIS MODULE DOES NOT EXIST YET. Every test below is RED at
// import resolution ("Cannot find module '../src/manifest.js'") until a builder creates it. That is the
// correct, most direct RED signal for "a new file this PR introduces" — see this PR's test-authoring
// report for why a module-resolution failure is treated as genuine here rather than deferred.
//
// Contract this test file is pinning (mirrors the catalog corpus's own `CatalogManifest` +
// `catalog-index.ts`'s manifest-write pattern — jobs/catalog-index.ts:177-200, :824-833 — but for the
// per-SUBJECT memory corpus, keyed off RuntimeStatePort like every other memory KV, not the vector port):
//
//   export interface MemoryManifest { model: string; dimension: number; purpose: "document"; at: string }
//   export function readMemoryManifest(store: RuntimeStatePort, ctx: {tenantId}): Promise<MemoryManifest | null>
//   export function writeMemoryManifest(store: RuntimeStatePort, ctx: {tenantId}, manifest: MemoryManifest): Promise<void>
//   export function memoryPinMismatch(manifest: MemoryManifest, embed: {model:string; dimension:number}): boolean
//
// Collection/key are pinned to the LITERAL strings the task spec names ("memory_index" / "manifest")
// rather than to constants imported from the new module, so this test does not silently pass merely
// because it re-imports whatever constant name the builder happens to pick — it independently proves the
// module reads/writes the KV location a future migration/ops runbook can also target by name.
import {
  readMemoryManifest,
  writeMemoryManifest,
  memoryPinMismatch,
  type MemoryManifest,
} from "../src/manifest.js";

const MANIFEST_COLLECTION = "memory_index";
const MANIFEST_KEY = "manifest";

function pinnedManifest(overrides: Partial<MemoryManifest> = {}): MemoryManifest {
  return {
    model: "gemini-embedding-2",
    dimension: 1536,
    purpose: "document",
    at: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("memoryPinMismatch — {model, dimension} pin check (mirrors catalog's corpus pin)", () => {
  it("exact {gemini-embedding-2, 1536} match is accepted (no mismatch)", () => {
    const manifest = pinnedManifest();
    expect(memoryPinMismatch(manifest, { model: "gemini-embedding-2", dimension: 1536 })).toBe(false);
  });

  it("a MODEL mismatch (same dimension) is detected", () => {
    const manifest = pinnedManifest();
    expect(memoryPinMismatch(manifest, { model: "some-other-embed-model", dimension: 1536 })).toBe(true);
  });

  it("a DIMENSION mismatch (same model) is detected", () => {
    const manifest = pinnedManifest();
    expect(memoryPinMismatch(manifest, { model: "gemini-embedding-2", dimension: 768 })).toBe(true);
  });

  it("a mismatch on BOTH model and dimension is still just a mismatch (true), not a crash", () => {
    const manifest = pinnedManifest();
    expect(memoryPinMismatch(manifest, { model: "totally-different", dimension: 4 })).toBe(true);
  });
});

describe("readMemoryManifest / writeMemoryManifest — persisted over RuntimeStatePort (collection: memory_index, key: manifest)", () => {
  it("round-trips: absent before any write (null), then reads back exactly what was written", async () => {
    const store = new InMemoryRuntimeStore();
    const ctx = { tenantId: "acme-manifest" };

    expect(await readMemoryManifest(store, ctx)).toBeNull();

    const manifest = pinnedManifest({ at: "2026-08-17T00:00:00.000Z" });
    await writeMemoryManifest(store, ctx, manifest);

    expect(await readMemoryManifest(store, ctx)).toEqual(manifest);
    // Independently verified at the literal KV location — not merely via the module's own read helper,
    // so this also pins WHERE the manifest lives for any future ops tooling.
    expect(await store.get(ctx, MANIFEST_COLLECTION, MANIFEST_KEY)).toEqual(manifest);
  });

  it("the FIRST write persists the manifest WITH an audit record (no silent write — ADR-0015 Inv 6 discipline)", async () => {
    const store = new InMemoryRuntimeStore();
    const ctx = { tenantId: "acme-manifest-audit" };

    const before = await store.readAudit(ctx);
    expect(before).toHaveLength(0);

    await writeMemoryManifest(store, ctx, pinnedManifest());

    const after = await store.readAudit(ctx);
    expect(after.length).toBeGreaterThan(0);
    // PII-free discipline, matching every other memory audit record in this package (audit.ts): the
    // manifest write is metadata (model/dimension/purpose), never shopper fact text — nothing here
    // should ever be shopper-authored content, so this is a cheap, durable guard against a future
    // regression that logs something it shouldn't.
    expect(JSON.stringify(after)).not.toContain("shopper");
  });

  it("tenant isolation: tenant A's manifest is never visible to tenant B", async () => {
    const store = new InMemoryRuntimeStore();
    await writeMemoryManifest(store, { tenantId: "tenant-a" }, pinnedManifest({ model: "model-a" }));

    expect(await readMemoryManifest(store, { tenantId: "tenant-b" })).toBeNull();
    expect((await readMemoryManifest(store, { tenantId: "tenant-a" }))?.model).toBe("model-a");
  });
});
