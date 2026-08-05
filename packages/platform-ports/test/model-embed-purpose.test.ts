import { describe, expect, it } from "vitest";
import { EMBED_PURPOSES, canEmbed, requireEmbedAlignment, requireEmbedInputs } from "../src/model-port.js";
import type { EmbedPurpose, EmbedRequest, EmbedResponse, ModelPort } from "../src/model-port.js";
import { createMeteringModelPort } from "../src/metering.js";
import { createRedactingModelPort } from "../src/redaction.js";
import { fakeEmbeddingPort } from "./fakes/fake-embedding-model.js";
import type { TelemetryEvent, TelemetryPort } from "../src/telemetry-port.js";

// THE PORT GAP B3 (#192) LEFT OPEN, CLOSED HERE.
//
// #188 deliberately left `purpose` off `EmbedRequest` ("adding an optional field later is
// backward-compatible") and flagged it for the Vertex PR. B3 then implemented the Vertex embedding path
// and reported the consequence precisely (vertex-adapter.ts's DEFAULT_EMBED_TASK_TYPE note): retrieval is
// ASYMMETRIC — a corpus and a query must be embedded differently — and Vertex's `task_type` DEFAULTS to
// RETRIEVAL_QUERY when unset, so a corpus embedded without one silently gets query treatment. Worse, both
// sides report the SAME `EmbedResponse.model`, so the caller's `{model, dimension}` corpus pin cannot see
// the difference. B3's verdict: the port needs a portable `purpose` before any query-side embedding
// ships. E1 IS query-side embedding, so it ships here.
//
// TWO DESIGN CHOICES THESE TESTS PIN, both deliberate departures from #188's sketch:
//   • `purpose` is REQUIRED on the request, not optional. An optional field forces the PORT to pick a
//     default, and a defaulted purpose is exactly the Vertex defect reproduced one layer up. Required
//     means the compiler asks the one question only the caller can answer, and it cannot be forgotten.
//   • `purpose` is REQUIRED on the response too, reporting what the adapter ACTUALLY applied — which is
//     what makes the corpus pin able to catch the asymmetry at last.
// No Google vocabulary crosses the port: "document"/"query" are portable words, and the mapping to
// RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY stays inside the Vertex adapter (ADR-0001, NN#3).

function spyTelemetry() {
  const events: Array<{ tenantId: string; event: TelemetryEvent }> = [];
  const port: TelemetryPort = {
    async record(ctx, event) {
      events.push({ tenantId: ctx.tenantId, event });
    },
    async query() {
      return { tenantId: "x", events: 0, inputTokens: 0, outputTokens: 0, latencyP50Ms: null, latencyP95Ms: null, byModel: {} };
    },
  };
  return { events, port };
}

describe("EmbedPurpose — a portable way to say which SIDE of retrieval this batch is", () => {
  it("is a closed two-value vocabulary with no provider words in it", () => {
    expect([...EMBED_PURPOSES]).toEqual(["document", "query"]);
    for (const p of EMBED_PURPOSES) expect(p).not.toMatch(/RETRIEVAL|TASK|GOOGLE|VERTEX|GEMINI/i);
  });

  it("is REQUIRED on the request — a caller cannot omit it and inherit a default", () => {
    // Typed callers are stopped by the compiler; an untyped one is stopped here, BEFORE provider spend.
    expect(() => requireEmbedInputs({ texts: ["a"] } as unknown as EmbedRequest)).toThrow(/purpose/i);
    expect(() => requireEmbedInputs({ texts: ["a"], purpose: "corpus" as EmbedPurpose })).toThrow(/purpose/i);
  });

  it("still rejects a blank batch before it ever looks at purpose (the #188 rules are unchanged)", () => {
    expect(() => requireEmbedInputs({ texts: [], purpose: "document" })).toThrow(/at least one text/i);
    expect(() => requireEmbedInputs({ texts: ["ok", "  "], purpose: "query" })).toThrow(/index 1/);
  });
});

describe("EmbedResponse.purpose — the adapter reports what it actually applied", () => {
  it("echoes the requested purpose on both sides", async () => {
    const port = fakeEmbeddingPort();
    if (!canEmbed(port)) throw new Error("fake should embed");
    expect((await port.embed({ texts: ["ceramide cream"], purpose: "document" })).purpose).toBe("document");
    expect((await port.embed({ texts: ["something for redness"], purpose: "query" })).purpose).toBe("query");
  });

  it("CLOSES THE B3 GAP: a corpus pin can now catch a purpose mismatch that {model, dimension} cannot", async () => {
    const port = fakeEmbeddingPort({ dimension: 4, model: "fake-embedding-4d" });
    if (!canEmbed(port)) throw new Error("fake should embed");
    const corpus = await port.embed({ texts: ["ceramide cream"], purpose: "document" });
    const asQuery = await port.embed({ texts: ["ceramide cream"], purpose: "query" });
    // Indistinguishable under the OLD pin…
    expect(asQuery.model).toBe(corpus.model);
    expect(asQuery.dimension).toBe(corpus.dimension);
    // …and distinguishable under the new one.
    expect(asQuery.purpose).not.toBe(corpus.purpose);
  });

  it("rejects an adapter that IGNORED the requested purpose (never store vectors it did not promise)", () => {
    const req: EmbedRequest = { texts: ["a"], purpose: "document" };
    const lying: EmbedResponse = { vectors: [[1, 2]], dimension: 2, model: "fake", purpose: "query" };
    expect(() => requireEmbedAlignment(req, lying)).toThrow(/purpose/i);
  });

  it("rejects a response with a missing or out-of-vocabulary purpose", () => {
    const req: EmbedRequest = { texts: ["a"], purpose: "document" };
    const absent = { vectors: [[1, 2]], dimension: 2, model: "fake" } as unknown as EmbedResponse;
    const bogus = { vectors: [[1, 2]], dimension: 2, model: "fake", purpose: "RETRIEVAL_DOCUMENT" } as unknown as EmbedResponse;
    expect(() => requireEmbedAlignment(req, absent)).toThrow(/purpose/i);
    expect(() => requireEmbedAlignment(req, bogus)).toThrow(/purpose/i);
  });

  it("keeps every pre-existing alignment rule intact alongside the new one", () => {
    const req: EmbedRequest = { texts: ["a", "b"], purpose: "document" };
    expect(() => requireEmbedAlignment(req, { vectors: [[1, 2], [3, 4]], dimension: 2, model: "f", purpose: "document" })).not.toThrow();
    expect(() => requireEmbedAlignment(req, { vectors: [[1, 2]], dimension: 2, model: "f", purpose: "document" })).toThrow(/2 texts.*1 vector/i);
    expect(() => requireEmbedAlignment(req, { vectors: [[1, 2], [3, 4, 5]], dimension: 2, model: "f", purpose: "document" })).toThrow(/dimension/i);
  });
});

describe("decorators forward purpose untouched", () => {
  it("the redacting port redacts the TEXTS and leaves the purpose alone", async () => {
    const seen: EmbedRequest[] = [];
    const inner: ModelPort = {
      async complete() {
        return { text: "ok", model: "spy" };
      },
      async embed(req) {
        seen.push(req);
        return { vectors: req.texts.map(() => [1, 0]), dimension: 2, model: "spy-embed", purpose: req.purpose };
      },
    };
    const port = createRedactingModelPort(inner);
    if (!canEmbed(port)) throw new Error("capability lost");
    const res = await port.embed({ texts: ["card 4111 1111 1111 1111"], purpose: "query", tenantId: "acme" });
    expect(seen[0]?.purpose).toBe("query");
    expect(seen[0]?.texts[0]).toBe("card [redacted-card]");
    expect(res.purpose).toBe("query");
  });

  it("the metering port meters a query embed the same way it meters a document embed", async () => {
    const { events, port: telemetry } = spyTelemetry();
    const port = createMeteringModelPort(fakeEmbeddingPort({ usage: true }), telemetry, { agentType: "catalog-retrieval" });
    if (!canEmbed(port)) throw new Error("capability lost");
    const res = await port.embed({ texts: ["something for redness"], purpose: "query", tenantId: "acme" });
    expect(res.purpose).toBe("query");
    expect(events).toHaveLength(1);
    expect(events[0]?.tenantId).toBe("acme");
    expect(events[0]?.event).toMatchObject({ kind: "model_call", agentType: "catalog-retrieval" });
  });
});
