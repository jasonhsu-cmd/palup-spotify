import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { primaryGoalContract } from "@palup/platform-ports/contract/primary-goal";
import { PGVECTOR_AVAILABLE, startPgvectorContainer } from "./helpers/pgvector-container.js";
import type { Sql } from "../src/sql.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import { PostgresPrimaryGoalStore } from "../src/primary-goal-store.js";

// W2 Task 2: the durable twin of `InMemoryPrimaryGoalStore` (the behavioral oracle — both run
// `primaryGoalContract`). Verified against a REAL Postgres engine via the shared testcontainer;
// skips cleanly (exit 0) when Docker is unreachable, same as merchant-rules-store.test.ts.

const ctx = { tenantId: "t1" };

describe.skipIf(!PGVECTOR_AVAILABLE)("PostgresPrimaryGoalStore", () => {
  let sql: Sql;
  let stop: () => Promise<void>;
  let runtimeStore: PostgresRuntimeStore;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    runtimeStore = new PostgresRuntimeStore(sql);
    await runtimeStore.migrate();
    const bootstrap = new PostgresPrimaryGoalStore(sql, runtimeStore);
    await bootstrap.migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  primaryGoalContract(async () => {
    await sql.query("TRUNCATE pl_primary_goal");
    await sql.query("TRUNCATE rs_audit");
    return new PostgresPrimaryGoalStore(sql, runtimeStore);
  });

  it("migrate() is idempotent", async () => {
    const s = new PostgresPrimaryGoalStore(sql, runtimeStore);
    await s.migrate();
    await s.migrate();
  });

  it("the CHECK constraint rejects an un-vetted kind written outside the adapter", async () => {
    await expect(
      sql.query("INSERT INTO pl_primary_goal (tenant_id, kind, note, set_by, set_at) VALUES ('tX','engagement_maxxing',NULL,'u','2026-08-24T00:00:00.000Z')"),
    ).rejects.toThrow();
  });

  it("audits goal.changed into the SHARED rs_audit chain after a successful set", async () => {
    await sql.query("TRUNCATE pl_primary_goal");
    await sql.query("TRUNCATE rs_audit");
    const s = new PostgresPrimaryGoalStore(sql, runtimeStore, { now: () => "2026-08-24T00:00:00.000Z" });
    await s.set(ctx, { kind: "recover_carts" }, "u1");
    const audit = await runtimeStore.readAudit(ctx);
    expect(audit.some((r) => r.action === "goal.changed" && r.actor === "u1")).toBe(true);
  });

  it("rejects a blank tenantId (tenant isolation, fail-closed)", async () => {
    const s = new PostgresPrimaryGoalStore(sql, runtimeStore);
    await expect(s.get({ tenantId: " " })).rejects.toThrow(/tenantId/);
  });
});
