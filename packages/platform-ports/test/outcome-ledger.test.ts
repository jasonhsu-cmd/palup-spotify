import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ArmAgg, ArmTally, OutcomeLedgerEntry, UsageLedgerEntry } from "../src/outcome-ledger.js";
import { EMPTY_ARM_AGG, MIN_EXPOSURES_PER_ARM, computeIncrementalLift } from "../src/outcome-ledger.js";

// Wave 2 / W2-A — synthetic-only tests (no real orders) for the pure incrementality math + ledger/tally
// type shapes. See `packages/platform-ports/src/outcome-ledger.ts` for the design-doc/ADR references.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "..", "src", "outcome-ledger.ts"), "utf8");

describe("computeIncrementalLift — well-powered arms", () => {
  it("positive lift when treated meaningfully outperforms control", () => {
    const treated: ArmAgg = { exposures: 1000, orders: 100, revenue: 10_000 }; // $10/exposure, 10% rate
    const control: ArmAgg = { exposures: 1000, orders: 20, revenue: 2_000 }; // $2/exposure, 2% rate
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(false);
    expect(r.incrementalLift).toBeCloseTo(8_000); // (10 - 2) * 1000
    expect(r.relativeLift).toBeCloseTo(4); // (10-2)/2
    expect(r.confidence).toBeGreaterThan(0.95);
    expect(r.method).toBe("incrementality-v1:two-arm-holdout-lift+two-proportion-z");
  });

  it("~0 lift when treated and control are identical", () => {
    const agg: ArmAgg = { exposures: 500, orders: 50, revenue: 5_000 };
    const r = computeIncrementalLift({ treated: { ...agg }, control: { ...agg } });
    expect(r.underpowered).toBe(false);
    expect(r.incrementalLift).toBeCloseTo(0);
    expect(r.confidence).toBeCloseTo(0); // literally zero measured difference in order rate
  });

  it("honestly reports a NEGATIVE lift when control outperforms treated (never floors a real deficit)", () => {
    const treated: ArmAgg = { exposures: 1000, orders: 20, revenue: 2_000 };
    const control: ArmAgg = { exposures: 1000, orders: 100, revenue: 10_000 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(false);
    expect(r.incrementalLift).toBeCloseTo(-8_000);
    expect(r.confidence).toBeGreaterThan(0.95); // well-powered — this is a confident negative result
  });

  it("meeting the floor but a genuinely small effect yields low confidence WITHOUT being 'underpowered'", () => {
    // Same rate in both arms (10%) at large N — floor is met, control is real, inputs are finite, so this
    // is NOT a fail-closed case; confidence legitimately reflects "no significant difference detected",
    // which is a different concept from "we don't have enough data to know anything".
    const treated: ArmAgg = { exposures: 1000, orders: 100, revenue: 10_000 };
    const control: ArmAgg = { exposures: 1000, orders: 100, revenue: 10_000 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(false);
    expect(r.confidence).toBeCloseTo(0);
  });
});

describe("computeIncrementalLift — fail-closed (underpowered), never a supported positive attribution", () => {
  it("below the min-exposure floor: underpowered, confidence 0, incrementalLift clamped to 0 even though the raw numbers look like a big win", () => {
    const treated: ArmAgg = { exposures: MIN_EXPOSURES_PER_ARM - 1, orders: 50, revenue: 5_000 };
    const control: ArmAgg = { exposures: MIN_EXPOSURES_PER_ARM - 1, orders: 1, revenue: 100 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.incrementalLift).toBe(0); // NOT the raw (positive) number the unsupported data would suggest
    expect(r.relativeLift).toBe(0);
    expect(r.method).toContain("underpowered");
  });

  it("zero exposures in the control arm: underpowered, confidence 0, no positive attribution", () => {
    const treated: ArmAgg = { exposures: 10_000, orders: 500, revenue: 50_000 };
    const control: ArmAgg = { exposures: 0, orders: 0, revenue: 0 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.incrementalLift).toBe(0);
    expect(r.method).toContain("underpowered-zero-control");
  });

  it("non-finite inputs (NaN): underpowered, confidence 0, no positive attribution", () => {
    const treated: ArmAgg = { exposures: NaN, orders: 50, revenue: 5_000 };
    const control: ArmAgg = { exposures: 1000, orders: 20, revenue: 2_000 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.incrementalLift).toBe(0);
    expect(r.method).toContain("underpowered-invalid-input");
  });

  it("non-finite inputs (Infinity): underpowered, confidence 0, no positive attribution", () => {
    const treated: ArmAgg = { exposures: 1000, orders: 50, revenue: Infinity };
    const control: ArmAgg = { exposures: 1000, orders: 20, revenue: 2_000 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.incrementalLift).toBe(0);
  });

  it("negative counts (corrupt data) are treated as invalid, never a supported positive attribution", () => {
    const treated: ArmAgg = { exposures: 1000, orders: -5, revenue: 5_000 };
    const control: ArmAgg = { exposures: 1000, orders: 20, revenue: 2_000 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.incrementalLift).toBe(0);
  });

  it("EMPTY_ARM_AGG as control (absent/never-populated) is treated as zero/absent control", () => {
    const treated: ArmAgg = { exposures: 10_000, orders: 500, revenue: 50_000 };
    const r = computeIncrementalLift({ treated, control: EMPTY_ARM_AGG });
    expect(r.underpowered).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.incrementalLift).toBe(0);
  });

  // Durability NOW-3 (security review): a control arm with real, above-floor EXPOSURES but ZERO revenue
  // has a controlRate of 0 — relativeLift's denominator has no finite answer to normalize by. This must
  // be underpowered, never a silent "trustworthy" relativeLift of 0 (which would read as a confident
  // "no lift" verdict to a relativeLift-comparing caller and could mask a real regression).
  it("control arm has real above-floor exposures but ZERO revenue (controlRate=0): underpowered, not a trustworthy zero", () => {
    const treated: ArmAgg = { exposures: 1000, orders: 100, revenue: 10_000 };
    const control: ArmAgg = { exposures: 1000, orders: 0, revenue: 0 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.incrementalLift).toBe(0); // clamped — NOT the raw (positive) $10/exposure the unsupported ratio would suggest
    expect(r.relativeLift).toBe(0);
    expect(r.method).toContain("underpowered-zero-control-rate");
  });

  it("both arms have zero revenue (0-vs-0 controlRate): underpowered, not a coincidental 'identical, no lift' result", () => {
    const treated: ArmAgg = { exposures: 1000, orders: 0, revenue: 0 };
    const control: ArmAgg = { exposures: 1000, orders: 0, revenue: 0 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.incrementalLift).toBe(0);
    expect(r.relativeLift).toBe(0);
    expect(r.method).toContain("underpowered-zero-control-rate");
  });

  it("a control with real above-floor exposures and NONZERO revenue is UNCHANGED — still a trusted measurement (regression pin)", () => {
    const treated: ArmAgg = { exposures: 1000, orders: 100, revenue: 10_000 };
    const control: ArmAgg = { exposures: 1000, orders: 20, revenue: 2_000 };
    const r = computeIncrementalLift({ treated, control });
    expect(r.underpowered).toBe(false);
    expect(r.incrementalLift).toBeCloseTo(8_000);
    expect(r.relativeLift).toBeCloseTo(4);
    expect(r.method).toBe("incrementality-v1:two-arm-holdout-lift+two-proportion-z");
  });
});

describe("types match the design doc's shapes (docs/design/attribution-and-billing.md :12, :23)", () => {
  it("OutcomeLedgerEntry carries exactly the design doc's fields", () => {
    const entry: OutcomeLedgerEntry = {
      merchantId: "m1",
      period: "2026-08",
      play: "cart_recovery",
      attributedIncrementalRevenue: 123.45,
      controlRef: "holdout-2026-08",
      method: "incrementality-v1:two-arm-holdout-lift+two-proportion-z",
      confidence: 0.97,
    };
    expect(Object.keys(entry).sort()).toEqual(
      ["attributedIncrementalRevenue", "confidence", "controlRef", "merchantId", "method", "period", "play"].sort(),
    );
  });

  it("UsageLedgerEntry carries exactly the design doc's fields (type only — population is later)", () => {
    const entry: UsageLedgerEntry = {
      merchantId: "m1",
      action: "conversation",
      credits: 10,
      billable: true,
      costCogs: 0.02,
      category: "chat",
      ts: "2026-08-19T00:00:00.000Z",
    };
    expect(Object.keys(entry).sort()).toEqual(
      ["merchantId", "action", "credits", "billable", "costCogs", "category", "ts"].sort(),
    );
  });

  it("ArmTally carries exactly the interface field (tenantId/play/period/arm + the ArmAgg counts)", () => {
    const tally: ArmTally = {
      tenantId: "acme",
      play: "cart_recovery",
      period: "2026-08",
      arm: "treated",
      exposures: 1,
      orders: 1,
      revenue: 1,
    };
    expect(Object.keys(tally).sort()).toEqual(
      ["tenantId", "play", "period", "arm", "exposures", "orders", "revenue"].sort(),
    );
  });
});

describe("no last-touch code path exists (ADR-0007 §2 / docs/PRICING.md §2 — forbidden as a fee basis)", () => {
  it("computeIncrementalLift's input shape (ArmAgg) has no order/click/recommendation identifier to join on", () => {
    const agg: ArmAgg = { exposures: 1, orders: 1, revenue: 1 };
    // The ONLY fields ArmAgg can carry are these three aggregate counts — there is structurally no
    // per-order or per-click id here that a last-touch join could use.
    expect(Object.keys(agg).sort()).toEqual(["exposures", "orders", "revenue"]);
  });

  it("the source contains no last-touch join identifiers (clickId/lastTouch/touchpoint/recommendedProductId)", () => {
    for (const forbidden of ["clickId", "lastTouch", "last_touch", "touchpoint", "recommendedProductId"]) {
      expect(SRC.includes(forbidden), `outcome-ledger.ts must never reference "${forbidden}"`).toBe(false);
    }
  });

  it("the source states the no-last-touch invariant (keeps the guarantee attached to the code it governs)", () => {
    expect(SRC).toMatch(/NO LAST-TOUCH/);
    expect(SRC).toMatch(/PROPOSER.FEE-COMPUTER/);
  });
});
