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
  const id = createHash("sha256").update(`${ctx.tenantId} ${ctx.anonId} ${turn.message} ${turn.reply}`).digest("hex");
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
