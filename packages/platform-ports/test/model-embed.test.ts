import { describe, it, expect } from "vitest";
import { canEmbed, requireEmbedInputs, requireEmbedAlignment } from "../src/model-port.js";
import type { EmbedRequest, EmbedResponse, ModelPort } from "../src/model-port.js";
import { createRedactingModelPort } from "../src/redaction.js";
import { createMeteringModelPort } from "../src/metering.js";
import type { TelemetryPort, TelemetryEvent } from "../src/telemetry-port.js";
import { fakeEmbeddingPort, completeOnlyPort } from "./fakes/fake-embedding-model.js";

// WHY THIS EXISTS. `ModelPort.embed?()` is the OPTIONAL capability a later catalog-indexing/retrieval PR
// needs (ADR-0009 §3, port-interfaces.md `model`). Optional is load-bearing in two directions:
//   1. every existing complete-only adapter must keep compiling and behaving identically, and
//   2. "this adapter cannot embed" must stay distinguishable from "the embedding call failed" —
//      absence is STATIC and free to check; failure is a rejected promise.
// Nothing in the repo calls embed yet (no Vertex embedding adapter, no index job) — these tests pin the
// port's shape and its invariants, they do NOT exercise a real embedding service.

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

// ── capability: absent vs failed ───────────────────────────────────────────────────────────────────
describe("canEmbed — 'cannot embed' and 'embedding failed' are different facts", () => {
  it("is false for a complete-only adapter, whose embed is ABSENT (not a throwing stub)", () => {
    expect(canEmbed(completeOnlyPort)).toBe(false);
    expect(completeOnlyPort.embed).toBeUndefined();
  });

  it("is true for an embedding adapter and narrows the type so the call needs no non-null assertion", async () => {
    const port = fakeEmbeddingPort();
    expect(canEmbed(port)).toBe(true);
    if (!canEmbed(port)) throw new Error("guard did not narrow");
    const res = await port.embed({ texts: ["ceramide cream"] }); // no `!`, no cast
    expect(res.vectors).toHaveLength(1);
  });

  it("stays TRUE for an adapter that CAN embed but whose call fails — a failure is not an absence", async () => {
    const flaky: ModelPort = {
      async complete() {
        return { text: "ok", model: "flaky" };
      },
      async embed() {
        throw new Error("provider 503");
      },
    };
    expect(canEmbed(flaky)).toBe(true); // capability is declared…
    await expect(flaky.embed?.({ texts: ["x"] })).rejects.toThrow(/503/); // …and the call rejects
  });
});

// ── batching + partial failure ─────────────────────────────────────────────────────────────────────
describe("requireEmbedInputs — a batch is validated before any provider spend", () => {
  it("rejects an empty batch (there is no honest dimension to report for zero texts)", () => {
    expect(() => requireEmbedInputs([])).toThrow(/at least one text/i);
  });

  it("rejects a blank/whitespace-only item, naming its index so the caller can fix that item", () => {
    expect(() => requireEmbedInputs(["ceramide cream", "   "])).toThrow(/index 1/);
  });

  it("rejects the WHOLE batch, so a bad item can never become a silent hole in the corpus", () => {
    const texts = ["a", "b", "c", "d", "e", "f", "g", "", "i"];
    // Item 7 is bad. Fail closed on all nine rather than indexing eight and losing one silently.
    expect(() => requireEmbedInputs(texts)).toThrow(/index 7/);
  });

  it("accepts a batch of many texts — batching is the point (250 products, not 250 HTTP calls)", () => {
    expect(() => requireEmbedInputs(Array.from({ length: 250 }, (_, i) => `product ${i}`))).not.toThrow();
  });

  it("rejects a non-array / non-string input rather than coercing it", () => {
    expect(() => requireEmbedInputs(undefined as unknown as string[])).toThrow(/array/i);
    expect(() => requireEmbedInputs([42 as unknown as string])).toThrow(/index 0/);
  });
});

describe("requireEmbedAlignment — vectors[i] belongs to texts[i], or nobody gets a corpus", () => {
  const ok = { vectors: [[1, 2], [3, 4]], dimension: 2, model: "fake" };

  it("passes an aligned response", () => {
    expect(() => requireEmbedAlignment(["a", "b"], ok)).not.toThrow();
  });

  it("REJECTS a truncated batch (the `first: 250` failure class, at the port)", () => {
    const short = { vectors: [[1, 2]], dimension: 2, model: "fake" };
    expect(() => requireEmbedAlignment(["a", "b"], short)).toThrow(/2 texts.*1 vector/i);
  });

  it("rejects extra vectors too — a longer answer is just as misaligned", () => {
    const long = { vectors: [[1, 2], [3, 4], [5, 6]], dimension: 2, model: "fake" };
    expect(() => requireEmbedAlignment(["a", "b"], long)).toThrow(/2 texts.*3 vector/i);
  });

  it("rejects mixed dimensions within one response (a corpus of two shapes ranks as garbage)", () => {
    const mixed = { vectors: [[1, 2], [3, 4, 5]], dimension: 2, model: "fake" };
    expect(() => requireEmbedAlignment(["a", "b"], mixed)).toThrow(/dimension/i);
  });

  it("rejects a `dimension` field that disagrees with the vectors it describes", () => {
    const lying = { vectors: [[1, 2], [3, 4]], dimension: 768, model: "fake" };
    expect(() => requireEmbedAlignment(["a", "b"], lying)).toThrow(/dimension/i);
  });

  it("rejects an empty or non-finite vector (a zero/NaN vector scores 0 against everything)", () => {
    expect(() => requireEmbedAlignment(["a"], { vectors: [[]], dimension: 0, model: "fake" })).toThrow(/dimension/i);
    expect(() => requireEmbedAlignment(["a"], { vectors: [[1, Number.NaN]], dimension: 2, model: "fake" })).toThrow(/finite/i);
  });
});

// ── the port reports what a caller needs to avoid mixing dimensions across a corpus ────────────────
describe("EmbedResponse provenance — dimension + model, so a corpus cannot silently mix shapes", () => {
  it("reports the dimension it actually produced, alongside the model that produced it", async () => {
    const port = fakeEmbeddingPort({ dimension: 4, model: "fake-embedding-4d" });
    if (!canEmbed(port)) throw new Error("fake should embed");
    const res = await port.embed({ texts: ["ceramide cream", "zinc sunscreen"] });
    expect(res.dimension).toBe(4);
    expect(res.vectors.every((v) => v.length === 4)).toBe(true);
    expect(res.model).toBe("fake-embedding-4d");
  });

  it("lets a caller detect a dimension change against an already-indexed corpus", async () => {
    // The scenario the field exists for: a corpus indexed at 4 dims, then a config/model change starts
    // returning 8. Without the reported dimension this ships as silently meaningless similarity scores.
    const indexedWith = { model: "fake-embedding-4d", dimension: 4 };
    const port = fakeEmbeddingPort({ dimension: 8, model: "fake-embedding-8d" });
    if (!canEmbed(port)) throw new Error("fake should embed");
    const res = await port.embed({ texts: ["ceramide cream"] });
    expect(res.dimension).not.toBe(indexedWith.dimension); // caller's own refusal condition
    expect(res.model).not.toBe(indexedWith.model);
  });

  it("omits usage when the adapter cannot report tokens, and reports inputTokens when it can", async () => {
    const silent = fakeEmbeddingPort();
    const metered = fakeEmbeddingPort({ usage: true });
    if (!canEmbed(silent) || !canEmbed(metered)) throw new Error("fakes should embed");
    expect((await silent.embed({ texts: ["abc"] })).usage).toBeUndefined(); // never a fabricated 0
    expect((await metered.embed({ texts: ["abc"] })).usage).toEqual({ inputTokens: 3 });
  });
});

// ── decorators must not silently drop (or fabricate) the capability ────────────────────────────────
describe("createRedactingModelPort — embed inputs get the same egress guardrail as complete", () => {
  it("redacts every text before the provider sees it (no trusted 'system' text in a batch)", async () => {
    const seen: EmbedRequest[] = [];
    const inner: ModelPort = {
      async complete() {
        return { text: "ok", model: "spy" };
      },
      async embed(req) {
        seen.push(req);
        return { vectors: req.texts.map(() => [1, 0]), dimension: 2, model: "spy-embed" };
      },
    };
    const port = createRedactingModelPort(inner);
    if (!canEmbed(port)) throw new Error("redacting port must forward the embed capability");
    await port.embed({ texts: ["note: card 4111 1111 1111 1111", "ceramide cream"], tenantId: "acme" });
    expect(seen[0]?.texts[0]).toBe("note: card [redacted-card]");
    expect(seen[0]?.texts[1]).toBe("ceramide cream");
    expect(seen[0]?.tenantId).toBe("acme"); // attribution preserved
  });

  it("does NOT fabricate an embed capability the inner adapter lacks", () => {
    const port = createRedactingModelPort(completeOnlyPort);
    expect(canEmbed(port)).toBe(false);
    expect(port.embed).toBeUndefined();
  });

  it("keeps a class-based adapter's `this` (Vertex adapters are classes)", async () => {
    class ClassAdapter implements ModelPort {
      private readonly dim = 3;
      async complete() {
        return { text: "ok", model: "class" };
      }
      async embed(req: EmbedRequest): Promise<EmbedResponse> {
        // Reads `this` — a decorator that forwarded an UNBOUND method reference would throw here.
        return { vectors: req.texts.map(() => new Array<number>(this.dim).fill(0.5)), dimension: this.dim, model: "class-embed" };
      }
    }
    const port = createRedactingModelPort(new ClassAdapter());
    if (!canEmbed(port)) throw new Error("capability lost");
    expect((await port.embed({ texts: ["x"] })).dimension).toBe(3);
  });
});

describe("createMeteringModelPort — embedding spend is metered at the same choke point as inference", () => {
  it("records a model_call event with the embedding model, input tokens, tenant and latency", async () => {
    let t = 1000;
    const { events, port: telemetry } = spyTelemetry();
    const port = createMeteringModelPort(fakeEmbeddingPort({ usage: true, model: "fake-embedding-1" }), telemetry, {
      agentType: "catalog-index",
      now: () => (t += 25),
    });
    if (!canEmbed(port)) throw new Error("metering port must forward the embed capability");
    const res = await port.embed({ texts: ["abc", "de"] });
    expect(res.vectors).toHaveLength(2); // passthrough
    expect(events).toHaveLength(1);
    expect(events[0]?.tenantId).toBe("unknown"); // no tenant on the request → never cross-tenant
    expect(events[0]?.event).toMatchObject({ kind: "model_call", model: "fake-embedding-1", inputTokens: 6, agentType: "catalog-index" });
    expect(events[0]?.event.latencyMs).toBeGreaterThanOrEqual(0);
    // An embedding call has no completion tokens; reporting 0 output tokens would be a fabricated number.
    expect(events[0]?.event.outputTokens).toBeUndefined();
  });

  it("attributes the event to the request tenant", async () => {
    const { events, port: telemetry } = spyTelemetry();
    const port = createMeteringModelPort(fakeEmbeddingPort({ usage: true }), telemetry);
    await port.embed?.({ texts: ["abc"], tenantId: "acme" });
    expect(events[0]?.tenantId).toBe("acme");
  });

  it("does not meter a FAILED embed (mirrors complete: a failed call consumed nothing we can count)", async () => {
    const { events, port: telemetry } = spyTelemetry();
    const boom: ModelPort = {
      async complete() {
        return { text: "ok", model: "boom" };
      },
      async embed() {
        throw new Error("provider 503");
      },
    };
    const port = createMeteringModelPort(boom, telemetry);
    await expect(port.embed?.({ texts: ["x"], tenantId: "acme" })).rejects.toThrow(/503/);
    expect(events).toHaveLength(0);
  });

  it("is FAIL-OPEN — a telemetry failure never breaks the embed call", async () => {
    const throwing: TelemetryPort = {
      async record() {
        throw new Error("telemetry down");
      },
      async query() {
        throw new Error("x");
      },
    };
    const port = createMeteringModelPort(fakeEmbeddingPort(), throwing);
    const res = await port.embed?.({ texts: ["x"], tenantId: "acme" });
    expect(res?.vectors).toHaveLength(1);
  });

  it("does NOT fabricate an embed capability the inner adapter lacks", () => {
    const { port: telemetry } = spyTelemetry();
    const port = createMeteringModelPort(completeOnlyPort, telemetry);
    expect(canEmbed(port)).toBe(false);
    expect(port.embed).toBeUndefined();
  });

  it("survives the real serving stack's decorator order: redact(meter(adapter))", async () => {
    // widget-backend/src/server.ts wraps the model port as createRedactingModelPort(meteredModel). If
    // either decorator dropped `embed`, a later index job would read "cannot embed" from an adapter that
    // can — the silent-degradation failure class this port is meant to make impossible.
    const { events, port: telemetry } = spyTelemetry();
    const stacked = createRedactingModelPort(createMeteringModelPort(fakeEmbeddingPort({ usage: true }), telemetry));
    expect(canEmbed(stacked)).toBe(true);
    const res = await stacked.embed?.({ texts: ["card 4111 1111 1111 1111"], tenantId: "acme" });
    expect(res?.vectors).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.model).toBe("fake-embedding-1");
  });
});
