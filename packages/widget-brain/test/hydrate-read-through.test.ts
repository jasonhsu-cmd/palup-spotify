import { describe, expect, it } from "vitest";
import type { GroundingContext, GroundingPort, ModelPort, ProductFact, ProductFactsPort } from "@palup/platform-ports";
import { DEFAULT_CATALOG_RETRIEVAL_K, MockCommerceAdapter, READ_THROUGH_TIMEOUT_MS, createBrain } from "../src/index.js";
import type { CatalogRetrieverPort, RetrievedProduct, Signals } from "../src/types.js";
import { RecordingModelPort } from "./helpers/flag-off-probes.js";

// Pillar 1 (ADR-0020) — serve-time READ-THROUGH. Behind PRODUCT_FACTS_READ_THROUGH (server.ts), when the
// serve path is about to quote a SKU whose Tier-2 fact is STALE or MISSING, the brain triggers a TARGETED,
// bounded, on-demand refresh of just those ids BEFORE quoting — instead of only hedging
// (priceConfirmed:false). This pins the MECHANISM: which ids get refreshed, that the refresh is bounded by
// a timeout, that any failure/hang falls back to the existing hedge without ever throwing into the reply,
// and that the flag-off shape (`refreshFacts` undefined) is byte-identical to the pre-Pillar-1 hydration
// path (see hydrate-serving.test.ts's own "A1b/D2" suite, which is untouched by this change).

function bigCatalog(): GroundingContext {
  const n = DEFAULT_CATALOG_RETRIEVAL_K + 8; // larger than k so retrieval narrows
  return {
    tenantId: "acme",
    brandName: "Acme",
    products: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, title: `Product ${i}`, price: `$${i}`, description: `Description of product ${i}.`, availableForSale: true,
    })),
    policy: { returns: "30 days", shipping: "free over $75" },
  };
}

const groundingOf = (ctx: GroundingContext): GroundingPort => ({
  async getContext() { return JSON.parse(JSON.stringify(ctx)) as GroundingContext; },
  async getShell() { return { tenantId: ctx.tenantId, brandName: ctx.brandName, policy: ctx.policy }; },
  async getProductsByIds(_tenantId, ids) { return ctx.products.filter((p) => ids.includes(p.id)); },
});

const fakeRetriever = (ids: string[]): CatalogRetrieverPort => ({
  async retrieve() {
    const hits = ids.map((productId, rank): RetrievedProduct => ({
      productId,
      score: 1 - rank / 100,
      metadata: { title: `Product ${productId.match(/\d+$/)?.[0] ?? productId}` },
    }));
    return { hits, corpusProductCount: hits.length };
  },
});

interface SequencedFacts extends ProductFactsPort {
  /** One entry per `getMany` call, in order. */
  getManyCalls: { tenantId: string; ids: string[] }[];
}

/** A ProductFactsPort whose `getMany` returns a DIFFERENT scripted response on each successive call (the
 *  Nth call returns `responses[min(N, responses.length - 1)]`, filtered to the requested ids) — so a test
 *  can script "first call: stale/missing, second call (post-refresh): fresh" without the refresh callback
 *  itself needing to mutate any shared state. */
function sequencedFacts(responses: ProductFact[][]): SequencedFacts {
  const getManyCalls: SequencedFacts["getManyCalls"] = [];
  let call = 0;
  return {
    getManyCalls,
    async getMany(tenantId, ids) {
      getManyCalls.push({ tenantId, ids: [...ids] });
      const facts = responses[Math.min(call, responses.length - 1)] ?? [];
      call++;
      return facts.filter((f) => ids.includes(f.productId));
    },
    async upsertMany() {},
    async deleteMany() {},
    async deleteTenant() {},
  };
}

interface RecordingRefresh {
  (tenantId: string, productIds: string[]): Promise<void>;
  calls: { tenantId: string; productIds: string[] }[];
}

/** Records every call, then delegates to `behavior` (default: resolves immediately). */
function recordingRefresh(behavior: (tenantId: string, productIds: string[]) => Promise<void> = async () => {}): RecordingRefresh {
  const calls: RecordingRefresh["calls"] = [];
  const fn = (async (tenantId: string, productIds: string[]) => {
    calls.push({ tenantId, productIds: [...productIds] });
    return behavior(tenantId, productIds);
  }) as RecordingRefresh;
  fn.calls = calls;
  return fn;
}

function brainWithReadThrough(
  model: ModelPort,
  grounding: GroundingPort,
  retriever: CatalogRetrieverPort,
  facts: ProductFactsPort | undefined,
  maxAgeMs?: number,
  refreshFacts?: (tenantId: string, productIds: string[]) => Promise<void>,
) {
  return createBrain(
    model, grounding, undefined, new MockCommerceAdapter(), undefined, undefined,
    false, false, false, false,
    retriever, /* catalogRetrieval */ true, DEFAULT_CATALOG_RETRIEVAL_K,
    false, false, false, false,
    facts, /* productFactsHydrationEnabled */ true,
    undefined, false,
    maxAgeMs,
    undefined, // turnEmbedder (position 23)
    false,     // greetingProactiveEnabled (position 24)
    undefined, // channelHealthFor (position 25)
    false,     // priceRequiresLiveChannelEnabled (position 26)
    false,     // proactiveOpenerEnabled (position 27)
    refreshFacts, // position 28
  );
}

function lastSystemPrompt(model: RecordingModelPort): string {
  const sys = model.requests.at(-1)?.messages.find((m) => m.role === "system");
  if (!sys) throw new Error("no system message");
  return sys.content;
}

const SALES: Signals = { tenantId: "acme" };
const ASK = "what do you recommend for dull skin?";
const ONE_HOUR_MS = 3_600_000;

describe("Pillar 1 — serve-time read-through (flag ON via refreshFacts)", () => {
  it("a STALE fact triggers a targeted refresh; the SECOND getMany's fresh fact is what gets quoted", async () => {
    const model = new RecordingModelPort();
    const stale: ProductFact = { productId: "p1", price: "$1 (stale)", updatedAt: new Date(0).toISOString() }; // 1970 ⇒ stale
    const freshP2: ProductFact = { productId: "p2", price: "$2", updatedAt: new Date().toISOString() };
    const freshP1: ProductFact = { productId: "p1", price: "$99", updatedAt: new Date().toISOString() };
    const facts = sequencedFacts([[stale, freshP2], [freshP1, freshP2]]);
    const refresh = recordingRefresh();

    const d = await brainWithReadThrough(model, groundingOf(bigCatalog()), fakeRetriever(["p1", "p2"]), facts, ONE_HOUR_MS, refresh)
      .decide(SALES, ASK);

    expect(d.reply).toBeTruthy();
    // refreshFacts was called with EXACTLY the stale id (p2 was already fresh, never included).
    expect(refresh.calls).toEqual([{ tenantId: "acme", productIds: ["p1"] }]);
    // the store was consulted twice: once before the refresh, once after.
    expect(facts.getManyCalls.length).toBe(2);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("$99"); // the post-refresh fresh price is what the model sees
    expect(prompt).not.toContain("current price needs confirming"); // no longer hedged
    expect(d.flags).toContain("hydration:read_through");
  });

  it("a MISSING fact (absent from the first getMany) also triggers the refresh", async () => {
    const model = new RecordingModelPort();
    const freshP1: ProductFact = { productId: "p1", price: "$29", updatedAt: new Date().toISOString() };
    // First call: no fact at all for p1 (missing). Second call (post-refresh): fresh.
    const facts = sequencedFacts([[], [freshP1]]);
    const refresh = recordingRefresh();

    const d = await brainWithReadThrough(model, groundingOf(bigCatalog()), fakeRetriever(["p1"]), facts, undefined, refresh)
      .decide(SALES, ASK);

    expect(d.reply).toBeTruthy();
    expect(refresh.calls).toEqual([{ tenantId: "acme", productIds: ["p1"] }]);
    expect(lastSystemPrompt(model)).toContain("$29");
    expect(d.flags).toContain("hydration:read_through");
  });

  it("refreshFacts THROWS ⇒ falls back to the existing hedge, decision still returns, never throws", async () => {
    const model = new RecordingModelPort();
    const stale: ProductFact = { productId: "p1", price: "$1", updatedAt: new Date(0).toISOString() };
    const facts = sequencedFacts([[stale]]);
    const refresh = recordingRefresh(async () => { throw new Error("refresh backend down"); });

    const d = await brainWithReadThrough(model, groundingOf(bigCatalog()), fakeRetriever(["p1"]), facts, ONE_HOUR_MS, refresh)
      .decide(SALES, ASK);

    expect(d.reply).toBeTruthy(); // the turn is answered, not thrown
    expect(refresh.calls).toEqual([{ tenantId: "acme", productIds: ["p1"] }]); // the attempt was made
    // getMany was consulted only ONCE — the throw short-circuits before any second fetch.
    expect(facts.getManyCalls.length).toBe(1);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("current price needs confirming"); // still hedged
    expect(d.flags).not.toContain("hydration:read_through");
  });

  it("refreshFacts NEVER RESOLVES ⇒ falls back to the hedge within the timeout ceiling, never hangs the reply", async () => {
    const model = new RecordingModelPort();
    const stale: ProductFact = { productId: "p1", price: "$1", updatedAt: new Date(0).toISOString() };
    const facts = sequencedFacts([[stale]]);
    const refresh = recordingRefresh(() => new Promise<void>(() => {})); // never settles

    const started = Date.now();
    const d = await brainWithReadThrough(model, groundingOf(bigCatalog()), fakeRetriever(["p1"]), facts, ONE_HOUR_MS, refresh)
      .decide(SALES, ASK);
    const elapsedMs = Date.now() - started;

    expect(d.reply).toBeTruthy();
    expect(elapsedMs).toBeLessThan(READ_THROUGH_TIMEOUT_MS + 1_000); // bounded, generous margin for test-runner jitter
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("current price needs confirming"); // still hedged — no fresh price arrived in time
    expect(d.flags).not.toContain("hydration:read_through");
  }, 10_000);

  it("refreshFacts is called ONLY with the stale/missing ids — never the whole retrieved set when some are already fresh", async () => {
    const model = new RecordingModelPort();
    const stale: ProductFact = { productId: "p1", price: "$1", updatedAt: new Date(0).toISOString() };
    const fresh: ProductFact = { productId: "p2", price: "$50", updatedAt: new Date().toISOString() };
    const facts = sequencedFacts([[stale, fresh], [{ productId: "p1", price: "$99", updatedAt: new Date().toISOString() }, fresh]]);
    const refresh = recordingRefresh();

    await brainWithReadThrough(model, groundingOf(bigCatalog()), fakeRetriever(["p1", "p2"]), facts, ONE_HOUR_MS, refresh)
      .decide(SALES, ASK);

    expect(refresh.calls).toEqual([{ tenantId: "acme", productIds: ["p1"] }]);
  });
});

describe("Pillar 1 — flag OFF (refreshFacts undefined) is byte-identical to the pre-read-through hedge", () => {
  it("no refresh is attempted; getMany is called exactly once; a stale fact is hedged exactly as before", async () => {
    const model = new RecordingModelPort();
    const stale: ProductFact = { productId: "p1", price: "$1", updatedAt: new Date(0).toISOString() };
    const facts = sequencedFacts([[stale], [{ productId: "p1", price: "$99", updatedAt: new Date().toISOString() }]]);

    const d = await brainWithReadThrough(model, groundingOf(bigCatalog()), fakeRetriever(["p1"]), facts, ONE_HOUR_MS, undefined)
      .decide(SALES, ASK);

    expect(facts.getManyCalls.length).toBe(1); // never a second (read-through) fetch
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("current price needs confirming");
    expect(prompt).not.toContain("$99");
    expect(d.flags).not.toContain("hydration:read_through");
  });

  it("no refresh is attempted for a MISSING fact either, with the flag off", async () => {
    const model = new RecordingModelPort();
    const facts = sequencedFacts([[], [{ productId: "p1", price: "$29", updatedAt: new Date().toISOString() }]]);

    const d = await brainWithReadThrough(model, groundingOf(bigCatalog()), fakeRetriever(["p1"]), facts, undefined, undefined)
      .decide(SALES, ASK);

    expect(facts.getManyCalls.length).toBe(1);
    expect(lastSystemPrompt(model)).not.toContain("$29");
    expect(d.flags).not.toContain("hydration:read_through");
  });
});
