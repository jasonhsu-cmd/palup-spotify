import { describe, it, expect } from "vitest";
import type { MerchantRegistryPort, NewMerchant } from "../merchant-registry-port.js";

// Port contract (ADR-0001): every MerchantRegistryPort adapter (the in-memory one that ships with the
// port, the Postgres one that is the FIRST real caller's dependency) MUST pass this, so adapters stay
// behavior-equivalent and the engine stays swappable (ADR-0004). Import into an adapter's test and call
// runMerchantRegistryPortContract(() => makeMyAdapter()).
//
// `makeAdapter` must return a FRESH, EMPTY registry each call. Async so a Postgres adapter can
// truncate/migrate a scratch schema per test.
//
// Two properties this suite is really about, because they are the two things env-var tenancy
// (WIDGET_EMBED_KEYS / SHOPIFY_STORES, see the port's own header) cannot do safely:
//   1. CROSS-TENANT lookup — you resolve shopDomain/embedKey -> tenantId BEFORE you know the tenant,
//      and the reverse index must be unambiguous (one shop domain = exactly one tenant, ever).
//   2. REVOCATION — a suspended/uninstalled merchant must become INERT by DEFAULT, so a caller that
//      forgets to check `status` fails closed (null) instead of serving a revoked merchant.
export function runMerchantRegistryPortContract(
  makeAdapter: () => MerchantRegistryPort | Promise<MerchantRegistryPort>,
): void {
  const ACME: NewMerchant = {
    tenantId: "acme",
    shopDomain: "acme.myshopify.com",
    embedKey: "pk-acme",
    region: "us",
  };
  const BETA: NewMerchant = {
    tenantId: "beta",
    shopDomain: "beta.myshopify.com",
    embedKey: "pk-beta",
    region: "eu",
  };

  describe("MerchantRegistryPort contract", () => {
    // --- create + the three lookups (the env-var registries this replaces) ---

    it("create then lookupByTenantId round-trips the record", async () => {
      const r = await makeAdapter();
      const created = await r.create(ACME);
      expect(created.tenantId).toBe("acme");
      expect(await r.lookupByTenantId("acme")).toEqual(created);
    });

    it("create then lookupByShopDomain resolves the tenant WITHOUT knowing it first (the cross-tenant read)", async () => {
      const r = await makeAdapter();
      const created = await r.create(ACME);
      expect(await r.lookupByShopDomain("acme.myshopify.com")).toEqual(created);
    });

    it("create then lookupByEmbedKey resolves the tenant WITHOUT knowing it first (replaces WIDGET_EMBED_KEYS)", async () => {
      const r = await makeAdapter();
      const created = await r.create(ACME);
      expect(await r.lookupByEmbedKey("pk-acme")).toEqual(created);
    });

    it("a new merchant is `active` and carries every field env-var tenancy carries today", async () => {
      const r = await makeAdapter();
      const created = await r.create({ ...ACME, plan: "growth", groundingMode: "general" });
      expect(created.status).toBe("active");
      expect(created.shopDomain).toBe("acme.myshopify.com");
      expect(created.embedKey).toBe("pk-acme");
      expect(created.region).toBe("us");
      expect(created.groundingMode).toBe("general");
      expect(created.plan).toBe("growth");
      expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("groundingMode defaults to `full` (matches the MERCHANT_GROUNDING_MODE default it replaces)", async () => {
      const r = await makeAdapter();
      expect((await r.create(ACME)).groundingMode).toBe("full");
    });

    // --- absent reads are null, never another tenant's row (the repo's recurring defect class) ---

    it("every lookup returns null for an unknown key — never a fallback merchant", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      expect(await r.lookupByTenantId("nobody")).toBeNull();
      expect(await r.lookupByShopDomain("nobody.myshopify.com")).toBeNull();
      expect(await r.lookupByEmbedKey("pk-nobody")).toBeNull();
    });

    it("two merchants never leak into each other's lookups", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await r.create(BETA);
      expect((await r.lookupByShopDomain("acme.myshopify.com"))?.tenantId).toBe("acme");
      expect((await r.lookupByShopDomain("beta.myshopify.com"))?.tenantId).toBe("beta");
      expect((await r.lookupByEmbedKey("pk-acme"))?.tenantId).toBe("acme");
      expect((await r.lookupByEmbedKey("pk-beta"))?.tenantId).toBe("beta");
      expect((await r.lookupByTenantId("beta"))?.region).toBe("eu");
    });

    it("a blank identifier is rejected on every lookup — an empty key is a cross-tenant wildcard, not a query", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await expect(r.lookupByTenantId("")).rejects.toThrow();
      await expect(r.lookupByShopDomain("  ")).rejects.toThrow();
      await expect(r.lookupByEmbedKey("")).rejects.toThrow();
    });

    it("a shopDomain lookup is case-insensitive (a host is; two case-variant rows would be two tenants owning one store)", async () => {
      const r = await makeAdapter();
      const created = await r.create({ ...ACME, shopDomain: "Acme.MyShopify.com" });
      expect(created.shopDomain).toBe("acme.myshopify.com"); // normalized on write
      expect((await r.lookupByShopDomain("ACME.MYSHOPIFY.COM"))?.tenantId).toBe("acme");
      expect((await r.lookupByShopDomain("acme.myshopify.com"))?.tenantId).toBe("acme");
    });

    it("an embedKey lookup is case-SENSITIVE (it is an opaque publishable identifier, not a host)", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      expect(await r.lookupByEmbedKey("PK-ACME")).toBeNull();
    });

    // --- uniqueness: what makes the reverse index sound ---

    it("create rejects a duplicate tenantId", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await expect(r.create({ ...ACME, shopDomain: "other.myshopify.com", embedKey: "pk-other" })).rejects.toThrow();
    });

    it("create rejects a duplicate shopDomain — one shop can never map to two tenants", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await expect(r.create({ ...BETA, shopDomain: "acme.myshopify.com" })).rejects.toThrow();
      // …including a case-variant of it, which the normalization above makes the SAME domain.
      await expect(r.create({ ...BETA, shopDomain: "ACME.myshopify.com" })).rejects.toThrow();
    });

    it("create rejects a duplicate embedKey — a shared key would mint widget tokens for the wrong tenant", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await expect(r.create({ ...BETA, embedKey: "pk-acme" })).rejects.toThrow();
    });

    it("create rejects a blank tenantId / shopDomain / embedKey (fail closed, no unaddressable row)", async () => {
      const r = await makeAdapter();
      await expect(r.create({ ...ACME, tenantId: "" })).rejects.toThrow();
      await expect(r.create({ ...ACME, shopDomain: "   " })).rejects.toThrow();
      await expect(r.create({ ...ACME, embedKey: "" })).rejects.toThrow();
    });

    it("create rejects an unknown region rather than silently defaulting to `us` (no implicit residency)", async () => {
      const r = await makeAdapter();
      await expect(r.create({ ...ACME, region: "atlantis" as NewMerchant["region"] })).rejects.toThrow();
      await expect(r.create({ ...ACME, region: undefined as unknown as NewMerchant["region"] })).rejects.toThrow();
    });

    // --- revocation: the capability that does not exist today at all ---

    it("an uninstalled merchant is INERT: every lookup resolves to null by default", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      const revoked = await r.setStatus("acme", "uninstalled", { reason: "app/uninstalled webhook" });
      expect(revoked.status).toBe("uninstalled");
      expect(revoked.statusReason).toBe("app/uninstalled webhook");
      expect(await r.lookupByTenantId("acme")).toBeNull();
      expect(await r.lookupByShopDomain("acme.myshopify.com")).toBeNull();
      expect(await r.lookupByEmbedKey("pk-acme")).toBeNull();
    });

    it("a suspended merchant is INERT the same way (non-payment / abuse hold)", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await r.setStatus("acme", "suspended", { reason: "billing hold" });
      expect(await r.lookupByEmbedKey("pk-acme")).toBeNull();
    });

    it("an inactive merchant is still readable with an EXPLICIT includeInactive (support/audit/erasure paths)", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await r.setStatus("acme", "uninstalled");
      const byTenant = await r.lookupByTenantId("acme", { includeInactive: true });
      expect(byTenant?.status).toBe("uninstalled");
      expect((await r.lookupByShopDomain("acme.myshopify.com", { includeInactive: true }))?.status).toBe("uninstalled");
      expect((await r.lookupByEmbedKey("pk-acme", { includeInactive: true }))?.status).toBe("uninstalled");
    });

    it("revocation is REVERSIBLE: reactivating restores servability (NN#5 needs a reversal path)", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await r.setStatus("acme", "uninstalled");
      const back = await r.setStatus("acme", "active", { reason: "reinstalled" });
      expect(back.status).toBe("active");
      expect((await r.lookupByShopDomain("acme.myshopify.com"))?.tenantId).toBe("acme");
    });

    it("setStatus on an unknown tenant throws — it never creates a merchant as a side effect", async () => {
      const r = await makeAdapter();
      await expect(r.setStatus("ghost", "uninstalled")).rejects.toThrow();
      expect(await r.lookupByTenantId("ghost", { includeInactive: true })).toBeNull();
    });

    it("setStatus rejects an unknown status value", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await expect(r.setStatus("acme", "deleted" as "active")).rejects.toThrow();
      expect((await r.lookupByTenantId("acme"))?.status).toBe("active"); // unchanged
    });

    it("a reinstall of a REVOKED shop must reactivate, not create a second tenant for the same shop", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await r.setStatus("acme", "uninstalled");
      // The domain stays claimed while the row exists: a fresh tenant on the same shop would strand the
      // first tenant's data in a namespace nothing reads (and hand its shop to a new tenantId).
      await expect(r.create({ ...ACME, tenantId: "acme-2", embedKey: "pk-acme-2" })).rejects.toThrow();
    });

    // --- update: the fields that are process-wide env today ---

    it("update changes region/groundingMode/plan and leaves status alone", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      const updated = await r.update("acme", { region: "eu", groundingMode: "off", plan: "scale" });
      expect(updated.region).toBe("eu");
      expect(updated.groundingMode).toBe("off");
      expect(updated.plan).toBe("scale");
      expect(updated.status).toBe("active");
      expect((await r.lookupByTenantId("acme"))?.region).toBe("eu");
    });

    it("update rejects an unknown tenant and an invalid region", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await expect(r.update("ghost", { region: "eu" })).rejects.toThrow();
      await expect(r.update("acme", { region: "atlantis" as NewMerchant["region"] })).rejects.toThrow();
      expect((await r.lookupByTenantId("acme"))?.region).toBe("us"); // unchanged
    });

    // --- portability (CLAUDE.md §3 NN#3): no Shopify type crosses this port ---

    it("shopDomain is just a string: a NON-Shopify host registers and resolves exactly the same", async () => {
      const r = await makeAdapter();
      await r.create({ tenantId: "woo", shopDomain: "shop.example.com", embedKey: "pk-woo", region: "uk" });
      expect((await r.lookupByShopDomain("shop.example.com"))?.tenantId).toBe("woo");
    });

    // --- primaryDomain (custom-domain CSP support) ---

    it("create/update round-trips primaryDomain, normalized (trim + lowercase)", async () => {
      const r = await makeAdapter();
      const created = await r.create({ ...ACME, primaryDomain: "  Shop.Example.com  " });
      expect(created.primaryDomain).toBe("shop.example.com");
      expect((await r.lookupByTenantId("acme"))?.primaryDomain).toBe("shop.example.com");

      const updated = await r.update("acme", { primaryDomain: "New.Example.com" });
      expect(updated.primaryDomain).toBe("new.example.com");
      expect((await r.lookupByShopDomain("acme.myshopify.com"))?.primaryDomain).toBe("new.example.com");
    });

    it("a merchant with no primaryDomain configured has the field ABSENT — not null, not empty string " +
      "(so a resolver can tell 'never configured' from 'explicitly cleared')", async () => {
      const r = await makeAdapter();
      const created = await r.create(ACME);
      expect(Object.hasOwn(created, "primaryDomain")).toBe(false);
      expect((await r.lookupByTenantId("acme"))?.primaryDomain).toBeUndefined();
    });

    it("create rejects a malformed primaryDomain (space, slash, scheme, semicolon, CR/LF) and creates NOTHING", async () => {
      const r = await makeAdapter();
      for (const bad of [
        "shop example.com",
        "shop.example.com/path",
        "https://shop.example.com",
        "shop.example.com;drop",
        "shop.example.com\r\nSet-Cookie:x",
      ]) {
        await expect(r.create({ ...ACME, primaryDomain: bad })).rejects.toThrow();
      }
      expect(await r.lookupByTenantId("acme", { includeInactive: true })).toBeNull();
    });

    it("update rejects a malformed primaryDomain and leaves the row untouched", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      await expect(r.update("acme", { primaryDomain: "https://evil.com" })).rejects.toThrow();
      await expect(r.update("acme", { primaryDomain: "evil.com; DROP" })).rejects.toThrow();
      expect((await r.lookupByTenantId("acme"))?.primaryDomain).toBeUndefined();
    });

    // Security follow-up: write/read alignment. Before this, `normalizePrimaryDomain` (the write-side gate)
    // was MORE PERMISSIVE than `HOSTNAME_SHAPE` (the read-side gate widget-backend's server.ts applies
    // immediately before CSP interpolation) — so a wildcard, an underscore, a leading/trailing hyphen, or a
    // bare single-label value could be WRITTEN here and then silently dropped (never widen the CSP) at read
    // time. That is a confusing, deferred failure an operator only discovers days later on a support
    // ticket, instead of an immediate, loud rejection at create/update/CLI time. These shapes must now fail
    // FAST, at the write gate, identically to how the read gate already refuses them.
    it("create rejects a wildcard, an underscore, a leading/trailing hyphen, and a bare single-label value " +
      "— the SAME shapes the read-side HOSTNAME_SHAPE guard rejects before CSP interpolation — and creates NOTHING", async () => {
      const r = await makeAdapter();
      for (const bad of [
        "*.shop.example.com", // wildcard — never valid in a literal frame-ancestors host
        "shop_example.com", // underscore — not a valid hostname label character
        "-shop.example.com", // leading hyphen on a label
        "shop-.example.com", // trailing hyphen on a label
        "localhost", // bare single-label — not a dotted hostname
      ]) {
        await expect(r.create({ ...ACME, primaryDomain: bad })).rejects.toThrow();
      }
      expect(await r.lookupByTenantId("acme", { includeInactive: true })).toBeNull();
    });

    it("update rejects the same newly-tightened shapes and leaves the row untouched", async () => {
      const r = await makeAdapter();
      await r.create(ACME);
      for (const bad of ["*.evil.com", "evil_domain.com", "-evil.com", "evil-.com", "evil"]) {
        await expect(r.update("acme", { primaryDomain: bad })).rejects.toThrow();
      }
      expect((await r.lookupByTenantId("acme"))?.primaryDomain).toBeUndefined();
    });

    it("currently-valid hostnames (including internal hyphens and multi-level subdomains) stay valid", async () => {
      const r = await makeAdapter();
      let i = 0;
      for (const ok of ["shop.example.com", "my-shop.example.co.uk", "a.b.c.example.com"]) {
        i += 1;
        const created = await r.create({
          tenantId: `valid-host-${i}`,
          shopDomain: `valid-host-${i}.myshopify.com`,
          embedKey: `pk-valid-host-${i}`,
          region: "us",
          primaryDomain: ok,
        });
        expect(created.primaryDomain).toBe(ok.toLowerCase());
      }
    });

    // --- listActive: the governed cross-tenant enumeration (ADR-0023) ---

    it("listActive paginates active-only merchants by cursor, secret-free, in tenantId order", async () => {
      const r = await makeAdapter();
      await r.create({ tenantId: "t-a", shopDomain: "a.myshopify.com", embedKey: "pk-a", region: "us" });
      await r.create({ tenantId: "t-b", shopDomain: "b.myshopify.com", embedKey: "pk-b", region: "us" });
      await r.setStatus("t-b", "uninstalled");
      await r.create({ tenantId: "t-c", shopDomain: "c.myshopify.com", embedKey: "pk-c", region: "us" });
      await r.create({ tenantId: "t-d", shopDomain: "d.myshopify.com", embedKey: "pk-d", region: "us" });

      const page1 = await r.listActive({ limit: 2 });
      expect(page1.items).toEqual([
        { tenantId: "t-a", shopDomain: "a.myshopify.com", status: "active" },
        { tenantId: "t-c", shopDomain: "c.myshopify.com", status: "active" },
      ]);
      expect(page1.nextCursor).toBe("t-c");

      const page2 = await r.listActive({ cursor: page1.nextCursor, limit: 2 });
      expect(page2.items).toEqual([{ tenantId: "t-d", shopDomain: "d.myshopify.com", status: "active" }]);
      expect(page2.nextCursor).toBeUndefined();

      // never the uninstalled tenant, and never a field beyond the {tenantId, shopDomain, status} allowlist
      for (const item of [...page1.items, ...page2.items]) {
        expect(item.tenantId).not.toBe("t-b");
        expect(Object.keys(item).sort()).toEqual(["shopDomain", "status", "tenantId"]);
      }
    });

    it("listActive on an empty/all-inactive registry returns an empty page with no nextCursor", async () => {
      const r = await makeAdapter();
      expect(await r.listActive()).toEqual({ items: [] });
      await r.create(ACME);
      await r.setStatus("acme", "uninstalled");
      expect(await r.listActive()).toEqual({ items: [] });
    });

    // --- callers cannot mutate stored state by reference (mirrors VectorPort's clone discipline) ---

    it("returned records are copies — mutating one does not change the registry", async () => {
      const r = await makeAdapter();
      const created = await r.create(ACME);
      created.status = "uninstalled";
      created.shopDomain = "hijacked.myshopify.com";
      expect((await r.lookupByTenantId("acme"))?.status).toBe("active");
      expect((await r.lookupByShopDomain("acme.myshopify.com"))?.tenantId).toBe("acme");
    });
  });
}
