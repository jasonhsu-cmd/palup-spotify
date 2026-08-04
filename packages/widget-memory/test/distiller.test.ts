import { describe, it, expect, vi } from "vitest";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { createInMemoryVectorStore, InMemoryRuntimeStore } from "@palup/platform-ports";
import { createStubDistiller, createModelDistiller, sanitizeFact, FACT_MAX_CHARS, type FactDistiller } from "../src/distiller.js";
import { createMemoryService } from "../src/service.js";
import { classifyFact } from "../src/classifier.js";
import type { MemoryCtx } from "../src/types.js";

// ADR-0015 Inv 1: distilled facts only — never the raw transcript; every stored fact passes the
// redaction guardrail (no card/SSN/PII) and a length cap.
describe("distiller — sanitizeFact (redact + cap; never the transcript)", () => {
  it("redacts a Luhn-valid card number — the digits are gone from the output", () => {
    const raw = "the card on file is 4111 1111 1111 1111, please use that one";
    const result = sanitizeFact(raw);
    expect(result).not.toBeNull();
    expect(result).not.toContain("4111");
    expect(result).toContain("[redacted-card]");
  });

  it("truncates a candidate over the ~160-char cap rather than dropping it", () => {
    const raw = "a".repeat(200);
    const result = sanitizeFact(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(FACT_MAX_CHARS);
  });

  it("returns null when the candidate is essentially the full raw transcript, not a distilled fact", () => {
    const message = "I have been looking for a new moisturizer for a while now and ".repeat(6);
    const reply = "Thanks for sharing that, here are a few options you might like to consider today. ".repeat(6);
    const candidate = `${message} ${reply}`; // what a broken/naive distiller would hand back verbatim
    expect(sanitizeFact(candidate)).toBeNull();
  });

  it("returns null for blank/empty input", () => {
    expect(sanitizeFact("")).toBeNull();
    expect(sanitizeFact("   ")).toBeNull();
  });

  it("returns null when contact-info PII (email) is present — a memory fact never needs it", () => {
    expect(sanitizeFact("email me at shopper@example.com to follow up")).toBeNull();
  });

  it("passes short, clean, ordinary facts through unchanged", () => {
    expect(sanitizeFact("prefers fragrance-free products")).toBe("prefers fragrance-free products");
  });

  // Security review, MEDIUM — "contract-fidelity gap on untrusted input": a NUL byte in shopper-derived
  // text is accepted by the in-memory VectorPort but THROWS in Postgres ("invalid byte sequence for
  // encoding UTF8"); a lone (unpaired) UTF-16 surrogate is accepted by neither adapter identically (in
  // memory it round-trips as-is, in Postgres it is silently mangled to U+FFFD on the wire — verified
  // against pglite). Stripped HERE, at the one place shopper-derived text is finalized before it is ever
  // considered for persistence, so every adapter downstream sees the same, already-safe string.
  it("strips a NUL byte (and other C0/C1 control characters) rather than passing it through", () => {
    const nul = String.fromCharCode(0);
    const soh = String.fromCharCode(1);
    const esc = String.fromCharCode(27);
    const result = sanitizeFact(`prefers${nul} ${soh}${esc}fragrance-free products`);
    expect(result).not.toBeNull();
    expect(result).not.toContain(nul);
    expect(result).not.toContain(soh);
    expect(result).not.toContain(esc);
    expect(result).toBe("prefers fragrance-free products");
  });

  it("strips an unpaired (lone) UTF-16 surrogate rather than passing it through", () => {
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const result = sanitizeFact(`likes${loneHigh} wool socks${loneLow}`);
    expect(result).not.toBeNull();
    expect(result).not.toContain(loneHigh);
    expect(result).not.toContain(loneLow);
  });

  it("keeps a VALID surrogate pair (e.g. an emoji) intact — only UNPAIRED surrogates are stripped", () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(sanitizeFact(`loves this product ${emoji}`)).toBe(`loves this product ${emoji}`);
  });
});

describe("distiller — createStubDistiller (deterministic, zero model calls)", () => {
  it("makes ZERO ModelPort-shaped calls — it never receives or touches a model", async () => {
    const modelSpy = { complete: vi.fn() };
    const distiller = createStubDistiller();
    const facts = await distiller.distill({ message: "loves the new serum", reply: "Great choice!" });
    expect(modelSpy.complete).not.toHaveBeenCalled();
    expect(Array.isArray(facts)).toBe(true);
  });

  it("is deterministic — same input, same output, across repeated calls", async () => {
    const distiller = createStubDistiller();
    const turn = { message: "prefers fragrance-free products", reply: "Noted!" };
    const first = await distiller.distill(turn);
    const second = await distiller.distill(turn);
    expect(second).toEqual(first);
  });
});

// PR-6 (ADR-0015 Inv 11 — extraction is a governed behavior, own eval + review): a REAL model-backed
// FactDistiller. It stays fully inert behind the SAME MEMORY_ENABLED + MEMORY_ADR_ACCEPTED double gate
// (flag.ts) — the only thing that changes is WHERE candidate facts come from; every sanitize/classify/
// consent/TTL gate downstream (service.ts) is REUSED UNCHANGED. A deterministic, offline mock ModelPort
// drives every test here — no network, no live model.
class MockModelAdapter implements ModelPort {
  readonly calls: ModelRequest[] = [];
  constructor(private readonly text: string | (() => string)) {}
  async complete(req: ModelRequest) {
    this.calls.push(req);
    const text = typeof this.text === "function" ? this.text() : this.text;
    return { text, model: "mock-distiller-1" };
  }
}

function respond(json: unknown): MockModelAdapter {
  return new MockModelAdapter(JSON.stringify(json));
}

describe("createModelDistiller — extraction (MockModelAdapter, offline, deterministic)", () => {
  it("extracts a plain candidate fact (no disposition) from the model's JSON response", async () => {
    const model = respond({ facts: [{ text: "prefers fragrance-free products" }] });
    const distiller = createModelDistiller({ model });
    const facts = await distiller.distill({ message: "I like fragrance-free stuff", reply: "Noted!" });
    // PR-8: distill() now returns candidate OBJECTS (text + optional disposition), not bare strings —
    // the disposition is surfaced instead of discarded. No disposition here ⇒ the key is simply absent.
    expect(facts).toEqual([{ text: "prefers fragrance-free products" }]);
    expect(facts[0]!.disposition).toBeUndefined();
  });

  it("keeps a candidate whose disposition has valid provenance ('stated' or 'observed') — PR-8: the disposition is SURFACED, not discarded", async () => {
    const model = respond({
      facts: [
        {
          text: "asked for ingredient names before buying",
          disposition: { axis: "style", value: "researcher", provenance: "observed", confidence: 0.8, sourceQuote: "what actives are in this" },
        },
        {
          text: "wants to stay under $50",
          disposition: { axis: "budget_stated", value: "under-50", provenance: "stated", confidence: 1 },
        },
      ],
    });
    const distiller = createModelDistiller({ model });
    const facts = await distiller.distill({ message: "what actives are in this? keep it under $50", reply: "..." });
    expect(facts).toEqual([
      {
        text: "asked for ingredient names before buying",
        disposition: { axis: "style", value: "researcher", provenance: "observed", confidence: 0.8, sourceQuote: "what actives are in this" },
      },
      {
        text: "wants to stay under $50",
        disposition: { axis: "budget_stated", value: "under-50", provenance: "stated", confidence: 1 },
      },
    ]);
  });

  it("REJECTS the whole candidate — not just the disposition — when provenance is 'inferred' (fairness structural)", async () => {
    const model = respond({
      facts: [
        { text: "seems like they'd pay a premium", disposition: { axis: "budget_stated", value: "premium", provenance: "inferred", confidence: 0.6 } },
        { text: "prefers fragrance-free products" },
      ],
    });
    const distiller = createModelDistiller({ model });
    const facts = await distiller.distill({ message: "m", reply: "r" });
    // The tainted candidate's TEXT is gone too, not just its disposition.
    expect(facts).toEqual([{ text: "prefers fragrance-free products" }]);
  });

  it("REJECTS a candidate whose disposition provenance is any other non-stated/observed string", async () => {
    const model = respond({
      facts: [{ text: "x", disposition: { axis: "style", value: "researcher", provenance: "guessed", confidence: 0.9 } }],
    });
    const facts = await createModelDistiller({ model }).distill({ message: "m", reply: "r" });
    expect(facts).toEqual([]);
  });

  it("REJECTS a candidate whose disposition has an invalid axis outside the controlled vocabulary", async () => {
    const model = respond({
      facts: [{ text: "x", disposition: { axis: "willingness_to_pay", value: "high", provenance: "observed", confidence: 0.9 } }],
    });
    const facts = await createModelDistiller({ model }).distill({ message: "m", reply: "r" });
    expect(facts).toEqual([]);
  });

  it("REJECTS a candidate whose disposition confidence is missing or out of [0,1] range", async () => {
    const model = respond({
      facts: [
        { text: "a", disposition: { axis: "style", value: "researcher", provenance: "observed" } },
        { text: "b", disposition: { axis: "style", value: "researcher", provenance: "observed", confidence: 1.5 } },
      ],
    });
    const facts = await createModelDistiller({ model }).distill({ message: "m", reply: "r" });
    expect(facts).toEqual([]);
  });

  it("the system prompt FORBIDS demographic / psychographic / willingness-to-pay extraction", async () => {
    const model = respond({ facts: [] });
    await createModelDistiller({ model }).distill({ message: "m", reply: "r" });
    const system = (model.calls[0]!.messages.find((m) => m.role === "system")?.content ?? "").toLowerCase();
    expect(system).toContain("demographic");
    expect(system).toContain("psychographic");
    expect(system).toContain("willingness-to-pay");
  });

  it("requests structured output (responseSchema, provenance enum-constrained) at temperature 0", async () => {
    const model = respond({ facts: [] });
    await createModelDistiller({ model }).distill({ message: "m", reply: "r" });
    const req = model.calls[0]!;
    expect(req.temperature).toBe(0);
    expect(req.responseSchema).toBeDefined();
    const schema = req.responseSchema as {
      properties: { facts: { items: { properties: { disposition: { properties: { provenance: { enum: string[] } } } } } } };
    };
    expect(schema.properties.facts.items.properties.disposition.properties.provenance.enum).toEqual(["stated", "observed"]);
  });

  it("fails closed to [] (never throws) when the model returns non-JSON prose", async () => {
    const model = new MockModelAdapter("Sorry, I can't help with that.");
    const facts = await createModelDistiller({ model }).distill({ message: "m", reply: "r" });
    expect(facts).toEqual([]);
  });

  it("fails closed to [] (never throws) when model.complete itself throws", async () => {
    const model: ModelPort = {
      complete: async () => {
        throw new Error("network down");
      },
    };
    const facts = await createModelDistiller({ model }).distill({ message: "m", reply: "r" });
    expect(facts).toEqual([]);
  });

  it("is deterministic given a deterministic model — same input, same output", async () => {
    const model = respond({ facts: [{ text: "prefers fragrance-free products" }] });
    const distiller = createModelDistiller({ model });
    const turn = { message: "m", reply: "r" };
    expect(await distiller.distill(turn)).toEqual(await distiller.distill(turn));
  });
});

describe("createModelDistiller — wired into createMemoryService (reuse, not reimplementation)", () => {
  it("a health/allergy-derived fact classifies SPECIAL via the EXISTING classifyFact — requires Consent 2, independent of Consent 1", async () => {
    const model = respond({ facts: [{ text: "shopper has a tree-nut allergy" }] });
    const service = createMemoryService({
      vector: createInMemoryVectorStore(),
      audit: new InMemoryRuntimeStore(),
      distiller: createModelDistiller({ model }),
      enabled: true,
    });

    const noConsent2: MemoryCtx = { tenantId: "acme-md", anonId: "g1", region: "us", consent1: "in", consent2: "unknown" };
    expect((await service.remember(noConsent2, { message: "m", reply: "r" })).written).toEqual([]);
    expect(await service.recall(noConsent2)).toEqual([]);

    const consented: MemoryCtx = { tenantId: "acme-md", anonId: "g2", region: "us", consent1: "in", consent2: "in" };
    const result = await service.remember(consented, { message: "m", reply: "r" });
    expect(result.written).toEqual(["special"]);
    expect(await service.recall(consented)).toEqual([{ text: "shopper has a tree-nut allergy", class: "special" }]);
  });

  it("a PII-laden model candidate is rejected by the EXISTING sanitizeFact gate — never written, regardless of consent", async () => {
    const model = respond({ facts: [{ text: "email me at shopper@example.com to follow up" }] });
    const service = createMemoryService({
      vector: createInMemoryVectorStore(),
      audit: new InMemoryRuntimeStore(),
      distiller: createModelDistiller({ model }),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme-md", anonId: "g3", region: "us", consent1: "in", consent2: "in" };
    expect((await service.remember(ctx, { message: "m", reply: "r" })).written).toEqual([]);
  });

  it("an inferred-provenance disposition candidate never reaches storage, even with full consent", async () => {
    const model = respond({
      facts: [{ text: "seems like a big spender", disposition: { axis: "budget_stated", value: "high", provenance: "inferred", confidence: 0.9 } }],
    });
    const service = createMemoryService({
      vector: createInMemoryVectorStore(),
      audit: new InMemoryRuntimeStore(),
      distiller: createModelDistiller({ model }),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme-md", anonId: "g4", region: "us", consent1: "in", consent2: "in" };
    expect((await service.remember(ctx, { message: "m", reply: "r" })).written).toEqual([]);
  });

  it("classifyFact is the EXACT function invoked for model-distilled candidates (spied via the existing override seam — not a parallel classifier)", async () => {
    const spy = vi.fn(classifyFact);
    const model = respond({ facts: [{ text: "prefers fragrance-free products" }] });
    const service = createMemoryService({
      vector: createInMemoryVectorStore(),
      audit: new InMemoryRuntimeStore(),
      distiller: createModelDistiller({ model }),
      classifier: spy,
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme-md", anonId: "g5", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctx, { message: "m", reply: "r" });
    expect(spy).toHaveBeenCalledWith("prefers fragrance-free products", undefined);
  });

  it("ttlForClass (reused unchanged) still stamps + governs model-sourced facts — both expire at the shared 30d", async () => {
    const model = respond({ facts: [{ text: "prefers fragrance-free" }, { text: "allergic to tree nuts" }] });
    let nowMs = new Date("2026-01-01T00:00:00Z").getTime();
    const service = createMemoryService({
      vector: createInMemoryVectorStore(),
      audit: new InMemoryRuntimeStore(),
      distiller: createModelDistiller({ model }),
      enabled: true,
      clock: () => new Date(nowMs),
    });
    const ctx: MemoryCtx = { tenantId: "acme-md-ttl", anonId: "g6", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    // legal 2026: ordinary and special share the 30d window. At day 35 with NO intervening recall (nothing
    // slides the TTL), both model-sourced facts have expired on read — proving ttlForClass still stamps and
    // governs model-sourced writes just as it does distiller-sourced ones.
    nowMs += 35 * 24 * 60 * 60 * 1000;
    const texts = (await service.recall(ctx)).map((f) => f.text);
    expect(texts).not.toContain("prefers fragrance-free");
    expect(texts).not.toContain("allergic to tree nuts");
    expect(texts).toEqual([]);
  });
});

describe("MemoryServiceDeps.model — threading ModelPort (a caller may hand the service a model directly)", () => {
  it("with no `distiller` given, a supplied `model` builds a real model-backed distiller (model.complete IS called)", async () => {
    const model = respond({ facts: [{ text: "prefers fragrance-free products" }] });
    const service = createMemoryService({ vector: createInMemoryVectorStore(), audit: new InMemoryRuntimeStore(), model, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-md", anonId: "g7", region: "us", consent1: "in", consent2: "unknown" };
    const result = await service.remember(ctx, { message: "m", reply: "r" });
    expect(model.calls.length).toBe(1);
    expect(result.written).toEqual(["ordinary"]);
  });

  it("falls back to createStubDistiller when NEITHER `distiller` nor `model` is given", async () => {
    const service = createMemoryService({ vector: createInMemoryVectorStore(), audit: new InMemoryRuntimeStore(), enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-md", anonId: "g8", region: "us", consent1: "in", consent2: "unknown" };
    const result = await service.remember(ctx, { message: "prefers fragrance-free products", reply: "ok" });
    expect(result.written).toEqual(["ordinary"]); // stub passthrough still works
  });

  it("INERT: with the gate off, model.complete is NEVER called — remember() short-circuits before distill() runs", async () => {
    const model = respond({ facts: [{ text: "x" }] });
    const runtimeStore = new InMemoryRuntimeStore();
    const auditSpy = vi.spyOn(runtimeStore, "audit");
    const service = createMemoryService({ vector: createInMemoryVectorStore(), audit: runtimeStore, model, enabled: false });
    const ctx: MemoryCtx = { tenantId: "acme-md", anonId: "g9", region: "us", consent1: "in", consent2: "in" };
    expect(await service.remember(ctx, { message: "m", reply: "r" })).toEqual({ written: [] });
    expect(model.calls.length).toBe(0);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("in production (no test env), MEMORY_ADR_ACCEPTED=false keeps it inert even with a real `model` threaded + enabled:true", async () => {
    const orig = { v: process.env.VITEST, n: process.env.NODE_ENV };
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    try {
      const model = respond({ facts: [{ text: "x" }] });
      const service = createMemoryService({ vector: createInMemoryVectorStore(), audit: new InMemoryRuntimeStore(), model, enabled: true });
      const ctx: MemoryCtx = { tenantId: "acme-md", anonId: "g10", region: "us", consent1: "in", consent2: "in" };
      await service.remember(ctx, { message: "m", reply: "r" });
      expect(model.calls.length).toBe(0); // MEMORY_ADR_ACCEPTED is hardcoded false — stays inert
    } finally {
      if (orig.v === undefined) delete process.env.VITEST;
      else process.env.VITEST = orig.v;
      process.env.NODE_ENV = orig.n as string;
    }
  });
});

// PR-8 — the disposition round-trip: `createModelDistiller` no longer discards the validated
// disposition (surfaced above); `remember()` now stores it on `FactMetadata.disposition` and `recall()`
// returns it on `RecalledFact.disposition`, so PR-7's recall -> style path has real data to translate.
describe("PR-8 — disposition persists through remember() and comes back on recall()", () => {
  it("a validated disposition attached to a distilled fact round-trips on RecalledFact.disposition", async () => {
    const model = respond({
      facts: [
        {
          text: "asked for ingredient names before buying",
          disposition: { axis: "style", value: "researcher", provenance: "observed", confidence: 0.8, sourceQuote: "what actives are in this" },
        },
      ],
    });
    const service = createMemoryService({
      vector: createInMemoryVectorStore(),
      audit: new InMemoryRuntimeStore(),
      distiller: createModelDistiller({ model }),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme-disp", anonId: "g-disp-1", region: "us", consent1: "in", consent2: "unknown" };

    const written = await service.remember(ctx, { message: "what actives are in this?", reply: "..." });
    expect(written.written).toEqual(["ordinary"]);

    const recalled = await service.recall(ctx);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.disposition).toEqual([
      { axis: "style", value: "researcher", provenance: "observed", confidence: 0.8, sourceQuote: "what actives are in this" },
    ]);
  });

  it("a fact with NO disposition round-trips with disposition simply absent (not an empty array / not a spurious value)", async () => {
    const model = respond({ facts: [{ text: "prefers fragrance-free products" }] });
    const service = createMemoryService({
      vector: createInMemoryVectorStore(),
      audit: new InMemoryRuntimeStore(),
      distiller: createModelDistiller({ model }),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme-disp", anonId: "g-disp-2", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const recalled = await service.recall(ctx);
    expect(recalled).toEqual([{ text: "prefers fragrance-free products", class: "ordinary" }]);
    expect(recalled[0]!.disposition).toBeUndefined();
  });

  it("a sourceQuote is redaction+cap sanitized the SAME as the fact text (a pasted card in the quoted span is redacted, never stored raw)", async () => {
    const model = respond({
      facts: [
        {
          text: "keeps a running budget for skincare",
          disposition: {
            axis: "budget_stated",
            value: "under-50",
            provenance: "stated",
            confidence: 1,
            sourceQuote: "keep it under $50, my card is 4111 1111 1111 1111 if you need it",
          },
        },
      ],
    });
    const service = createMemoryService({
      vector: createInMemoryVectorStore(),
      audit: new InMemoryRuntimeStore(),
      distiller: createModelDistiller({ model }),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme-disp", anonId: "g-disp-quote", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const recalled = await service.recall(ctx);
    const quote = recalled[0]!.disposition?.[0]?.sourceQuote ?? "";
    expect(quote).not.toContain("4111");
    expect(quote).toContain("[redacted-card]");
  });

  it("defense-in-depth: service.ts re-validates the disposition (isValidDisposition, reject-in-full) even from a hand-rolled FactDistiller that skipped its own validation — never just createModelDistiller's own gate", async () => {
    const distiller: FactDistiller = {
      async distill() {
        return [
          {
            text: "seems like a big spender",
            disposition: { axis: "budget_stated", value: "high", provenance: "inferred" as never, confidence: 0.9 },
          },
        ];
      },
    };
    const service = createMemoryService({ vector: createInMemoryVectorStore(), audit: new InMemoryRuntimeStore(), distiller, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-disp", anonId: "g-disp-3", region: "us", consent1: "in", consent2: "unknown" };

    // Reject-in-full: the WHOLE candidate (fact text included) never reaches storage, mirroring
    // createModelDistiller's own rule — the same fairness-structural bar applies regardless of which
    // FactDistiller produced the candidate.
    const written = await service.remember(ctx, { message: "m", reply: "r" });
    expect(written.written).toEqual([]);
    expect(await service.recall(ctx)).toEqual([]);
  });
});
