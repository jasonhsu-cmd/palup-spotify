import { createHash } from "node:crypto";
import type { QueueMessage } from "@palup/platform-ports";
import type { MemoryCtx, MemoryTurn } from "@palup/widget-memory";

// #126 — the async memory-write queue's message builder. Mirrors catalog-webhook-queue.ts's
// `catalogReconcileMessage`: a pure builder, no I/O, so the caller (dispatch, dark until wired) can
// enqueue-then-return instead of paying the memory `remember()` write inline on the hot /chat path.
//
// Portability (NN#3): only the vendor-neutral QueuePort/QueueMessage shape crosses this module — no
// provider SDK, and no MemoryCtx/MemoryTurn field is dropped from the payload (the queue consumer needs
// the FULL consent snapshot to honor the same write-gate `remember()` would have applied inline).

export const MEMORY_WRITE_TOPIC = "memory.write";

/**
 * Build the memory-write message for one turn. `id` is a deterministic idempotency key — sha256 of
 * `tenantId anonId message reply` — so an at-least-once redelivery of the SAME turn dedups in the
 * QueuePort (ADR-0006 contract), while a genuinely different message or reply gets its own key. `nowMs`
 * is accepted for call-site symmetry with the caller's clock but deliberately does NOT feed the id: two
 * publishes of the identical turn at different times must still collapse to one write.
 *
 * `tenantKey` is `ctx.anonId`, not `ctx.tenantId` — per-SUBJECT publish order (ADR-0006 §Decision.4)
 * matters here more than per-tenant order, since two turns for the same shopper must land in order even
 * if their distilled facts race, and the port keys ordering off `tenantKey`.
 */
export function memoryWriteMessage(ctx: MemoryCtx, turn: MemoryTurn, nowMs: number): QueueMessage {
  void nowMs; // accepted for symmetry with other message builders; not part of the idempotency key
  // NUL-separated (not space-separated): free shopper text can itself contain a space, so a space-joined
  // preimage lets a boundary shift between fields produce the SAME hash for two DIFFERENT turns (e.g.
  // message="x"/reply="y z" vs message="x y"/reply="z" both join to "...x y z") — the queue would then
  // dedup them as "already processed" and silently drop a real fact. `\0` cannot occur in ordinary
  // shopper/model text, so each field's boundary is unambiguous.
  //
  // Production idempotency caveat (MEMORY-GO-LIVE-CHECKLIST.md §E2): this `id` only DEDUPS where a
  // consumer actually checks it. Today that's the in-memory reference QueuePort used in tests. The
  // real Pub/Sub push subscription is at-least-once with no consume-side dedup wired in yet — a
  // redelivery re-runs the distiller call in full. Go-live needs either a consume-side id-dedup check
  // on the push route or exactly-once (pull-only in Pub/Sub, so push needs the app-level check either
  // way).
  const id = createHash("sha256").update(`${ctx.tenantId}\0${ctx.anonId}\0${turn.message}\0${turn.reply}`).digest("hex");
  return {
    id,
    type: MEMORY_WRITE_TOPIC,
    tenantKey: ctx.anonId,
    payload: {
      tenantId: ctx.tenantId,
      anonId: ctx.anonId,
      region: ctx.region,
      consent1: ctx.consent1,
      consent2: ctx.consent2,
      message: turn.message,
      reply: turn.reply,
    },
  };
}
