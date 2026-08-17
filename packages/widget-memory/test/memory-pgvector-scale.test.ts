import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { PgVectorStore, type Sql } from "@palup/state-postgres";
import { startPgvectorContainer, PGVECTOR_AVAILABLE } from "@palup/state-postgres/test/helpers/pgvector-container";
import { withdrawConsent1 } from "../src/erasure.js";
import { sweepExpired } from "../src/retention.js";
import { subjectNamespace } from "../src/identity.js";

// semantic-memory-v1 foundation, T2 — "add the same 1500-fact erasure/retention proofs to the pgvector
// container file where feasible": these mirror erasure.test.ts's/retention.test.ts's own 1500-fact scale
// proofs (run there against the in-memory oracle), but here against a REAL pgvector/HNSW engine — the
// engine this feature will actually run behind once ANN is enabled for memory — proving the pagination
// fix is genuinely engine-portable (ADR-0001), not an artifact of the in-memory adapter's Map iteration.
// `list`/pagination correctness never depends on vector CONTENT, so every seeded record below carries the
// SAME trivial vector; only ids/metadata matter to erasure.ts/retention.ts.
//
// merge.ts's own 1500-fact proof is intentionally NOT duplicated here — the task scoping this file names
// only erasure + retention for the pgvector container; merge's real-engine coverage is left to the
// builder if wanted, tracked in this PR's report.

const DIMENSION = 2;
function vec(): number[] {
  return [1, 0];
}

describe.skipIf(!PGVECTOR_AVAILABLE)("widget-memory erasure/retention at 1500-fact scale — pgvector container", () => {
  let sql: Sql;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    await new PgVectorStore(sql, { dimension: DIMENSION }).migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  it(
    "withdrawConsent1 over PgVectorStore deletes EVERY ordinary id across 1500 facts (specials retained), " +
      "audited with the TRUE count — not the old 500-record cap (today: enumerateSubjectOrFail fails " +
      "closed at k=500, so this REJECTS instead of resolving)",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const namespace = subjectNamespace("acme", "guest-pgv-1500-c1");
      const ORDINARY = 1200;
      const SPECIAL = 300;
      const records = [
        ...Array.from({ length: ORDINARY }, (_, i) => ({
          id: `ord-${String(i).padStart(4, "0")}`,
          vector: vec(),
          metadata: { text: `fact ${i}`, class: "ordinary" as const },
        })),
        ...Array.from({ length: SPECIAL }, (_, i) => ({
          id: `spec-${String(i).padStart(4, "0")}`,
          vector: vec(),
          metadata: { text: `special ${i}`, class: "special" as const },
        })),
      ];
      await vector.upsert(namespace, records);

      const result = await withdrawConsent1({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-pgv-1500-c1" });
      expect(result.purged).toBe(ORDINARY); // the TRUE total, not the old 500 cap

      const remaining = await vector.query(namespace, { vector: vec(), k: 2000 });
      expect(remaining).toHaveLength(SPECIAL);

      const log = await runtimeStore.readAudit({ tenantId: "acme" });
      const row = log.find((r) => r.action === "consent.withdrawn");
      expect(row?.decision).toMatchObject({ count: ORDINARY });
    },
    300_000,
  );

  it(
    "sweepExpired over PgVectorStore deletes EXACTLY the expired half across 1500 facts (not just whatever " +
      "the first 500-record scan happened to catch)",
    async () => {
      await sql.query("TRUNCATE vp_ann");
      const vector = new PgVectorStore(sql, { dimension: DIMENSION });
      const runtimeStore = new InMemoryRuntimeStore();
      const namespace = subjectNamespace("acme", "guest-pgv-1500-sweep");
      const now = new Date("2026-01-01T00:00:00.000Z");
      const past = new Date("2020-01-01T00:00:00.000Z").toISOString();
      const future = new Date("2030-01-01T00:00:00.000Z").toISOString();

      // Interleaved by ascending id so the OLD truncate-at-first-500-scanned behavior would only ever
      // see about a quarter of the true expired count — proving this is a genuine pagination fix.
      const records = Array.from({ length: 1500 }, (_, i) => ({
        id: `f-${String(i).padStart(4, "0")}`,
        vector: vec(),
        metadata: { text: `fact ${i}`, class: "ordinary" as const, expiresAt: i % 2 === 0 ? past : future },
      }));
      await vector.upsert(namespace, records);

      const deleted = await sweepExpired({ vector, audit: runtimeStore }, "acme", ["guest-pgv-1500-sweep"], now);
      expect(deleted).toBe(750); // exactly the true expired half across all 1500

      const remaining = await vector.query(namespace, { vector: vec(), k: 2000 });
      expect(remaining).toHaveLength(750);
    },
    300_000,
  );
});
