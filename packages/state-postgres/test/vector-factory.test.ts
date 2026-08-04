import { describe, it, expect, afterEach } from "vitest";
import { createVectorStore } from "../src/vector-factory.js";
import type { Sql } from "../src/sql.js";

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

  // Security review, MEDIUM — createVectorStore was missing createRuntimeStore's OWN identical fail-fast
  // guard, so a prod misconfig would silently degrade to a per-process in-memory store and POST /forget
  // would then return {ok:true} + write an `erase.subject` audit record for an erasure that never
  // durably happened.
  const originalRequire = process.env.PALUP_REQUIRE_DATABASE_URL;
  afterEach(() => {
    if (originalRequire === undefined) delete process.env.PALUP_REQUIRE_DATABASE_URL;
    else process.env.PALUP_REQUIRE_DATABASE_URL = originalRequire;
  });

  it("FAILS FAST when PALUP_REQUIRE_DATABASE_URL=true and DATABASE_URL is unset (mirrors createRuntimeStore)", async () => {
    delete process.env.DATABASE_URL;
    process.env.PALUP_REQUIRE_DATABASE_URL = "true";
    await expect(createVectorStore()).rejects.toThrow(/PALUP_REQUIRE_DATABASE_URL/);
  });

  it("does NOT fail fast when PALUP_REQUIRE_DATABASE_URL is unset/false (byte-identical to before)", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.PALUP_REQUIRE_DATABASE_URL;
    const { kind } = await createVectorStore();
    expect(kind).toBe("memory");
  });

  // Security review, HIGH — vector-factory previously created a SECOND, unshared pg.Pool unconditionally
  // whenever DATABASE_URL was set, doubling per-process Postgres connections even when the caller already
  // had one (widget-backend/server.ts constructs the run-time state store's pool first). Passing a
  // fake DATABASE_URL that would hang/fail a REAL pg.Pool proves the shared `sql` is actually used instead
  // of the factory opening its own connection — if it ignored `sql` and dialed the fake host, this test
  // would time out / throw a connection error rather than resolve.
  it("uses the SHARED sql executor passed in — never opens its own pool when one is provided", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@vector-factory-test.invalid:5432/nope";
    const calls: string[] = [];
    const sql: Sql = {
      query: async (text) => {
        calls.push(text);
        return { rows: [] };
      },
      tx: async (fn) => fn(sql),
    };
    const { kind } = await createVectorStore(sql);
    expect(kind).toBe("postgres");
    expect(calls.some((c) => /CREATE TABLE/i.test(c))).toBe(true); // migrate() ran against the SHARED sql
  });
});
