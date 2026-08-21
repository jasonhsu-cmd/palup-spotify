import { describe, it, expect } from "vitest";
import { formatPriceForTest as formatPrice } from "../src/shopify-grounding.js";

describe("formatPrice", () => {
  it("formats USD to two decimals", () => {
    expect(formatPrice({ amount: "35.0", currencyCode: "USD" })).toBe("$35.00");
    expect(formatPrice({ amount: "35", currencyCode: "USD" })).toBe("$35.00");
    expect(formatPrice({ amount: "1234.5" })).toBe("$1,234.50");
  });
  it("keeps non-USD as amount + code, two decimals", () => {
    expect(formatPrice({ amount: "35.0", currencyCode: "EUR" })).toBe("35.00 EUR");
  });
  it("returns empty string for missing amount", () => {
    expect(formatPrice({})).toBe("");
    expect(formatPrice(undefined)).toBe("");
  });
});
