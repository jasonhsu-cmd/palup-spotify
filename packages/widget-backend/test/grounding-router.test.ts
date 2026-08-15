import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { createGroundingPort, GroundingCredentialUnreadableError } from "../src/model.js";

// D2: createGroundingPort's router now consults resolveStorefrontCredential's three-way outcome
// (live/fixtures/refuse) instead of resolveShopifyStore's boolean creds/no-creds. `refuse` must
// throw distinctly — never silently serve the fixture catalog under a merchant's own brand.
const store = () => new InMemoryRuntimeStore();
const secrets = { get: async () => undefined } as any;

describe("createGroundingPort — credential read-back routing (D2)", () => {
  it("readback ON + found → serves the merchant's real catalog via the injected fetch", async () => {
    const g = createGroundingPort(store(), secrets, {
      readbackEnabled: true,
      credRead: async () => ({ status: "found", token: "shpat_live" }),
      shopDomainFor: async () => "acme.myshopify.com",
      shopifyFetch: async () => ({ shop: { name: "Acme" }, products: { nodes: [{ id: "1", title: "Widget" }] } }),
    });
    const ctx = await g.getContext("acme");
    expect(ctx.brandName).toBe("Acme");
    expect(ctx.products.map((p) => p.title)).toContain("Widget");
  });

  it("readback ON + unreadable → throws GroundingCredentialUnreadableError (router does NOT serve fixtures)", async () => {
    // Assert via the caching wrapper's degrade behavior: a cold failure becomes safe-empty, never the
    // fixture catalog — that would silently hand the tenant's shoppers a wrong brand.
    //
    // DISCRIMINATING ON PURPOSE: tenant "demo" is used here, NOT "acme". "acme" has no entry in
    // StaticGroundingAdapter's FIXTURES map, so fixtures.getContext("acme") ALSO returns
    // {brandName:"this store", products:[]} — byte-identical to safeEmpty in the two fields this test
    // asserts. A `refuse → fixtures` regression at model.ts's `if (outcome.status === "refuse") throw …`
    // (were it ever changed to fall through to `fixtures.getContext(tenantId)` instead) would therefore
    // survive the suite with "acme": both the correct and the buggy path produce the same observable
    // result. "demo" DOES have a fixture (AURIA, brandName "Auria", 12 products), so the same regression
    // surfaces here as brandName:"Auria" / products.length:12 — provably distinguishable from the correct
    // refuse→throw→safeEmpty outcome asserted below. (Proven empirically: applying that exact mutation to
    // model.ts and re-running this test turns it red — see the PR/commit history for the verification.)
    const st = store();
    const g = createGroundingPort(st, secrets, {
      readbackEnabled: true,
      credRead: async () => ({ status: "unreadable", reason: "undecryptable" }),
      shopDomainFor: async () => "demo-store.myshopify.com",
    });
    const ctx = await g.getContext("demo");
    expect(ctx.brandName).toBe("this store"); // safeEmpty brandName — NOT "Auria" (the demo fixture)
    expect(ctx.products).toEqual([]); // safe-empty — NOT the AURIA fixture catalog

    // A throw is never cached: createCachingGroundingPort only writes to the store on a successful
    // `inner.getContext` (grounding-cache.ts). Read the store directly — no row means the refusal never
    // got laundered into a cache entry a later request could re-serve. A `refuse → fixtures` bug WOULD
    // write a row here (a normal successful getContext result), so this assertion is itself part of the
    // mutation-catching coverage, independent of the brandName/products checks above.
    const cached = await st.get({ tenantId: "demo" }, "grounding", "context");
    expect(cached).toBeNull();
  });

  it("readback OFF → unchanged SecretsPort path (missing token → fixtures for demo)", async () => {
    const g = createGroundingPort(
      store(),
      { get: async (_t: string, _n: string) => undefined } as any,
      {
        readbackEnabled: false,
        credRead: async () => ({ status: "unreadable", reason: "undecryptable" }),
        shopDomainFor: async () => "demo-store.myshopify.com",
      },
    );
    const ctx = await g.getContext("demo");
    expect(ctx.brandName).not.toBe("this store"); // demo resolves the AURIA fixture, credRead never consulted
  });

  it("GroundingCredentialUnreadableError carries the refusal reason and a distinct name", () => {
    const err = new GroundingCredentialUnreadableError("malformed-record");
    expect(err.name).toBe("GroundingCredentialUnreadableError");
    expect(err.reason).toBe("malformed-record");
    expect(err).toBeInstanceOf(Error);
  });
});

// S2 — getShell mirrors getContext's routing exactly (live Shopify shell / refuse / fixtures), just
// over the brand+policy-only shape. One test per branch, same fixtures/discriminating-tenant choices
// as the getContext cases above so a `getShell` regression is caught the same way a `getContext` one is.
describe("createGroundingPort — getShell routing (S2)", () => {
  it("readback ON + found → serves the merchant's real SHELL via the injected shell fetch", async () => {
    const g = createGroundingPort(store(), secrets, {
      readbackEnabled: true,
      credRead: async () => ({ status: "found", token: "shpat_live" }),
      shopDomainFor: async () => "acme.myshopify.com",
      // Deliberately a DIFFERENT fake than shopifyFetch/shopifyShellFetch's sibling — proves getShell
      // never touches the (paginated) catalog fetch, only the shell-only one.
      shopifyFetch: async () => { throw new Error("getShell must never call the catalog fetch"); },
      shopifyShellFetch: async () => ({ shop: { name: "Acme", refundPolicy: { body: "30 days" }, shippingPolicy: { body: "free" } } }),
    });
    const shell = await g.getShell("acme");
    expect(shell.tenantId).toBe("acme");
    expect(shell.brandName).toBe("Acme");
    expect(shell.policy).toEqual({ returns: "30 days", shipping: "free" });
    expect("products" in (shell as object)).toBe(false);
  });

  it("readback ON + unreadable → fails CLOSED to a safe-empty shell (router does NOT serve fixtures)", async () => {
    // Same discriminating-tenant reasoning as the getContext case above: "demo" has a real fixture
    // (brandName "Auria"), so a `refuse → fixtures` regression is provably distinguishable from the
    // correct refuse→throw→safe-empty-shell outcome asserted below.
    const g = createGroundingPort(store(), secrets, {
      readbackEnabled: true,
      credRead: async () => ({ status: "unreadable", reason: "undecryptable" }),
      shopDomainFor: async () => "demo-store.myshopify.com",
    });
    const shell = await g.getShell("demo");
    expect(shell.tenantId).toBe("demo");
    expect(shell.brandName).toBe("this store"); // safe-empty brandName — NOT "Auria" (the demo fixture)
    expect(shell.policy).toEqual({ returns: "", shipping: "" }); // safe-empty policy — NOT AURIA's real policy
  });

  it("readback OFF → unchanged SecretsPort path (missing token → fixtures SHELL for demo)", async () => {
    const g = createGroundingPort(
      store(),
      { get: async (_t: string, _n: string) => undefined } as any,
      {
        readbackEnabled: false,
        credRead: async () => ({ status: "unreadable", reason: "undecryptable" }),
        shopDomainFor: async () => "demo-store.myshopify.com",
      },
    );
    const shell = await g.getShell("demo");
    expect(shell.brandName).not.toBe("this store"); // demo resolves the AURIA fixture's shell, credRead never consulted
    expect(shell.brandName).toBe("Auria");
  });
});
