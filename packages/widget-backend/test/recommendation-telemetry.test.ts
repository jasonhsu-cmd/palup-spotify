import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Decision } from "@palup/widget-brain";
import { REPO } from "./shopper-promise-guard.js";
import { recommendationTelemetryFields, recommendationWireFields } from "../src/recommendation-telemetry.js";

// E3 — THE FORWARDING LAYER, and the constraint that governs it.
//
// `TelemetryEvent.recommendedProductIds` and the two /chat response fields are produced by two pure
// functions rather than inline spreads, for one reason: server.ts CANNOT construct a `Decision` that
// carries them. Its `createBrain` call passes seven positional arguments, so PRODUCT_CITATIONS and
// PRODUCT_CARDS both sit at their `false` defaults and no composition in this repo turns them on. A test
// that drove this through `POST /chat` could therefore only ever assert the ABSENT case. Extracting the
// forwarding makes the PRESENT case testable without adding a production seam that could enable a
// posture flag — which is exactly the thing HITL-POLICY §5 says must go through a human promotion.
//
// THIS IS RECOMMENDATION TELEMETRY, NOT A BILLING BASIS. Chaining `recommended -> clicked -> purchased`
// off `recommendedProductIds` is LAST-TOUCH attribution, which ADR-0007 §2 and docs/PRICING.md §2 forbid
// as a fee basis ("conservative, incrementality-based attribution ... never last-touch inflation ... the
// billing form of engagement-maxxing"). The grep test at the bottom keeps that statement attached to the
// field it governs, so deleting the sentence fails the build rather than quietly licensing a fee.

const base: Decision = {
  mode: "sales",
  reply: "Here's what I'd suggest.",
  pitch: "guided_rec",
  escalateToHuman: false,
  outbound: false,
  safetyClass: "none",
  flags: [],
  model: "mock-1",
};

describe("E3 — telemetry forwarding", () => {
  it("adds recommendedProductIds when the decision cited something", () => {
    expect(recommendationTelemetryFields({ ...base, recommendedProducts: ["serum-vc", "moist-daily"] })).toEqual({
      recommendedProductIds: ["serum-vc", "moist-daily"],
    });
  });

  it("adds NOTHING — not an empty array, not an undefined-valued key — when it did not", () => {
    expect(recommendationTelemetryFields(base)).toEqual({});
    expect(Object.keys(recommendationTelemetryFields(base))).toEqual([]);
    // Spread into a real event, the result must be byte-identical to the event without it.
    const event = { kind: "turn" as const, mode: "sales", ...recommendationTelemetryFields(base) };
    expect(JSON.stringify(event)).toBe(JSON.stringify({ kind: "turn", mode: "sales" }));
  });

  it("an empty citation list is also nothing — a zero-length array would read as a measured zero", () => {
    expect(recommendationTelemetryFields({ ...base, recommendedProducts: [] })).toEqual({});
  });

  it("carries IDS ONLY — no title, price or availability reaches the telemetry stream", () => {
    const out = recommendationTelemetryFields({
      ...base,
      recommendedProducts: ["serum-vc"],
      recommendedProductCards: [{ productId: "serum-vc", title: "Vitamin-C Brightening Serum", price: "$34" }],
    });
    expect(JSON.stringify(out)).not.toContain("Vitamin-C");
    expect(JSON.stringify(out)).not.toContain("$34");
  });
});

describe("E3 — /chat wire forwarding", () => {
  it("forwards both fields when the decision carries them", () => {
    const cards = [{ productId: "serum-vc", title: "Vitamin-C Brightening Serum", price: "$34", availableForSale: false }];
    expect(recommendationWireFields({ ...base, recommendedProducts: ["serum-vc"], recommendedProductCards: cards })).toEqual({
      recommendedProducts: ["serum-vc"],
      recommendedProductCards: cards,
    });
  });

  it("forwards NOTHING when the decision carries nothing — the keys are absent from the serialized body", () => {
    const response = { reply: "hi", flags: [] as string[], ...recommendationWireFields(base) };
    expect(JSON.stringify(response)).toBe(JSON.stringify({ reply: "hi", flags: [] }));
    expect(Object.keys(recommendationWireFields(base))).toEqual([]);
  });

  it("ids without cards still forward the ids (PRODUCT_CITATIONS on, PRODUCT_CARDS off)", () => {
    expect(recommendationWireFields({ ...base, recommendedProducts: ["serum-vc"] })).toEqual({
      recommendedProducts: ["serum-vc"],
    });
  });
});

describe("E3 — the constraint is written next to the thing it governs, not only in the PR", () => {
  const read = (p: string): string => readFileSync(`${REPO}/${p}`, "utf8");

  it("the telemetry port states that recommendedProductIds is NOT a billing basis, and names the rule", () => {
    const src = read("packages/platform-ports/src/telemetry-port.ts");
    expect(src).toContain("recommendedProductIds");
    const doc = src.slice(Math.max(0, src.indexOf("recommendedProductIds") - 3000), src.indexOf("recommendedProductIds") + 500);
    expect(doc).toMatch(/NOT A BILLING BASIS|not a billing basis/);
    expect(doc).toMatch(/last-touch/i);
    expect(doc).toMatch(/ADR-0007/);
    expect(doc).toMatch(/PRICING\.md/);
  });

  it("the telemetry port states that the field UNDER-COUNTS, so no rate is computed off it by accident", () => {
    const src = read("packages/platform-ports/src/telemetry-port.ts");
    const doc = src.slice(Math.max(0, src.indexOf("recommendedProductIds") - 3000), src.indexOf("recommendedProductIds") + 500);
    expect(doc).toMatch(/under-count|UNDER-COUNT|lower bound/i);
  });

  it("the rule it cites really says that (the source, not our memory of it)", () => {
    expect(read("docs/PRICING.md")).toContain("never last-touch inflation");
  });

  it("rollupEvents deliberately does NOT aggregate recommendedProductIds into a headline number", () => {
    // An aggregate over an under-counting field is a metric that looks measured and is not. If one is
    // ever wanted it needs its own named, caveated surface — not a silent addition to the cost rollup.
    const src = read("packages/platform-ports/src/telemetry-port.ts");
    const rollup = src.slice(src.indexOf("export function rollupEvents"));
    expect(rollup).not.toContain("recommendedProductIds");
  });
});
