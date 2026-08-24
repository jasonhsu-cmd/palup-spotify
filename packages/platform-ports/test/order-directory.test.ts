import { describe, expect, it } from "vitest";
import { SandboxOrderDirectory, type MerchantOrderSummary } from "../src/commerce-port.js";

const o = (id: string): MerchantOrderSummary => ({
  id,
  orderNumber: `#${id}`,
  placedAt: "2026-08-20T00:00:00Z",
  totalUsd: 42,
  currency: "USD",
  financialStatus: "paid",
  fulfillmentStatus: "unfulfilled",
  customerLabel: "Guest",
});

describe("SandboxOrderDirectory", () => {
  it("returns only the requested tenant's orders (isolation)", async () => {
    const dir = new SandboxOrderDirectory({ "tenant-a": [o("1"), o("2")], "tenant-b": [o("9")] });
    expect(await dir.listOrders({ tenantId: "tenant-a" })).toHaveLength(2);
    expect((await dir.listOrders({ tenantId: "tenant-b" }))[0]!.id).toBe("9");
  });

  it("returns an empty list for an unseeded tenant (never another tenant's data)", async () => {
    const dir = new SandboxOrderDirectory({ "tenant-a": [o("1")] });
    expect(await dir.listOrders({ tenantId: "unknown" })).toEqual([]);
  });

  it("honors opts.limit", async () => {
    const dir = new SandboxOrderDirectory({ t: [o("1"), o("2"), o("3")] });
    expect(await dir.listOrders({ tenantId: "t" }, { limit: 2 })).toHaveLength(2);
  });

  it("defaults to an empty directory", async () => {
    expect(await new SandboxOrderDirectory().listOrders({ tenantId: "t" })).toEqual([]);
  });
});
