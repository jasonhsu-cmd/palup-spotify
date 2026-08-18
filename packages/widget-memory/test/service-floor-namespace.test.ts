import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  createEnvSecrets,
  type VectorPort,
  type VectorRecord,
  type VectorListOpts,
  type SecretsPort,
  type ModelPort,
  type EmbedRequest,
  type EmbedResponse,
} from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace, floorNamespace } from "../src/identity.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// #125 — "pinned floor namespace": special/`mustRecall` facts route to a DEDICATED per-subject namespace
// (`floorNamespace`, identity.ts) at write time, so `recall()`'s safety-floor enumeration reads ONLY that
// namespace (O(floor)) instead of paging the subject's entire corpus (O(N)) to find the handful of special
// rows. v1/no customers: NO dual-read, NO migration — this is a pure write-routing + read-routing change.

const SEMANTIC_FLAG = "MEMORY_SEMANTIC_RECALL";

beforeEach(() => {
  delete process.env[SEMANTIC_FLAG];
});
afterEach(() => {
  delete process.env[SEMANTIC_FLAG];
});

function keyedSecrets(...tenantIds: string[]): SecretsPort {
  const byTenant: Record<string, Record<string, string>> = {};
  for (const t of tenantIds) byTenant[t] = { MEMORY_ENCRYPTION_KEY: `test-key-for-${t}` };
  return createEnvSecrets(JSON.stringify(byTenant));
}

function fixedDistiller(facts: string[]): FactDistiller {
  return { async distill() { return facts.map((text) => ({ text })); } };
}

const DIMENSION = 8;
const PIN = { model: "table-embed-8d", dimension: DIMENSION };

function basis(i: number): number[] {
  const v = new Array<number>(DIMENSION).fill(0);
  v[i] = 1;
  return v;
}

function tableEmbedModel(table: Record<string, number[]>): ModelPort {
  return {
    async complete() {
      throw new Error("tableEmbedModel: complete() should never be called in these tests");
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      const vectors = req.texts.map((t) => {
        const v = table[t];
        if (!v) throw new Error(`tableEmbedModel: no fixture vector for text: ${JSON.stringify(t)}`);
        return v;
      });
      return { vectors, dimension: vectors[0]?.length ?? DIMENSION, model: PIN.model, purpose: req.purpose };
    },
  };
}

/** Wraps a VectorPort so a test can count exactly how many `list` calls landed on a given namespace —
 *  the O(floor) proof needs to show that count is INDEPENDENT of how large the main namespace is, not
 *  just that the right data comes back. */
function countingVectorStore(): VectorPort & { listCallCount: (namespace: string) => number } {
  const inner = createInMemoryVectorStore();
  const calls: string[] = [];
  return {
    upsert: (ns, records) => inner.upsert(ns, records),
    query: (ns, q) => inner.query(ns, q),
    list: (ns: string, opts: VectorListOpts) => {
      calls.push(ns);
      return inner.list(ns, opts);
    },
    deleteById: (ns, ids) => inner.deleteById(ns, ids),
    deleteNamespace: (ns) => inner.deleteNamespace(ns),
    listCallCount: (ns: string) => calls.filter((c) => c === ns).length,
  };
}

describe("#125 — write routing: a special-category remember() lands in the floor namespace, not the main one", () => {
  it("a special fact is stored in floorNamespace; the main subjectNamespace has ZERO class:\"special\" rows", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-floor-write";
    const anonId = "guest-floor-write";
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets(tenantId),
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

    const result = await service.remember(ctx, { message: "m", reply: "r" });
    expect(result.written).toEqual(["special"]);

    const mainRows = await vector.list(subjectNamespace(tenantId, anonId), { limit: 100 });
    expect(mainRows.filter((r) => (r.metadata as { class?: string } | undefined)?.class === "special")).toHaveLength(0);

    const floorRows = await vector.list(floorNamespace(tenantId, anonId), { limit: 100 });
    expect(floorRows).toHaveLength(1);
    expect((floorRows[0]!.metadata as { class?: string } | undefined)?.class).toBe("special");
  });

  it("an ordinary fact stays in the main subjectNamespace (only special/floor rows move)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-floor-ordinary";
    const anonId = "guest-floor-ordinary";
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "unknown" };

    await service.remember(ctx, { message: "m", reply: "r" });

    const mainRows = await vector.list(subjectNamespace(tenantId, anonId), { limit: 100 });
    expect(mainRows).toHaveLength(1);
    const floorRows = await vector.list(floorNamespace(tenantId, anonId), { limit: 100 });
    expect(floorRows).toHaveLength(0);
  });
});

describe("#125 — HEADLINE: the floor read is O(floor), independent of the subject's total ordinary-fact count", () => {
  async function floorListCallsFor(ordinaryCount: number): Promise<number> {
    const vector = countingVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = `acme-o-floor-${ordinaryCount}`;
    const anonId = "guest-o-floor";
    const mainNs = subjectNamespace(tenantId, anonId);
    const floorNs = floorNamespace(tenantId, anonId);
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

    // N ordinary rows in the MAIN namespace — the whole point is that the floor read must never scale
    // with this number.
    const ordinaryRows: VectorRecord[] = Array.from({ length: ordinaryCount }, (_, i) => ({
      id: `ord-${String(i).padStart(4, "0")}`,
      text: `ordinary fact ${i}`,
      vector: basis(0),
      metadata: { text: `ordinary fact ${i}`, class: "ordinary" as const, expiresAt: future, encrypted: false },
    }));
    await vector.upsert(mainNs, ordinaryRows);

    // A handful of floor rows in the DEDICATED floor namespace.
    const floorRows: VectorRecord[] = Array.from({ length: 2 }, (_, i) => ({
      id: `spec-${i}`,
      text: `special fact ${i}`,
      vector: basis(1),
      metadata: { text: `special fact ${i}`, class: "special" as const, mustRecall: true, expiresAt: future, encrypted: false },
    }));
    await vector.upsert(floorNs, floorRows);

    // A manifest pin so `recall()` takes the semantic (ranked + floor) branch — the branch whose floor
    // half is `enumerateFloor`, the O(floor) code path this test is proving.
    const { writeMemoryManifest } = await import("../src/manifest.js");
    await writeMemoryManifest(runtimeStore, { tenantId }, { model: PIN.model, dimension: DIMENSION, purpose: "document", at: new Date().toISOString() });

    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: { async distill() { return []; } },
      enabled: true,
      semanticRecall: true,
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

    const recalled = await service.recall(ctx, { queryVector: basis(0), pin: PIN });
    // Sanity: both floor facts genuinely surfaced (this is a real read, not a no-op).
    expect(recalled.filter((f) => f.class === "special")).toHaveLength(2);

    return vector.listCallCount(floorNs);
  }

  it("the floor namespace's `list` call count is the SAME whether the subject has 2 or 200 ordinary facts", async () => {
    const callsAtN2 = await floorListCallsFor(2);
    const callsAtN200 = await floorListCallsFor(200);

    expect(callsAtN2).toBeGreaterThan(0); // the floor really was read
    expect(callsAtN200).toBe(callsAtN2); // independent of N — the O(floor) proof
  });
});

describe("#125 — recall + renewal correctly targets the floor namespace", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("an EXPIRED floor row is not served; a LIVE one is", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-floor-ttl";
    const anonId = "guest-floor-ttl";
    const future = new Date(Date.now() + 10 * DAY).toISOString();
    const past = new Date(Date.now() - DAY).toISOString();
    await vector.upsert(floorNamespace(tenantId, anonId), [
      {
        id: "expired-1",
        text: "an old allergy note",
        metadata: { text: "an old allergy note", class: "special", mustRecall: true, expiresAt: past, encrypted: false },
      },
      {
        id: "live-1",
        text: "shopper has a tree-nut allergy",
        metadata: { text: "shopper has a tree-nut allergy", class: "special", mustRecall: true, expiresAt: future, encrypted: false },
      },
    ]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller: { async distill() { return []; } }, enabled: true });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };

    const recalled = await service.recall(ctx);
    const texts = recalled.map((f) => f.text);
    expect(texts).not.toContain("an old allergy note");
    expect(texts).toContain("shopper has a tree-nut allergy");
  });

  it("a returning recall re-stamps a live floor row's TTL, and the re-stamp upsert targets the FLOOR namespace (never the main one)", async () => {
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-floor-renew";
    const anonId = "guest-floor-renew";
    let nowMs = new Date("2026-01-01T00:00:00Z").getTime();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      clock: () => new Date(nowMs),
      secrets: keyedSecrets(tenantId),
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });
    upsertSpy.mockClear(); // only care about calls made by the RECALL below, not the write above

    // Day 25 return (< 30d TTL, > RENEW_MIN_GAP=1d) — the fact should slide forward.
    nowMs += 25 * DAY;
    const recalled = await service.recall(ctx);
    expect(recalled).toEqual([{ text: "shopper has a tree-nut allergy", class: "special" }]);

    const floorNs = floorNamespace(tenantId, anonId);
    const mainNs = subjectNamespace(tenantId, anonId);
    const renewalCalls = upsertSpy.mock.calls.filter(([ns]) => ns === floorNs);
    expect(renewalCalls).toHaveLength(1); // the re-stamp landed in the floor namespace...
    expect(upsertSpy.mock.calls.some(([ns]) => ns === mainNs)).toBe(false); // ...never the main one

    const log = await runtimeStore.readAudit({ tenantId });
    const renewEvt = log.find((r) => r.action === "ttl_renew");
    expect(renewEvt).toBeDefined();
    expect((renewEvt?.decision as { count?: number } | undefined)?.count).toBe(1);
  });
});

describe("#125 — completeness is preserved by construction: a special fact always surfaces, even when orthogonal to the ranked query", () => {
  it("an ordinary fact ranks near the query; the special fact surfaces via the floor regardless of similarity", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme-floor-completeness";
    const anonId = "guest-floor-completeness";
    const NEAR_TEXT = "likes product family alpha-7";
    const model = tableEmbedModel({ [NEAR_TEXT]: basis(0) });
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller([NEAR_TEXT, "shopper has a tree-nut allergy"]),
      model,
      enabled: true,
      secrets: keyedSecrets(tenantId),
    });
    const ctx: MemoryCtx = { tenantId, anonId, region: "us", consent1: "in", consent2: "in" };
    process.env[SEMANTIC_FLAG] = "true";
    const written = await service.remember(ctx, { message: "m", reply: "r" });
    expect(written.written).toEqual(["ordinary", "special"]);

    // Query vector orthogonal to the ordinary fact's own embedding — it ranks last, not first, in the
    // ranked half. The special fact carries a content-independent RANDOM placeholder vector (T4), so it
    // never ranks in either way; it must surface purely through the floor.
    const orthogonalQuery = basis(7);
    const recalled = await service.recall(ctx, { queryVector: orthogonalQuery, pin: PIN });
    const texts = recalled.map((f) => f.text);
    expect(texts).toContain("shopper has a tree-nut allergy");
    expect(recalled.some((f) => f.class === "special")).toBe(true);
  });
});
