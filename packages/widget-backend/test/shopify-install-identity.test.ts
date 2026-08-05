import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  ADMIN_API_VERSION,
  DELEGATE_SCOPES_DEFAULT,
  OAUTH_TIMESTAMP_TOLERANCE_SECONDS,
  buildInstallAuthorizeUrl,
  createDelegateAccessToken,
  exchangeInstallCode,
  grantedScopesCover,
  isValidShopDomain,
  normalizeOauthQuery,
  signOauthQuery,
  timestampWithinTolerance,
  verifyOauthHmac,
} from "../src/shopify-install-identity.js";

// C1 — the Shopify install/OAuth WIRE FORMAT adapter. Every assertion here is traceable to a primary
// source cited in the file under test; the citations (URL + API version + retrieval date) live there.
//
// The HMAC tests follow the discipline shopify-shopper-identity.test.ts set for App-Proxy signatures: our
// signer is checked against an INDEPENDENT, from-the-spec transcription of the documented algorithm. That
// catches drift between our implementation and the documented steps. It is NOT proof our bytes match
// Shopify's LIVE output — both sides share one reading of the spec. True conformance needs a GOLDEN VECTOR
// (a real (secret, query, hmac) triple captured from an actual install), which this repo does not have.

const SECRET = "hush-this-is-the-app-client-secret";
const SHOP = "acme-store.myshopify.com";

/**
 * INDEPENDENT transcription of Shopify's documented admin/OAuth HMAC message construction, written from
 * the spec text rather than by calling the code under test:
 *   1. drop `hmac` and `signature`
 *   2. sort the remaining keys alphabetically
 *   3. serialise as application/x-www-form-urlencoded with `+` rendered as %20
 *   4. HMAC-SHA256 with the app's client secret, hex
 */
function specHmac(secret: string, query: Record<string, string | string[]>): string {
  const keys = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort((a, b) => a.localeCompare(b));
  const sp = new URLSearchParams();
  for (const k of keys) {
    const v = query[k];
    sp.append(k, Array.isArray(v) ? v.join(",") : v);
  }
  return createHmac("sha256", secret).update(sp.toString().replace(/\+/g, "%20")).digest("hex");
}

function signed(query: Record<string, string | string[]>): Record<string, string | string[]> {
  return { ...query, hmac: specHmac(SECRET, query) };
}

describe("shopify-install-identity — shop domain validation", () => {
  it("accepts a well-formed myshopify host, case-insensitively", () => {
    expect(isValidShopDomain("acme-store.myshopify.com")).toBe(true);
    expect(isValidShopDomain("ACME-STORE.MYSHOPIFY.COM")).toBe(true);
    expect(isValidShopDomain("a1.myshopify.com")).toBe(true);
  });

  it("REFUSES everything else — no normalising, no stripping, no guessing", () => {
    for (const bad of [
      "",
      "   ",
      "myshopify.com", //                        no subdomain
      "-acme.myshopify.com", //                  must start alphanumeric
      "acme.myshopify.com.", //                  trailing DNS root dot (the gap B1 reported — refused HERE)
      "acme.myshopify.com.evil.test", //         suffix-extension
      "evil.test/acme.myshopify.com", //         path smuggling
      "acme.myshopify.com:8443", //              port
      "acme.myshopify.com/admin", //             path
      "https://acme.myshopify.com", //           scheme
      "acme@evil.test", //                       userinfo
      "acme.myshopify.com?x=1",
      "acme.myshopify.com#f",
      "acme_store.myshopify.com", //             underscore is not a legal label char
      "acme.shopify.com",
      "acme.myshopify.co",
      "sub.acme.myshopify.com", //               only ONE label before the suffix
      "acme.myshopify.com\n", //                 trailing newline (a $-anchored regex without \n care)
      "acme.myshopify.com\nevil.test",
      "\nacme.myshopify.com",
      "acme.myshopify.com ",
      " acme.myshopify.com",
      "__proto__.myshopify.com", //              legal-looking but underscores ⇒ refused
      undefined,
      null,
      42,
      {},
      ["acme.myshopify.com"],
    ]) {
      expect(isValidShopDomain(bad as unknown), `expected refusal for ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("shopify-install-identity — OAuth HMAC", () => {
  it("matches an independent from-the-spec transcription of the documented algorithm", () => {
    const q = { code: "0907a61c", shop: SHOP, state: "0.678", timestamp: "1337178173" };
    expect(signOauthQuery(SECRET, q)).toBe(specHmac(SECRET, q));
  });

  it("verifies the documented callback parameter set", () => {
    const q = signed({ code: "abc", host: "YWRtaW4uc2hvcGlmeS5jb20", shop: SHOP, state: "st", timestamp: "1337178173" });
    expect(verifyOauthHmac(SECRET, q)).toBe(true);
  });

  it("EXCLUDES both `hmac` and `signature` from the signed message", () => {
    // Shopify's own validator strips both; a `signature` that changed the digest would let an attacker
    // grind the message. Adding `signature` must NOT change what we hash.
    const base = { code: "abc", shop: SHOP, state: "st", timestamp: "1337178173" };
    expect(signOauthQuery(SECRET, base)).toBe(signOauthQuery(SECRET, { ...base, signature: "whatever" }));
  });

  it("is order-independent (the message is sorted) but content-sensitive", () => {
    const a = { code: "abc", shop: SHOP, state: "st", timestamp: "1" };
    const b = { timestamp: "1", state: "st", shop: SHOP, code: "abc" };
    expect(signOauthQuery(SECRET, a)).toBe(signOauthQuery(SECRET, b));
    expect(signOauthQuery(SECRET, { ...a, code: "abd" })).not.toBe(signOauthQuery(SECRET, a));
  });

  it("percent-encodes the message (URLSearchParams, `+` rendered as %20) — a space is not a plus", () => {
    const q = { a: "x y", shop: SHOP, timestamp: "1" };
    expect(signOauthQuery(SECRET, q)).toBe(specHmac(SECRET, q));
    // Belt and braces: prove the encoding actually differs from the naive `+` form, so this test would
    // fail if the implementation dropped the replace().
    const naive = createHmac("sha256", SECRET)
      .update(new URLSearchParams({ a: "x y", shop: SHOP, timestamp: "1" }).toString())
      .digest("hex");
    expect(signOauthQuery(SECRET, q)).not.toBe(naive);
  });

  it("joins a REPEATED parameter with a comma (Shopify's own normalisation)", () => {
    const q = { ids: ["1", "2"], shop: SHOP, timestamp: "1" };
    expect(signOauthQuery(SECRET, q)).toBe(specHmac(SECRET, q));
    expect(verifyOauthHmac(SECRET, signed(q))).toBe(true);
  });

  it("REJECTS a tampered, truncated, extended, re-cased or absent hmac", () => {
    const q = signed({ code: "abc", shop: SHOP, state: "st", timestamp: "1337178173" });
    const good = q.hmac as string;
    expect(verifyOauthHmac(SECRET, { ...q, hmac: `${good.slice(0, -1)}0` })).toBe(false);
    expect(verifyOauthHmac(SECRET, { ...q, hmac: good.slice(0, -2) })).toBe(false); // length mismatch
    expect(verifyOauthHmac(SECRET, { ...q, hmac: `${good}00` })).toBe(false);
    expect(verifyOauthHmac(SECRET, { ...q, hmac: good.toUpperCase() })).toBe(false); // hex digest is lower
    expect(verifyOauthHmac(SECRET, { ...q, hmac: "" })).toBe(false);
    expect(verifyOauthHmac(SECRET, { ...q, hmac: undefined })).toBe(false);
    expect(verifyOauthHmac(SECRET, { ...q, hmac: ["a", "b"] })).toBe(false); // array ⇒ not a digest
  });

  it("REJECTS an added, removed or mutated parameter — every param is covered by the signature", () => {
    const base = { code: "abc", host: "aG9zdA", shop: SHOP, state: "st", timestamp: "1337178173" };
    const q = signed(base);
    expect(verifyOauthHmac(SECRET, { ...q, evil: "1" })).toBe(false); // attacker appends
    expect(verifyOauthHmac(SECRET, { ...q, shop: "evil.myshopify.com" })).toBe(false); // shop swap
    expect(verifyOauthHmac(SECRET, { ...q, state: "other" })).toBe(false); // state swap
    expect(verifyOauthHmac(SECRET, { ...q, code: "stolen" })).toBe(false); // code swap
    const { host: _dropped, ...withoutHost } = q;
    expect(verifyOauthHmac(SECRET, withoutHost)).toBe(false); // attacker drops a signed param
  });

  it("REJECTS a signature made with a different app secret, and refuses a blank secret outright", () => {
    const q = signed({ code: "abc", shop: SHOP, state: "st", timestamp: "1" });
    expect(verifyOauthHmac("some-other-secret", q)).toBe(false);
    expect(verifyOauthHmac("", q)).toBe(false); // an unconfigured secret must never verify anything
  });

  it("never throws on hostile input shapes — it returns false", () => {
    for (const q of [{}, { hmac: "zz" }, { hmac: "not-hex-at-all", shop: SHOP }]) {
      expect(() => verifyOauthHmac(SECRET, q)).not.toThrow();
      expect(verifyOauthHmac(SECRET, q)).toBe(false);
    }
  });
});

describe("shopify-install-identity — normalizeOauthQuery", () => {
  it("keeps strings and string arrays, drops every other value, and uses a null prototype", () => {
    const n = normalizeOauthQuery({ shop: SHOP, ids: ["1", "2"], n: 5, o: {}, mixed: ["a", 1], u: undefined });
    expect(n.shop).toBe(SHOP);
    expect(n.ids).toEqual(["1", "2"]);
    expect(n.n).toBeUndefined();
    expect(n.o).toBeUndefined();
    expect(n.mixed).toBeUndefined();
    expect(Object.getPrototypeOf(n)).toBeNull();
  });

  it("cannot be prototype-polluted by an attacker-chosen parameter name", () => {
    const n = normalizeOauthQuery({ __proto__: "x", constructor: "y", shop: SHOP });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(n.shop).toBe(SHOP);
  });
});

describe("shopify-install-identity — timestamp tolerance", () => {
  it("accepts a timestamp inside Shopify's own ±90s tolerance and refuses one outside it", () => {
    expect(OAUTH_TIMESTAMP_TOLERANCE_SECONDS).toBe(90);
    const now = 1_700_000_000;
    expect(timestampWithinTolerance("1700000000", now)).toBe(true);
    expect(timestampWithinTolerance(String(now - 90), now)).toBe(true);
    expect(timestampWithinTolerance(String(now + 90), now)).toBe(true);
    expect(timestampWithinTolerance(String(now - 91), now)).toBe(false); // replay
    expect(timestampWithinTolerance(String(now + 91), now)).toBe(false); // future skew
  });

  it("refuses a missing / non-numeric / array timestamp rather than treating it as 0", () => {
    for (const bad of [undefined, "", "  ", "abc", "NaN", "Infinity", "1e999", ["1"]]) {
      expect(timestampWithinTolerance(bad as unknown as string, 1_700_000_000)).toBe(false);
    }
  });
});

describe("shopify-install-identity — authorize URL", () => {
  it("builds exactly the documented shape, with grant_options[] OMITTED for an offline token", () => {
    const url = buildInstallAuthorizeUrl({
      shopDomain: SHOP,
      clientId: "client-123",
      redirectUri: "https://widget.palup.ai/shopify/callback",
      scopes: "read_products,read_content",
      state: "nonce-abc",
    });
    const u = new URL(url);
    expect(u.protocol).toBe("https:");
    expect(u.host).toBe(SHOP);
    expect(u.pathname).toBe("/admin/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("scope")).toBe("read_products,read_content");
    expect(u.searchParams.get("redirect_uri")).toBe("https://widget.palup.ai/shopify/callback");
    expect(u.searchParams.get("state")).toBe("nonce-abc");
    // Offline (long-lived) token: the doc says omit grant_options[] entirely. `per-user` would give us an
    // ONLINE token tied to whoever clicked install, which expires and cannot back server-side grounding.
    expect(u.searchParams.has("grant_options[]")).toBe(false);
  });

  it("REFUSES to build a URL for a non-myshopify host (no request is ever aimed at an attacker host)", () => {
    expect(() =>
      buildInstallAuthorizeUrl({
        shopDomain: "evil.test",
        clientId: "c",
        redirectUri: "https://widget.palup.ai/shopify/callback",
        scopes: "read_products",
        state: "s",
      }),
    ).toThrow(/myshopify\.com/);
  });
});

describe("shopify-install-identity — token exchange", () => {
  const OK_BODY = { access_token: "shpat_PARENT_TOKEN_0001", scope: "read_products,read_content" };

  function fetchStub(impl: (url: string, init?: RequestInit) => unknown): typeof globalThis.fetch {
    return (async (url: unknown, init?: unknown) => impl(String(url), init as RequestInit)) as unknown as typeof globalThis.fetch;
  }

  it("POSTs form-encoded credentials to the shop's own access_token endpoint", async () => {
    let seenUrl = "";
    let seenBody = "";
    let seenHeaders: Record<string, string> = {};
    const res = await exchangeInstallCode(
      { shopDomain: SHOP, clientId: "client-123", clientSecret: SECRET, code: "code-abc" },
      fetchStub((url, init) => {
        seenUrl = url;
        seenBody = String(init?.body);
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return { ok: true, status: 200, json: async () => OK_BODY };
      }),
    );
    expect(seenUrl).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(seenHeaders["content-type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(seenBody);
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("client_secret")).toBe(SECRET);
    expect(body.get("code")).toBe("code-abc");
    // `expiring` is NOT sent: an offline token with no expiry is what a durable delegate token needs.
    expect(body.has("expiring")).toBe(false);
    expect(res).toEqual({ accessToken: OK_BODY.access_token, grantedScopes: ["read_products", "read_content"] });
  });

  it("refuses a non-myshopify shop before any network call is made", async () => {
    let called = false;
    const res = await exchangeInstallCode(
      { shopDomain: "evil.test", clientId: "c", clientSecret: SECRET, code: "code-abc" },
      fetchStub(() => {
        called = true;
        return { ok: true, status: 200, json: async () => OK_BODY };
      }),
    );
    expect(res).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null (never throws, never leaks) on a non-2xx, a bad body, or a transport fault", async () => {
    const cases: Array<() => unknown> = [
      () => ({ ok: false, status: 401, json: async () => ({ error: "invalid_request" }) }),
      () => ({ ok: true, status: 200, json: async () => ({}) }),
      () => ({ ok: true, status: 200, json: async () => ({ access_token: "" }) }),
      () => ({ ok: true, status: 200, json: async () => ({ access_token: 42 }) }),
      () => ({ ok: true, status: 200, json: async () => null }),
      () => {
        throw new Error("network down");
      },
    ];
    for (const impl of cases) {
      await expect(
        exchangeInstallCode({ shopDomain: SHOP, clientId: "c", clientSecret: SECRET, code: "code-abc" }, fetchStub(impl)),
      ).resolves.toBeNull();
    }
  });

  it("never puts the code, the client secret or the token in a thrown error", async () => {
    // The function's contract is "never throws" — prove it for the hostile case where fetch throws an
    // error whose own message would otherwise be re-wrapped with our arguments.
    let message = "unset";
    const res = await exchangeInstallCode(
      { shopDomain: SHOP, clientId: "c", clientSecret: SECRET, code: "code-abc" },
      fetchStub(() => {
        throw new Error("upstream said: nope");
      }),
    ).catch((err: unknown) => {
      message = err instanceof Error ? err.message : String(err);
      return "THREW" as const;
    });
    expect(res).toBeNull();
    expect(message).toBe("unset");
  });
});

describe("shopify-install-identity — delegateAccessTokenCreate", () => {
  function fetchStub(impl: (url: string, init?: RequestInit) => unknown): typeof globalThis.fetch {
    return (async (url: unknown, init?: unknown) => impl(String(url), init as RequestInit)) as unknown as typeof globalThis.fetch;
  }
  const okPayload = {
    data: {
      delegateAccessTokenCreate: {
        delegateAccessToken: { accessToken: "shpca_DELEGATE_0001", accessScopes: ["unauthenticated_read_product_listings"] },
        userErrors: [],
      },
    },
  };

  it("calls the shop's Admin GraphQL endpoint at the pinned version, authenticated by the PARENT token", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: { query?: string; variables?: { input?: { delegateAccessScope?: string[]; expiresIn?: number } } } = {};
    const res = await createDelegateAccessToken(
      { shopDomain: SHOP, parentAccessToken: "shpat_PARENT_TOKEN_0001", delegateScopes: ["unauthenticated_read_product_listings"] },
      fetchStub((url, init) => {
        seenUrl = url;
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        seenBody = JSON.parse(String(init?.body));
        return { ok: true, status: 200, json: async () => okPayload };
      }),
    );
    expect(seenUrl).toBe(`https://${SHOP}/admin/api/${ADMIN_API_VERSION}/graphql.json`);
    expect(seenHeaders["x-shopify-access-token"]).toBe("shpat_PARENT_TOKEN_0001");
    expect(seenHeaders["content-type"]).toBe("application/json");
    expect(seenBody.query).toContain("delegateAccessTokenCreate");
    expect(seenBody.variables?.input?.delegateAccessScope).toEqual(["unauthenticated_read_product_listings"]);
    // No expiresIn ⇒ the delegate expires WITH its parent. The parent is a non-expiring offline token, so
    // the delegate does not silently expire and strand grounding on fixtures.
    expect(seenBody.variables?.input?.expiresIn).toBeUndefined();
    expect(res).toEqual({ accessToken: "shpca_DELEGATE_0001", accessScopes: ["unauthenticated_read_product_listings"] });
  });

  it("refuses an empty scope list — a delegate token with no scopes can do nothing", async () => {
    let called = false;
    const res = await createDelegateAccessToken(
      { shopDomain: SHOP, parentAccessToken: "p", delegateScopes: [] },
      fetchStub(() => {
        called = true;
        return { ok: true, status: 200, json: async () => okPayload };
      }),
    );
    expect(res).toBeNull();
    expect(called).toBe(false);
  });

  it("fails closed on userErrors, on a GraphQL `errors` array, and on a missing token", async () => {
    const cases: Array<unknown> = [
      { data: { delegateAccessTokenCreate: { delegateAccessToken: null, userErrors: [{ field: ["input"], message: "scope not granted" }] } } },
      { errors: [{ message: "Access denied" }] },
      { data: { delegateAccessTokenCreate: { delegateAccessToken: { accessToken: "" }, userErrors: [] } } },
      { data: {} },
      {},
      null,
    ];
    for (const payload of cases) {
      await expect(
        createDelegateAccessToken(
          { shopDomain: SHOP, parentAccessToken: "p", delegateScopes: ["unauthenticated_read_product_listings"] },
          fetchStub(() => ({ ok: true, status: 200, json: async () => payload })),
        ),
      ).resolves.toBeNull();
    }
  });

  it("never throws — a transport fault is a null, not an exception carrying the parent token", async () => {
    let message = "unset";
    const res = await createDelegateAccessToken(
      { shopDomain: SHOP, parentAccessToken: "shpat_PARENT_TOKEN_0001", delegateScopes: ["unauthenticated_read_product_listings"] },
      fetchStub(() => {
        throw new Error("boom");
      }),
    ).catch((err: unknown) => {
      message = err instanceof Error ? err.message : String(err);
      return "THREW" as const;
    });
    expect(res).toBeNull();
    expect(message).toBe("unset");
  });

  it("grantedScopesCover honours the documented read/write implication, and refuses a short grant", () => {
    // [S1] "Confirm the requested scopes" + "If you requested both the read and write access scopes for a
    // resource, then check only for the write access scope."
    expect(grantedScopesCover(["unauthenticated_read_product_listings"], ["unauthenticated_read_product_listings"])).toBe(true);
    expect(grantedScopesCover(["read_orders"], ["write_orders"])).toBe(true); // write implies read
    expect(grantedScopesCover(["write_orders"], ["read_orders"])).toBe(false); // read does NOT imply write
    expect(grantedScopesCover(["a", "b"], ["a"])).toBe(false); // a merchant who granted less
    expect(grantedScopesCover(["a"], [])).toBe(false); // nothing granted at all
    expect(grantedScopesCover([], ["a"])).toBe(true); // nothing required is vacuously covered
    expect(grantedScopesCover(["read_x"], ["write_y"])).toBe(false); // the implication is per-resource
  });

  it("defaults to the least-privilege Storefront scope this product actually reads", () => {
    // The grounding adapter reads products only (shopify-grounding.ts). Anything beyond that is scope we
    // do not need and must not hold.
    expect(DELEGATE_SCOPES_DEFAULT).toEqual(["unauthenticated_read_product_listings"]);
  });
});
