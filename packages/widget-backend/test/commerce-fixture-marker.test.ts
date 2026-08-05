import { describe, it, expect } from "vitest";
import { createCommercePort } from "../src/model.js";
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

  it("END TO END: the port this deployment actually uses refuses to confirm a demo order", async () => {
    const { port } = createCommercePort();
    // "shopper-demo" is the brain's fallback shopper id AND the owner of fixture #1042 — the exact
    // combination that made the ownership check pass against demo data.
    const r = await handleSupport(port, "shopper-demo", "where's my order #1042?");

    expect(r.reply).not.toMatch(/I've confirmed order|is on your account/i);
    expect(r.reply).not.toMatch(/in transit/i);
    expect(r.escalate).toBe(true);
    expect(r.flags).toContain("account_lookup_unavailable");
  });
});
