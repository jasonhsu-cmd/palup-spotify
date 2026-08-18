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
 * is carried into the payload as `publishedAt` (MEMORY-GO-LIVE-CHECKLIST.md §E1 — the erasure-tombstone
 * check on the consume side needs the publish time) but deliberately does NOT feed the id: two publishes
 * of the identical turn at different times must still collapse to one write.
 *
 * `tenantKey` is `ctx.anonId`, not `ctx.tenantId` — per-SUBJECT publish order (ADR-0006 §Decision.4)
 * matters here more than per-tenant order, since two turns for the same shopper must land in order even
 * if their distilled facts race, and the port keys ordering off `tenantKey`.
 */
export function memoryWriteMessage(ctx: MemoryCtx, turn: MemoryTurn, nowMs: number): QueueMessage {
  // NUL-separated (not space-separated): free shopper text can itself contain a space, so a space-joined
  // preimage lets a boundary shift between fields produce the SAME hash for two DIFFERENT turns (e.g.
  // message="x"/reply="y z" vs message="x y"/reply="z" both join to "...x y z") — the queue would then
  // dedup them as "already processed" and silently drop a real fact. `\0` cannot occur in ordinary
  // shopper/model text, so each field's boundary is unambiguous.
  //
  // Production idempotency (MEMORY-GO-LIVE-CHECKLIST.md §E2 — CLOSED): this `id` rides in the Pub/Sub
  // message attributes (server.ts's memory publish call) AND the push route (pubsub-push-memory.ts) now
  // checks it against a durable dedup collection via `RuntimeStatePort` before calling `remember`, so a
  // redelivery (ack-deadline miss, retry) no longer re-runs the distiller call.
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
      publishedAt: nowMs,
    },
  };
}
