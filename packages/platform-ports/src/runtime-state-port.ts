// Runtime-state port (ADR-0001 / ADR-0004): durable, TENANT-SCOPED state for the RUN-TIME plane —
// the live shopper agent. It is deliberately separate from the build-time evolution `StorePort`
// (packages/evolution): that store is single-operator and un-scoped; this one is multi-tenant and
// must enforce isolation, because it holds per-conversation state, the operator Kill Switch, canary
// config, and the immutable Audit Log for millions of merchants.
//
// Why a higher-level KV+log+audit port rather than the raw `storage` (tx/query) port in
// port-interfaces.md: feature code should never write SQL. A Postgres adapter implements THIS port on
// top of tenant-scoped tables + real transactions (that is where `storage`'s tx/query live); an
// in-memory adapter implements it for tests/dev. Both pass the same contract, so the engine
// (Cloud SQL now; Spanner-via-pg-interface / YugabyteDB at scale — ADR-0004) stays swappable and no
// engine-proprietary API leaks past the adapter (ADR-0001).

/** Every call is scoped to one tenant (merchant). Isolation is the port's core guarantee. */
export interface RuntimeStateCtx {
  /** Merchant/tenant id — the shard key. A tenant can never read another tenant's rows. */
  tenantId: string;
}

/**
 * An autonomous run-time action, recorded immutably (governance non-negotiable #5: actor, input,
 * decision, and reversal path — "no silent actions"). Callers MUST redact PII before passing input.
 */
export interface AuditInput {
  /** Who acted: an operator id, an agent id, or "system". */
  actor: string;
  /** What happened, as a stable slug: e.g. "kill.arm", "guardrail.injection_blocked", "refund.route_to_human". */
  action: string;
  /** The triggering input (already redacted). Optional but strongly encouraged. */
  input?: unknown;
  /** The decision/outcome taken. */
  decision?: unknown;
  /** How this action can be reversed (or "n/a — read-only" / "escalated to human"). */
  reversalPath?: string;
}

/** A committed audit record: an AuditInput plus its chain position and tamper-evident hash. */
export interface AuditRecord extends AuditInput {
  /** Per-tenant monotonic sequence, 1-based. */
  seq: number;
  /** ISO-8601 timestamp the record was committed. */
  at: string;
  /** Hash of the previous record in this tenant's chain (genesis = 64 zeros). */
  prevHash: string;
  /** sha256 over the canonicalized record (excluding this field). Chain-verifiable. */
  hash: string;
}

/** The reads + mutations available inside a transaction (see `tx`). Reads-your-writes within the tx. */
export interface RuntimeStateTx {
  /** Read within the tx (use this for read-modify-write so the read shares the tx's connection/snapshot). */
  get<T>(collection: string, key: string): Promise<T | null>;
  put<T>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  append<T>(stream: string, entry: T): Promise<number>;
  audit(entry: AuditInput, at?: string): Promise<AuditRecord>;
}

export interface RuntimeStatePort {
  // --- Tenant-scoped key/value (session state, kill-switch registry, canary config) ---
  /** Read a JSON doc, or null if absent. */
  get<T>(ctx: RuntimeStateCtx, collection: string, key: string): Promise<T | null>;
  /** Write (overwrite) a JSON doc. */
  put<T>(ctx: RuntimeStateCtx, collection: string, key: string, value: T): Promise<void>;
  /** Delete a key (no-op if absent). */
  delete(ctx: RuntimeStateCtx, collection: string, key: string): Promise<void>;
  /** All entries in a collection for this tenant. */
  list<T>(ctx: RuntimeStateCtx, collection: string): Promise<Array<{ key: string; value: T }>>;

  // --- Tenant-scoped append-only operational streams (traffic, cost telemetry) ---
  /** Append one entry to a stream; returns the new length. */
  append<T>(ctx: RuntimeStateCtx, stream: string, entry: T): Promise<number>;
  /** Read a stream oldest-first; `limit` returns the most recent N. */
  readStream<T>(ctx: RuntimeStateCtx, stream: string, opts?: { limit?: number }): Promise<T[]>;

  // --- Immutable, hash-chained Audit Log (NN #5) ---
  //
  // TRUST ASSUMPTION (immutability): the chain is tamper-EVIDENT, not tamper-proof by itself. In-place
  // mutation, reorder, mid-chain removal, and naive insertion are caught by `verifyAudit`. But
  // tail-truncation and a full re-hash are NOT catchable from the chain alone (no secret is stored),
  // so immutability rests on the BACKING STORE being genuinely append-only. Adapters MUST enforce this:
  // the Postgres adapter's audit table must grant NO UPDATE/DELETE to the app role (INSERT-only), and
  // production SHOULD persist a periodic trusted head anchor and/or HMAC-sign records so truncation and
  // store-level rewrite are detectable (pass the anchor to `verifyAudit`).
  /** Append an audit record to this tenant's chain; returns the committed record with its hash. */
  audit(ctx: RuntimeStateCtx, entry: AuditInput, at?: string): Promise<AuditRecord>;
  /** Read the audit log oldest-first; `limit` returns the most recent N. */
  readAudit(ctx: RuntimeStateCtx, opts?: { limit?: number }): Promise<AuditRecord[]>;
  /**
   * Recompute the chain and report whether it is intact. Pass `expectedHead` (a trusted, separately
   * persisted `{seq, hash}`) to also detect tail-truncation / rewrite the in-chain check can't see.
   */
  verifyAudit(
    ctx: RuntimeStateCtx,
    opts?: { expectedHead?: { seq: number; hash: string } },
  ): Promise<{ ok: boolean; brokenAt?: number }>;

  // --- Atomicity + isolation: run mutations + their audit record so they commit together or not at all ---
  /**
   * Execute `fn` atomically and ISOLATED. If it throws, ALL writes/audit in the tx roll back. Adapters
   * MUST serialize/isolate concurrent transactions on the same tenant (the in-memory adapter serializes
   * per tenant; the Postgres adapter uses SERIALIZABLE / row locks) so no concurrent write is lost.
   */
  tx<T>(ctx: RuntimeStateCtx, fn: (t: RuntimeStateTx) => Promise<T>): Promise<T>;
}

/** Genesis previous-hash for the first record in a tenant's audit chain. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);
