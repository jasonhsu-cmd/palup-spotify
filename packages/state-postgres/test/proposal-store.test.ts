import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { proposalStoreContract } from "@palup/agent-runtime/contract/proposal-store";
import { VersionConflictError, ProposalNotFoundError, type Proposal } from "@palup/agent-runtime";
import { PGVECTOR_AVAILABLE, startPgvectorContainer } from "./helpers/pgvector-container.js";
import type { Sql } from "../src/sql.js";
import { PostgresProposalStore } from "../src/proposal-store.js";

// Postgres adapter for `ProposalStore` (E1 Task 8), verified against a REAL Postgres engine via the
// Docker testcontainer the other state-postgres container-backed tests use (PGVECTOR_TESTCONTAINER;
// `pgvector-store.contract.test.ts`'s beforeAll/afterAll precedent) — a real engine matters here
// because the optimistic-lock CAS ("UPDATE ... WHERE version=$expected") is exactly the kind of thing
// an in-process/single-connection fake can't prove. `PGVECTOR_AVAILABLE` is the same Docker-reachability
// gate the vector tests use — the extension itself is not needed, only a real Postgres.
//
// Skips cleanly (no failure) when Docker is unreachable: `PGVECTOR_TESTCONTAINER=off pnpm exec vitest
// run packages/state-postgres/test/proposal-store.test.ts` must exit 0.

const base = (id: string, over: Partial<Proposal> = {}): Proposal => ({
  id,
  tenantId: "t1",
  agentId: "a",
  agentType: "win_back",
  action: { type: "issue_discount", params: { code: "SAVE10", percent: 10 }, blastRadius: 3 },
  category: "discount",
  rationale: "r",
  boundaryReasons: [{ rule: "discount>5pct", detail: "10% exceeds auto floor" }],
  reversalPlan: { reversible: true, plan: "revoke the discount code" },
  preconditions: { skuInStock: true },
  status: "pending",
  version: 0,
  createdAt: "2026-08-23T00:00:00Z",
  expiresAt: "2026-08-24T00:00:00Z",
  ...over,
});

describe.skipIf(!PGVECTOR_AVAILABLE)("PostgresProposalStore", () => {
  let sql: Sql;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    const bootstrap = new PostgresProposalStore(sql);
    await bootstrap.migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  // The adapter must pass the SAME contract as the in-memory reference (Task 2) — behavior-equivalence.
  proposalStoreContract(async () => {
    await sql.query("TRUNCATE pl_proposal");
    return new PostgresProposalStore(sql);
  });

  describe("PostgresProposalStore — schema + engine-level guarantees", () => {
    it("migrate() creates pl_proposal idempotently and does not lose data on re-run", async () => {
      await sql.query("TRUNCATE pl_proposal");
      const store = new PostgresProposalStore(sql);
      await store.create(base("p1"));
      await store.migrate(); // re-run, as happens on every boot
      expect((await store.get({ tenantId: "t1" }, "p1"))?.id).toBe("p1");
      const { rows } = await sql.query<{ n: string }>("SELECT count(*)::text AS n FROM pl_proposal");
      expect(rows[0]?.n).toBe("1");
    });

    it("round-trips nested JSONB (action/params/boundaryReasons/preconditions/reversalPlan) exactly", async () => {
      await sql.query("TRUNCATE pl_proposal");
      const store = new PostgresProposalStore(sql);
      const created = await store.create(
        base("p1", {
          action: { type: "send_campaign", params: { segments: ["vip", "lapsed"], nested: { a: 1, b: [1, 2, 3] } }, irreversible: true, blastRadius: 500 },
          boundaryReasons: [
            { rule: "mass_send_floor", detail: "blastRadius 500 exceeds 200" },
            { rule: "irreversible", detail: "email send cannot be recalled" },
          ],
          estimatedImpact: { amountUsd: 12.5, reach: 500, note: "vip win-back" },
        }),
      );
      const fetched = await store.get({ tenantId: "t1" }, "p1");
      expect(fetched).toEqual(created);
      expect(fetched?.action.params).toEqual({ segments: ["vip", "lapsed"], nested: { a: 1, b: [1, 2, 3] } });
      expect(fetched?.boundaryReasons).toHaveLength(2);
      expect(fetched?.estimatedImpact).toEqual({ amountUsd: 12.5, reach: 500, note: "vip win-back" });
    });

    it("optional fields are ABSENT (not null) when unset — parity with the in-memory oracle's shape", async () => {
      await sql.query("TRUNCATE pl_proposal");
      const store = new PostgresProposalStore(sql);
      const created = await store.create(base("p1"));
      expect(Object.hasOwn(created, "estimatedImpact")).toBe(false);
      expect(Object.hasOwn(created, "decidedBy")).toBe(false);
      expect(Object.hasOwn(created, "decidedAt")).toBe(false);
      expect(Object.hasOwn(created, "decisionNote")).toBe(false);
      expect(Object.hasOwn(created, "executionId")).toBe(false);
      expect(Object.hasOwn(created, "executedAt")).toBe(false);
      expect(Object.hasOwn(created, "executionResult")).toBe(false);
      const fetched = await store.get({ tenantId: "t1" }, "p1");
      expect(fetched).toStrictEqual(created);
    });

    it("the CAS UPDATE genuinely gates on the version column at the ENGINE level, not just app logic", async () => {
      await sql.query("TRUNCATE pl_proposal");
      const store = new PostgresProposalStore(sql);
      await store.create(base("p1"));
      // A raw UPDATE bumping the row's version out from under the adapter (simulating a concurrent
      // writer the adapter never went through) — only the SQL WHERE clause can catch this.
      await sql.query("UPDATE pl_proposal SET version = 5 WHERE tenant_id='t1' AND id='p1'");
      await expect(store.transition({ tenantId: "t1" }, "p1", 0, { status: "approved" })).rejects.toBeInstanceOf(
        VersionConflictError,
      );
      const err = await store
        .transition({ tenantId: "t1" }, "p1", 0, { status: "approved" })
        .catch((e: unknown) => e as VersionConflictError);
      expect(err.actualVersion).toBe(5);
      expect(err.expectedVersion).toBe(0);
    });

    it("transition() is a no-op on the row when it throws — a failed CAS leaves the stored row untouched", async () => {
      await sql.query("TRUNCATE pl_proposal");
      const store = new PostgresProposalStore(sql);
      await store.create(base("p1"));
      await store.transition({ tenantId: "t1" }, "p1", 0, { status: "approved", decidedBy: "owner" });
      await expect(
        store.transition({ tenantId: "t1" }, "p1", 0, { status: "rejected", decisionNote: "too late" }),
      ).rejects.toBeInstanceOf(VersionConflictError);
      const row = await store.get({ tenantId: "t1" }, "p1");
      expect(row?.status).toBe("approved");
      expect(row?.decidedBy).toBe("owner");
      expect(Object.hasOwn(row ?? {}, "decisionNote")).toBe(false);
    });

    it("tenant isolation is enforced at the ENGINE level: a raw cross-tenant row never surfaces via get/list", async () => {
      await sql.query("TRUNCATE pl_proposal");
      const store = new PostgresProposalStore(sql);
      await store.create(base("p1"));
      await store.create({ ...base("p1"), tenantId: "t2" });
      expect((await store.get({ tenantId: "t1" }, "p1"))?.tenantId).toBe("t1");
      expect((await store.get({ tenantId: "t2" }, "p1"))?.tenantId).toBe("t2");
      const t1List = await store.list({ tenantId: "t1" });
      expect(t1List.items.map((p) => p.tenantId)).toEqual(["t1"]);
    });

    it("list() filters by BOTH status and category (AND semantics)", async () => {
      await sql.query("TRUNCATE pl_proposal");
      const store = new PostgresProposalStore(sql);
      await store.create(base("p1", { category: "discount", status: "pending" }));
      await store.create(base("p2", { category: "refund", status: "pending" }));
      await store.create(base("p3", { category: "discount", status: "rejected" }));
      const result = await store.list({ tenantId: "t1" }, { status: "pending", category: "discount" });
      expect(result.items.map((p) => p.id)).toEqual(["p1"]);
    });

    it("throws ProposalNotFoundError transitioning an id that belongs to a DIFFERENT tenant", async () => {
      await sql.query("TRUNCATE pl_proposal");
      const store = new PostgresProposalStore(sql);
      await store.create(base("p1"));
      await expect(store.transition({ tenantId: "other" }, "p1", 0, { status: "approved" })).rejects.toBeInstanceOf(
        ProposalNotFoundError,
      );
    });

    it("holds an exact column allowlist (no stray columns silently added)", async () => {
      const { rows } = await sql.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name",
        ["pl_proposal"],
      );
      expect(rows.map((r) => r.column_name)).toEqual(
        [
          "action",
          "agent_id",
          "agent_type",
          "boundary_reasons",
          "category",
          "created_at",
          "decided_at",
          "decided_by",
          "decision_note",
          "estimated_impact",
          "executed_at",
          "execution_id",
          "execution_result",
          "expires_at",
          "id",
          "preconditions",
          "rationale",
          "reversal_plan",
          "status",
          "tenant_id",
          "version",
        ].sort(),
      );
    });
  });
});
