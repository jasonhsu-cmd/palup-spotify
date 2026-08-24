import { describe, expect, it } from "vitest";
import {
  SandboxPayoutsPort, computeFeeLine, PALUP_ILLUSTRATIVE_TAKE_RATE, type Payout,
} from "../src/payouts-port.js";

const p = (id: string): Payout => ({ id, status: "paid", amountUsd: 100, currency: "USD", issuedAt: "2026-08-20T00:00:00Z" });

describe("SandboxPayoutsPort", () => {
  it("isolates tenants and honors limit; unseeded tenant is empty", async () => {
    const port = new SandboxPayoutsPort({ a: [p("1"), p("2")], b: [p("9")] });
    expect(await port.listPayouts({ tenantId: "a" })).toHaveLength(2);
    expect(await port.listPayouts({ tenantId: "a" }, { limit: 1 })).toHaveLength(1);
    expect(await port.listPayouts({ tenantId: "unknown" })).toEqual([]);
  });
  it("defaults to empty", async () => {
    expect(await new SandboxPayoutsPort().listPayouts({ tenantId: "a" })).toEqual([]);
  });
});

describe("computeFeeLine (illustrative, never charged)", () => {
  it("computes 6% of incremental, rounded to cents, and is NEVER chargeable", () => {
    const fee = computeFeeLine(1000, true);
    expect(fee).toEqual({ chargeable: false, ratePct: 6, baseIncrementalUsd: 1000, computedFeeUsd: 60, reason: "computed" });
    expect(PALUP_ILLUSTRATIVE_TAKE_RATE).toBe(0.06);
  });
  it("rounds to cents", () => {
    expect(computeFeeLine(133.33, true).computedFeeUsd).toBe(8); // 133.33*0.06 = 7.9998 -> 8.00
  });
  it("withholds the number (null) when attribution is underpowered — never a fabricated fee", () => {
    expect(computeFeeLine(1000, false)).toEqual({
      chargeable: false, ratePct: 6, baseIncrementalUsd: null, computedFeeUsd: null, reason: "attribution_underpowered",
    });
  });
  it("a zero incremental base yields a zero fee line, still not chargeable", () => {
    expect(computeFeeLine(0, true)).toEqual({
      chargeable: false, ratePct: 6, baseIncrementalUsd: 0, computedFeeUsd: 0, reason: "computed",
    });
  });
  it("a negative incremental base (net-negative attribution) yields a negative fee, still not chargeable", () => {
    const fee = computeFeeLine(-500, true);
    expect(fee.chargeable).toBe(false);
    expect(fee.baseIncrementalUsd).toBe(-500);
    expect(fee.computedFeeUsd).toBe(-30);
    expect(fee.reason).toBe("computed");
  });
  it("accepts a custom rate override, still not chargeable", () => {
    const fee = computeFeeLine(1000, true, 0.1);
    expect(fee).toEqual({ chargeable: false, ratePct: 10, baseIncrementalUsd: 1000, computedFeeUsd: 100, reason: "computed" });
  });
});
