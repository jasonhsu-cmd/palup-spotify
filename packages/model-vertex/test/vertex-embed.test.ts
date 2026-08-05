import { describe, it, expect, vi, afterEach } from "vitest";
import { canEmbed } from "@palup/platform-ports";
import {
  VertexModelAdapter,
  maxBatchForEmbedModel,
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_TASK_TYPES,
  type EmbedContentFn,
  type GenerateFn,
  type VertexEmbedRequest,
} from "../src/vertex-adapter.js";
import { createVertexAdapter } from "../src/create.js";

// B3 — the Vertex EMBEDDING adapter. Every test here drives an INJECTED embedContent transport: there are
// no GCP credentials in this environment, so what is proven below is the adapter's own chunking /
// alignment / usage / fail-closed logic and its request shaping — NOT that the live service behaves this
// way. The one command that could prove the live path is `pnpm model:smoke` with real creds.

const gen: GenerateFn = async () => ({ text: "ok" });
const CFG = { model: "gemini-test" };

/** A deterministic, content-derived fake embedding: same text => same vector, different text => different
 *  vector. Content-derived (not positional) so the contract suite's cosine ORDER check is meaningful. */
const DIM = 16;
function fakeVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % DIM]! += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** A well-behaved fake provider: one embedding per content, in order, with a token count. */
function fakeEmbed(): EmbedContentFn {
  return async (req: VertexEmbedRequest) => ({
    embeddings: req.contents.map((t) => ({
      values: fakeVector(t),
      statistics: { truncated: false, tokenCount: Math.max(1, Math.ceil(t.length / 4)) },
    })),
  });
}

/** Build an embed-capable adapter over an injected transport. */
function adapterWith(call: EmbedContentFn, maxBatch = 1, extra: Record<string, unknown> = {}) {
  return new VertexModelAdapter(gen, CFG, {
    call,
    cfg: { model: "embed-test-1", taskTypes: DEFAULT_EMBED_TASK_TYPES, maxBatch, ...extra },
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("VertexModelAdapter.embed — capability declaration (#188's absence rule)", () => {
  it("OMITS embed when no embedContent transport was injected — never a stub that throws", () => {
    const noEmbed = new VertexModelAdapter(gen, CFG);
    expect(noEmbed.embed).toBeUndefined();
    expect(canEmbed(noEmbed)).toBe(false);
  });

  it("DECLARES embed when a transport was injected — canEmbed reports true", () => {
    const withEmbed = adapterWith(fakeEmbed());
    expect(typeof withEmbed.embed).toBe("function");
    expect(canEmbed(withEmbed)).toBe(true);
  });
});

describe("VertexModelAdapter.embed — the port's contract, satisfied by the port's own validators", () => {
  it("returns one vector per text, in order, with the dimension and model it actually produced", async () => {
    const adapter = adapterWith(fakeEmbed(), 3);
    const texts = ["ceramide barrier cream", "zinc mineral sunscreen", "caffeine eye cream", "niacinamide serum"];
    const res = await adapter.embed!({ texts, purpose: "document" });
    expect(res.vectors).toHaveLength(4);
    expect(res.dimension).toBe(DIM);
    expect(res.model).toBe("embed-test-1");
    // vectors[i] embeds texts[i] — checked against the same deterministic oracle the fake used.
    texts.forEach((t, i) => expect(res.vectors[i]).toEqual(fakeVector(t)));
  });

  it("rejects an empty batch BEFORE spending a provider call (requireEmbedInputs)", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed());
    const adapter = adapterWith(call);
    await expect(adapter.embed!({ texts: [], purpose: "document" })).rejects.toThrow(/at least one text/);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a blank text BEFORE spending a provider call, naming the index (requireEmbedInputs)", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed());
    const adapter = adapterWith(call);
    await expect(adapter.embed!({ texts: ["ceramide cream", "   "], purpose: "document" })).rejects.toThrow(/index 1/);
    expect(call).not.toHaveBeenCalled();
  });

  it("reports usage as inputTokens only — an embedding has no completion tokens", async () => {
    const adapter = adapterWith(fakeEmbed(), 2);
    const res = await adapter.embed!({ texts: ["abcd", "efgh", "ijkl"], purpose: "document" });
    expect(res.usage).toEqual({ inputTokens: 3 }); // 1 token per 4 chars, summed across 2 chunks
    expect(res.usage).not.toHaveProperty("outputTokens");
  });

  it("OMITS usage entirely when any text's token count is missing — never a fabricated low number", async () => {
    const partial: EmbedContentFn = async (req) => ({
      embeddings: req.contents.map((t, i) => ({
        values: fakeVector(t),
        ...(i === 0 ? { statistics: { tokenCount: 7 } } : {}),
      })),
    });
    const res = await adapterWith(partial, 5).embed!({ texts: ["aaaa", "bbbb"], purpose: "document" });
    expect(res.usage).toBeUndefined();
  });
});

describe("VertexModelAdapter.embed — chunking to the provider's per-request cap", () => {
  it("splits the batch at maxBatch and reassembles IN ORDER", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed());
    const adapter = adapterWith(call, 3);
    const texts = ["t0", "t1", "t2", "t3", "t4", "t5", "t6"];
    const res = await adapter.embed!({ texts, purpose: "document" });
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls.map((c) => c[0].contents)).toEqual([["t0", "t1", "t2"], ["t3", "t4", "t5"], ["t6"]]);
    texts.forEach((t, i) => expect(res.vectors[i]).toEqual(fakeVector(t)));
  });

  it("sends ONE text per request at the gemini-embedding-001 default of maxBatch=1", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed());
    await adapterWith(call, 1).embed!({ texts: ["a", "b", "c"], purpose: "document" });
    expect(call).toHaveBeenCalledTimes(3);
    for (const c of call.mock.calls) expect(c[0].contents).toHaveLength(1);
  });

  it("a chunk that THROWS mid-way rejects the WHOLE call — never a partial batch", async () => {
    let n = 0;
    const flaky: EmbedContentFn = async (req) => {
      if (++n === 2) throw new Error("provider 503");
      return { embeddings: req.contents.map((t) => ({ values: fakeVector(t) })) };
    };
    await expect(adapterWith(flaky, 1).embed!({ texts: ["a", "b", "c"], purpose: "document" })).rejects.toThrow(/503/);
  });

  it("a chunk that returns FEWER vectors than its texts rejects the whole call", async () => {
    const short: EmbedContentFn = async (req) => ({
      embeddings: req.contents.slice(0, req.contents.length - 1).map((t) => ({ values: fakeVector(t) })),
    });
    await expect(adapterWith(short, 3).embed!({ texts: ["a", "b", "c"], purpose: "document" })).rejects.toThrow(
      /3 texts .* 2 vectors|sent 3 .* got 2/,
    );
  });

  it("a chunk that returns MORE vectors than its texts rejects the whole call", async () => {
    const over: EmbedContentFn = async (req) => ({
      embeddings: [...req.contents, "phantom"].map((t) => ({ values: fakeVector(t) })),
    });
    await expect(adapterWith(over, 3).embed!({ texts: ["a", "b"], purpose: "document" })).rejects.toThrow();
  });

  it("a chunk with NO embeddings field at all rejects rather than yielding empty vectors", async () => {
    await expect(adapterWith(async () => ({}), 1).embed!({ texts: ["a"], purpose: "document" })).rejects.toThrow();
  });

  it("rejects when the dimension CHANGES between chunks — mixed spaces rank as garbage", async () => {
    let n = 0;
    const drifting: EmbedContentFn = async (req) => ({
      embeddings: req.contents.map(() => ({ values: new Array(++n === 1 ? 8 : 4).fill(0.5) })),
    });
    await expect(adapterWith(drifting, 1).embed!({ texts: ["a", "b"], purpose: "document" })).rejects.toThrow(/dimension/i);
  });

  it("rejects a non-finite component (via the port's own requireEmbedAlignment)", async () => {
    const nanny: EmbedContentFn = async (req) => ({
      embeddings: req.contents.map(() => ({ values: [1, Number.NaN, 3] })),
    });
    await expect(adapterWith(nanny, 5).embed!({ texts: ["a"], purpose: "document" })).rejects.toThrow(/finite/);
  });
});

describe("VertexModelAdapter.embed — fail closed on provider-side silent degradation", () => {
  it("rejects when the provider reports the input was TRUNCATED", async () => {
    const truncating: EmbedContentFn = async (req) => ({
      embeddings: req.contents.map((t) => ({ values: fakeVector(t), statistics: { truncated: true, tokenCount: 9 } })),
    });
    await expect(truncating && adapterWith(truncating, 1).embed!({ texts: ["a very long product description"], purpose: "document" })).rejects.toThrow(
      /truncat/i,
    );
  });

  it("rejects when a requested outputDimensionality was NOT honored", async () => {
    const ignoring: EmbedContentFn = async (req) => ({
      embeddings: req.contents.map((t) => ({ values: fakeVector(t) })), // DIM=16, not the 8 asked for
    });
    await expect(
      adapterWith(ignoring, 1, { outputDimensionality: 8 }).embed!({ texts: ["a"], purpose: "document" }),
    ).rejects.toThrow(/8/);
  });

  it("never leaks the embedded text into an error message (operator logs stay content-free)", async () => {
    const secretish = "shopper@example.com ordered the ceramide cream";
    const short: EmbedContentFn = async () => ({ embeddings: [] });
    const err = await adapterWith(short, 5)
      .embed!({ texts: [secretish], purpose: "document" })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("ceramide");
    expect(err!.message).not.toContain("@example.com");
  });
});

describe("VertexModelAdapter.embed — request shaping (no Google concept crosses the port)", () => {
  it("sends the adapter's OWN model + task type, and turns silent truncation OFF", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed());
    await adapterWith(call, 1).embed!({ texts: ["ceramide cream"], purpose: "document" });
    const req = call.mock.calls[0]![0];
    expect(req.model).toBe("embed-test-1");
    expect(req.config?.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(req.config?.autoTruncate).toBe(false);
    expect(req.config?.outputDimensionality).toBeUndefined();
  });

  it("forwards outputDimensionality only when the adapter was configured with one", async () => {
    const sized: EmbedContentFn = async (req) => ({
      embeddings: req.contents.map(() => ({ values: new Array(768).fill(0.01) })),
    });
    const call = vi.fn<EmbedContentFn>(sized);
    const res = await adapterWith(call, 1, { outputDimensionality: 768 }).embed!({ texts: ["a"], purpose: "document" });
    expect(call.mock.calls[0]![0].config?.outputDimensionality).toBe(768);
    expect(res.dimension).toBe(768);
  });

  it("does NOT send the port's tenantId to the provider (attribution is metered locally)", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed());
    await adapterWith(call, 1).embed!({ texts: ["a"], tenantId: "acme", purpose: "document" });
    expect(JSON.stringify(call.mock.calls[0]![0])).not.toContain("acme");
  });
});

describe("the per-model batch cap table (a documented vendor fact, conservative for the unknown)", () => {
  it("caps gemini-embedding-001 at ONE text per request", () => {
    expect(maxBatchForEmbedModel("gemini-embedding-001")).toBe(1);
  });

  it("allows five for the gecko-family text-embedding models", () => {
    expect(maxBatchForEmbedModel("text-embedding-005")).toBe(5);
    expect(maxBatchForEmbedModel("text-multilingual-embedding-002")).toBe(5);
  });

  it("falls back to ONE for a model id it has no documented cap for (fail safe, never a guess up)", () => {
    expect(maxBatchForEmbedModel("some-future-embedding-model")).toBe(1);
    expect(maxBatchForEmbedModel("gemini-embedding-2")).toBe(1);
  });
});

describe("createVertexAdapter wires the embedding capability", () => {
  it("declares embed, so a deployed adapter reports canEmbed === true", () => {
    const adapter = createVertexAdapter({ project: "p" });
    expect(canEmbed(adapter)).toBe(true);
  });

  it("defaults to the documented per-token-priced embedding model and the DOCUMENT task type", () => {
    expect(DEFAULT_EMBED_MODEL).toBe("gemini-embedding-001");
    expect(DEFAULT_EMBED_TASK_TYPES.document).toBe("RETRIEVAL_DOCUMENT");
  });

  it("lets an operator override model / task type / batch cap / dimension by env", async () => {
    vi.stubEnv("PALUP_EMBED_MODEL", "text-embedding-005");
    vi.stubEnv("PALUP_EMBED_TASK_TYPE_DOCUMENT", "SEMANTIC_SIMILARITY");
    vi.stubEnv("PALUP_EMBED_MAX_BATCH", "2");
    vi.stubEnv("PALUP_EMBED_DIMENSION", "768");
    const call = vi.fn<EmbedContentFn>(async (req) => ({
      embeddings: req.contents.map(() => ({ values: new Array(768).fill(0.01) })),
    }));
    const adapter = createVertexAdapter({ project: "p", embedContent: call });
    await adapter.embed!({ texts: ["a", "b", "c"], purpose: "document" });
    expect(call).toHaveBeenCalledTimes(2); // maxBatch 2 => chunks of 2 and 1
    const req = call.mock.calls[0]![0];
    expect(req.model).toBe("text-embedding-005");
    expect(req.config?.taskType).toBe("SEMANTIC_SIMILARITY");
    expect(req.config?.outputDimensionality).toBe(768);
  });
});
