import { describe, it, expect, afterEach } from "vitest";
import { createVectorStore } from "../src/vector-factory.js";

// Mirrors the (untested-at-the-factory-level, precedent: state-postgres/src/factory.ts has no dedicated
// factory.test.ts either — the Postgres BRANCH's real behavior is instead proven directly against pglite
// in postgres-vector-store.test.ts) env-driven selection: no DATABASE_URL -> in-memory (local/dev/test),
// DATABASE_URL set -> Postgres. We only exercise the in-memory branch here without a live DB; the
// Postgres branch's actual query/erasure behavior is fully covered by the pglite contract + durability
// tests in postgres-vector-store.test.ts (this factory's Postgres branch is a 3-line delegation to
// PostgresVectorStore + pgPoolSqlFromUrl, identical in shape to createRuntimeStore's own untested-at-
// this-level Postgres branch).

describe("createVectorStore", () => {
  const originalUrl = process.env.DATABASE_URL;
  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it('selects the in-memory adapter (kind "memory") when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;
    const { store, kind } = await createVectorStore();
    expect(kind).toBe("memory");
    // Sanity: it is a genuinely functioning VectorPort, not a stub.
    await store.upsert("t", [{ id: "a", text: "hello" }]);
    expect((await store.query("t", { text: "", k: 10 })).map((h) => h.id)).toEqual(["a"]);
  });

  it("in-memory instances from separate createVectorStore() calls do NOT share state (per-process, as documented)", async () => {
    delete process.env.DATABASE_URL;
    const first = (await createVectorStore()).store;
    const second = (await createVectorStore()).store;
    await first.upsert("t", [{ id: "a", text: "hello" }]);
    expect(await second.query("t", { text: "", k: 10 })).toEqual([]); // proves it's a fresh store, not a shared singleton
  });
});
