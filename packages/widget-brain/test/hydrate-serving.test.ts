import { describe, expect, it } from "vitest";
import type { GroundingContext, GroundingPort, ModelPort, ProductFact, ProductFactsPort } from "@palup/platform-ports";
import { DEFAULT_CATALOG_RETRIEVAL_K, MockCommerceAdapter, createBrain } from "../src/index.js";
import type { CatalogRetrieverPort, RetrievedProduct, Signals } from "../src/types.js";
import { RecordingModelPort } from "./helpers/flag-off-probes.js";

// A1b — behind PRODUCT_FACTS_HYDRATION, the brain overlays the Tier-2 store's fresh price/availability onto
// the RETRIEVED subset before rendering the CATALOG block. Fake retriever + fake facts store: this pins the
// MECHANISM (which turns consult the store, what reaches the prompt, fail-open), not retrieval/price
// QUALITY — that is the eval gate's job on real data before any human promotion.

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
});

const fakeRetriever = (ids: string[]): CatalogRetrieverPort => ({
  async retrieve() { return ids.map((productId, rank): RetrievedProduct => ({ productId, score: 1 - rank / 100 })); },
});

interface FakeFacts extends ProductFactsPort {
  calls: { tenantId: string; ids: string[] }[];
}
function fakeFacts(facts: ProductFact[], opts: { throws?: Error } = {}): FakeFacts {
  const calls: FakeFacts["calls"] = [];
  return {
    calls,
    async getMany(tenantId, ids) {
      calls.push({ tenantId, ids: [...ids] });
      if (opts.throws) throw opts.throws;
      return facts.filter((f) => ids.includes(f.productId));
    },
    async upsertMany() {},
    async deleteTenant() {},
  };
}

function brainWithHydration(
  model: ModelPort,
  grounding: GroundingPort,
  retriever: CatalogRetrieverPort,
  facts: ProductFactsPort | undefined,
  hydrationEnabled: boolean,
  maxAgeMs?: number, // A1b/D2 staleness ceiling (position 22)
) {
  return createBrain(
    model, grounding, undefined, new MockCommerceAdapter(), undefined, undefined,
    false, false, false, false,
    retriever, /* catalogRetrieval */ true, DEFAULT_CATALOG_RETRIEVAL_K,
    false, false, false, false,
    facts, hydrationEnabled,
    undefined, false,
    maxAgeMs,
  );
}

function lastSystemPrompt(model: RecordingModelPort): string {
  const sys = model.requests.at(-1)?.messages.find((m) => m.role === "system");
  if (!sys) throw new Error("no system message");
  return sys.content;
}

const SALES: Signals = { tenantId: "acme" };
const ASK = "what do you recommend for dull skin?";

describe("A1b — hydrate-by-ID serving (flag ON)", () => {
  it("overlays the Tier-2 fresh price onto the retrieved subset in the CATALOG block", async () => {
    const model = new RecordingModelPort();
    const facts = fakeFacts([{ productId: "p1", price: "$99" }]);
    await brainWithHydration(model, groundingOf(bigCatalog()), fakeRetriever(["p1", "p2"]), facts, true).decide(SALES, ASK);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("$99");            // fresher fact price is what the model sees
    expect(prompt).not.toMatch(/\$1\b/);        // the stale catalog "$1" for p1 is gone
  });

  it("consults the store for the RETRIEVED ids only — never the whole catalog", async () => {
    const model = new RecordingModelPort();
    const facts = fakeFacts([]);
    await brainWithHydration(model, groundingOf(bigCatalog()), fakeRetriever(["p3", "p5"]), facts, true).decide(SALES, ASK);
    expect(facts.calls).toEqual([{ tenantId: "acme", ids: ["p3", "p5"] }]);
  });

  it("fails OPEN: a store error still answers the turn with the un-hydrated catalog price", async () => {
    const model = new RecordingModelPort();
    const facts = fakeFacts([], { throws: new Error("db down") });
    const d = await brainWithHydration(model, groundingOf(bigCatalog()), fakeRetriever(["p1"]), facts, true).decide(SALES, ASK);
    expect(d.reply).toBeTruthy();               // the turn is answered, not thrown
    expect(lastSystemPrompt(model)).toMatch(/\$1\b/); // catalog price survives the failure
  });
});

describe("A1b — flag OFF is inert", () => {
  it("does NOT consult the store and renders the live-catalog price, even with a store wired", async () => {
    const model = new RecordingModelPort();
    const facts = fakeFacts([{ productId: "p1", price: "$99" }]);
    await brainWithHydration(model, groundingOf(bigCatalog()), fakeRetriever(["p1", "p2"]), facts, false).decide(SALES, ASK);
    expect(facts.calls).toEqual([]);            // never called
    expect(lastSystemPrompt(model)).not.toContain("$99");
  });
});

describe("A1b/D2 — staleness ceiling in serving (fail-honest on a stale fact)", () => {
  it("a STALE fact is NOT quoted — the CATALOG shows 'needs confirming' + the confirm-price rule, not the number", async () => {
    const model = new RecordingModelPort();
    const stale = fakeFacts([{ productId: "p1", price: "$99", updatedAt: new Date(0).toISOString() }]); // 1970 ⇒ stale
    await brainWithHydration(model, groundingOf(bigCatalog()), fakeRetriever(["p1", "p2"]), stale, true, 3_600_000).decide(SALES, ASK);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("current price needs confirming"); // the withheld-price marker
    expect(prompt).toMatch(/do NOT quote or guess a price/i);   // the fail-honest rule was added
    expect(prompt).not.toContain("$99");                        // the stale number never reaches the model
  });

  it("a FRESH fact under the same ceiling IS quoted (the ceiling only withholds stale ones)", async () => {
    const model = new RecordingModelPort();
    const fresh = fakeFacts([{ productId: "p1", price: "$29", updatedAt: new Date().toISOString() }]);
    await brainWithHydration(model, groundingOf(bigCatalog()), fakeRetriever(["p1", "p2"]), fresh, true, 3_600_000).decide(SALES, ASK);
    const prompt = lastSystemPrompt(model);
    expect(prompt).toContain("$29");
    expect(prompt).not.toContain("current price needs confirming");
  });
});
