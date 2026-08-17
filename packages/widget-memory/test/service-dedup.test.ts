import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  createEnvSecrets,
  type SecretsPort,
  type ModelPort,
  type EmbedRequest,
  type EmbedResponse,
} from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace } from "../src/identity.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// semantic-memory-v1, PR2 (write path), T5 — write-time dedup. Gated the same way T4 is
// (MEMORY_SEMANTIC_RECALL=true) because ordinary-fact dedup is a similarity operation over the SAME
// vectors T4 introduces — there is no vector to compare against with the flag off, so this file assumes
// T4's embed integration exists once both land; today, both are red for the same underlying reason (no
// embed integration at all yet).

const SEMANTIC_FLAG = "MEMORY_SEMANTIC_RECALL";

beforeEach(() => {
  delete process.env[SEMANTIC_FLAG];
  process.env[SEMANTIC_FLAG] = "true";
});
afterEach(() => {
  delete process.env[SEMANTIC_FLAG];
});

function keyedSecrets(...tenantIds: string[]): SecretsPort {
  const byTenant: Record<string, Record<string, string>> = {};
  for (const t of tenantIds) byTenant[t] = { MEMORY_ENCRYPTION_KEY: `test-key-for-${t}` };
  return createEnvSecrets(JSON.stringify(byTenant));
}

/** A FULLY test-controlled embed model: every input text maps to an EXPLICIT vector from `table`
 *  (fixture text -> vector), so "near-duplicate" and "distinct" are exact, deterministic properties of
 *  the fixture — never an artifact of a real model's fuzziness. Unmapped text throws loudly (a fixture
 *  gap, not a silently-wrong vector). */
function tableEmbedModel(dimension: number, table: Record<string, number[]>): ModelPort {
  return {
    async complete() {
      throw new Error("tableEmbedModel: complete() should never be called — tests inject `distiller` directly");
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      const vectors = req.texts.map((t) => {
        const v = table[t];
        if (!v) throw new Error(`tableEmbedModel: no fixture vector registered for text: ${JSON.stringify(t)}`);
        return v;
      });
      return { vectors, dimension, model: "table-embed", purpose: req.purpose };
    },
  };
}

function distillerReturning(text: string): FactDistiller {
  return { async distill() { return [{ text }]; } };
}

describe("createMemoryService — write-time dedup, ORDINARY facts (semantic, near-duplicate vectors)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const TABLE = {
    "prefers fragrance-free products": [1, 0, 0],
    "prefers fragrance free (no added fragrance)": [0.99, 0.01, 0], // near-duplicate: cosine ~0.9998
    "loves hiking in national parks": [0, 1, 0], // orthogonal: cosine 0, clearly distinct
  };

  it("a near-duplicate write collapses into ONE record with a RE-STAMPED expiresAt (not a second row)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    let nowMs = new Date("2026-01-01T00:00:00Z").getTime();
    const model = tableEmbedModel(3, TABLE);

    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning("prefers fragrance-free products"),
      model,
      enabled: true,
      clock: () => new Date(nowMs),
    });
    const ctx: MemoryCtx = { tenantId: "acme-dedup-ord", anonId: "guest-dedup-ord", region: "us", consent1: "in", consent2: "unknown" };

    await service.remember(ctx, { message: "m1", reply: "r1" });

    // 5 days later, a near-duplicate of the SAME preference is expressed differently.
    nowMs += 5 * DAY;
    const service2 = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning("prefers fragrance free (no added fragrance)"),
      model,
      enabled: true,
      clock: () => new Date(nowMs),
    });
    await service2.remember(ctx, { message: "m2", reply: "r2" });

    const ns = subjectNamespace("acme-dedup-ord", "guest-dedup-ord");
    const listed = await vector.list(ns, { limit: 10 });
    expect(listed).toHaveLength(1); // ONE record, not two

    const expiresAt = (listed[0]!.metadata as { expiresAt?: string }).expiresAt;
    expect(expiresAt).toBeDefined();
    // Re-stamped from the SECOND write's clock (day 5), not the original (day 0): 5d + 30d = day 35.
    const expected = new Date(nowMs + 30 * DAY).toISOString();
    expect(expiresAt).toBe(expected);
  });

  it("a genuinely DISTINCT fact is stored as its OWN, second record (no over-merging)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const model = tableEmbedModel(3, TABLE);
    const ctx: MemoryCtx = { tenantId: "acme-dedup-distinct", anonId: "guest-dedup-distinct", region: "us", consent1: "in", consent2: "unknown" };

    const service1 = createMemoryService({ vector, audit: runtimeStore, distiller: distillerReturning("prefers fragrance-free products"), model, enabled: true });
    await service1.remember(ctx, { message: "m1", reply: "r1" });

    const service2 = createMemoryService({ vector, audit: runtimeStore, distiller: distillerReturning("loves hiking in national parks"), model, enabled: true });
    await service2.remember(ctx, { message: "m2", reply: "r2" });

    const ns = subjectNamespace("acme-dedup-distinct", "guest-dedup-distinct");
    const listed = await vector.list(ns, { limit: 10 });
    expect(listed).toHaveLength(2); // both stored — genuinely different preferences
  });
});

describe("createMemoryService — write-time dedup, SPECIAL facts (exact-match keyed-HMAC dedupTag, NEVER vector similarity)", () => {
  it("the SAME special-category plaintext, written twice, collapses to ONE record (via dedupTag, not embedding)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ctx: MemoryCtx = { tenantId: "acme-dedup-special", anonId: "guest-dedup-special", region: "us", consent1: "in", consent2: "in" };

    const service1 = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning("shopper has a tree-nut allergy"),
      enabled: true,
      secrets: keyedSecrets("acme-dedup-special"),
    });
    await service1.remember(ctx, { message: "m1", reply: "r1" });

    const service2 = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning("shopper has a tree-nut allergy"), // EXACT same plaintext
      enabled: true,
      secrets: keyedSecrets("acme-dedup-special"),
    });
    await service2.remember(ctx, { message: "m2", reply: "r2" });

    const ns = subjectNamespace("acme-dedup-special", "guest-dedup-special");
    const listed = await vector.list(ns, { limit: 10 });
    expect(listed).toHaveLength(1); // ONE record, not two
    // The dedup mechanism for special facts is a keyed-HMAC tag stamped on the metadata (types.ts's new
    // `FactMetadata.dedupTag`), never a vector similarity computation over health text.
    expect(typeof (listed[0]!.metadata as { dedupTag?: string }).dedupTag).toBe("string");
  });

  it("a DIFFERENT special-category plaintext is stored as its own, second record", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ctx: MemoryCtx = { tenantId: "acme-dedup-special-2", anonId: "guest-dedup-special-2", region: "us", consent1: "in", consent2: "in" };

    const service1 = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning("shopper has a tree-nut allergy"),
      enabled: true,
      secrets: keyedSecrets("acme-dedup-special-2"),
    });
    await service1.remember(ctx, { message: "m1", reply: "r1" });

    const service2 = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: distillerReturning("shopper is pregnant"), // a DIFFERENT special-category fact
      enabled: true,
      secrets: keyedSecrets("acme-dedup-special-2"),
    });
    await service2.remember(ctx, { message: "m2", reply: "r2" });

    const ns = subjectNamespace("acme-dedup-special-2", "guest-dedup-special-2");
    const listed = await vector.list(ns, { limit: 10 });
    expect(listed).toHaveLength(2); // two genuinely different special facts, both retained
  });
});
