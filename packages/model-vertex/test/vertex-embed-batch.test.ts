import { describe, it, expect } from "vitest";
import { VertexModelAdapter } from "../src/vertex-adapter.js";

/**
 * A transport that fails the first N calls, then succeeds — to prove retry/backoff. Records peak
 * concurrency AND total attempts made, and returns a CONTENT-DEPENDENT vector (first component = the
 * ORIGINAL INDEX of the single input text it was asked to embed) so a caller can decode which input
 * produced which vector — the assembly-order bug this file's "preserves order" test is built to catch
 * would otherwise be invisible, since every chunk previously returned the identical `Array(dim).fill(0.1)`
 * regardless of which text it embedded.
 */
function flakyEmbedContent(failFirst: number, opts: { staggerMs?: (text: string) => number } = {}) {
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
        // Each request here embeds exactly ONE text (maxBatch=1 in every test below), so there is exactly
        // one text to encode. Stagger completion so out-of-order finishes are actually exercised under
        // concurrency, rather than every request happening to settle in dispatch order.
        const text = req.contents[0]!;
        const delay = opts.staggerMs ? opts.staggerMs(text) : 5;
        await new Promise((r) => setTimeout(r, delay));
        // Encode the text's ORIGINAL INDEX (its position in the full batch, "a"=0, "b"=1, ...) into the
        // vector: component 0 carries the index, the rest are filler. Content-dependent, not positional-
        // by-completion, so assembling `perChunk` by completion order instead of by chunk index would
        // scramble which vector lands at which output position and this test would catch it.
        const originalIndex = text.charCodeAt(0) - "a".charCodeAt(0);
        return { embeddings: [{ values: [originalIndex, ...Array(dim - 1).fill(0.1)], statistics: { tokenCount: 3 } }] };
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

  it("runs `concurrency` requests in flight, not fewer (non-vacuous: fails if forced sequential)", async () => {
    // 6 chunks (maxBatch=1) at concurrency=3, each held open 20ms: with real parallelism at least 3 must
    // be in flight at once. Forcing `concurrency: 1` on this same call makes maxInFlight === 1 and this
    // assertion fail — confirmed by mutation-testing this case before finalizing (see task-5-report.md).
    const t = flakyEmbedContent(0, { staggerMs: () => 20 });
    await adapter(t, { concurrency: 3 }).embed({ texts: ["a", "b", "c", "d", "e", "f"], purpose: "document", tenantId: "t1" });
    expect(t.maxInFlight()).toBeGreaterThan(1);
    expect(t.maxInFlight()).toBeLessThanOrEqual(3);
  });

  it("preserves per-text identity across OUT-OF-ORDER completion under concurrency (order-by-index, not by completion)", async () => {
    // 6 single-text chunks at concurrency=3. The pool dispatches chunks 0,1,2 immediately (one per worker);
    // chunk 0 ("a") is held far longer than every other chunk, so it is the LAST to complete even though
    // it was the FIRST dispatched — a completion order that actively diverges from chunk-index order given
    // this pool's dispatch pattern (verified: with these delays chunk 0 finishes after all five others). If
    // results were assembled by PUSH-ON-COMPLETION instead of by chunk index, `res.vectors[0]` (which must
    // hold chunk 0's / "a"'s vector) would instead hold whichever chunk happened to finish FIRST — "b"'s
    // vector, decoding to 1, not 0 — and this assertion would fail.
    const order = ["a", "b", "c", "d", "e", "f"];
    const delayMs: Record<string, number> = { a: 200, b: 5, c: 10, d: 15, e: 20, f: 25 };
    const t = flakyEmbedContent(0, { staggerMs: (text) => delayMs[text]! });
    const res = await adapter(t, { concurrency: 3 }).embed({ texts: order, purpose: "document", tenantId: "t1" });
    for (let i = 0; i < order.length; i++) {
      expect(res.vectors[i]![0]).toBe(i); // component 0 decodes back to the text's ORIGINAL index
    }
  });

  it("gives up after EXACTLY maxRetries retries (maxRetries+1 total attempts) and rejects the whole batch (all-or-nothing)", async () => {
    const t = flakyEmbedContent(99); // always throws — every attempt fails
    await expect(adapter(t, { maxRetries: 2 }).embed({ texts: ["a"], purpose: "document", tenantId: "t1" })).rejects.toThrow();
    // 1 initial attempt + 2 retries = 3 total calls on this single-chunk batch. Non-vacuous: forcing
    // `maxRetries: 0` on this same call makes `t.calls()` === 1, failing this assertion — confirmed by
    // mutation-testing this case before finalizing (see task-5-report.md).
    expect(t.calls()).toBe(3);
  });

  it("does NOT retry a deterministic validateChunk failure (wrong dimension) — provider called exactly once, batch still rejects", async () => {
    // The provider call itself SUCCEEDS every time (no transport/timeout error) but always answers with the
    // WRONG dimension (asked for 1536, returns 3) — a validateChunk anomaly, not a transport failure. If
    // this were still retried like a transient error, `t.calls()` would be `maxRetries+1` (4) for this
    // single-chunk batch, exactly as the transport-failure test above asserts for a REAL transient error.
    // Confirmed this assertion would FAIL under the pre-fix behaviour (validation errors funneled through
    // the same catch-and-retry path as transport errors): `t.calls()` would read 4, not 1.
    let calls = 0;
    const wrongDimensionCall = async (req: { contents: string[] }) => {
      calls++;
      return { embeddings: req.contents.map(() => ({ values: [0.1, 0.2, 0.3], statistics: { tokenCount: 3 } })) };
    };
    const a = new VertexModelAdapter(
      async () => ({ text: "x" }),
      { model: "gemini-3.5-flash" },
      {
        call: wrongDimensionCall,
        cfg: {
          model: "gemini-embedding-2",
          taskTypes: { document: "RETRIEVAL_DOCUMENT", query: "RETRIEVAL_QUERY" },
          maxBatch: 1,
          outputDimensionality: 1536,
          concurrency: 1,
          maxRetries: 3,
        },
      },
    );
    await expect(a.embed({ texts: ["a"], purpose: "document", tenantId: "t1" })).rejects.toThrow(
      /asked for 1536 dimensions but the provider returned 3/,
    );
    expect(calls).toBe(1); // NOT maxRetries+1 (4) — a deterministic validation failure is not retried
  });
});
