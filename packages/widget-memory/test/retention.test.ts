import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore } from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace } from "../src/identity.js";
import { ORDINARY_TTL_DAYS, SPECIAL_TTL_DAYS, ttlForClass, sweepExpired } from "../src/retention.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// ADR-0015 Inv 4 (retention TTL, enforced not aspirational) + Inv 9 (special-category facts get a
// SHORTER TTL than ordinary). TTL-on-write is service.ts's `remember` (already stamps
// `metadata.expiresAt`); TTL-on-read is service.ts's `recall` (already drops expired facts); this test
// file proves both hold end-to-end, plus the periodic `sweepExpired` that reclaims storage.

function noopDistiller(): FactDistiller {
  return { async distill() { return []; } };
}

describe("retention — TTL day-counts (Inv 4/9; legal 2026: both 30d, special never LONGER than ordinary)", () => {
  it("both classes are the legal-approved 30 days, and special is never longer than ordinary (Inv 9 as ≤)", () => {
    expect(ORDINARY_TTL_DAYS).toBe(30);
    expect(SPECIAL_TTL_DAYS).toBe(30);
    expect(SPECIAL_TTL_DAYS).toBeLessThanOrEqual(ORDINARY_TTL_DAYS);
  });

  it("ttlForClass mirrors the day-counts (in milliseconds)", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    expect(ttlForClass("ordinary")).toBe(ORDINARY_TTL_DAYS * DAY_MS);
    expect(ttlForClass("special")).toBe(SPECIAL_TTL_DAYS * DAY_MS);
    expect(ttlForClass("special")).toBeLessThanOrEqual(ttlForClass("ordinary"));
  });
});

describe("retention — TTL-on-read (Inv 4: expiry is enforced, not aspirational)", () => {
  it("a fact whose expiresAt is in the past is NOT returned by recall, even though still in the store", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const namespace = subjectNamespace("acme", "guest-ttl");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();

    await vector.upsert(namespace, [
      {
        id: "expired-1",
        text: "prefers fragrance-free",
        metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: past },
      },
    ]);

    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: noopDistiller(),
      enabled: true,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-ttl", region: "us", consent1: "in", consent2: "unknown" };

    expect(await service.recall(ctx)).toEqual([]);

    // still physically present — recall filters it, it isn't (yet) deleted
    const raw = await vector.query(namespace, { text: "", k: 10 });
    expect(raw.map((r) => r.id)).toEqual(["expired-1"]);
  });
});

describe("retention — sliding TTL on return (legal 2026: the 30d window resets from last activity)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-06-01T00:00:00.000Z");
  const soon = new Date(now.getTime() + 5 * DAY_MS).toISOString(); // 5d out — well inside the window
  const svc = (vector: ReturnType<typeof createInMemoryVectorStore>, runtimeStore: InMemoryRuntimeStore) =>
    createMemoryService({ vector, audit: runtimeStore, distiller: noopDistiller(), enabled: true, clock: () => now });
  const expiryOf = async (vector: ReturnType<typeof createInMemoryVectorStore>, ns: string) =>
    (await vector.query(ns, { text: "", k: 10 }))[0]?.metadata?.expiresAt;

  it("a consented, still-valid ORDINARY fact is slid forward to now + 30d on recall (the return resets the TTL)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ns = subjectNamespace("acme", "slide-ord");
    await vector.upsert(ns, [{ id: "f1", text: "prefers fragrance-free", metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: soon } }]);

    const ctx: MemoryCtx = { tenantId: "acme", anonId: "slide-ord", region: "us", consent1: "in", consent2: "unknown" };
    const facts = await svc(vector, runtimeStore).recall(ctx);
    expect(facts.map((f) => f.text)).toEqual(["prefers fragrance-free"]);
    expect(await expiryOf(vector, ns)).toBe(new Date(now.getTime() + ORDINARY_TTL_DAYS * DAY_MS).toISOString());
  });

  it("a WITHDRAWN-consent ordinary fact (consent1=out) is NEVER extended — its expiry is untouched (data-minimization)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ns = subjectNamespace("acme", "slide-withdrawn");
    await vector.upsert(ns, [{ id: "f1", text: "prefers fragrance-free", metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: soon } }]);

    const ctx: MemoryCtx = { tenantId: "acme", anonId: "slide-withdrawn", region: "us", consent1: "out", consent2: "unknown" };
    await svc(vector, runtimeStore).recall(ctx);
    expect(await expiryOf(vector, ns)).toBe(soon); // unchanged — withdrawn data ages out on its original schedule
  });

  it("a SPECIAL-category fact slides only with consent2=in; consent2=unknown does NOT extend it", async () => {
    const ns = subjectNamespace("acme", "slide-special");
    // consent2 = unknown → not extended
    const v1 = createInMemoryVectorStore();
    await v1.upsert(ns, [{ id: "s1", text: "tree-nut allergy", metadata: { text: "tree-nut allergy", class: "special", expiresAt: soon } }]);
    await svc(v1, new InMemoryRuntimeStore()).recall({ tenantId: "acme", anonId: "slide-special", region: "us", consent1: "in", consent2: "unknown" });
    expect(await expiryOf(v1, ns)).toBe(soon);

    // consent2 = in → slid forward to now + 30d
    const v2 = createInMemoryVectorStore();
    await v2.upsert(ns, [{ id: "s1", text: "tree-nut allergy", metadata: { text: "tree-nut allergy", class: "special", expiresAt: soon } }]);
    await svc(v2, new InMemoryRuntimeStore()).recall({ tenantId: "acme", anonId: "slide-special", region: "us", consent1: "in", consent2: "in" });
    expect(await expiryOf(v2, ns)).toBe(new Date(now.getTime() + SPECIAL_TTL_DAYS * DAY_MS).toISOString());
  });

  it("an already-expired fact is dropped, never resurrected or re-stamped by the slide", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ns = subjectNamespace("acme", "slide-expired");
    const past = new Date(now.getTime() - DAY_MS).toISOString();
    await vector.upsert(ns, [{ id: "f1", text: "old", metadata: { text: "old", class: "ordinary", expiresAt: past } }]);

    const facts = await svc(vector, runtimeStore).recall({ tenantId: "acme", anonId: "slide-expired", region: "us", consent1: "in", consent2: "unknown" });
    expect(facts).toEqual([]); // not returned
    expect(await expiryOf(vector, ns)).toBe(past); // and its expiry was NOT slid forward
  });
});

describe("retention — sweepExpired (reclaims storage; audited)", () => {
  it("deletes exactly the expired ids for the given subjects and emits a ttl_sweep audit", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const namespace = subjectNamespace("acme", "guest-sweep");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();
    const future = new Date("2030-01-01T00:00:00.000Z").toISOString();

    await vector.upsert(namespace, [
      { id: "expired-1", text: "a", metadata: { text: "a", class: "ordinary", expiresAt: past } },
      { id: "expired-2", text: "b", metadata: { text: "b", class: "ordinary", expiresAt: past } },
      { id: "alive-1", text: "c", metadata: { text: "c", class: "ordinary", expiresAt: future } },
    ]);

    const deleted = await sweepExpired({ vector, audit: runtimeStore }, "acme", ["guest-sweep"], now);
    expect(deleted).toBe(2);

    const remaining = await vector.query(namespace, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toEqual(["alive-1"]);

    const log = await runtimeStore.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("ttl_sweep");
  });

  it("a subject with nothing expired is left untouched — no delete, no audit", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const namespace = subjectNamespace("acme", "guest-fresh");
    const future = new Date("2030-01-01T00:00:00.000Z").toISOString();
    await vector.upsert(namespace, [{ id: "alive-1", text: "c", metadata: { text: "c", class: "ordinary", expiresAt: future } }]);

    const deleted = await sweepExpired(
      { vector, audit: runtimeStore },
      "acme",
      ["guest-fresh"],
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(deleted).toBe(0);

    const remaining = await vector.query(namespace, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toEqual(["alive-1"]);

    const log = await runtimeStore.readAudit({ tenantId: "acme" });
    expect(log).toEqual([]);
  });

  it("sweeps multiple subjects independently and sums the deleted count", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();

    await vector.upsert(subjectNamespace("acme", "guest-x"), [
      { id: "x-1", text: "a", metadata: { text: "a", class: "ordinary", expiresAt: past } },
    ]);
    await vector.upsert(subjectNamespace("acme", "guest-y"), [
      { id: "y-1", text: "b", metadata: { text: "b", class: "ordinary", expiresAt: past } },
    ]);

    const deleted = await sweepExpired({ vector, audit: runtimeStore }, "acme", ["guest-x", "guest-y"], now);
    expect(deleted).toBe(2);
  });
});
