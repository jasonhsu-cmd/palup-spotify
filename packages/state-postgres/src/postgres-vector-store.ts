import {
  requireCleanText,
  scoreRecord,
  type VectorPort,
  type VectorRecord,
  type VectorQuery,
  type VectorMatch,
  type VectorListItem,
  type VectorListOpts,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// Postgres adapter for VectorPort (ADR-0001 `vector` port — durable, portable cross-visit memory,
// ADR-0015). Mirrors PostgresRuntimeStore's discipline exactly: namespace is a BOUND parameter on every
// statement (never string-interpolated), and a blank/missing namespace fails closed via the SAME guard
// pattern as the in-memory oracle (vector-port.ts) and PostgresRuntimeStore's tenant guard. Table keyed
// by (namespace, id); `text` and `metadata` are stored as-is, `vector` as jsonb (a Postgres
// `double precision[]` column round-trips fine too, but jsonb is the SAME proven encoding
// PostgresRuntimeStore already uses for `rs_kv.value` — reusing a working pattern rather than
// introducing a second one this file would be the only user of).
//
// ENCRYPTION FOR SPECIAL-CATEGORY (Art-9) DATA — CLOSED, AT THE SERVICE LAYER, NOT HERE (go-live blocker
// #2; formerly a GO-LIVE GAP flagged HIGH by security review). ADR-0015 Invariant 9 requires
// special-category facts to get STRICTER STORAGE "including encryption" (the shopper-facing consent copy
// literally promises "I'll keep it encrypted" — ADR-0015 line 108). This table still stores `text`/
// `metadata` as plain `text`/`jsonb` columns, byte-identical for `class:"ordinary"` and `class:"special"`
// rows — but by the time a record REACHES this adapter's `upsert`, a special-category fact's `text` (both
// the top-level `VectorRecord.text` and `metadata.text`) and any `metadata.disposition[].value`/
// `sourceQuote` are already an AES-256-GCM `CryptoPort` envelope, encrypted in
// `packages/widget-memory/src/service.ts` BEFORE this (or ANY) `VectorPort` adapter ever sees them —
// deliberately adapter-agnostic defense in
// depth (ADR-0001: the vector port must stay swappable without re-implementing encryption per adapter).
// So a DBA, disk snapshot, or log-shipping path reading this table's raw columns sees ciphertext for
// special-category rows, not a health fact in the clear; `metadata.encrypted` (a plain boolean, never the
// key or plaintext) records which rows are protected this way. This adapter itself does NOT decrypt,
// encrypt, or even know about sensitivity classes — it is a dumb byte store, exactly as before; the
// invariant is enforced one layer up. `MEMORY_ADR_ACCEPTED` still needs named-owner + `security-reviewer`
// + LEGAL sign-off before it can ever flip (ADR-0015 Status note) — this note is updated, not removed,
// because the mechanism it originally flagged as missing now exists (see service.ts's own module-header
// note for the fail-closed/best-effort contract and the similarity-search trade-off this implies).
//
// TENANT ISOLATION / RLS (security review, HIGH). The app-level isolation guarantee is `namespace=$1`
// bound-equality on every statement below (never interpolated, never a prefix/LIKE match) — verified by
// the isolation contract test. `namespace` itself is an OPAQUE `${tenantId}::${anonId}` string
// (widget-memory's Option B scheme), so unlike `PostgresRuntimeStore` (whose `tenant_id` is a first-class
// column) an RLS policy here would otherwise need `split_part(namespace, '::', 1)` against a session GUC.
// `tenant_id` below is a REAL, adapter-populated column (derived from `namespace`, always a BOUND
// parameter, never interpolated) specifically so a defense-in-depth RLS policy is expressible directly —
// production SHOULD additionally enable row-level security on `vp_records` scoped by `tenant_id` (mirrors
// `postgres-runtime-store.ts`'s own note); this file does not enable it itself (that is a deploy-time
// `CREATE POLICY` + `ENABLE ROW LEVEL SECURITY`, not app code).
//
// HONEST SEMANTICS NOTE — READ BEFORE ASSUMING THIS IS AN ANN/VECTOR-SEARCH ENGINE: it is not. `query`
// does NOT run a vector index / approximate-nearest-neighbor search. It fetches every row in the
// namespace and RE-SCORES them in application code with platform-ports' exported `scoreRecord` — the
// EXACT SAME cosine-similarity / lexical-Jaccard function the in-memory oracle uses — so ranking is
// byte-identical to the oracle, just computed by a SQL scan + JS sort instead of a Map iteration. That is
// a deliberate, documented choice, not a shortcut standing in for a missing feature:
//   - FAST-V1 (packages/widget-memory) deliberately DROPPED embeddings/ANN from scope (see service.ts /
//     erasure.ts doc comments). Its ONLY real query pattern is `query(namespace, {text: "", k: 500})` —
//     "list everything for this subject" — where every record ties at score 0 (lexical() on an empty
//     query token set) and the tie-break is stable id order. A full-namespace scan is EXACTLY correct
//     and cheap for that pattern at the modest per-subject record counts this system deals in (capped at
//     500 by the caller).
//   - For a genuinely non-empty vector/text query this still computes REAL cosine/Jaccard ranking (not a
//     stub), it is just O(records in namespace) rather than backed by an index — fine at this scale,
//     NOT a claim of ANN/approximate search or of scaling to large per-tenant corpora.
// If a future need requires real ANN at scale (pgvector, a managed vector DB, …), that is a NEW adapter
// behind this SAME port (ADR-0001) — do not bolt an index onto this file and call it done without
// updating this comment; a reader must never come away believing this does semantic vector search over
// an index.

function requireNamespace(namespace: string): string {
  if (!namespace || !namespace.trim())
    throw new Error("VectorPort: a non-blank namespace is required (tenant isolation)");
  return namespace;
}

// widget-memory's Option B namespace scheme (identity.ts `subjectNamespace`) is `${tenantId}::${anonId}`,
// with "::" REJECTED inside either component — so the FIRST "::" unambiguously splits the two. This is a
// defense-in-depth column only (see the RLS note above); the actual isolation boundary remains the bound
// `namespace=$1` equality every statement already uses, unchanged by this. A namespace with no "::" at
// all (every REAL caller goes through subjectNamespace, but the generic VectorPort contract tests and any
// future non-widget-memory caller may not) falls back to the whole namespace as its own tenant_id — still
// non-blank (requireNamespace already guarantees that), just not further split.
function tenantIdFromNamespace(namespace: string): string {
  const idx = namespace.indexOf("::");
  return idx === -1 ? namespace : namespace.slice(0, idx);
}

// Hard cap on rows scanned per `query()` call (security review, MEDIUM — "unbounded per-namespace
// SELECT"). The ONLY real consumer pattern is `query(ns, {text:"", k:500})` ("list everything for this
// subject" — see the honest semantics note above), and `erasure.ts`'s `enumerateSubjectOrFail` already
// refuses to treat >=500 rows as a complete enumeration. This scan bound sits comfortably above that (so
// it never changes behavior for a well-behaved subject) while still bounding the WORST case: widget-
// backend/server.ts's POST /chat now DOES call `sweepExpired` (widget-memory/src/retention.ts) as a
// production caller, opportunistically and PER-SUBJECT (scoped to only the subject served that turn) —
// but that reclamation still leaves a namespace unbounded for a subject who never returns (retention.ts's
// own doc comment tracks that as a go-live gap), so this scan bound remains the backstop: a single
// `query()` can never become a full-table-shaped scan of an unboundedly large namespace regardless of
// whether/when a sweep runs for it. Ranking beyond this cap is not attempted — this is a safety backstop,
// not a claim that ranking over more than `MAX_SCAN_ROWS` records would still be correct/complete.
const MAX_SCAN_ROWS = 5000;

interface VpRow {
  id: string;
  vector: number[] | null;
  text: string | null;
  metadata: Record<string, unknown> | null;
}

export class PostgresVectorStore implements VectorPort {
  /** `maxScanRows` defaults to MAX_SCAN_ROWS in production; a test may inject a small value to exercise
   *  the truncation behavior without inserting thousands of rows. */
  constructor(
    private readonly sql: Sql,
    private readonly maxScanRows: number = MAX_SCAN_ROWS,
  ) {}

  /** Create the table if absent. Idempotent; run at startup / in a migration step (mirrors
   *  PostgresRuntimeStore.migrate()). `tenant_id` is a REAL column (see the file-level RLS note) —
   *  populated by the adapter (`upsert`), always derived from `namespace`, never client-supplied. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS vp_records (
         namespace text NOT NULL, tenant_id text NOT NULL, id text NOT NULL, vector jsonb, text text,
         metadata jsonb, PRIMARY KEY (namespace, id))`,
    );
    await this.sql.query("CREATE INDEX IF NOT EXISTS vp_records_tenant ON vp_records (tenant_id)");
  }

  async upsert(namespace: string, records: VectorRecord[]): Promise<void> {
    const ns = requireNamespace(namespace);
    if (records.length === 0) return;
    for (const rec of records) requireCleanText(rec.text);
    const tenantId = tenantIdFromNamespace(ns);
    // Transactional (security review, MEDIUM — "non-transactional batch upsert leaves partial, unaudited
    // writes"): service.ts only writes its write.ordinary/write.special audit AFTER `upsert` resolves, so
    // a mid-batch failure must leave EITHER every record in this batch persisted or NONE of them — never
    // a partial set that silently skips the audit for whatever DID land (ADR-0015 Inv 6: no silent memory
    // action). `this.sql.tx` runs every INSERT in one transaction: commit on success, rollback (so the
    // caller's audit never fires either) on any failure. Verified against pglite: upserting
    // [good, bad, third] where `bad` throws (e.g. a NUL byte) now leaves NEITHER `good` nor `third`
    // persisted — previously `good` alone would have landed with no audit record at all.
    await this.sql.tx(async (tx) => {
      for (const rec of records) {
        await tx.query(
          `INSERT INTO vp_records (namespace, tenant_id, id, vector, text, metadata)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (namespace, id) DO UPDATE SET vector = EXCLUDED.vector, text = EXCLUDED.text, metadata = EXCLUDED.metadata`,
          [
            ns,
            tenantId,
            rec.id,
            rec.vector != null ? JSON.stringify(rec.vector) : null,
            rec.text ?? null,
            rec.metadata !== undefined ? JSON.stringify(rec.metadata) : null,
          ],
        );
      }
    });
  }

  async query(namespace: string, query: VectorQuery): Promise<VectorMatch[]> {
    const ns = requireNamespace(namespace);
    // `ORDER BY id LIMIT $2` (not an unbounded SELECT — see MAX_SCAN_ROWS's own note above): deterministic,
    // stable-id-order truncation, so a genuinely oversized namespace is never scanned/re-scored in full.
    const { rows } = await this.sql.query<VpRow>(
      "SELECT id, vector, text, metadata FROM vp_records WHERE namespace=$1 ORDER BY id LIMIT $2",
      [ns, this.maxScanRows],
    );
    // Brute-force re-score in app code with the SHARED scoreRecord — see the file-level honesty note.
    const scored: VectorMatch[] = rows.map((r) => ({
      id: r.id,
      score: scoreRecord(query, { id: r.id, vector: r.vector ?? undefined, text: r.text ?? undefined }),
      metadata: r.metadata ?? undefined,
    }));
    scored.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const limit = query.k != null ? Math.max(0, Math.floor(query.k)) : scored.length;
    return scored.slice(0, limit);
  }

  /** Plain keyset scan by id, leaving `query`/`MAX_SCAN_ROWS` untouched (see the file-level honesty
   *  note above) — `list` is a distinct, unranked enumerate over `vp_records`. */
  async list(namespace: string, opts: VectorListOpts): Promise<VectorListItem[]> {
    const ns = requireNamespace(namespace);
    const limit = Math.max(0, Math.floor(opts.limit));
    if (limit === 0) return [];
    const { rows } = await this.sql.query<{ id: string; metadata: Record<string, unknown> | null }>(
      "SELECT id, metadata FROM vp_records WHERE namespace=$1 AND ($2::text IS NULL OR id > $2) ORDER BY id LIMIT $3",
      [ns, opts.after ?? null, limit],
    );
    return rows.map((r) => ({ id: r.id, metadata: r.metadata ?? undefined }));
  }

  async deleteById(namespace: string, ids: string[]): Promise<void> {
    const ns = requireNamespace(namespace);
    if (ids.length === 0) return;
    await this.sql.query("DELETE FROM vp_records WHERE namespace=$1 AND id = ANY($2::text[])", [ns, ids]);
  }

  async deleteNamespace(namespace: string): Promise<void> {
    const ns = requireNamespace(namespace);
    await this.sql.query("DELETE FROM vp_records WHERE namespace=$1", [ns]);
  }
}
