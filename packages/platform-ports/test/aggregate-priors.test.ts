import { describe, it, expect } from "vitest";
import {
  anonymizePrivateInsight, isAggregateLearningEnabled, AGGREGATE_LEARNING_ADR_ACCEPTED,
  InMemoryAggregatePriorStore, MIN_CONTRIBUTING_MERCHANTS, type LearnedInsight,
} from "../src/index.js";

function insight(over: Partial<LearnedInsight> = {}): LearnedInsight {
  return {
    id: "l1", tenantId: "t1", category: "customers", tier: "private", origin: "synthesized",
    text: "First-time buyers convert more with a sample add-on",
    grounding: { source: "orders", sampleSize: 250, confidence: "high" },
    pinned: true, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z", ...over,
  };
}

describe("the aggregate layer is OFF by construction (double gate)", () => {
  it("stays disabled even with the env flag set — the ADR const is false", () => {
    expect(AGGREGATE_LEARNING_ADR_ACCEPTED).toBe(false);
    expect(isAggregateLearningEnabled({ AGGREGATE_LEARNING_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("readPriors returns [] while disabled, regardless of contributions (dark)", async () => {
    const s = new InMemoryAggregatePriorStore(); // default: real (hard-off) gate
    for (let i = 0; i < MIN_CONTRIBUTING_MERCHANTS + 1; i++) await s.contribute(insight({ tenantId: `t${i}` }), "secret");
    expect(await s.readPriors()).toEqual([]);
  });
});

describe("the hard wall: anonymization strips every tenant identifier", () => {
  it("keeps only category/text/sampleSize + a non-reversible contributor tag", () => {
    const c = anonymizePrivateInsight(insight(), "secret");
    expect(Object.keys(c).sort()).toEqual(["category", "contributorTag", "sampleSize", "text"]);
    expect(c.contributorTag).not.toContain("t1");
    expect(c).not.toHaveProperty("tenantId");
    expect(c).not.toHaveProperty("id");
    expect(c).not.toHaveProperty("pinned");
    // Same tenant → same tag (dedup), different tenant → different tag (distinct-count).
    expect(anonymizePrivateInsight(insight({ tenantId: "t1" }), "secret").contributorTag)
      .toBe(anonymizePrivateInsight(insight({ tenantId: "t1", id: "x" }), "secret").contributorTag);
    expect(anonymizePrivateInsight(insight({ tenantId: "t2" }), "secret").contributorTag)
      .not.toBe(anonymizePrivateInsight(insight({ tenantId: "t1" }), "secret").contributorTag);
  });
});

describe("k-anonymity floor (exercised with an injected enabled gate — never enabled in prod)", () => {
  it("sums sampleSize, counts distinct contributors, and hides priors below the floor", async () => {
    const s = new InMemoryAggregatePriorStore({ isEnabled: () => true });
    // Same text from < floor distinct tenants → hidden.
    for (let i = 0; i < MIN_CONTRIBUTING_MERCHANTS - 1; i++) await s.contribute(insight({ tenantId: `t${i}`, grounding: { source: "orders", sampleSize: 100, confidence: "high" } }), "secret");
    expect(await s.readPriors()).toEqual([]);
    // Add contributors to clear the floor.
    for (let i = MIN_CONTRIBUTING_MERCHANTS - 1; i < MIN_CONTRIBUTING_MERCHANTS + 1; i++) await s.contribute(insight({ tenantId: `t${i}`, grounding: { source: "orders", sampleSize: 100, confidence: "high" } }), "secret");
    const priors = await s.readPriors();
    expect(priors).toHaveLength(1);
    expect(priors[0].contributingMerchants).toBe(MIN_CONTRIBUTING_MERCHANTS + 1);
    expect(priors[0].sampleSize).toBe((MIN_CONTRIBUTING_MERCHANTS + 1) * 100);
    expect(priors[0].confidence).toBe("high"); // aggregate sample well above the high floor
    expect(priors[0]).not.toHaveProperty("contributorTag"); // never leaked out
  });
  it("dedups repeat contributions from the same tenant (no k-anon inflation)", async () => {
    const s = new InMemoryAggregatePriorStore({ isEnabled: () => true });
    for (let i = 0; i < MIN_CONTRIBUTING_MERCHANTS + 1; i++) await s.contribute(insight({ tenantId: "t1" }), "secret");
    expect(await s.readPriors()).toEqual([]); // one distinct contributor < floor
  });
});
