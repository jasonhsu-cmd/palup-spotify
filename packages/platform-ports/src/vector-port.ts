// Vector port (ADR-0001; port-interfaces.md `vector`): the ONLY way run-time agent/feature code reads
// or writes per-tenant memory/personalization embeddings. Feature code depends on this interface;
// adapters (this in-memory one now, a cloud vector DB — Vertex Matching Engine / a vendor-neutral
// store — later) implement it and swap behind it, so no provider SDK leaks into feature code
// (portability-guard, ADR-0001).
//
// Tenant isolation is the port's core guarantee: the NAMESPACE IS THE TENANT and there is NO
// cross-namespace query. A blank/missing namespace is rejected on every op — an empty namespace would
// be a cross-tenant wildcard, so we fail closed exactly like RuntimeStatePort's tenant guard rather
// than silently widening scope. Right-to-erasure is first-class: deleteById erases specific records
// and deleteNamespace erases an entire tenant (GDPR/CCPA "delete my data").
//
// (port-interfaces.md sketches a single `delete(ns, ids|filter)`; this port splits it into the two
// explicit erasure ops the memory foundation needs — by id and by whole namespace. Async because a
// real vector-DB adapter is network-bound; the in-memory adapter just returns resolved promises,
// matching SecretsPort/RuntimeStatePort which are async even when the backing read is local.)

/** One stored memory: an id unique within the namespace, an embedding vector and/or raw text, and
 *  arbitrary JSON metadata returned with query matches. At least one of `vector`/`text` should be set
 *  for the record to be rankable by the corresponding query modality. */
export interface VectorRecord {
  id: string;
  vector?: number[];
  text?: string;
  metadata?: Record<string, unknown>;
}

/** A similarity query. Provide `vector` (→ cosine) or `text` (→ lexical overlap); `k` caps how many
 *  nearest matches are returned. */
export interface VectorQuery {
  vector?: number[];
  text?: string;
  k: number;
}

/** A query hit: the record id, its similarity score (higher = nearer), and a copy of its metadata. */
export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorPort {
  /** Insert-or-replace records within one tenant namespace (keyed by `record.id`). */
  upsert(namespace: string, records: VectorRecord[]): Promise<void>;
  /** Nearest records to the query, scoped to `namespace` ONLY, ordered nearest-first (capped at `k`).
   *  An unknown namespace yields []. Never returns another namespace's records. */
  query(namespace: string, query: VectorQuery): Promise<VectorMatch[]>;
  /** Right-to-erasure by id: remove the given ids from `namespace` (missing ids are ignored). */
  deleteById(namespace: string, ids: string[]): Promise<void>;
  /** Right-to-erasure by tenant: erase the entire namespace (all of that tenant's records). */
  deleteNamespace(namespace: string): Promise<void>;
}

/** A namespace is REQUIRED and non-blank on every op — a null/empty namespace is a cross-tenant
 *  wildcard, so we throw rather than widen scope (mirrors RuntimeStatePort's tenant guard). */
function requireNamespace(namespace: string): string {
  if (!namespace || !namespace.trim())
    throw new Error("VectorPort: a non-blank namespace is required (tenant isolation)");
  return namespace;
}

// C0 controls (U+0000-U+001F), DEL (U+007F), and C1 controls (U+0080-U+009F).
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F-\x9F]/;
// An unpaired ("lone") UTF-16 surrogate: a high surrogate not followed by a low one, or a low surrogate
// not preceded by a high one. A valid surrogate PAIR (e.g. an emoji) is left untouched.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Rejects a record's `text` up front if it carries a control character or an unpaired UTF-16 surrogate.
 * Both are bytes a durable engine may not even be able to store byte-for-byte — verified against pglite
 * (Postgres dialect): a NUL byte THROWS ("invalid byte sequence for encoding UTF8") while a lone
 * surrogate is silently mangled to U+FFFD on the wire, neither of which the in-memory adapter would ever
 * exhibit on its own (it just holds the JS string as-is). Exported and called by EVERY adapter's
 * `upsert` (in-memory included) so a caller that skips app-level sanitization (widget-memory's
 * `sanitizeFact` already strips these) gets the SAME fail-closed error from every engine, rather than a
 * cryptic driver-level crash on one and silent acceptance on another — behavior-equivalence (ADR-0001)
 * for this input class is enforced at the port, not left to each adapter to (mis)handle independently.
 * Scoped to `record.text` only (the field a shopper's own words land in via the distiller); arbitrary
 * `metadata` is untouched here.
 */
export function requireCleanText(text: string | undefined): void {
  if (text === undefined) return;
  if (CONTROL_CHAR_RE.test(text) || LONE_SURROGATE_RE.test(text))
    throw new Error(
      "VectorPort: record.text contains a control character or an unpaired UTF-16 surrogate — sanitize " +
        "before calling upsert (see widget-memory's sanitizeFact)",
    );
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

function norm(a: number[]): number {
  let s = 0;
  for (const x of a) s += x * x;
  return Math.sqrt(s);
}

/** Cosine similarity in [-1, 1]; 0 when either vector is empty or zero-norm. */
function cosine(a: number[], b: number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Lexical similarity: Jaccard overlap of word tokens, in [0, 1]. Dependency-free and deterministic. */
function lexical(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Score one record against a query — cosine for vector queries, lexical Jaccard for text queries, 0
 *  when neither modality matches (e.g. an empty-text "list everything" query, or a record with neither
 *  a vector nor text). EXPORTED (not just an in-memory implementation detail) so every VectorPort
 *  adapter — Postgres included — ranks with the EXACT SAME function as this oracle: a durable adapter
 *  that re-scores its own rows in application code with `scoreRecord` is byte-identical in ranking
 *  behavior to this in-memory one, by construction, not by parallel reimplementation that could drift. */
export function scoreRecord(query: VectorQuery, rec: VectorRecord): number {
  if (query.vector && rec.vector) return cosine(query.vector, rec.vector);
  if (query.text != null && rec.text != null) return lexical(query.text, rec.text);
  return 0;
}

/**
 * In-memory reference adapter for VectorPort — the DEV/TEST implementation and the behavioral oracle a
 * cloud adapter must match. A Map keyed by namespace holds a null-prototype id→record map per tenant
 * (so an id like `__proto__`/`constructor` can't resolve an inherited value — same hardening as the
 * env SecretsPort). Cross-namespace reads are impossible BY CONSTRUCTION: query only ever iterates the
 * one namespace's own map. Records are deep-cloned in and out so callers can't mutate stored state by
 * reference. Similarity is cosine (vectors) or lexical Jaccard (text); ties break by id for
 * determinism. No external deps.
 */
export function createInMemoryVectorStore(): VectorPort {
  const byNamespace = new Map<string, Record<string, VectorRecord>>();

  return {
    async upsert(namespace, records) {
      requireNamespace(namespace);
      for (const rec of records) requireCleanText(rec.text);
      let inner = byNamespace.get(namespace);
      if (!inner) {
        inner = Object.create(null) as Record<string, VectorRecord>;
        byNamespace.set(namespace, inner);
      }
      for (const rec of records) inner[rec.id] = clone(rec);
    },

    async query(namespace, query) {
      requireNamespace(namespace);
      const inner = byNamespace.get(namespace);
      if (!inner) return []; // unknown namespace — never falls back to another tenant
      const scored: VectorMatch[] = [];
      for (const id of Object.keys(inner)) {
        const rec = inner[id];
        if (!rec) continue;
        scored.push({ id, score: scoreRecord(query, rec), metadata: clone(rec.metadata) });
      }
      // Nearest-first; deterministic id tie-break so equal scores have a stable order.
      scored.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      const limit = query.k != null ? Math.max(0, Math.floor(query.k)) : scored.length;
      return scored.slice(0, limit);
    },

    async deleteById(namespace, ids) {
      requireNamespace(namespace);
      const inner = byNamespace.get(namespace);
      if (!inner) return;
      for (const id of ids) delete inner[id];
    },

    async deleteNamespace(namespace) {
      requireNamespace(namespace);
      byNamespace.delete(namespace); // erase the whole tenant (right-to-erasure)
    },
  };
}
