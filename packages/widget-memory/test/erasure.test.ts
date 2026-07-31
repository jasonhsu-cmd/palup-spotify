import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore } from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { eraseSubject, withdrawConsent1, withdrawConsent2, eraseTenant } from "../src/erasure.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// ADR-0015 Inv 5 (right-to-erasure, audited) + the Consent UX "Withdrawal is symmetric" rule:
// withdrawing Consent 2 PURGES the special-category fact (erasure-first) but leaves ordinary facts
// alone; Consent 1 withdrawal stops + erases ordinary facts, leaving any separately-consented special
// fact untouched (Consent 2 is independent of Consent 1 — Inv 9).

function fixedDistiller(facts: string[]): FactDistiller {
  return { async distill() { return facts; } };
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

describe("erasure — completeness guard (Inv 5: a rights purge is never silently partial)", () => {
  it("withdrawConsent2 FAILS CLOSED when the subject hits the enumeration cap", async () => {
    const runtimeStore = new InMemoryRuntimeStore();
    // A subject at/over the query cap: one query can't prove it saw everything, so a purge must throw
    // rather than delete a partial set and audit it as complete.
    const capped = Array.from({ length: 500 }, (_, i) => ({ id: `id-${i}`, text: "x", score: 0, metadata: { class: "special" as const } }));
    const spyVector = {
      upsert: async () => {},
      query: async () => capped,
      deleteById: async () => {},
      deleteNamespace: async () => {},
    };
    await expect(
      withdrawConsent2({ vector: spyVector as never, audit: runtimeStore }, { tenantId: "acme", anonId: "big" }),
    ).rejects.toThrow(/complete purge/i);
  });
});
