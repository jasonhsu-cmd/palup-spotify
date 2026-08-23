import { describe, it, expect } from "vitest";
import { SandboxCustomerDirectory } from "../src/commerce-port.js";

// WB review fix (Minor): SandboxCustomerDirectory must honor ctx.tenantId, not hand every tenant
// the same fixture list — a test/staging double must not be the one place that leaks across tenants.
describe("SandboxCustomerDirectory", () => {
  it("returns only the seeded tenant's customers", async () => {
    const dir = new SandboxCustomerDirectory({
      "merchant-a": [{ customerId: "c1", contact: "c1@x.com", lastOrderAt: "2026-05-01T00:00:00Z" }],
      "merchant-b": [{ customerId: "c2", contact: "c2@x.com", lastOrderAt: "2026-05-01T00:00:00Z" }],
    });
    expect((await dir.listCustomersWithLastOrder({ tenantId: "merchant-a" })).map((c) => c.customerId)).toEqual(["c1"]);
    expect((await dir.listCustomersWithLastOrder({ tenantId: "merchant-b" })).map((c) => c.customerId)).toEqual(["c2"]);
  });

  it("returns an empty list for an unseeded/unknown tenant — never another tenant's fixtures", async () => {
    const dir = new SandboxCustomerDirectory({
      "merchant-a": [{ customerId: "c1", contact: "c1@x.com", lastOrderAt: "2026-05-01T00:00:00Z" }],
    });
    expect(await dir.listCustomersWithLastOrder({ tenantId: "merchant-z" })).toEqual([]);
  });
});
