import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { learnedStoreContract } from "@palup/platform-ports/contract/learned-store";
import { type RuntimeStatePort } from "@palup/platform-ports";
import { PGVECTOR_AVAILABLE, startPgvectorContainer } from "./helpers/pgvector-container.js";
import type { Sql } from "../src/sql.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import { PostgresLearnedStore } from "../src/learned-store.js";

// Postgres adapter for `LearnedStore` (W3 Task 3; the durable twin of `InMemoryLearnedStore`, Task 1).
// Verified against a REAL Postgres engine via the Docker testcontainer the other state-postgres
// container-backed tests use (PGVECTOR_TESTCONTAINER; `merchant-rules-store.test.ts`'s precedent).
//
// Skips cleanly (no failure) when Docker is unreachable: `PGVECTOR_TESTCONTAINER=off pnpm exec vitest
// run packages/state-postgres/test/learned-store.test.ts` must exit 0.

describe.skipIf(!PGVECTOR_AVAILABLE)("PostgresLearnedStore", () => {
  let sql: Sql;
  let stop: () => Promise<void>;
  let runtimeStore: PostgresRuntimeStore;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    runtimeStore = new PostgresRuntimeStore(sql);
    await runtimeStore.migrate();
    await new PostgresLearnedStore(sql, runtimeStore).migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  // The adapter must pass the SAME contract as the in-memory reference (Task 1) — behavior-equivalence.
  learnedStoreContract(async () => {
    await sql.query("TRUNCATE pl_learned_insight");
    return new PostgresLearnedStore(sql, runtimeStore);
  });

  describe("PostgresLearnedStore — schema + engine-level guarantees", () => {
    it("records an audit row in rs_audit for a recorded insight", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      const store: RuntimeStatePort = runtimeStore;
      const s = new PostgresLearnedStore(sql, runtimeStore);
      await s.record({ tenantId: "t9" }, {
        id: "a", tenantId: "t9", category: "voice", tier: "private", origin: "merchant_taught",
        text: "no exclamation marks in apologies", grounding: { source: "merchant_taught", sampleSize: 0, confidence: "high" },
        pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
      }, "owner");
      expect((await store.readAudit({ tenantId: "t9" })).some((r) => r.action === "learned.recorded")).toBe(true);
    });

    it("migrate() creates pl_learned_insight idempotently and does not lose data on re-run", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      const store = new PostgresLearnedStore(sql, runtimeStore);
      await store.record({ tenantId: "t1" }, {
        id: "a", tenantId: "t1", category: "products", tier: "private", origin: "synthesized",
        text: "bestseller is SKU-123", grounding: { source: "orders", sampleSize: 250, confidence: "high" },
        pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
      }, "owner");
      await store.migrate(); // re-run, as happens on every boot
      expect(await store.get({ tenantId: "t1" }, "a")).not.toBeNull();
      const { rows } = await sql.query<{ n: string }>("SELECT count(*)::text AS n FROM pl_learned_insight");
      expect(rows[0]?.n).toBe("1");
    });

    it("holds an exact column allowlist", async () => {
      const { rows } = await sql.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name",
        ["pl_learned_insight"],
      );
      expect(rows.map((r) => r.column_name)).toEqual(
        [
          "tenant_id", "id", "category", "tier", "origin", "text", "source", "sample_size",
          "confidence", "pinned", "created_at", "updated_at",
        ].sort(),
      );
    });

    it("category is CHECK-constrained at the ENGINE level to the LearnedCategory union", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      await expect(
        sql.query(
          `INSERT INTO pl_learned_insight
             (tenant_id, id, category, tier, origin, text, source, sample_size, confidence, pinned, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          ["t1", "a", "not_a_real_category", "private", "synthesized", "text", "src", 100, "high", false,
            "2026-08-24T00:00:00Z", "2026-08-24T00:00:00Z"],
        ),
      ).rejects.toThrow();
    });

    it("tier is CHECK-constrained at the ENGINE level", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      await expect(
        sql.query(
          `INSERT INTO pl_learned_insight
             (tenant_id, id, category, tier, origin, text, source, sample_size, confidence, pinned, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          ["t1", "a", "voice", "not_a_real_tier", "synthesized", "text", "src", 100, "high", false,
            "2026-08-24T00:00:00Z", "2026-08-24T00:00:00Z"],
        ),
      ).rejects.toThrow();
    });

    it("origin is CHECK-constrained at the ENGINE level", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      await expect(
        sql.query(
          `INSERT INTO pl_learned_insight
             (tenant_id, id, category, tier, origin, text, source, sample_size, confidence, pinned, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          ["t1", "a", "voice", "private", "not_a_real_origin", "text", "src", 100, "high", false,
            "2026-08-24T00:00:00Z", "2026-08-24T00:00:00Z"],
        ),
      ).rejects.toThrow();
    });

    it("confidence is CHECK-constrained at the ENGINE level", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      await expect(
        sql.query(
          `INSERT INTO pl_learned_insight
             (tenant_id, id, category, tier, origin, text, source, sample_size, confidence, pinned, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          ["t1", "a", "voice", "private", "synthesized", "text", "src", 100, "low", false,
            "2026-08-24T00:00:00Z", "2026-08-24T00:00:00Z"],
        ),
      ).rejects.toThrow();
    });

    it("a blank tenant_id is rejected at the ENGINE level", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      await expect(
        sql.query(
          `INSERT INTO pl_learned_insight
             (tenant_id, id, category, tier, origin, text, source, sample_size, confidence, pinned, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          ["   ", "a", "voice", "private", "synthesized", "text", "src", 100, "high", false,
            "2026-08-24T00:00:00Z", "2026-08-24T00:00:00Z"],
        ),
      ).rejects.toThrow();
    });

    it("tenant isolation is enforced at the ENGINE level: a raw cross-tenant row never surfaces via get/list", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      const store = new PostgresLearnedStore(sql, runtimeStore);
      await store.record({ tenantId: "t1" }, {
        id: "a", tenantId: "t1", category: "voice", tier: "private", origin: "synthesized",
        text: "t1 insight", grounding: { source: "orders", sampleSize: 100, confidence: "medium" },
        pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
      }, "owner");
      await store.record({ tenantId: "t2" }, {
        id: "a", tenantId: "t2", category: "voice", tier: "private", origin: "synthesized",
        text: "t2 insight", grounding: { source: "orders", sampleSize: 100, confidence: "medium" },
        pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
      }, "owner");
      expect((await store.get({ tenantId: "t1" }, "a"))?.text).toBe("t1 insight");
      expect((await store.get({ tenantId: "t2" }, "a"))?.text).toBe("t2 insight");
      expect((await store.list({ tenantId: "t1" })).map((i) => i.text)).toEqual(["t1 insight"]);
    });

    it("setPinned audits learned.pinned and remove audits learned.removed", async () => {
      await sql.query("TRUNCATE pl_learned_insight");
      const store = new PostgresLearnedStore(sql, runtimeStore);
      await store.record({ tenantId: "t3" }, {
        id: "a", tenantId: "t3", category: "voice", tier: "private", origin: "synthesized",
        text: "insight", grounding: { source: "orders", sampleSize: 100, confidence: "medium" },
        pinned: false, createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
      }, "owner");
      await store.setPinned({ tenantId: "t3" }, "a", true, "owner", "2026-08-24T01:00:00Z");
      await store.remove({ tenantId: "t3" }, "a", "owner", "2026-08-24T02:00:00Z");
      const records = await runtimeStore.readAudit({ tenantId: "t3" });
      expect(records.map((r) => r.action)).toEqual(["learned.recorded", "learned.pinned", "learned.removed"]);
    });
  });
});
