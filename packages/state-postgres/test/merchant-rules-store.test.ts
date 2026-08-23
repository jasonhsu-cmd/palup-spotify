import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { merchantRulesContract } from "@palup/platform-ports/contract/merchant-rules";
import { CONSERVATIVE_DEFAULTS } from "@palup/platform-ports";
import { PGVECTOR_AVAILABLE, startPgvectorContainer } from "./helpers/pgvector-container.js";
import type { Sql } from "../src/sql.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import { PostgresMerchantRulesStore } from "../src/merchant-rules-store.js";

// Postgres adapter for `MerchantRulesStore` (W4-min task 5), verified against a REAL Postgres engine via
// the Docker testcontainer the other state-postgres container-backed tests use (PGVECTOR_TESTCONTAINER;
// `proposal-store.test.ts`'s beforeAll/afterAll precedent) — a real engine matters here because the
// mutation path relies on SERIALIZABLE isolation for concurrency-safety, which an in-process/
// single-connection fake can't prove.
//
// Skips cleanly (no failure) when Docker is unreachable: `PGVECTOR_TESTCONTAINER=off pnpm exec vitest
// run packages/state-postgres/test/merchant-rules-store.test.ts` must exit 0.

const ctx = { tenantId: "t1" };

describe.skipIf(!PGVECTOR_AVAILABLE)("PostgresMerchantRulesStore", () => {
  let sql: Sql;
  let stop: () => Promise<void>;
  let runtimeStore: PostgresRuntimeStore;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    runtimeStore = new PostgresRuntimeStore(sql);
    await runtimeStore.migrate();
    const bootstrap = new PostgresMerchantRulesStore(sql, runtimeStore);
    await bootstrap.migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  // The adapter must pass the SAME contract as the in-memory reference (task 2) — behavior-equivalence.
  merchantRulesContract(async () => {
    await sql.query("TRUNCATE pl_merchant_rules");
    await sql.query("TRUNCATE rs_audit");
    return new PostgresMerchantRulesStore(sql, runtimeStore);
  });

  describe("PostgresMerchantRulesStore — schema + engine-level guarantees", () => {
    it("migrate() creates pl_merchant_rules idempotently and does not lose data on re-run", async () => {
      await sql.query("TRUNCATE pl_merchant_rules");
      await sql.query("TRUNCATE rs_audit");
      const store = new PostgresMerchantRulesStore(sql, runtimeStore);
      await store.set(ctx, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
      await store.migrate(); // re-run, as happens on every boot
      expect((await store.get(ctx)).discount?.maxPct).toBe(25);
      const { rows } = await sql.query<{ n: string }>("SELECT count(*)::text AS n FROM pl_merchant_rules");
      expect(rows[0]?.n).toBe("1");
    });

    it("holds an exact column allowlist (tenant_id, envelope, provenance, updated_by, updated_at)", async () => {
      const { rows } = await sql.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name",
        ["pl_merchant_rules"],
      );
      expect(rows.map((r) => r.column_name)).toEqual(
        ["envelope", "provenance", "tenant_id", "updated_at", "updated_by"].sort(),
      );
    });

    it("persists provenance and updated_by as real, independently-queryable columns", async () => {
      await sql.query("TRUNCATE pl_merchant_rules");
      await sql.query("TRUNCATE rs_audit");
      const store = new PostgresMerchantRulesStore(sql, runtimeStore);
      await store.set(ctx, { refund: { allowedAuto: true, maxUsd: 20 } }, "alice@merchant.example", "merchant_set");
      const { rows } = await sql.query<{ provenance: string; updated_by: string }>(
        "SELECT provenance, updated_by FROM pl_merchant_rules WHERE tenant_id = $1",
        ["t1"],
      );
      expect(rows[0]?.provenance).toBe("merchant_set");
      expect(rows[0]?.updated_by).toBe("alice@merchant.example");
    });

    it("writes an audit record via RuntimeStatePort.audit on every set()", async () => {
      await sql.query("TRUNCATE pl_merchant_rules");
      await sql.query("TRUNCATE rs_audit");
      const store = new PostgresMerchantRulesStore(sql, runtimeStore);
      await store.set(ctx, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
      const records = await runtimeStore.readAudit(ctx);
      expect(records).toHaveLength(1);
      expect(records[0]?.action).toBe("rules.changed");
      expect(records[0]?.actor).toBe("owner");
      const verified = await runtimeStore.verifyAudit(ctx);
      expect(verified.ok).toBe(true);
    });

    it("tenant isolation is enforced at the ENGINE level: a raw cross-tenant row never surfaces via get", async () => {
      await sql.query("TRUNCATE pl_merchant_rules");
      await sql.query("TRUNCATE rs_audit");
      const store = new PostgresMerchantRulesStore(sql, runtimeStore);
      await store.set({ tenantId: "t1" }, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
      await store.set({ tenantId: "t2" }, { refund: { allowedAuto: true, maxUsd: 20 } }, "owner", "merchant_set");
      expect((await store.get({ tenantId: "t1" })).discount?.maxPct).toBe(25);
      expect((await store.get({ tenantId: "t1" })).refund?.allowedAuto ?? false).toBe(
        CONSERVATIVE_DEFAULTS.refund?.allowedAuto ?? false,
      );
      expect((await store.get({ tenantId: "t2" })).refund?.maxUsd).toBe(20);
    });

    it("a second set() re-reads the CURRENT row rather than blind-overwriting (last patch wins per category)", async () => {
      await sql.query("TRUNCATE pl_merchant_rules");
      await sql.query("TRUNCATE rs_audit");
      const store = new PostgresMerchantRulesStore(sql, runtimeStore);
      await store.set(ctx, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
      await store.set(ctx, { refund: { allowedAuto: true, maxUsd: 20 } }, "owner", "merchant_set");
      const got = await store.get(ctx);
      expect(got.discount?.maxPct).toBe(25); // untouched by the 2nd set — still there
      expect(got.refund?.maxUsd).toBe(20);
    });
  });
});
