import { describe, it, expect } from "vitest";
import { findLapsedSegment, draftWinBack } from "../src/agents/win-back.js";

const ctx = { tenantId: "t1" };
const fakeCommerce = {
  async listCustomersWithLastOrder() {
    return [
      { customerId: "c1", contact: "c1@x.com", lastOrderAt: "2026-05-01T00:00:00Z" }, // lapsed
      { customerId: "c2", contact: "c2@x.com", lastOrderAt: "2026-08-20T00:00:00Z" }, // recent
    ];
  },
} as any;

describe("win-back segment", () => {
  it("selects customers whose last order is older than lapsedDays", async () => {
    const seg = await findLapsedSegment(fakeCommerce, ctx, { lapsedDays: 60, now: "2026-08-23T00:00:00Z" });
    expect(seg.map((s) => s.customerId)).toEqual(["c1"]);
  });

  it("drafts a deterministic message naming the brand", () => {
    const d = draftWinBack([{ customerId: "c1", contact: "c1@x.com", lastOrderAt: "2026-05-01T00:00:00Z" }], "Auria");
    expect(d.body).toContain("Auria");
    expect(d.channel).toBe("email");
  });

  it("is deterministic — same inputs produce the same draft body every call", () => {
    const seg = [{ customerId: "c1", contact: "c1@x.com", lastOrderAt: "2026-05-01T00:00:00Z" }];
    expect(draftWinBack(seg, "Auria").body).toBe(draftWinBack(seg, "Auria").body);
  });
});
