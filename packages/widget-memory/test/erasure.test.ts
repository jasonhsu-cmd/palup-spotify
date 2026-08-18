import { describe, it, expect, vi } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore, createEnvSecrets, type SecretsPort } from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import {
  eraseSubject,
  withdrawConsent1,
  withdrawConsent2,
  eraseTenant,
  ERASURE_TOMBSTONE_COLLECTION,
  ERASURE_TOMBSTONE_TTL_SECONDS,
  tombstoneKey,
} from "../src/erasure.js";
import { subjectNamespace, floorNamespace } from "../src/identity.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// ADR-0015 Inv 5 (right-to-erasure, audited) + the Consent UX "Withdrawal is symmetric" rule:
// withdrawing Consent 2 PURGES the special-category fact (erasure-first) but leaves ordinary facts
// alone; Consent 1 withdrawal stops + erases ordinary facts, leaving any separately-consented special
// fact untouched (Consent 2 is independent of Consent 1 — Inv 9).

function fixedDistiller(facts: string[]): FactDistiller {
  // PR-8: FactDistiller.distill() returns candidate OBJECTS ({text, disposition?}), not bare strings.
  return { async distill() { return facts.map((text) => ({ text })); } };
}

// ADR-0015 Inv 9 (go-live blocker #2): a special-category write is refused without a configured
// encryption key (service.ts, fail closed), so every test below that writes one via `service.remember`
// needs a key provisioned for the tenant it uses — mirrors service.test.ts's own `keyedSecrets` helper.
function keyedSecrets(...tenantIds: string[]): SecretsPort {
  const byTenant: Record<string, Record<string, string>> = {};
  for (const t of tenantIds) byTenant[t] = { MEMORY_ENCRYPTION_KEY: `test-key-for-${t}` };
  return createEnvSecrets(JSON.stringify(byTenant));
}

describe("erasure — eraseSubject (Inv 5: full, audited right-to-erasure)", () => {
  it("after eraseSubject, recall returns [] and an erase.subject audit exists", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-erase", region: "us", consent1: "in", consent2: "unknown" };

    await service.remember(ctx, { message: "m", reply: "r" });
    expect(await service.recall(ctx)).toHaveLength(1);

    await eraseSubject({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-erase" });

    expect(await service.recall(ctx)).toEqual([]);
    const log = await runtimeStore.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("erase.subject");
  });

  it("erasing subject A leaves subject B intact (isolation)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctxA: MemoryCtx = { tenantId: "acme", anonId: "guest-a", region: "us", consent1: "in", consent2: "unknown" };
    const ctxB: MemoryCtx = { tenantId: "acme", anonId: "guest-b", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctxA, { message: "m", reply: "r" });
    await service.remember(ctxB, { message: "m", reply: "r" });

    await eraseSubject({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-a" });

    expect(await service.recall(ctxA)).toEqual([]);
    expect(await service.recall(ctxB)).toHaveLength(1);
  });
});

describe("erasure — withdrawConsent2 (erasure-first: purges special, KEEPS ordinary)", () => {
  it("purges only the special-category fact, leaves the ordinary fact intact, and audits consent.withdrawn", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-mix", region: "us", consent1: "in", consent2: "in" };

    await createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    }).remember(ctx, { message: "m", reply: "r" });

    const specialService = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme"),
    });
    await specialService.remember(ctx, { message: "m", reply: "r" });

    const before = await specialService.recall(ctx);
    expect(before.map((f) => f.class).sort()).toEqual(["ordinary", "special"]);

    const result = await withdrawConsent2({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-mix" });
    expect(result.purged).toBe(1);

    const after = await specialService.recall(ctx);
    expect(after).toEqual([{ text: "prefers fragrance-free", class: "ordinary" }]);

    const log = await runtimeStore.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("consent.withdrawn");
  });

  it("still audits even when there was nothing special to purge (withdrawal is itself the event)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();

    const result = await withdrawConsent2({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-empty" });
    expect(result.purged).toBe(0);

    const log = await runtimeStore.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("consent.withdrawn");
  });
});

describe("erasure — withdrawConsent1 (stop + erase ordinary; leaves a separately-consented special fact alone)", () => {
  it("purges the ordinary fact but keeps the special fact (Consent 2 is independent)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-c1", region: "us", consent1: "in", consent2: "in" };

    await createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    }).remember(ctx, { message: "m", reply: "r" });

    const specialService = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme"),
    });
    await specialService.remember(ctx, { message: "m", reply: "r" });

    const result = await withdrawConsent1({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-c1" });
    expect(result.purged).toBe(1);

    const after = await specialService.recall(ctx);
    expect(after).toEqual([{ text: "shopper has a tree-nut allergy", class: "special" }]);
  });
});

describe("erasure — eraseTenant (KNOWN deferred gap under Option B — per-subject namespaces)", () => {
  it("throws a clear NotImplemented error rather than silently no-op-ing", () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    expect(() => eraseTenant({ vector, audit: runtimeStore }, "acme")).toThrow(/NotImplemented/i);
  });
});

// semantic-memory-v1 foundation, T2 — SUPERSEDES the prior "completeness guard" test below (which
// asserted `withdrawConsent2` FAILS CLOSED via a raw one-shot `query(ns,{text:"",k:500})` mock the
// instant a subject hit 500 records). That guard existed only because a single query genuinely
// couldn't prove completeness past its cap. Pagination (walking pages to a short page, no hard upper
// bound) removes that limitation entirely — a subject sitting exactly at the OLD boundary must now
// succeed with a complete, correctly-counted purge, not reject. This is an inferred design call (the
// task's own framing: "today this fails-closed at 500 — RED until pagination lands"), flagged here as
// exactly that: the old assertion's PREMISE is what this whole foundation removes, so keeping the old
// mock-based assertion literally green would mean testing a guarantee the feature is designed to no
// longer have. See erasure-scale.test.ts sibling below for the full 1500-fact proof.
describe("erasure — completeness at the OLD 500-record boundary (semantic-memory-v1 foundation, T2)", () => {
  it("withdrawConsent2 no longer fails closed at the old 500-record boundary — a subject with EXACTLY 500 special facts is purged COMPLETELY, not rejected", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    // #125 — withdrawConsent2 now enumerates/deletes special-category facts from the dedicated FLOOR
    // namespace, not the main subject namespace.
    const namespace = floorNamespace("acme", "guest-boundary-500");
    const records = Array.from({ length: 500 }, (_, i) => ({
      id: `s-${String(i).padStart(3, "0")}`,
      text: `special ${i}`,
      metadata: { text: `special ${i}`, class: "special" as const },
    }));
    await vector.upsert(namespace, records);

    const result = await withdrawConsent2({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-boundary-500" });
    expect(result.purged).toBe(500); // NOT a rejection — the old QUERY_LIMIT=500 fail-closed guard no longer applies

    expect(await vector.query(namespace, { text: "", k: 2000 })).toEqual([]);
  });
});

describe("erasure — PAGINATED enumeration at scale (semantic-memory-v1 foundation, T2): a 1500-fact subject is no longer fail-closed at 500", () => {
  it(
    "withdrawConsent1 deletes EVERY ordinary id across 1500 facts (specials retained), and the " +
      "consent.withdrawn audit count is the TRUE total — not capped at 500 (today: enumerateSubjectOrFail " +
      "fails closed at k=500, so this REJECTS instead of resolving)",
    async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const namespace = subjectNamespace("acme", "guest-1500-c1");
      const ORDINARY = 1200;
      const SPECIAL = 300;
      const records = [
        ...Array.from({ length: ORDINARY }, (_, i) => ({
          id: `ord-${String(i).padStart(4, "0")}`,
          text: `fact ${i}`,
          metadata: { text: `fact ${i}`, class: "ordinary" as const },
        })),
        ...Array.from({ length: SPECIAL }, (_, i) => ({
          id: `spec-${String(i).padStart(4, "0")}`,
          text: `special ${i}`,
          metadata: { text: `special ${i}`, class: "special" as const },
        })),
      ];
      await vector.upsert(namespace, records);

      const result = await withdrawConsent1({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-1500-c1" });
      expect(result.purged).toBe(ORDINARY); // the TRUE total, not the old 500 cap

      const remaining = await vector.query(namespace, { text: "", k: 2000 });
      expect(remaining).toHaveLength(SPECIAL);
      expect(remaining.every((r) => (r.metadata as { class?: string } | undefined)?.class === "special")).toBe(true);

      const log = await runtimeStore.readAudit({ tenantId: "acme" });
      const row = log.find((r) => r.action === "consent.withdrawn" && (r.decision as { class?: string })?.class === "ordinary");
      expect(row?.decision).toMatchObject({ count: ORDINARY });
    },
  );
});

describe("erasure — works on ENCRYPTED records too (ADR-0015 Inv 9, go-live blocker #2)", () => {
  it("eraseSubject fully erases an encrypted special-category fact — erasure never needs to decrypt anything", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme-erase-enc"),
    });
    const ctx: MemoryCtx = { tenantId: "acme-erase-enc", anonId: "guest-erase-enc", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    // Confirm it really is stored encrypted before erasing it. #125 — special-category records now live in
    // the dedicated FLOOR namespace.
    const raw = await vector.query(floorNamespace("acme-erase-enc", "guest-erase-enc"), { text: "", k: 10 });
    expect(raw[0]?.metadata?.encrypted).toBe(true);
    expect(await service.recall(ctx)).toHaveLength(1);

    await eraseSubject({ vector, audit: runtimeStore }, { tenantId: "acme-erase-enc", anonId: "guest-erase-enc" });

    expect(await service.recall(ctx)).toEqual([]);
    // eraseSubject deletes BOTH the main and floor namespaces (#125) — a full subject erasure must not
    // leave the floor namespace behind.
    expect(await vector.query(subjectNamespace("acme-erase-enc", "guest-erase-enc"), { text: "", k: 10 })).toEqual([]);
    expect(await vector.query(floorNamespace("acme-erase-enc", "guest-erase-enc"), { text: "", k: 10 })).toEqual([]);
  });

  it("withdrawConsent2 purges an encrypted special-category fact by id, exactly like a plaintext one", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme-withdraw-enc"),
    });
    const ctx: MemoryCtx = { tenantId: "acme-withdraw-enc", anonId: "guest-withdraw-enc", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const result = await withdrawConsent2(
      { vector, audit: runtimeStore },
      { tenantId: "acme-withdraw-enc", anonId: "guest-withdraw-enc" },
    );
    expect(result.purged).toBe(1);
    expect(await service.recall(ctx)).toEqual([]);
  });
});

// MEMORY-GO-LIVE-CHECKLIST.md §E1 (raw-turn PII in Pub/Sub) — a subject's erasure request must be able
// to drop an in-flight/DLQ'd async memory-write for that subject even though the erasure path itself
// never reaches Pub/Sub. Each of the three withdrawal/erasure entry points now writes a subject-level
// tombstone (RuntimeStatePort KV, TTL-bounded) that the queue CONSUMER (pubsub-push-memory.ts) checks
// before writing: any message published for this subject at or before `erasedAtMs` is dropped rather
// than remembered.
describe("erasure — E1 tombstone: eraseSubject / withdrawConsent1 / withdrawConsent2 each write an erasure tombstone", () => {
  it("eraseSubject writes a tombstone under tombstoneKey(anonId) with the injected now and the fixed TTL", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const now = () => 1_700_000_000_000;

    await eraseSubject({ vector, audit: runtimeStore, now }, { tenantId: "acme", anonId: "guest-tomb-erase" });

    const tombstone = await runtimeStore.get<{ erasedAtMs: number }>(
      { tenantId: "acme" },
      ERASURE_TOMBSTONE_COLLECTION,
      tombstoneKey("guest-tomb-erase"),
    );
    expect(tombstone).toEqual({ erasedAtMs: 1_700_000_000_000 });
  });

  it("withdrawConsent1 writes the same subject-level tombstone", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const now = () => 1_700_000_001_000;

    await withdrawConsent1({ vector, audit: runtimeStore, now }, { tenantId: "acme", anonId: "guest-tomb-c1" });

    const tombstone = await runtimeStore.get<{ erasedAtMs: number }>(
      { tenantId: "acme" },
      ERASURE_TOMBSTONE_COLLECTION,
      tombstoneKey("guest-tomb-c1"),
    );
    expect(tombstone).toEqual({ erasedAtMs: 1_700_000_001_000 });
  });

  it("withdrawConsent2 writes the same subject-level tombstone", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const now = () => 1_700_000_002_000;

    await withdrawConsent2({ vector, audit: runtimeStore, now }, { tenantId: "acme", anonId: "guest-tomb-c2" });

    const tombstone = await runtimeStore.get<{ erasedAtMs: number }>(
      { tenantId: "acme" },
      ERASURE_TOMBSTONE_COLLECTION,
      tombstoneKey("guest-tomb-c2"),
    );
    expect(tombstone).toEqual({ erasedAtMs: 1_700_000_002_000 });
  });

  it("without an injected `now`, the tombstone still lands (defaults to Date.now) and TTL is the fixed 48h constant", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const putSpy = vi.spyOn(runtimeStore, "put");

    await eraseSubject({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-tomb-default" });

    const tombstoneCall = putSpy.mock.calls.find((c) => c[1] === ERASURE_TOMBSTONE_COLLECTION);
    expect(tombstoneCall).toBeDefined();
    expect(tombstoneCall?.[4]).toEqual({ ttlSeconds: ERASURE_TOMBSTONE_TTL_SECONDS });
    putSpy.mockRestore();
  });

  it("MED-1 — writes the tombstone BEFORE any deleteNamespace (no resurrect-between-delete-and-tombstone window)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const order: string[] = [];
    vi.spyOn(vector, "deleteNamespace").mockImplementation(async () => { order.push("delete"); });
    vi.spyOn(runtimeStore, "put").mockImplementation(async () => { order.push("tombstone"); });

    await eraseSubject({ vector, audit: runtimeStore, now: () => 1 }, { tenantId: "acme", anonId: "guest-order" });

    // The tombstone must land first; any in-flight message was published before this erasure so it is
    // dropped regardless of when the (later) deletes run.
    expect(order[0]).toBe("tombstone");
    expect(order).toContain("delete");
  });
});
