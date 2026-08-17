import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  createEnvSecrets,
  requireEmbedInputs,
  requireEmbedAlignment,
  type VectorPort,
  type SecretsPort,
  type ModelPort,
  type EmbedRequest,
  type EmbedResponse,
} from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace } from "../src/identity.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";
import type { Disposition } from "../src/disposition.js";

const EMBED_DIMENSION = 4;

// semantic-memory-v1, PR2 (write path), T4 — embed ordinary / NEVER embed special / stamp `.vector`,
// gated behind the NEW `MEMORY_SEMANTIC_RECALL` flag (env var, mirrors `MEMORY_ENABLED`'s shape — see
// flag.ts's OWN double-gate for the double-gate PATTERN this reuses; flag.ts ITSELF is untouched by this
// PR, per the task scope — `MEMORY_SEMANTIC_RECALL` is read directly by the (not-yet-existing) embed
// integration inside service.ts, never folded into isMemoryEnabled/MEMORY_ADR_ACCEPTED).
//
// ALL tests here also pass `enabled: true` (the EXISTING createMemoryService test seam, service.ts:159 —
// honored only under a real test runner) so the double gate itself is not what's under test; the NEW
// semantic-recall gate is layered independently on top of it.
//
// WHAT THESE TESTS DO NOT CLAIM: the fake embedder below is a fully test-controlled deterministic
// function, not a real embedding model — it proves the WIRING (when embed is/isn't called, what purpose,
// what lands on the record), not retrieval quality on real embeddings (that is the eval gate's job).

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

function fixedDistiller(facts: Array<{ text: string; disposition?: Disposition }>): FactDistiller {
  return { distill: vi.fn(async () => facts) };
}

/** Deterministic, fully test-controlled embed model: every call runs the SAME shared port validators a
 *  real adapter must (requireEmbedInputs / requireEmbedAlignment), and records every request it ever
 *  received so a test can assert EXACTLY what (and how many times) something was embedded — including
 *  proving a given plaintext was NEVER among the texts sent. */
function spyEmbedModel(dimension = 4): ModelPort & { calls: EmbedRequest[] } {
  const calls: EmbedRequest[] = [];
  return {
    calls,
    async complete() {
      throw new Error("spyEmbedModel: complete() should never be called — these tests inject `distiller` directly");
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      calls.push({ ...req, texts: [...req.texts] });
      requireEmbedInputs(req);
      const vectors = req.texts.map((t) => {
        const v = new Array<number>(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] = (v[i % dimension] ?? 0) + t.charCodeAt(i);
        return v;
      });
      const res: EmbedResponse = { vectors, dimension, model: "fake-embed-4d", purpose: req.purpose };
      requireEmbedAlignment(req, res);
      return res;
    },
  };
}

describe("createMemoryService — ordinary candidates are embedded when MEMORY_SEMANTIC_RECALL is ON", () => {
  it("each ordinary candidate is embedded exactly once, purpose:'document', and the persisted record carries a dimension-matched vector", async () => {
    process.env[SEMANTIC_FLAG] = "true";
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const runtimeStore = new InMemoryRuntimeStore();
    const embedModel = spyEmbedModel(4);
    const distiller = fixedDistiller([{ text: "prefers fragrance-free products" }]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, model: embedModel, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-embed", anonId: "guest-embed", region: "us", consent1: "in", consent2: "unknown" };

    const result = await service.remember(ctx, { message: "m", reply: "r" });
    expect(result.written).toEqual(["ordinary"]);

    expect(embedModel.calls).toHaveLength(1);
    expect(embedModel.calls[0]!.purpose).toBe("document");
    expect(embedModel.calls[0]!.texts).toEqual(["prefers fragrance-free products"]);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const [, records] = upsertSpy.mock.calls[0]!;
    expect(records).toHaveLength(1);
    expect(records[0]!.vector).toBeDefined();
    expect(records[0]!.vector).toHaveLength(4); // dimension-matched to the embed response
    expect(records[0]!.vector!.every((n) => Number.isFinite(n))).toBe(true);
  });
});

describe("createMemoryService — special-category candidates are NEVER embedded (privacy boundary)", () => {
  it("a special candidate's plaintext never reaches embed; its record carries mustRecall:true and a placeholder vector NOT derived from embed", async () => {
    process.env[SEMANTIC_FLAG] = "true";
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const runtimeStore = new InMemoryRuntimeStore();
    const embedModel = spyEmbedModel(4);
    // One ordinary + one special candidate in the SAME turn, so the dimension the special placeholder
    // must match is independently knowable from the ordinary candidate's REAL embed response in this
    // very test, rather than assumed.
    const distiller = fixedDistiller([
      { text: "prefers fragrance-free products" },
      { text: "shopper has a tree-nut allergy" },
    ]);
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller,
      model: embedModel,
      enabled: true,
      secrets: keyedSecrets("acme-embed-special"), // special write must not be refused for lack of a key
    });
    const ctx: MemoryCtx = { tenantId: "acme-embed-special", anonId: "guest-embed-special", region: "us", consent1: "in", consent2: "in" };

    const result = await service.remember(ctx, { message: "m", reply: "r" });
    expect(result.written).toContain("ordinary");
    expect(result.written).toContain("special");

    // The ONLY embed call ever made carries ONLY the ordinary candidate's text — proving the special
    // candidate's plaintext (and its Art-9-adjacent content) was never among the batch sent to embed.
    expect(embedModel.calls).toHaveLength(1);
    expect(embedModel.calls[0]!.texts).toEqual(["prefers fragrance-free products"]);

    // upsert is called once for the ordinary batch and once for the special batch (service.ts's existing
    // split — remember()'s "if (ordinaryRecords.length > 0)" / "if (specialRecords.length > 0)").
    expect(upsertSpy).toHaveBeenCalledTimes(2);
    const specialCall = upsertSpy.mock.calls.find(([, recs]) => (recs[0]?.metadata as { class?: string } | undefined)?.class === "special");
    expect(specialCall).toBeDefined();
    const specialRecord = specialCall![1][0]!;
    expect((specialRecord.metadata as { mustRecall?: boolean }).mustRecall).toBe(true);
    expect(specialRecord.vector).toBeDefined();
    expect(specialRecord.vector).toHaveLength(EMBED_DIMENSION); // dimension-matched...
    // ...but NOT the vector embed() would have produced for this text (embed was never asked to
    // produce one at all — already proven above by embedModel.calls having length 1, none of which
    // named this text). This assertion documents the placeholder is a DISTINCT construction, not a
    // lazily-computed real embedding.
    expect(embedModel.calls.map((c) => c.texts).flat()).not.toContain("shopper has a tree-nut allergy");
  });
});

describe("createMemoryService — Art-9 leak guard: a sourceQuote-promoted-to-special candidate is never embedded either", () => {
  it("an ordinary-looking fact carrying an Art-9 sourceQuote (promoted to special via effectiveClass) is NOT embedded", async () => {
    process.env[SEMANTIC_FLAG] = "true";
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const embedModel = spyEmbedModel(4);
    const distiller: FactDistiller = {
      async distill() {
        return [
          {
            text: "prefers fragrance-free",
            disposition: {
              axis: "style",
              value: "needs_guidance",
              provenance: "stated",
              confidence: 0.9,
              // Art-9 per classifier.ts's medication terms ("tretinoin") — the FACT text alone would
              // classify ordinary, but the quote promotes the whole candidate to special end-to-end
              // (service.ts's existing `effectiveClass` logic, security review finding 2).
              sourceQuote: "I'm on tretinoin so I need fragrance-free",
            },
          },
        ];
      },
    };
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller,
      model: embedModel,
      enabled: true,
      secrets: keyedSecrets("acme-art9-leak"),
    });
    const ctx: MemoryCtx = { tenantId: "acme-art9-leak", anonId: "guest-art9-leak", region: "us", consent1: "in", consent2: "in" };

    const result = await service.remember(ctx, { message: "m", reply: "r" });
    expect(result.written).toEqual(["special"]); // promoted, not "ordinary"

    // THE PRIVACY BOUNDARY: the embed spy must NEVER have been called at all for this turn — the health
    // text ("tretinoin"/"fragrance-free" combination) must never reach the embedding provider, even
    // though the FACT text alone looks ordinary.
    expect(embedModel.calls).toHaveLength(0);
  });
});

describe("createMemoryService — MEMORY_SEMANTIC_RECALL OFF (default/unset): baseline unchanged", () => {
  it("embed is NEVER called and records are vector-less, exactly like today's behavior", async () => {
    // Deliberately NOT setting the flag — this is the default posture.
    expect(process.env[SEMANTIC_FLAG]).toBeUndefined();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const runtimeStore = new InMemoryRuntimeStore();
    const embedModel = spyEmbedModel(4);
    const distiller = fixedDistiller([{ text: "prefers fragrance-free products" }]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, model: embedModel, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-embed-off", anonId: "guest-embed-off", region: "us", consent1: "in", consent2: "unknown" };

    const result = await service.remember(ctx, { message: "m", reply: "r" });
    expect(result.written).toEqual(["ordinary"]);
    expect(embedModel.calls).toHaveLength(0);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const [, records] = upsertSpy.mock.calls[0]!;
    expect(records[0]!.vector).toBeUndefined();

    const raw = await vector.query(subjectNamespace("acme-embed-off", "guest-embed-off"), { text: "", k: 10 });
    expect(raw[0]?.metadata?.text).toBe("prefers fragrance-free products");
  });
});
