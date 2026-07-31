import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore } from "@palup/platform-ports";
import { generateGuestId, subjectNamespace, validateAnonId } from "../src/identity.js";

// ADR-0015 Inv 8: the anonymous id is a random, first-party, per-tenant identifier — NEVER derived from
// device/browser fingerprints or any shopper-supplied input. Inv 2: memory is namespaced by tenant, no
// cross-namespace read; Option B keys the vector port by `${tenantId}::${anonId}`.
describe("identity — generateGuestId (random, not fingerprint)", () => {
  it("takes no arguments at all — cannot be derived from device/input by construction", () => {
    expect(generateGuestId.length).toBe(0);
  });

  it("two calls produce different ids", () => {
    expect(generateGuestId()).not.toBe(generateGuestId());
  });

  it("is high-entropy: 1000 draws from the 128-bit space never collide, base32 charset", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateGuestId());
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Z2-7]{20,30}$/); // RFC4648 base32 charset, ~26 chars for 128 bits
    }
  });
});

describe("identity — subjectNamespace (Option B: tenantId::anonId)", () => {
  it("namespaces by both tenant and anon id", () => {
    expect(subjectNamespace("acme", "guest-1")).toBe("acme::guest-1");
  });

  it("the SAME anonId under two different tenants yields different, isolated namespaces", async () => {
    const nsA = subjectNamespace("tenant-a", "shared-anon");
    const nsB = subjectNamespace("tenant-b", "shared-anon");
    expect(nsA).not.toBe(nsB);

    const vector = createInMemoryVectorStore();
    await vector.upsert(nsA, [{ id: "fact-1", text: "prefers fragrance-free", metadata: {} }]);
    // Tenant B can never read tenant A's write, even with the identical anon id.
    const hitsB = await vector.query(nsB, { text: "", k: 10 });
    expect(hitsB).toEqual([]);
    const hitsA = await vector.query(nsA, { text: "", k: 10 });
    expect(hitsA.map((h) => h.id)).toEqual(["fact-1"]);
  });

  it("throws on a blank tenantId or anonId", () => {
    expect(() => subjectNamespace("", "guest-1")).toThrow();
    expect(() => subjectNamespace("   ", "guest-1")).toThrow();
    expect(() => subjectNamespace("acme", "")).toThrow();
    expect(() => subjectNamespace("acme", "   ")).toThrow();
  });

  it("throws when either component contains the :: separator (namespace-injection)", () => {
    expect(() => subjectNamespace("acme::evil", "guest-1")).toThrow();
    expect(() => subjectNamespace("acme", "other-tenant::victim")).toThrow();
  });
});

describe("identity — validateAnonId (charset + length bounded)", () => {
  it("accepts a well-formed generated id", () => {
    const id = generateGuestId();
    expect(validateAnonId(id)).toBe(id);
  });

  it("rejects an oversized id", () => {
    expect(validateAnonId("A".repeat(200))).toBeUndefined();
  });

  it("rejects an illegal-charset id", () => {
    expect(validateAnonId("not base32!! ::injected")).toBeUndefined();
    expect(validateAnonId("has spaces here")).toBeUndefined();
  });

  it("rejects non-string / empty input without throwing", () => {
    expect(validateAnonId(undefined)).toBeUndefined();
    expect(validateAnonId("")).toBeUndefined();
  });
});
