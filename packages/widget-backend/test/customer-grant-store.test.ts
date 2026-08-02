import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createEnvSecrets } from "@palup/platform-ports";
import { createCustomerGrantStore, CAA_GRANT_KEY_SCOPE, CAA_GRANT_KEY_NAME, type StoredGrant } from "../src/customer-grant-store.js";

// ADR-0018 tasks 1+6: encrypted at-rest grant custody over the unchanged RuntimeStatePort.

const secretsWith = (key?: string) => createEnvSecrets(key ? JSON.stringify({ [CAA_GRANT_KEY_SCOPE]: { [CAA_GRANT_KEY_NAME]: key } }) : undefined);
const grant = (over: Partial<StoredGrant> = {}): StoredGrant => ({ accessToken: "at-123", refreshToken: "rt-456", expiresAt: 1_700_000_900, scope: "openid", grantedAt: 1_700_000_000, ...over });

describe("createCustomerGrantStore", () => {
  it("put → get round-trips the grant (and ready() is true with a key)", async () => {
    const store = new InMemoryRuntimeStore();
    const gs = createCustomerGrantStore(store, secretsWith("super-secret-key-material"));
    expect(await gs.ready()).toBe(true);
    await gs.put("acme", "shopify:acme:48291", grant());
    expect(await gs.get("acme", "shopify:acme:48291")).toEqual(grant());
  });

  it("stores CIPHERTEXT, never the plaintext token, in the KV", async () => {
    const store = new InMemoryRuntimeStore();
    const gs = createCustomerGrantStore(store, secretsWith("k"));
    await gs.put("acme", "shopify:acme:1", grant({ accessToken: "PLAINTEXT-SECRET" }));
    const raw = await store.get<{ c?: string }>({ tenantId: "acme" }, "caa_grants", "shopify:acme:1");
    expect(raw?.c).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain("PLAINTEXT-SECRET");
    expect(JSON.stringify(raw)).not.toContain("rt-456");
  });

  it("is tenant-isolated — tenant B cannot read tenant A's grant", async () => {
    const store = new InMemoryRuntimeStore();
    const gs = createCustomerGrantStore(store, secretsWith("k"));
    await gs.put("acme", "shopify:acme:1", grant());
    expect(await gs.get("brandx", "shopify:acme:1")).toBeNull();
  });

  it("a different key ⇒ get returns null (fail closed on wrong key / tamper)", async () => {
    const store = new InMemoryRuntimeStore();
    await createCustomerGrantStore(store, secretsWith("key-one")).put("acme", "shopify:acme:1", grant());
    // A store built with a DIFFERENT key can't decrypt what key-one wrote.
    expect(await createCustomerGrantStore(store, secretsWith("key-two")).get("acme", "shopify:acme:1")).toBeNull();
  });

  it("a tampered ciphertext ⇒ null (GCM auth tag)", async () => {
    const store = new InMemoryRuntimeStore();
    const gs = createCustomerGrantStore(store, secretsWith("k"));
    await gs.put("acme", "shopify:acme:1", grant());
    const raw = await store.get<{ c: string }>({ tenantId: "acme" }, "caa_grants", "shopify:acme:1");
    const flipped = raw!.c.slice(0, -4) + (raw!.c.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    await store.put({ tenantId: "acme" }, "caa_grants", "shopify:acme:1", { c: flipped });
    expect(await gs.get("acme", "shopify:acme:1")).toBeNull();
  });

  it("no encryption key ⇒ ready() false, get() null, put() throws (never plaintext)", async () => {
    const store = new InMemoryRuntimeStore();
    const gs = createCustomerGrantStore(store, secretsWith(undefined));
    expect(await gs.ready()).toBe(false);
    expect(await gs.get("acme", "x")).toBeNull();
    await expect(gs.put("acme", "x", grant())).rejects.toThrow();
  });

  it("delete removes the grant (erasure — Decision A)", async () => {
    const store = new InMemoryRuntimeStore();
    const gs = createCustomerGrantStore(store, secretsWith("k"));
    await gs.put("acme", "shopify:acme:1", grant());
    await gs.delete("acme", "shopify:acme:1");
    expect(await gs.get("acme", "shopify:acme:1")).toBeNull();
  });
});
