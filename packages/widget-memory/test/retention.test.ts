import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore } from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace, floorNamespace } from "../src/identity.js";
import { recordSubject } from "../src/subject-index.js";
import {
  ORDINARY_TTL_DAYS,
  SPECIAL_TTL_DAYS,
  ttlForClass,
  sweepExpired,
  sweepAllSubjects,
  RENEW_MIN_GAP_MS,
} from "../src/retention.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// ADR-0015 Inv 4 (retention TTL, enforced not aspirational, sliding from last activity) + Inv 9 (per the
// 2026-08-04 amendment, TTL_special ≤ TTL_ordinary — both 30d). TTL-on-write is service.ts's `remember`
// (stamps `metadata.expiresAt`); TTL-on-read is service.ts's `recall` (drops expired facts AND slides the
// survivors forward, consent-gated + throttled + audited); this file proves both hold end-to-end, plus the
// periodic `sweepExpired` that reclaims storage.

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

  it("emits a ttl_renew audit when it slides a fact forward — the retention extension is never silent (Inv 6)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ns = subjectNamespace("acme", "slide-audit");
    await vector.upsert(ns, [{ id: "f1", text: "prefers fragrance-free", metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: soon } }]);

    await svc(vector, runtimeStore).recall({ tenantId: "acme", anonId: "slide-audit", region: "us", consent1: "in", consent2: "unknown" });
    const actions = (await runtimeStore.readAudit({ tenantId: "acme" })).map((r) => r.action);
    expect(actions).toContain("ttl_renew"); // the write is audited...
    expect(actions).toContain("recall"); // ...distinct from the read audit

    // a WITHDRAWN-consent recall extends nothing, so it emits NO ttl_renew.
    const v2 = createInMemoryVectorStore();
    const rs2 = new InMemoryRuntimeStore();
    await v2.upsert(ns, [{ id: "f1", text: "prefers fragrance-free", metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: soon } }]);
    await svc(v2, rs2).recall({ tenantId: "acme", anonId: "slide-audit", region: "us", consent1: "out", consent2: "unknown" });
    expect((await rs2.readAudit({ tenantId: "acme" })).map((r) => r.action)).not.toContain("ttl_renew");
  });

  it("throttled: a second recall within RENEW_MIN_GAP does not re-stamp again or emit a second ttl_renew", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ns = subjectNamespace("acme", "slide-throttle");
    await vector.upsert(ns, [{ id: "f1", text: "prefers fragrance-free", metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: soon } }]);
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "slide-throttle", region: "us", consent1: "in", consent2: "unknown" };

    let clockMs = now.getTime();
    const service = createMemoryService({ vector, audit: runtimeStore, distiller: noopDistiller(), enabled: true, clock: () => new Date(clockMs) });
    await service.recall(ctx); // first return → slides forward
    const afterFirst = await expiryOf(vector, ns);

    clockMs += RENEW_MIN_GAP_MS / 2; // a few hours later, well inside the throttle window
    await service.recall(ctx);
    expect(await expiryOf(vector, ns)).toBe(afterFirst); // NOT re-stamped again
    expect((await runtimeStore.readAudit({ tenantId: "acme" })).filter((r) => r.action === "ttl_renew")).toHaveLength(1); // only the first
  });
});

describe("retention — sliding TTL survives a same-cycle sweep (security review, Finding 8)", () => {
  // The review asked for: "a consented ('in') fact whose last stamp is >RENEW_MIN_GAP_MS old, one
  // recall, assert the fact survives [a sweep] and expiresAt moved forward." Composed here at the
  // widget-memory level (service.ts recall + retention.ts sweepExpired directly) rather than through a
  // real /chat turn — server.ts's `memoryPort` wrapper currently hardcodes consent1/consent2 to
  // "unknown" for every recall() call (a separate, pre-existing gap this PR does not fix — see
  // widget-backend/test/chat-retention-sweep.test.ts's note), so a genuine consent1="in" renewal cannot
  // be observed through a real /chat turn today. The ORDERING invariant this test proves — a fact
  // renewed by recall is never then swept as if expired — holds at this level regardless of that gap,
  // since it is a property of service.ts + retention.ts, not of server.ts's wiring.
  it("a fact renewed by recall (stamped >RENEW_MIN_GAP_MS ago, still consented 'in') is NOT deleted by a sweep run immediately after, and its expiry moved forward", async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = new Date("2026-06-01T00:00:00.000Z");
    // Stamped 2 days before `now` (> RENEW_MIN_GAP_MS = 1 day) but still comfortably un-expired.
    const originalExpiresAt = new Date(now.getTime() - 2 * DAY_MS + ORDINARY_TTL_DAYS * DAY_MS).toISOString();
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ns = subjectNamespace("acme", "slide-then-sweep");
    await vector.upsert(ns, [
      { id: "f1", text: "prefers fragrance-free", metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: originalExpiresAt } },
    ]);

    const service = createMemoryService({ vector, audit: runtimeStore, distiller: noopDistiller(), enabled: true, clock: () => now });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "slide-then-sweep", region: "us", consent1: "in", consent2: "unknown" };

    // Recall's renewal upsert (service.ts) is awaited here, exactly mirroring server.ts's own ordering —
    // it MUST complete before the sweep is invoked, so the sweep sees the already-renewed record.
    const recalled = await service.recall(ctx);
    expect(recalled.map((f) => f.text)).toEqual(["prefers fragrance-free"]); // served — not treated as expired
    const renewedExpiresAt = (await vector.query(ns, { text: "", k: 10 }))[0]?.metadata?.expiresAt as string;
    expect(new Date(renewedExpiresAt).getTime()).toBeGreaterThan(new Date(originalExpiresAt).getTime());

    // Immediately after (same cycle), a sweep for the SAME subject must NOT delete it — the renewal
    // already moved expiresAt into the future, so the sweep's own expiry check correctly skips it.
    const deleted = await sweepExpired({ vector, audit: runtimeStore }, "acme", ["slide-then-sweep"], now);
    expect(deleted).toBe(0);
    const remaining = await vector.query(ns, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toEqual(["f1"]); // still physically present

    const actions = (await runtimeStore.readAudit({ tenantId: "acme" })).map((r) => r.action);
    expect(actions).toContain("ttl_renew");
    expect(actions).not.toContain("ttl_sweep"); // nothing was expired -> the sweep decided nothing
  });
});

describe("retention — sweepExpired never deletes without its audit (security review, HIGH)", () => {
  it("a FAILING ttl_sweep audit aborts the delete for that subject — no deleted-but-unaudited records", async () => {
    // The guarantee is ordering, not luck: audit first, and only delete if it committed. If the audit
    // throws and we deleted anyway, a destructive autonomous action would be invisible in the immutable
    // log (ADR-0015 Inv 6 / NN#5). Reverting the order makes this test fail.
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const namespace = subjectNamespace("acme", "guest-auditfail");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await vector.upsert(namespace, [
      { id: "expired-1", text: "a", metadata: { text: "a", class: "ordinary", expiresAt: past } },
    ]);
    // Audit surface that rejects — a distressed/unavailable audit store.
    const failingAudit = {
      ...runtimeStore,
      audit: async () => { throw new Error("audit store unavailable"); },
    } as unknown as InMemoryRuntimeStore;

    const deleted = await sweepExpired(
      { vector, audit: failingAudit },
      "acme",
      ["guest-auditfail"],
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(deleted).toBe(0); // nothing counted as deleted...
    const remaining = await vector.query(namespace, { text: "", k: 10 });
    expect(remaining.map((r) => r.id)).toEqual(["expired-1"]); // ...and the record is genuinely still there
  });

  it("a subject whose audit succeeds is still swept normally (the guard does not block the happy path)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const namespace = subjectNamespace("acme", "guest-auditok");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();
    await vector.upsert(namespace, [
      { id: "expired-1", text: "a", metadata: { text: "a", class: "ordinary", expiresAt: past } },
    ]);

    const deleted = await sweepExpired({ vector, audit: runtimeStore }, "acme", ["guest-auditok"], new Date("2026-01-01T00:00:00.000Z"));
    expect(deleted).toBe(1);
    expect(await vector.query(namespace, { text: "", k: 10 })).toEqual([]);
    expect((await runtimeStore.readAudit({ tenantId: "acme" })).map((r) => r.action)).toContain("ttl_sweep");
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

describe("retention — PAGINATED sweep at scale (semantic-memory-v1 foundation, T2): 1500 facts, half expired", () => {
  it(
    "sweepExpired deletes EXACTLY the expired half (750 of 1500) — not just whatever the first " +
      "500-record scan happened to catch (today: query(ns,{text:'',k:500}) truncates to the first 500 " +
      "by ascending id, well short of the true expired count)",
    async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const namespace = subjectNamespace("acme", "guest-1500-sweep");
      const now = new Date("2026-01-01T00:00:00.000Z");
      const past = new Date("2020-01-01T00:00:00.000Z").toISOString();
      const future = new Date("2030-01-01T00:00:00.000Z").toISOString();

      // Interleaved by ascending id: the OLD truncate-at-first-500-scanned behavior would only ever
      // see ~250 expired (half of its own 500-record window) — nowhere near the true 750 — so this
      // proves genuine pagination, not an accidental pass from a lucky id ordering.
      const records = Array.from({ length: 1500 }, (_, i) => ({
        id: `f-${String(i).padStart(4, "0")}`,
        text: `fact ${i}`,
        metadata: { text: `fact ${i}`, class: "ordinary" as const, expiresAt: i % 2 === 0 ? past : future },
      }));
      await vector.upsert(namespace, records);

      const deleted = await sweepExpired({ vector, audit: runtimeStore }, "acme", ["guest-1500-sweep"], now);
      expect(deleted).toBe(750); // exactly the true expired half across all 1500, not the old ~250

      const remaining = await vector.query(namespace, { text: "", k: 2000 });
      expect(remaining).toHaveLength(750);
      expect(
        remaining.every((r) => new Date((r.metadata as { expiresAt: string }).expiresAt).getTime() > now.getTime()),
      ).toBe(true);
    },
  );
});

// #125 — retention.ts gap closed: special-category facts now live in the dedicated per-subject FLOOR
// namespace (identity.ts's `floorNamespace`), not the main subject namespace, so `sweepExpired` must
// reclaim BOTH namespaces — otherwise an expired special fact's TTL would never be physically swept from
// storage (TTL-on-read in service.ts's `recall` would still hide it from being served, but it would sit
// in the floor namespace forever). `sweepAllSubjects`'s retire check must likewise require BOTH
// namespaces confirmed empty, or it either orphans live floor rows (retiring too early) or never retires
// an ordinary-only subject (gating on a floor namespace that is always empty for them).
describe("retention — sweepExpired ALSO sweeps the floor namespace (#125)", () => {
  it("an expired floor row (special-category fact) IS swept — deleted from the floor namespace, not just the main one", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme";
    const anonId = "guest-floor-sweep";
    const floorNs = floorNamespace(tenantId, anonId);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();

    await vector.upsert(floorNs, [
      { id: "special-expired-1", text: "tree-nut allergy", metadata: { text: "tree-nut allergy", class: "special", expiresAt: past } },
    ]);

    const deleted = await sweepExpired({ vector, audit: runtimeStore }, tenantId, [anonId], now);
    expect(deleted).toBe(1);

    const remainingFloor = await vector.list(floorNs, { limit: 10 });
    expect(remainingFloor).toEqual([]);
  });

  it("a LIVE floor row is left untouched by the sweep", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme";
    const anonId = "guest-floor-live";
    const floorNs = floorNamespace(tenantId, anonId);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const future = new Date("2030-01-01T00:00:00.000Z").toISOString();

    await vector.upsert(floorNs, [
      { id: "special-live-1", text: "tree-nut allergy", metadata: { text: "tree-nut allergy", class: "special", expiresAt: future } },
    ]);

    const deleted = await sweepExpired({ vector, audit: runtimeStore }, tenantId, [anonId], now);
    expect(deleted).toBe(0);

    const remainingFloor = await vector.list(floorNs, { limit: 10 });
    expect(remainingFloor.map((r) => r.id)).toEqual(["special-live-1"]);
  });

  it("combines the main + floor expired counts into ONE returned total and ONE ttl_sweep audit entry (not two)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme";
    const anonId = "guest-floor-combined";
    const ns = subjectNamespace(tenantId, anonId);
    const floorNs = floorNamespace(tenantId, anonId);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();

    await vector.upsert(ns, [
      { id: "ordinary-expired-1", text: "a", metadata: { text: "a", class: "ordinary", expiresAt: past } },
    ]);
    await vector.upsert(floorNs, [
      { id: "special-expired-1", text: "b", metadata: { text: "b", class: "special", expiresAt: past } },
    ]);

    const deleted = await sweepExpired({ vector, audit: runtimeStore }, tenantId, [anonId], now);
    expect(deleted).toBe(2); // combined: 1 main + 1 floor

    expect(await vector.list(ns, { limit: 10 })).toEqual([]);
    expect(await vector.list(floorNs, { limit: 10 })).toEqual([]);

    const sweepAudits = (await runtimeStore.readAudit({ tenantId })).filter((r) => r.action === "ttl_sweep");
    expect(sweepAudits).toHaveLength(1); // ONE combined audit, not one per namespace
  });
});

describe("retention — sweepAllSubjects retires a subject only when BOTH namespaces are empty (#125)", () => {
  it("a subject with an empty main namespace but a LIVE floor row is NOT retired", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme";
    const anonId = "guest-floor-only";
    const floorNs = floorNamespace(tenantId, anonId);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const future = new Date("2030-01-01T00:00:00.000Z").toISOString();

    // Main namespace is empty (no ordinary facts) — only a live floor row exists.
    await vector.upsert(floorNs, [
      { id: "special-live-1", text: "tree-nut allergy", metadata: { text: "tree-nut allergy", class: "special", expiresAt: future } },
    ]);
    await recordSubject(runtimeStore, { tenantId, subject: anonId, now });

    const result = await sweepAllSubjects({ vector, audit: runtimeStore }, tenantId, { now });
    expect(result.retired).toBe(0);

    // still indexed — never dropped while the floor namespace still holds a live row
    const rows = await runtimeStore.list({ tenantId }, "memory_subjects");
    expect(rows.map((r) => (r.value as { subject: string }).subject)).toContain(anonId);
  });

  it("a subject is retired once BOTH the main and floor namespaces are confirmed empty", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme";
    const anonId = "guest-both-empty";
    const ns = subjectNamespace(tenantId, anonId);
    const floorNs = floorNamespace(tenantId, anonId);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();

    // Both namespaces hold only an EXPIRED row — the sweep clears both, leaving both empty.
    await vector.upsert(ns, [{ id: "ordinary-expired-1", text: "a", metadata: { text: "a", class: "ordinary", expiresAt: past } }]);
    await vector.upsert(floorNs, [{ id: "special-expired-1", text: "b", metadata: { text: "b", class: "special", expiresAt: past } }]);
    await recordSubject(runtimeStore, { tenantId, subject: anonId, now });

    const result = await sweepAllSubjects({ vector, audit: runtimeStore }, tenantId, { now });
    expect(result.deleted).toBe(2);
    expect(result.retired).toBe(1);

    const rows = await runtimeStore.list({ tenantId }, "memory_subjects");
    expect(rows.map((r) => (r.value as { subject: string }).subject)).not.toContain(anonId);
  });

  it("an ordinary-only subject (never wrote a special fact, floor namespace always empty) is still retired once its main namespace empties out", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const tenantId = "acme";
    const anonId = "guest-ordinary-only";
    const ns = subjectNamespace(tenantId, anonId);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const past = new Date("2020-01-01T00:00:00.000Z").toISOString();

    // No floor namespace write at all for this subject.
    await vector.upsert(ns, [{ id: "ordinary-expired-1", text: "a", metadata: { text: "a", class: "ordinary", expiresAt: past } }]);
    await recordSubject(runtimeStore, { tenantId, subject: anonId, now });

    const result = await sweepAllSubjects({ vector, audit: runtimeStore }, tenantId, { now });
    expect(result.retired).toBe(1); // an always-empty floor namespace never blocks retirement
  });
});
