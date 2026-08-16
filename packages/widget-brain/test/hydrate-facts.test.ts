import { describe, expect, it } from "vitest";
import type { Product, ProductFact } from "@palup/platform-ports";
import { hydrateProductFacts } from "../src/hydrate-facts.js";

// A1b — the pure fact-overlay. See hydrate-facts.ts for the contract; these pin it.

const prod = (over: Partial<Product> = {}): Product => ({
  id: "serum-vc",
  title: "Vitamin-C Brightening Serum",
  description: "A daily brightening serum.",
  price: "$34",
  availableForSale: true,
  ...over,
});

describe("A1b — hydrateProductFacts (fresh money-facts overlaid onto the live catalog product)", () => {
  it("overlays a fresher price from the matching fact", () => {
    const out = hydrateProductFacts([prod()], [{ productId: "serum-vc", price: "$29" }]);
    expect(out[0]!.price).toBe("$29");
    // stable fields untouched
    expect(out[0]!.title).toBe("Vitamin-C Brightening Serum");
    expect(out[0]!.description).toBe("A daily brightening serum.");
  });

  it("overlays availability ONLY when the fact states it (three-state preserved)", () => {
    // fact omits availableForSale → product's own true is kept
    const kept = hydrateProductFacts([prod({ availableForSale: true })], [{ productId: "serum-vc", price: "$34" }]);
    expect(kept[0]!.availableForSale).toBe(true);
    // fact states false → overwritten to false
    const flipped = hydrateProductFacts([prod({ availableForSale: true })], [{ productId: "serum-vc", price: "$34", availableForSale: false }]);
    expect(flipped[0]!.availableForSale).toBe(false);
  });

  it("leaves a product with NO matching fact completely unchanged (same object reference)", () => {
    const p = prod();
    const out = hydrateProductFacts([p], [{ productId: "other", price: "$1" }]);
    expect(out[0]).toBe(p); // untouched: sparse overlay, live catalog is authoritative about existence
  });

  it("empty facts is a no-op returning the same array", () => {
    const arr = [prod()];
    expect(hydrateProductFacts(arr, [])).toBe(arr);
  });

  it("preserves order and identity across a mixed set", () => {
    const a = prod({ id: "a", title: "A", price: "$1" });
    const b = prod({ id: "b", title: "B", price: "$2" });
    const c = prod({ id: "c", title: "C", price: "$3" });
    const out = hydrateProductFacts([a, b, c], [{ productId: "c", price: "$9" }, { productId: "a", price: "$8" }]);
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(out.map((p) => p.price)).toEqual(["$8", "$2", "$9"]);
    expect(out[1]).toBe(b); // the unmatched one is the same reference
  });

  it("does not mutate the inputs", () => {
    const p = prod();
    const facts: ProductFact[] = [{ productId: "serum-vc", price: "$29", availableForSale: false }];
    hydrateProductFacts([p], facts);
    expect(p.price).toBe("$34");
    expect(p.availableForSale).toBe(true);
  });

  it("last-write-wins on a duplicate fact id (mirrors getMany de-dup)", () => {
    const out = hydrateProductFacts([prod()], [{ productId: "serum-vc", price: "$10" }, { productId: "serum-vc", price: "$20" }]);
    expect(out[0]!.price).toBe("$20");
  });

  it("never invents a product: an id present only in facts produces nothing", () => {
    const out = hydrateProductFacts([prod({ id: "a" })], [{ productId: "ghost", price: "$1" }]);
    expect(out.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("A1b/D2 — the staleness ceiling (fail-honest on a stale money fact)", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");
  const ceiling = { now, maxAgeMs: 3_600_000 }; // 1h
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("marks a STALE fact priceConfirmed:false and does NOT overlay its price/availability", () => {
    const p = prod({ price: "$34", availableForSale: true });
    const out = hydrateProductFacts([p], [{ productId: "serum-vc", price: "$29", availableForSale: false, updatedAt: ago(7_200_000) }], ceiling);
    expect(out[0]!.priceConfirmed).toBe(false);
    expect(out[0]!.price).toBe("$34"); // the stale $29 is NOT quoted; base price retained but withheld by the flag
    // S3 §D fix: availability is DROPPED (undefined), not left at the product's own last-known value — a
    // fact existing at all means an availability-affecting event fired, so the pre-fact value isn't trusted.
    expect(out[0]!.availableForSale).toBeUndefined();
  });

  it("overlays a FRESH fact normally and leaves priceConfirmed unset", () => {
    const out = hydrateProductFacts([prod({ price: "$34" })], [{ productId: "serum-vc", price: "$29", updatedAt: ago(60_000) }], ceiling);
    expect(out[0]!.price).toBe("$29");
    expect(out[0]!.priceConfirmed).toBeUndefined();
  });

  it("treats a fact with NO updatedAt as UNCONFIRMABLE ⇒ stale (freshness can't be proven)", () => {
    const out = hydrateProductFacts([prod({ price: "$34" })], [{ productId: "serum-vc", price: "$29" }], ceiling);
    expect(out[0]!.priceConfirmed).toBe(false);
    expect(out[0]!.price).toBe("$34");
  });

  it("treats a malformed updatedAt as stale", () => {
    const out = hydrateProductFacts([prod({ price: "$34" })], [{ productId: "serum-vc", price: "$29", updatedAt: "not-a-date" }], ceiling);
    expect(out[0]!.priceConfirmed).toBe(false);
  });

  it("with NO ceiling supplied, overlays regardless of updatedAt (pre-D2 behaviour, byte-identical)", () => {
    const out = hydrateProductFacts([prod({ price: "$34" })], [{ productId: "serum-vc", price: "$29", updatedAt: ago(999_999_999) }]);
    expect(out[0]!.price).toBe("$29");
    expect(out[0]!.priceConfirmed).toBeUndefined();
  });

  it("a fact exactly AT the ceiling is still fresh; just past it is stale", () => {
    const atLimit = hydrateProductFacts([prod({ price: "$34" })], [{ productId: "serum-vc", price: "$29", updatedAt: ago(3_600_000) }], ceiling);
    expect(atLimit[0]!.price).toBe("$29"); // not > maxAgeMs
    const justPast = hydrateProductFacts([prod({ price: "$34" })], [{ productId: "serum-vc", price: "$29", updatedAt: ago(3_600_001) }], ceiling);
    expect(justPast[0]!.priceConfirmed).toBe(false);
  });
});

describe("S3 §D — 15-minute serve-time staleness ceiling (fail-honest)", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const CEILING_15_MIN = 900_000;
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const prod = (over: Partial<Product> = {}): Product => ({ id: "serum-vc", title: "Vitamin C", description: "d", price: "$34", tags: [], availableForSale: true, ...over });

  it("a fact 14 minutes old is still quoted", () => {
    const out = hydrateProductFacts([prod()], [{ productId: "serum-vc", price: "$29", availableForSale: true, updatedAt: ago(14 * 60_000) }], { now, maxAgeMs: CEILING_15_MIN });
    expect(out[0]!.price).toBe("$29");
    expect(out[0]!.priceConfirmed).not.toBe(false);
  });

  it("a fact 16 minutes old is NOT quoted — priceConfirmed:false and availability dropped", () => {
    const out = hydrateProductFacts([prod()], [{ productId: "serum-vc", price: "$29", availableForSale: true, updatedAt: ago(16 * 60_000) }], { now, maxAgeMs: CEILING_15_MIN });
    expect(out[0]!.priceConfirmed).toBe(false);
    expect(out[0]!.availableForSale).toBeUndefined();
  });
});
