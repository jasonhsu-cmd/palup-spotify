import { describe, it, expect } from "vitest";
import { PALUP_FLOORS, CONSERVATIVE_DEFAULTS } from "../src/rules.js";

describe("rule constants", () => {
  it("defines a mass-send floor and per-category caps", () => {
    expect(PALUP_FLOORS.campaign.massSendRecipientFloor).toBeGreaterThan(0);
    expect(PALUP_FLOORS.discount.maxAutoPct).toBeGreaterThan(0); // a hard ceiling even the merchant can't exceed
  });
  it("defaults deny auto spend/discount/refund for a new tenant", () => {
    expect(CONSERVATIVE_DEFAULTS.discount?.allowedAuto ?? false).toBe(false);
    expect(CONSERVATIVE_DEFAULTS.ad_spend?.allowedAuto ?? false).toBe(false);
    expect(CONSERVATIVE_DEFAULTS.refund?.allowedAuto ?? false).toBe(false);
  });
});
