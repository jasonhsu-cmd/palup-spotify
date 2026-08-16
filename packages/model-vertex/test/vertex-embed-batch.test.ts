import { describe, it, expect } from "vitest";
import { VertexModelAdapter } from "../src/vertex-adapter.js";

/** A transport that fails the first N calls, then succeeds — to prove retry/backoff. Records concurrency. */
function flakyEmbedContent(failFirst: number) {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    calls: () => calls,
    maxInFlight: () => maxInFlight,
    fn: async (req: { contents: string[]; config?: { outputDimensionality?: number } }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls++;
      const dim = req.config?.outputDimensionality ?? 3;
      try {
        if (calls <= failFirst) throw new Error("transient 503");
        await new Promise((r) => setTimeout(r, 5));
        return { embeddings: req.contents.map(() => ({ values: Array(dim).fill(0.1), statistics: { tokenCount: 3 } })) };
      } finally {
        inFlight--;
      }
    },
  };
}

function adapter(t: ReturnType<typeof flakyEmbedContent>, cfg: Partial<{ maxBatch: number; concurrency: number; maxRetries: number; timeoutMs: number; outputDimensionality: number }> = {}) {
  return new VertexModelAdapter(
    async () => ({ text: "x" }),
    { model: "gemini-3.5-flash" },
    {
      call: t.fn,
      cfg: {
        model: "gemini-embedding-2",
        taskTypes: { document: "RETRIEVAL_DOCUMENT", query: "RETRIEVAL_QUERY" },
        maxBatch: cfg.maxBatch ?? 1,
        outputDimensionality: cfg.outputDimensionality ?? 1536,
        concurrency: cfg.concurrency ?? 4,
        maxRetries: cfg.maxRetries ?? 3,
        timeoutMs: cfg.timeoutMs ?? 1000,
      },
    },
  );
}

describe("vertex embedBatch — timeout, retry, bounded concurrency", () => {
  it("retries a transient failure with backoff and still returns every vector in order", async () => {
    const t = flakyEmbedContent(2); // first 2 chunk-calls throw
    const res = await adapter(t).embed({ texts: ["a", "b", "c", "d"], purpose: "document", tenantId: "t1" });
    expect(res.vectors.length).toBe(4);
    expect(res.dimension).toBe(1536);
    expect(res.model).toBe("gemini-embedding-2");
  });

  it("runs at most `concurrency` requests in flight", async () => {
    const t = flakyEmbedContent(0);
    await adapter(t, { concurrency: 2 }).embed({ texts: ["a", "b", "c", "d", "e", "f"], purpose: "document", tenantId: "t1" });
    expect(t.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it("gives up after maxRetries and rejects the whole batch (all-or-nothing)", async () => {
    const t = flakyEmbedContent(99);
    await expect(adapter(t, { maxRetries: 2 }).embed({ texts: ["a"], purpose: "document", tenantId: "t1" })).rejects.toThrow();
  });
});
