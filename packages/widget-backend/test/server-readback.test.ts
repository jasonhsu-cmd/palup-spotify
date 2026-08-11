import { describe, it, expect, afterEach } from "vitest";
import {
  InMemoryRuntimeStore,
  createAesGcmCrypto,
  createEnvSecrets,
  keyScopeSecretName,
} from "@palup/platform-ports";
import { createMerchantCredentialStore, MERCHANT_CRED_KEY_SCOPE } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// Task 3 (D2 plan): proves buildServer's OWN composition-root wiring — not just the router unit-tested in
// grounding-router.test.ts. Specifically: (a) MERCHANT_CRED_READBACK_ENABLED is read from the environment,
// (b) the read handle it gates is a FULL `MerchantCredentialStore` built as
// `createMerchantCredentialStore(store, createAesGcmCrypto(secrets))` — never the put-only
// `merchantCredentials` sink and never `opts.merchantCredentials` (the composition root does not even
// construct those until later in `buildServer`, so there is no way this test could be accidentally reading
// through them), and (c) that handle's `.read` reaches `createGroundingPort` and is actually consulted on
// the `/chat` path for the SERVER-DERIVED tenant (never a client-supplied one — the request body below
// never mentions a tenant at all).
//
// The credential is provisioned exactly as `merchant-credential-store.test.ts` provisions one: a real
// `createMerchantCredentialStore` over a real `CryptoPort`, with the per-(tenant, scope) key placed in
// `PALUP_SECRETS` under `keyScopeSecretName("MEMORY_ENCRYPTION_KEY", MERCHANT_CRED_KEY_SCOPE)` — the SAME
// env var `buildServer`'s own `createEnvSecrets()` reads, so the write and the server's later read go
// through the identical key material.
//
// The `shopifyFetch` test seam (added to `buildServer`'s opts by this task — there was previously no way
// to inject a fake Storefront fetch) lets the live path be asserted deterministically without a network
// call: the injected fetch records the EXACT creds it was invoked with, which is the strongest possible
// proof that resolveStorefrontCredential's "live" outcome (built from the read-back token, not a
// SecretsPort fallback) reached the Shopify grounding adapter.

const TENANT = "demo";
const TOKEN = "shpat_D2_READBACK_LIVE_TOKEN_0001";
const SHOP_DOMAIN = "acme-readback-test.myshopify.com";
const CRED_KEY_NAME = keyScopeSecretName("MEMORY_ENCRYPTION_KEY", MERCHANT_CRED_KEY_SCOPE);
const KEY_MATERIAL = "readback-test-credential-key-material-32bytes";

interface CanonicalCreds {
  shopDomain: string;
  accessToken: string;
}

/** The grounding cache row `createCachingGroundingPort` (platform-ports/grounding-cache.ts) writes —
 *  fire-and-forget, so poll briefly rather than assume it has landed the instant `/chat` returns. */
async function pollGroundingCache(
  store: InMemoryRuntimeStore,
  tenantId: string,
): Promise<{ ctx: { brandName: string; products: { title: string }[] } } | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await store.get<{ ctx: { brandName: string; products: { title: string }[] } }>(
      { tenantId },
      "grounding",
      "context",
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

const ENV_KEYS = ["SHOPIFY_STORES", "PALUP_SECRETS", "MERCHANT_CRED_READBACK_ENABLED"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("buildServer wires the D2 read handle + MERCHANT_CRED_READBACK_ENABLED into grounding", () => {
  it("flag ON + a custodied credential for a tenant whose shop domain resolves + an injected shopifyFetch → grounding serves that catalog", async () => {
    process.env.SHOPIFY_STORES = JSON.stringify({ [TENANT]: SHOP_DOMAIN });
    process.env.PALUP_SECRETS = JSON.stringify({ [TENANT]: { [CRED_KEY_NAME]: KEY_MATERIAL } });
    process.env.MERCHANT_CRED_READBACK_ENABLED = "true";

    const store = new InMemoryRuntimeStore();
    // Provision the credential exactly the way C1's install flow would (merchant-credential-store.test.ts's
    // own pattern): a real store over a real CryptoPort built from the SAME PALUP_SECRETS the server reads.
    const credStore = createMerchantCredentialStore(store, createAesGcmCrypto(createEnvSecrets()));
    await credStore.put(TENANT, TOKEN, { actor: "test:install-flow" });

    let seenCreds: CanonicalCreds | undefined;
    const app = await buildServer({
      store,
      shopifyFetch: async (creds) => {
        seenCreds = creds;
        return {
          shop: { name: "Acme Read-Back" },
          products: { nodes: [{ id: "gid://shopify/Product/1", title: "Custodied Widget" }] },
        };
      },
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: {
          sessionId: "sess-readback-on",
          message: "hi",
          signals: {},
          idempotencyKey: "readback-on-0",
        },
      });
      expect(res.statusCode).toBe(200);

      // The injected fetch was invoked with the read-back token's OWN creds — proof the live outcome
      // (not the SecretsPort fallback, which was never provisioned for this tenant) reached the adapter.
      expect(seenCreds).toEqual({ shopDomain: SHOP_DOMAIN, accessToken: TOKEN });

      // Never leak the token onto the wire.
      expect(res.body).not.toContain(TOKEN);

      const row = await pollGroundingCache(store, TENANT);
      expect(row).not.toBeNull();
      expect(row!.ctx.brandName).toBe("Acme Read-Back");
      expect(row!.ctx.products.map((p) => p.title)).toContain("Custodied Widget");
    } finally {
      await app.close();
    }
  });

  it("flag OFF → the same tenant + same custodied credential never gets read; serving stays on fixtures", async () => {
    process.env.SHOPIFY_STORES = JSON.stringify({ [TENANT]: SHOP_DOMAIN });
    process.env.PALUP_SECRETS = JSON.stringify({ [TENANT]: { [CRED_KEY_NAME]: KEY_MATERIAL } });
    process.env.MERCHANT_CRED_READBACK_ENABLED = "false";

    const store = new InMemoryRuntimeStore();
    const credStore = createMerchantCredentialStore(store, createAesGcmCrypto(createEnvSecrets()));
    await credStore.put(TENANT, TOKEN, { actor: "test:install-flow" });

    let shopifyFetchCalled = false;
    const app = await buildServer({
      store,
      shopifyFetch: async () => {
        shopifyFetchCalled = true;
        return { shop: { name: "Acme Read-Back" }, products: { nodes: [] } };
      },
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: {
          sessionId: "sess-readback-off",
          message: "hi",
          signals: {},
          idempotencyKey: "readback-off-0",
        },
      });
      expect(res.statusCode).toBe(200);

      // With the flag off, `credReadHandle` is never constructed and `resolveStorefrontCredential` never
      // consults it — even though a valid credential AND a resolvable shop domain both exist. Because no
      // `shopify_storefront_token` was ever provisioned via SecretsPort for this tenant, the pre-D2 path
      // (unchanged) has nothing to serve live, so it falls back to the built-in fixture catalog — proving
      // the credential store was not the source.
      expect(shopifyFetchCalled).toBe(false);

      const row = await pollGroundingCache(store, TENANT);
      expect(row).not.toBeNull();
      expect(row!.ctx.brandName).toBe("Auria"); // the "demo" tenant's built-in fixture (static-grounding.ts)
      expect(row!.ctx.brandName).not.toBe("Acme Read-Back");
    } finally {
      await app.close();
    }
  });
});
