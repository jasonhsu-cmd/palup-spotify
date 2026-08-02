import { describe, it, expect } from "vitest";
import { buildIdentityAuditInput, buildCaaGrantAuditInput, buildCaaRevokeAuditInput } from "../src/audit.js";

// ADR-0017 T8: the identity-resolution audit is PII-safe — F7 keyed-HMAC ref (NOT a bare hash), no raw
// shopperId/customer id anywhere in the record.

describe("buildIdentityAuditInput (T8, PII-safe, F7 keyed HMAC)", () => {
  it("emits identity.shopper.resolved with a keyed-HMAC ref; the raw shopperId never appears", () => {
    const shopperId = "shopify:acme:48291";
    const entry = buildIdentityAuditInput({ shopperId, source: "shopify", tenantId: "acme", hmacKey: "audit-hmac-key" });
    expect(entry.actor).toBe("system:identity");
    expect(entry.action).toBe("identity.shopper.resolved");
    expect(entry.reversalPath).toBe("n/a — read-only identity");
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(shopperId);
    expect(serialized).not.toContain("48291"); // the raw numeric customer id
    const input = entry.input as { shopperRef: string; source: string; tenantId: string };
    expect(input.source).toBe("shopify");
    expect(input.tenantId).toBe("acme");
    expect(typeof input.shopperRef).toBe("string");
    expect(input.shopperRef.length).toBeGreaterThan(0);
  });

  it("is a KEYED hash — the SAME shopperId under a DIFFERENT key produces a DIFFERENT ref (not a bare/unsalted hash)", () => {
    const shopperId = "shopify:acme:48291";
    const a = buildIdentityAuditInput({ shopperId, source: "shopify", tenantId: "acme", hmacKey: "key-a" });
    const b = buildIdentityAuditInput({ shopperId, source: "shopify", tenantId: "acme", hmacKey: "key-b" });
    const refA = (a.input as { shopperRef: string }).shopperRef;
    const refB = (b.input as { shopperRef: string }).shopperRef;
    expect(refA).not.toBe(refB);
  });

  it("is deterministic for the SAME key + shopperId (so repeat resolutions of the same shopper are correlatable by an auditor holding the key)", () => {
    const shopperId = "shopify:acme:48291";
    const a = buildIdentityAuditInput({ shopperId, source: "shopify", tenantId: "acme", hmacKey: "k" });
    const b = buildIdentityAuditInput({ shopperId, source: "shopify", tenantId: "acme", hmacKey: "k" });
    expect((a.input as { shopperRef: string }).shopperRef).toBe((b.input as { shopperRef: string }).shopperRef);
  });
});

describe("buildCaaGrantAuditInput (ADR-0018 task 9 — grant custody, PII-safe)", () => {
  it("emits identity.shopper.oauth_granted with a keyed-HMAC ref + a REAL reversal path; no raw id/token", () => {
    const shopperId = "shopify:acme:48291";
    const entry = buildCaaGrantAuditInput({ shopperId, source: "shopify", tenantId: "acme", hmacKey: "audit-hmac-key", scope: "openid email" });
    expect(entry.actor).toBe("system:identity");
    expect(entry.action).toBe("identity.shopper.oauth_granted");
    expect(entry.reversalPath).toContain("delete stored grant");
    const input = entry.input as { shopperRef: string; mechanism: string; scope?: string };
    expect(input.mechanism).toBe("caa");
    expect(input.scope).toBe("openid email");
    expect(typeof input.shopperRef).toBe("string");
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(shopperId); // never the raw namespaced id
    expect(serialized).not.toContain("48291"); // never the raw numeric customer id
  });
});

describe("buildCaaRevokeAuditInput (ADR-0018 task 7 — grant revocation, PII-safe)", () => {
  it("emits identity.shopper.oauth_revoked with a keyed-HMAC ref; no raw id/token", () => {
    const shopperId = "shopify:acme:48291";
    const entry = buildCaaRevokeAuditInput({ shopperId, source: "shopify", tenantId: "acme", hmacKey: "audit-hmac-key" });
    expect(entry.actor).toBe("system:identity");
    expect(entry.action).toBe("identity.shopper.oauth_revoked");
    expect((entry.decision as { revoked?: boolean }).revoked).toBe(true);
    expect((entry.input as { mechanism: string }).mechanism).toBe("caa");
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(shopperId);
    expect(serialized).not.toContain("48291");
  });
});
