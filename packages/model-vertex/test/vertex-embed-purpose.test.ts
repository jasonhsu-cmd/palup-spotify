import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMBED_TASK_TYPES,
  VertexModelAdapter,
  type EmbedContentFn,
  type GenerateFn,
  type VertexEmbedRequest,
} from "../src/vertex-adapter.js";
import { createVertexAdapter } from "../src/create.js";

// E1's PREREQUISITE, on the Vertex side. B3 (#192) shipped `embed` with a single, adapter-configured
// task type and recorded the consequence in DEFAULT_EMBED_TASK_TYPE's own doc comment:
//
//   "a query path must construct a SECOND adapter with PALUP_EMBED_TASK_TYPE=RETRIEVAL_QUERY and must
//    not reuse this instance."
//
// That workaround is what these tests retire. The port now carries a portable `purpose`, and ONE adapter
// maps it to the right provider task type per call. Two properties matter more than the mapping itself:
//   • the task type is ALWAYS sent explicitly — [E2] documents that an UNSET task_type defaults to
//     RETRIEVAL_QUERY, so "unset" is never a safe state for a corpus; and
//   • the response reports which purpose was applied, so the caller's pin can catch a mismatch.
//
// No credentials here: every test drives an injected transport, exactly like the rest of this suite.

const gen: GenerateFn = async () => ({ text: "ok" });
const CFG = { model: "gemini-test" };

const fakeEmbed: EmbedContentFn = async (req: VertexEmbedRequest) => ({
  embeddings: req.contents.map(() => ({ values: [0.1, 0.2, 0.3], statistics: { truncated: false, tokenCount: 3 } })),
});

function adapter(call: EmbedContentFn, extra: Record<string, unknown> = {}) {
  return new VertexModelAdapter(gen, CFG, {
    call,
    cfg: { model: "embed-test-1", taskTypes: DEFAULT_EMBED_TASK_TYPES, maxBatch: 1, ...extra },
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("E1 — the portable purpose maps to the provider task type, per call", () => {
  it("document -> RETRIEVAL_DOCUMENT and query -> RETRIEVAL_QUERY, from ONE adapter instance", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed);
    const a = adapter(call);
    await a.embed!({ texts: ["ceramide cream"], purpose: "document" });
    await a.embed!({ texts: ["something for redness"], purpose: "query" });
    expect(call.mock.calls[0]![0].config?.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(call.mock.calls[1]![0].config?.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("NEVER leaves the task type unset — an unset one defaults to RETRIEVAL_QUERY at the provider", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed);
    await adapter(call).embed!({ texts: ["a"], purpose: "document" });
    expect(call.mock.calls[0]![0].config?.taskType).toBeTruthy();
  });

  it("reports the purpose it applied back on the response", async () => {
    const a = adapter(fakeEmbed);
    expect((await a.embed!({ texts: ["a"], purpose: "document" })).purpose).toBe("document");
    expect((await a.embed!({ texts: ["a"], purpose: "query" })).purpose).toBe("query");
  });

  it("keeps the provider vocabulary INSIDE the adapter — nothing Google-shaped is on the response", async () => {
    const res = await adapter(fakeEmbed).embed!({ texts: ["a"], purpose: "query" });
    expect(JSON.stringify(res)).not.toMatch(/RETRIEVAL|taskType|task_type/i);
  });

  it("stamps the task type on EVERY chunk of a batch that had to be split", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed);
    await adapter(call, { maxBatch: 1 }).embed!({ texts: ["a", "b", "c"], purpose: "query" });
    expect(call).toHaveBeenCalledTimes(3);
    for (const [req] of call.mock.calls) expect(req.config?.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("rejects a purpose outside the port's vocabulary rather than sending an unmapped task type", async () => {
    const call = vi.fn<EmbedContentFn>(fakeEmbed);
    await expect(
      adapter(call).embed!({ texts: ["a"], purpose: "corpus" as "document" }),
    ).rejects.toThrow(/purpose/i);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("E1 — the default task-type table and its per-side operator override", () => {
  it("defaults to the pair Google's own task-type guidance prescribes for retrieval", () => {
    expect(DEFAULT_EMBED_TASK_TYPES).toEqual({ document: "RETRIEVAL_DOCUMENT", query: "RETRIEVAL_QUERY" });
  });

  it("lets an operator override each SIDE independently", async () => {
    vi.stubEnv("PALUP_EMBED_TASK_TYPE_DOCUMENT", "SEMANTIC_SIMILARITY");
    vi.stubEnv("PALUP_EMBED_TASK_TYPE_QUERY", "QUESTION_ANSWERING");
    const call = vi.fn<EmbedContentFn>(fakeEmbed);
    const a = createVertexAdapter({ project: "p", embedContent: call });
    await a.embed!({ texts: ["a"], purpose: "document" });
    await a.embed!({ texts: ["a"], purpose: "query" });
    expect(call.mock.calls[0]![0].config?.taskType).toBe("SEMANTIC_SIMILARITY");
    expect(call.mock.calls[1]![0].config?.taskType).toBe("QUESTION_ANSWERING");
  });

  it("REFUSES to start when the retired single-value PALUP_EMBED_TASK_TYPE is still set", () => {
    // One value cannot express an asymmetric pair. Silently ignoring an env an operator deliberately set
    // is how a corpus ends up embedded on the wrong side — so this fails loudly instead.
    vi.stubEnv("PALUP_EMBED_TASK_TYPE", "RETRIEVAL_QUERY");
    expect(() => createVertexAdapter({ project: "p" })).toThrow(/PALUP_EMBED_TASK_TYPE/);
  });
});
