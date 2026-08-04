import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace } from "../src/identity.js";
import { listSubjects, recordSubject, retireSubject, MEMORY_SUBJECTS } from "../src/subject-index.js";
import { sweepAllSubjects } from "../src/retention.js";

// B4 — "retention actually enforced" (ADR-0015 Inv 4: "expiry is enforced, not aspirational").
//
// THE GAP THIS CLOSES. `sweepExpired` reclaims storage, but its only production caller is an
// opportunistic per-turn sweep on /chat scoped to the subject being served THAT TURN. So a shopper who
// returns cleans up after themselves, and a shopper who NEVER RETURNS is never reclaimed at all — their
// expired facts sit in durable storage indefinitely. TTL-on-read (service.ts `recall`) still guarantees
// such a fact is never SERVED, so this is a storage/retention-hygiene gap rather than a serving one, but
// Inv 4 is about expiry being real.
//
// WHY IT COULD NOT SIMPLY BE FIXED. There was no way to ENUMERATE a tenant's subjects. `VectorPort` has
// no namespace-listing operation (vector-port.ts) and adding one would push a non-portable requirement
// onto every adapter (ADR-0001). The `memory_consent` KV is per-subject but only has a row for someone
// who RECORDED a consent choice — in the US opt-out regime the common case is a shopper who never
// answered, writes facts on "unknown", and therefore has no consent row at all. So the index has to be
// driven by the WRITE, which is what `subject-index.ts` does.
//
// PRIVACY NOTE (deliberate, not overlooked): this index stores raw subject ids. That is not a new class
// of data — `memory_consent` (state-postgres/runtime-consent-store.ts) already stores exactly the same
// ids, tenant-scoped, in the same KV. No fact text, no message content.

const TENANT = "demo";
const DAY_MS = 24 * 60 * 60 * 1000;

function deps(store: InMemoryRuntimeStore, vector: ReturnType<typeof createInMemoryVectorStore>) {
  return { vector, audit: store };
}

async function seedExpiredFact(vector: ReturnType<typeof createInMemoryVectorStore>, subject: string, id = "f1") {
  await vector.upsert(subjectNamespace(TENANT, subject), [
    { id, text: "prefers fragrance-free", metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: new Date(Date.now() - DAY_MS).toISOString() } },
  ]);
}

async function seedLiveFact(vector: ReturnType<typeof createInMemoryVectorStore>, subject: string, id = "f-live") {
  await vector.upsert(subjectNamespace(TENANT, subject), [
    { id, text: "likes matte finish", metadata: { text: "likes matte finish", class: "ordinary", expiresAt: new Date(Date.now() + 10 * DAY_MS).toISOString() } },
  ]);
}

const countIn = async (vector: ReturnType<typeof createInMemoryVectorStore>, subject: string) =>
  (await vector.query(subjectNamespace(TENANT, subject), { text: "", k: 100 })).length;

describe("B4 — the subject index", () => {
  it("records, lists, and retires a subject", async () => {
    const store = new InMemoryRuntimeStore();
    await recordSubject(store, { tenantId: TENANT, subject: "SUBJECTAAA" });
    await recordSubject(store, { tenantId: TENANT, subject: "SUBJECTBBB" });

    const listed = (await listSubjects(store, TENANT)).map((e) => e.subject).sort();
    expect(listed).toEqual(["SUBJECTAAA", "SUBJECTBBB"]);

    await retireSubject(store, { tenantId: TENANT, subject: "SUBJECTAAA" });
    expect((await listSubjects(store, TENANT)).map((e) => e.subject)).toEqual(["SUBJECTBBB"]);
  });

  it("is TENANT-SCOPED — one tenant's sweep can never enumerate another's subjects", async () => {
    const store = new InMemoryRuntimeStore();
    await recordSubject(store, { tenantId: "tenant-a", subject: "AAA" });
    await recordSubject(store, { tenantId: "tenant-b", subject: "BBB" });

    expect((await listSubjects(store, "tenant-a")).map((e) => e.subject)).toEqual(["AAA"]);
    expect((await listSubjects(store, "tenant-b")).map((e) => e.subject)).toEqual(["BBB"]);
  });

  it("re-recording the same subject updates it in place rather than duplicating", async () => {
    const store = new InMemoryRuntimeStore();
    await recordSubject(store, { tenantId: TENANT, subject: "SUBJECTAAA" });
    await recordSubject(store, { tenantId: TENANT, subject: "SUBJECTAAA" });
    expect(await listSubjects(store, TENANT)).toHaveLength(1);
  });
});

describe("B4 — remember() indexes the subject it just wrote for", () => {
  it("a fact write adds the subject to the index", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const svc = createMemoryService({ vector, audit: store, enabled: true });

    await svc.remember(
      { tenantId: TENANT, anonId: "SUBJECTAAA", region: "us", consent1: "unknown", consent2: "unknown" },
      { message: "I prefer fragrance-free products", reply: "noted" },
    );

    expect((await listSubjects(store, TENANT)).map((e) => e.subject)).toContain("SUBJECTAAA");
  });

  it("a turn that writes NOTHING (opted out) indexes nothing — the index tracks stored data, not visitors", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const svc = createMemoryService({ vector, audit: store, enabled: true });

    await svc.remember(
      { tenantId: TENANT, anonId: "SUBJECTAAA", region: "us", consent1: "out", consent2: "out" },
      { message: "I prefer fragrance-free products", reply: "noted" },
    );

    expect(await listSubjects(store, TENANT)).toHaveLength(0);
  });

  it("INERT: with memory off, no index entry is written (the double gate short-circuits first)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const svc = createMemoryService({ vector, audit: store }); // no `enabled` seam ⇒ flag.ts governs ⇒ off

    await svc.remember(
      { tenantId: TENANT, anonId: "SUBJECTAAA", region: "us", consent1: "in", consent2: "in" },
      { message: "I prefer fragrance-free products", reply: "noted" },
    );

    expect(await listSubjects(store, TENANT)).toHaveLength(0);
  });

  it("an index-write failure NEVER fails the turn — the fact is still stored and audited", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const put = vi.spyOn(store, "put").mockImplementation(async (_ctx, collection) => {
      if (collection === MEMORY_SUBJECTS) throw new Error("kv down");
    });
    const svc = createMemoryService({ vector, audit: store, enabled: true });

    await expect(
      svc.remember(
        { tenantId: TENANT, anonId: "SUBJECTAAA", region: "us", consent1: "unknown", consent2: "unknown" },
        { message: "I prefer fragrance-free products", reply: "noted" },
      ),
    ).resolves.not.toThrow();

    expect(await countIn(vector, "SUBJECTAAA")).toBeGreaterThan(0); // the fact itself landed
    put.mockRestore();
  });
});

describe("B4 — sweepAllSubjects: the shopper who NEVER RETURNS is finally reclaimed", () => {
  it("THE GAP: deletes an absent subject's expired facts without them ever chatting again", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await recordSubject(store, { tenantId: TENANT, subject: "GONEFOREVER" });
    await seedExpiredFact(vector, "GONEFOREVER");
    expect(await countIn(vector, "GONEFOREVER")).toBe(1);

    const result = await sweepAllSubjects(deps(store, vector), TENANT);

    expect(result.deleted).toBe(1);
    expect(await countIn(vector, "GONEFOREVER")).toBe(0);
  });

  it("leaves UNEXPIRED facts alone — this reclaims expiry, it is not a bulk delete", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await recordSubject(store, { tenantId: TENANT, subject: "STILLVALID" });
    await seedLiveFact(vector, "STILLVALID");

    const result = await sweepAllSubjects(deps(store, vector), TENANT);

    expect(result.deleted).toBe(0);
    expect(await countIn(vector, "STILLVALID")).toBe(1);
  });

  it("retires a subject whose namespace is now empty, so the index cannot grow without bound", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await recordSubject(store, { tenantId: TENANT, subject: "GONEFOREVER" });
    await seedExpiredFact(vector, "GONEFOREVER");

    const result = await sweepAllSubjects(deps(store, vector), TENANT);

    expect(result.retired).toBe(1);
    expect(await listSubjects(store, TENANT)).toHaveLength(0);
  });

  it("keeps the index entry for a subject who still has live facts", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await recordSubject(store, { tenantId: TENANT, subject: "STILLVALID" });
    await seedLiveFact(vector, "STILLVALID");

    await sweepAllSubjects(deps(store, vector), TENANT);

    expect((await listSubjects(store, TENANT)).map((e) => e.subject)).toEqual(["STILLVALID"]);
  });

  it("is BOUNDED by maxSubjects and reports the truncation rather than hiding it", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    for (const s of ["SUBJECTAAA", "SUBJECTBBB", "SUBJECTCCC"]) {
      await recordSubject(store, { tenantId: TENANT, subject: s });
      await seedExpiredFact(vector, s);
    }

    const result = await sweepAllSubjects(deps(store, vector), TENANT, { maxSubjects: 2 });

    expect(result.visited).toBe(2);
    expect(result.remaining).toBe(1); // a caller/operator can see work was left behind
    expect(result.deleted).toBe(2);
  });

  it("one subject's failure does not abort the run — the rest are still swept", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    for (const s of ["BROKENSUBJ", "HEALTHYSUB"]) {
      await recordSubject(store, { tenantId: TENANT, subject: s });
      await seedExpiredFact(vector, s);
    }
    const realQuery = vector.query.bind(vector);
    vi.spyOn(vector, "query").mockImplementation(async (ns, q) => {
      if (ns === subjectNamespace(TENANT, "BROKENSUBJ")) throw new Error("vector down");
      return realQuery(ns, q);
    });

    const result = await sweepAllSubjects(deps(store, vector), TENANT);

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1); // HEALTHYSUB still reclaimed
    vi.restoreAllMocks();
  });

  it("tenant isolation: sweeping one tenant never touches another's facts", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await recordSubject(store, { tenantId: "tenant-a", subject: "SUBJECTAAA" });
    await recordSubject(store, { tenantId: "tenant-b", subject: "SUBJECTBBB" });
    await vector.upsert(subjectNamespace("tenant-b", "SUBJECTBBB"), [
      { id: "f1", text: "x", metadata: { text: "x", class: "ordinary", expiresAt: new Date(Date.now() - DAY_MS).toISOString() } },
    ]);

    const result = await sweepAllSubjects(deps(store, vector), "tenant-a");

    expect(result.deleted).toBe(0);
    expect((await vector.query(subjectNamespace("tenant-b", "SUBJECTBBB"), { text: "", k: 10 })).length).toBe(1);
  });
});
