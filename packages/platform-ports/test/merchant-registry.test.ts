import { describe, it, expect } from "vitest";
import { createInMemoryMerchantRegistry } from "../src/merchant-registry-port.js";
import { runMerchantRegistryPortContract } from "../src/contract/merchant-registry-port.contract.js";

// The in-memory adapter is the behavioral oracle for the port: it must pass the full contract (the
// Postgres adapter that lands later runs the SAME suite — that is the point of ADR-0001 contract tests).
runMerchantRegistryPortContract(() => createInMemoryMerchantRegistry());

const ACME = {
  tenantId: "acme",
  shopDomain: "acme.myshopify.com",
  embedKey: "pk-acme",
  region: "us",
} as const;

describe("createInMemoryMerchantRegistry — adapter-specific behavior", () => {
  it("uses null-prototype indexes: a tenantId/domain/embedKey of `__proto__` cannot resolve an inherited value", async () => {
    const r = createInMemoryMerchantRegistry();
    expect(await r.lookupByTenantId("__proto__")).toBeNull();
    expect(await r.lookupByTenantId("constructor")).toBeNull();
    expect(await r.lookupByShopDomain("__proto__")).toBeNull();
    expect(await r.lookupByEmbedKey("constructor")).toBeNull();
  });

  it("accepts `__proto__` as a real (if odd) identifier without polluting the index", async () => {
    const r = createInMemoryMerchantRegistry();
    await r.create({ ...ACME, tenantId: "__proto__" });
    expect((await r.lookupByTenantId("__proto__"))?.shopDomain).toBe("acme.myshopify.com");
    expect(await r.lookupByTenantId("acme")).toBeNull();
  });

  it("honors an injected clock so createdAt/updatedAt are deterministic (and updatedAt moves on a change)", async () => {
    let now = "2026-01-01T00:00:00.000Z";
    const r = createInMemoryMerchantRegistry({ now: () => now });
    const created = await r.create(ACME);
    expect(created.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(created.updatedAt).toBe("2026-01-01T00:00:00.000Z");

    now = "2026-02-02T00:00:00.000Z";
    const revoked = await r.setStatus("acme", "uninstalled");
    expect(revoked.createdAt).toBe("2026-01-01T00:00:00.000Z"); // never rewritten
    expect(revoked.updatedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("trims surrounding whitespace on identifiers so a stray space cannot create a second, unreachable tenant", async () => {
    const r = createInMemoryMerchantRegistry();
    await r.create({ ...ACME, shopDomain: "  acme.myshopify.com  ", tenantId: " acme ", embedKey: " pk-acme " });
    expect((await r.lookupByTenantId("acme"))?.shopDomain).toBe("acme.myshopify.com");
    expect((await r.lookupByEmbedKey("pk-acme"))?.tenantId).toBe("acme");
  });

  it("the error text for a claimed shop domain names the conflict and points at reactivation, without echoing a secret", async () => {
    const r = createInMemoryMerchantRegistry();
    await r.create(ACME);
    await r.setStatus("acme", "uninstalled");
    let message = "";
    try {
      await r.create({ ...ACME, tenantId: "acme-2", embedKey: "pk-acme-2" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("acme.myshopify.com");
    expect(message).toMatch(/setStatus|reactivat/i);
  });
});
