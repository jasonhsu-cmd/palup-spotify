import { describe, it, expect } from "vitest";
import { buildLayer2GroundTruth } from "./layer2-groundtruth.js";

describe("buildLayer2GroundTruth", () => {
  it("returns '' when no turn carried recommendedProductCards", () => {
    expect(buildLayer2GroundTruth([{ response: {} }])).toBe("");
    expect(buildLayer2GroundTruth([])).toBe("");
    expect(buildLayer2GroundTruth([{ response: { recommendedProductCards: [] } }])).toBe("");
  });

  it("lists a real product from recommendedProductCards so the judge can cross-check it", () => {
    const gt = buildLayer2GroundTruth([
      {
        response: {
          recommendedProductCards: [
            {
              productId: "gid://shopify/Product/7932996681805",
              title: "Aveda Botanical Kinetics Oil Control Lotion 50ml",
              price: "current price needs confirming",
            },
          ],
        },
      },
    ]);
    expect(gt).toContain("AUTHORITATIVE PRODUCTS CITED THIS TURN");
    expect(gt).toContain("Aveda Botanical Kinetics Oil Control Lotion 50ml");
    expect(gt).toContain("current price needs confirming");
  });

  it("de-duplicates the same productId cited across multiple turns", () => {
    const card = { productId: "p1", title: "Serum", price: "$28" };
    const gt = buildLayer2GroundTruth([
      { response: { recommendedProductCards: [card] } },
      { response: { recommendedProductCards: [card] } },
    ]);
    expect(gt.match(/Serum/g)?.length).toBe(1);
  });

  it("merges distinct products cited across different turns of the same case run", () => {
    const gt = buildLayer2GroundTruth([
      { response: { recommendedProductCards: [{ productId: "p1", title: "Serum", price: "$28" }] } },
      { response: { recommendedProductCards: [{ productId: "p2", title: "Cleanser", price: "$18" }] } },
    ]);
    expect(gt).toContain("Serum");
    expect(gt).toContain("Cleanser");
  });

  it("ignores malformed card entries (missing/non-string productId) without throwing", () => {
    const gt = buildLayer2GroundTruth([
      { response: { recommendedProductCards: [{ title: "No id" }, null, "garbage", { productId: 5 }] } },
    ]);
    expect(gt).toBe("");
  });

  it("tolerates a response with no recommendedProductCards key at all (flag-off turn)", () => {
    expect(buildLayer2GroundTruth([{ response: { reply: "hi" } as any }])).toBe("");
  });
});
