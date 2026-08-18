import { describe, it, expect } from "vitest";
import { createCommercePort } from "../src/model.js";
import { guardCommercePort } from "../src/commerce-guard.js";
import { handleSupport } from "@palup/widget-brain";

// THE BACKSTOP for the live fabrication fixed in this PR.
//
// packages/widget-brain/test/fixture-commerce-honesty.test.ts proves the GUARD works when a port is
// marked as fixture data. This file proves the thing that actually reached shoppers: that the PRODUCTION
// composition root marks it. Those are different failures — the guard could be perfect and production
// still broken if `createCommercePort()` forgot the flag, which is precisely the shape of the original
// defect (the ADR-0016 fail-closed guard was also correct, and also never fired, because it opens with
// `if (!isLive) return;`).
//
// If a live commerce adapter lands, this file should be updated to assert THAT — not deleted.

describe("production composition root — the commerce port cannot silently serve demo data as fact", () => {
  it("createCommercePort() marks its port as fixture data", () => {
    const { port, isLive } = createCommercePort();
    expect(port.isFixtureData).toBe(true);
    expect(isLive).toBe(false);
  });

  it("guardCommercePort forwards the fixture marker — the GUARDED port is what production wires in", () => {
    const { port: raw, isLive } = createCommercePort();
    // Production wires the GUARDED port into the brain, not the raw one; if the guard drops the marker
    // the honesty suppression in support.ts never fires. Regression lock for the isFixtureData drop.
    expect(guardCommercePort(raw, isLive).isFixtureData).toBe(true);
  });

  it("END TO END: the GUARDED port this deployment actually uses refuses to confirm a demo order", async () => {
    const { port: raw, isLive } = createCommercePort();
    // Wrap exactly as buildServer() does — testing the RAW port green-lit a path production doesn't run
    // (the original illusory lock, which passed even while shoppers were told demo #1042 as fact).
    const port = guardCommercePort(raw, isLive);
    // "shopper-demo" is the brain's fallback shopper id AND the owner of fixture #1042 — the exact
    // combination that made the ownership check pass against demo data.
    const r = await handleSupport(port, "shopper-demo", "where's my order #1042?");

    expect(r.reply).not.toMatch(/I've confirmed order|is on your account/i);
    expect(r.reply).not.toMatch(/in transit/i);
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("account_lookup_unavailable");
  });
});
