import { describe, it, expect } from "vitest";
import { buildMemoryAudit, subjectRef, type MemoryAction } from "../src/audit.js";

// ADR-0015 Inv 6: consent + memory access are audited — no silent memory action. Mirrors
// packages/widget-backend/src/audit.ts's shape (actor, action, input, decision, reversalPath) and its
// PII discipline: the raw shopper/tenant identifier and the fact TEXT never land in the immutable log.
describe("audit — buildMemoryAudit (mirrors the existing AuditInput shape; PII-safe)", () => {
  it("a write audit carries a hashed subjectRef + class + count, and NEVER the raw anonId", () => {
    const input = buildMemoryAudit({
      action: "write.ordinary",
      tenantId: "acme",
      anonId: "guest-super-secret-id",
      factClass: "ordinary",
      count: 2,
    });
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("guest-super-secret-id");
    expect(input.decision).toMatchObject({ class: "ordinary", count: 2 });
    const inputField = input.input as { subjectRef?: string };
    expect(typeof inputField.subjectRef).toBe("string");
    expect(inputField.subjectRef!.length).toBeGreaterThan(0);
    expect(inputField.subjectRef).not.toBe("guest-super-secret-id");
  });

  it("never carries fact text — only the class + a count", () => {
    const input = buildMemoryAudit({
      action: "write.special",
      tenantId: "acme",
      anonId: "guest-1",
      factClass: "special",
      count: 1,
    });
    const serialized = JSON.stringify(input).toLowerCase();
    expect(serialized).not.toContain("tree-nut");
    expect(serialized).not.toContain("allergy");
  });

  it("actor is the memory subsystem's own agent identity", () => {
    const input = buildMemoryAudit({ action: "recall", tenantId: "acme", anonId: "guest-1" });
    expect(input.actor).toBe("agent:shopper-memory");
  });

  it("each action produces a stable, distinct slug", () => {
    const actions: MemoryAction[] = [
      "consent.granted",
      "consent.withdrawn",
      "write.ordinary",
      "write.special",
      "write.refused",
      "recall",
      "erase.subject",
      "erase.tenant",
      "merge",
      "ttl_sweep",
    ];
    const slugs = actions.map((action) => buildMemoryAudit({ action, tenantId: "t", anonId: "a" }).action);
    expect(new Set(slugs).size).toBe(actions.length); // all distinct
    expect(slugs).toEqual(actions); // action field IS the stable slug
  });

  it("write.special and write.ordinary are distinct actions", () => {
    const ordinary = buildMemoryAudit({ action: "write.ordinary", tenantId: "t", anonId: "a", factClass: "ordinary", count: 1 });
    const special = buildMemoryAudit({ action: "write.special", tenantId: "t", anonId: "a", factClass: "special", count: 1 });
    expect(ordinary.action).not.toBe(special.action);
  });

  it("carries a non-empty reversal path", () => {
    const input = buildMemoryAudit({ action: "write.ordinary", tenantId: "t", anonId: "a", factClass: "ordinary", count: 1 });
    expect(typeof input.reversalPath).toBe("string");
    expect(input.reversalPath!.length).toBeGreaterThan(0);
  });

  // Security review (feat/memory-encryption-at-rest, finding 6): a fail-closed special-category refusal
  // must not be silent (ADR-0015 Inv 6 / NN#5). write.refused carries ONLY the class + a count — never
  // the fact text, never the raw anonId — same PII discipline as every other memory audit action.
  it("write.refused carries only class + count, never fact text or the raw anonId (finding 6)", () => {
    const input = buildMemoryAudit({
      action: "write.refused",
      tenantId: "acme",
      anonId: "guest-super-secret-id",
      factClass: "special",
      count: 2,
    });
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("guest-super-secret-id");
    expect(input.decision).toMatchObject({ class: "special", count: 2 });
    expect(typeof input.reversalPath).toBe("string");
    expect(input.reversalPath!.length).toBeGreaterThan(0);
  });
});

// MEDIUM finding (security-review remediation, PR #152) — a low-entropy `acct:` subject id routed
// through a bare/unsalted hash is brute-forceable (widget-backend/src/audit.ts's own `hashShopperRef`
// rule). `subjectRef` must support a KEYED HMAC when a key is supplied.
describe("subjectRef — keyed HMAC when hmacKey is supplied", () => {
  it("with NO hmacKey, behaves exactly as before (a stable, deterministic hash, still never the raw id)", () => {
    const ref = subjectRef("acme", "acct:shopify:acme:12345");
    expect(ref).toBe(subjectRef("acme", "acct:shopify:acme:12345")); // deterministic
    expect(ref).not.toContain("12345");
  });

  it("with an hmacKey, the ref DIFFERS from the unkeyed hash for the SAME (tenantId, anonId)", () => {
    const unkeyed = subjectRef("acme", "acct:shopify:acme:12345");
    const keyed = subjectRef("acme", "acct:shopify:acme:12345", "secret-hmac-key");
    expect(keyed).not.toBe(unkeyed);
  });

  it("a different hmacKey produces a different ref for the SAME (tenantId, anonId) — the ref is genuinely keyed, not just re-hashed", () => {
    const refA = subjectRef("acme", "acct:shopify:acme:12345", "key-a");
    const refB = subjectRef("acme", "acct:shopify:acme:12345", "key-b");
    expect(refA).not.toBe(refB);
  });

  it("buildMemoryAudit threads hmacKey through to subjectRef", () => {
    const withKey = buildMemoryAudit({ action: "erase.subject", tenantId: "acme", anonId: "acct:shopify:acme:12345", hmacKey: "secret" });
    const withoutKey = buildMemoryAudit({ action: "erase.subject", tenantId: "acme", anonId: "acct:shopify:acme:12345" });
    const refOf = (i: typeof withKey) => (i.input as { subjectRef?: string }).subjectRef;
    expect(refOf(withKey)).not.toBe(refOf(withoutKey));
    expect(refOf(withKey)).toBe(subjectRef("acme", "acct:shopify:acme:12345", "secret"));
  });
});
