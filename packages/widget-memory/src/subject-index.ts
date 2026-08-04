import type { RuntimeStatePort } from "@palup/platform-ports";

// B4 (ADR-0015 Inv 4, "expiry is enforced, not aspirational") — the per-tenant index of subjects that
// actually have stored facts, so a SCHEDULED sweep can reclaim expired data for a shopper who never
// comes back. Without it, `sweepExpired`'s only production caller is the opportunistic per-turn sweep on
// /chat, which visits only the subject being served that turn: a returning shopper cleans up after
// themselves and a departed one is never reclaimed at all.
//
// WHY AN INDEX AND NOT ENUMERATION. `VectorPort` has no namespace-listing operation (vector-port.ts) and
// adding one would impose a non-portable requirement on every adapter (ADR-0001) — plenty of vector
// engines cannot list namespaces. The `memory_consent` KV is per-subject but only holds a row for
// someone who RECORDED a choice, and in the default US opt-out regime the common case is a shopper who
// never answered, writes on "unknown", and has no consent row. So the index must be driven by the WRITE.
//
// PRIVACY. This stores raw subject ids (a guest `anonId`, or `acct:<shopperId>`) and a timestamp — no
// fact text, no message content. That is NOT a new class of data: `memory_consent`
// (state-postgres/runtime-consent-store.ts) already stores the same ids in the same KV, tenant-scoped.
// It is deliberately NOT hashed, unlike an audit `subjectRef`: the sweep has to reconstruct the vector
// namespace from the id, which a one-way hash would make impossible. Audit records ABOUT the sweep still
// carry only the hashed ref (retention.ts).

/** KV collection holding one entry per subject that has at least one stored fact. */
export const MEMORY_SUBJECTS = "memory_subjects";

export interface SubjectIndexEntry {
  /** The memory subject — a validated guest `anonId`, or `acct:<shopperId>` (identity.ts). */
  subject: string;
  /** ISO-8601 of the most recent fact write for this subject. Lets an operator (or a future
   * prioritised sweep) tell a long-dormant subject from an active one without touching the facts. */
  lastWriteAt: string;
}

/**
 * Marks `subject` as having stored facts under `tenantId`. Idempotent — re-recording an existing
 * subject overwrites its entry (refreshing `lastWriteAt`) rather than adding a duplicate, so this is
 * safe to call on every write.
 */
export async function recordSubject(
  store: RuntimeStatePort,
  args: { tenantId: string; subject: string; now?: Date },
): Promise<void> {
  const entry: SubjectIndexEntry = { subject: args.subject, lastWriteAt: (args.now ?? new Date()).toISOString() };
  await store.put({ tenantId: args.tenantId }, MEMORY_SUBJECTS, args.subject, entry);
}

/** Every subject known to hold facts for this tenant. Tenant-scoped by the port itself, which rejects a
 * blank tenantId outright — one tenant's sweep can never enumerate another's subjects. */
export async function listSubjects(store: RuntimeStatePort, tenantId: string): Promise<SubjectIndexEntry[]> {
  const rows = await store.list<SubjectIndexEntry>({ tenantId }, MEMORY_SUBJECTS);
  return rows.map((r) => r.value).filter((v): v is SubjectIndexEntry => Boolean(v?.subject));
}

/**
 * Drops `subject` from the index. Called when a sweep finds the subject's namespace empty, so the index
 * tracks live storage rather than growing forever.
 *
 * NOTE this removes only the INDEX ENTRY, never facts — it is not an erasure path (`eraseSubject`,
 * erasure.ts, is). Retiring a subject that somehow still has facts would only mean the scheduled sweep
 * stops visiting them; their own next turn would re-index them on the next write, and TTL-on-read still
 * prevents an expired fact from ever being served in the meantime.
 */
export async function retireSubject(store: RuntimeStatePort, args: { tenantId: string; subject: string }): Promise<void> {
  await store.delete({ tenantId: args.tenantId }, MEMORY_SUBJECTS, args.subject);
}
