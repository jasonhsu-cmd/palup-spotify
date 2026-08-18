import type { Arm, Play, QueueMessage, QueuePort, QueueSubscription, RuntimeStatePort } from "@palup/platform-ports";
import { accumulateArmTally } from "@palup/state-postgres";
import { resolveOrderJoinToken } from "./order-join-token.js";

// Wave 2 / W2-C (item 2) — the seam between a verified `orders/create` / `orders/updated` /
// `refunds/create` WEBHOOK (routes/shopify-webhooks.ts) and the ORDER-ATTRIBUTION WORKER that turns a
// resolved join token into a real `ArmTally` write on the W2-A ledger (`accumulateArmTally`).
//
// Mirrors `catalog-webhook-queue.ts`'s split exactly: the webhook route's ONLY job is verify → extract
// the few non-PII fields → enqueue → 200; this file is the worker, OFF the /chat hot path and off the
// webhook's own request/response cycle, so a slow ledger write can never make Shopify's 5-second
// webhook timeout matter.
//
// NO PII CROSSES THIS FILE. A message payload carries only: a tenantId, a topic literal, the OPAQUE
// join token (itself PII-free — see order-join-token.ts's header), a bare numeric order id (a Shopify
// business-record identifier, not a customer identifier — same class as a shop domain, not a customer
// id), and plain numeric amounts/currency. The full Shopify order/refund BODY (which carries email,
// address, name, line items…) is read once in the route, has these few fields extracted from it, and
// is then discarded — it never reaches the queue, this file, or any collection this file writes to.
//
// FAIL-CLOSED ATTRIBUTION. An order/refund whose token is absent, unresolvable (expired/unknown/wrong
// tenant), or whose order-arm resolution was never recorded is `"unattributed"` — no tally, no crash,
// nothing guessed. This is the direct realization of the work item's "an order with NO / unknown /
// expired join token is NOT attributed to any arm" requirement.
//
// IDEMPOTENCY, TWO INDEPENDENT DIMENSIONS, BOTH "CLAIM THEN ACT":
//   1. MESSAGE-LEVEL (`ORDER_ATTRIBUTION_DEDUP_COLLECTION`, keyed by the queue message's OWN
//      idempotency `id`) — guards a QueuePort redelivery of the identical message (at-least-once
//      delivery, ADR-0006 §Decision.4). This is on TOP of the route's own `alreadyHandled`/
//      `markHandled` webhook-delivery dedup (routes/shopify-webhooks.ts) — belt-and-suspenders across
//      the publish/consume trust boundary, mirroring `pubsub-push-memory.ts`'s §E2 consume-side dedup,
//      because a real durable adapter's redelivery guarantee is looser than the in-memory reference's.
//   2. ORDER-LEVEL (`ORDER_ARM_COLLECTION`'s `tallied` flag) — guards `orders/create` AND
//      `orders/updated` BOTH resolving the SAME order (by design: either topic can complete the
//      order's tally, whichever is delivered first — see `applyOrder`'s own doc).
//
// BOTH CLAIM BEFORE THEY ACT (mark the dedup/tallied row, THEN call `accumulateArmTally`), the
// OPPOSITE ordering from `routes/shopify-webhooks.ts`'s own "mark handled AFTER the action" convention
// — a deliberate, documented departure, not an inconsistency overlooked. That file marks-after because
// its actions are DESTRUCTIVE and marking-first "would let one failed attempt swallow the whole
// obligation" (an erasure that never ran would look done). Here the ledger is ADDITIVE and
// governance-critical (ADR-0007: attribution is billing-adjacent infrastructure with its own eval
// gate) — the failure mode this file is more worried about is a race OVER-counting a number the whole
// flywheel exists to keep honest, not a rare crash under-counting one. Claim-then-act bounds the first
// risk at the cost of the second: a hard process crash between the claim committing and
// `accumulateArmTally` committing leaves a permanent, self-evident (auditable) under-count for that
// one delivery — never an over-count. A thrown (non-crash) failure in `accumulateArmTally` propagates
// normally and the QueuePort's own retry-then-dead-letter handles it within the SAME delivery attempt.

export const ORDER_ATTRIBUTION_TOPIC = "order.attribution";
export const ORDER_ATTRIBUTION_GROUP = "order-attribution-worker";

/** KV collection: `orderId → OrderArmRow` — the durable link a `refunds/create` delivery (whose body
 *  carries no join token — see shopify-webhook-identity.ts's header) needs to find the arm an EARLIER
 *  `orders/create`/`orders/updated` delivery already resolved for that order. */
export const ORDER_ARM_COLLECTION = "holdout_order_arm";

/** How long an order→arm resolution survives. Deliberately much longer than the join token's own TTL
 *  (`JOIN_TOKEN_TTL_SECONDS`, order-join-token.ts): the TOKEN only needs to survive checkout→first
 *  webhook delivery, but this ROW must still be there when a REFUND arrives, which can be weeks later.
 *  180 days is an ENGINEERING default chosen to comfortably outlive an ordinary return/dispute window —
 *  NOT a verified merchant policy or a Shopify SLA; a human should confirm it against real return-
 *  window data before this path is ever enabled live.
 */
export const ORDER_ARM_TTL_SECONDS = 180 * 24 * 60 * 60;

/** KV collection for the message-level consume-side dedup (idempotency dimension 1 above). */
export const ORDER_ATTRIBUTION_DEDUP_COLLECTION = "order_attribution_dedup";
export const ORDER_ATTRIBUTION_DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

export type OrderAttributionKind = "order" | "refund";

/** The durable `orderId → arm` row. `tallied` is the order-level idempotency claim (dimension 2). */
interface OrderArmRow {
  tenantId: string;
  arm: Arm;
  play: Play;
  period: string;
  currency?: string;
  tallied: boolean;
}

/** The queue message payload — the ONLY fields extracted from a verified webhook body. Every field is
 *  either our own opaque token, a bare business-record id, or a plain number/currency code — see the
 *  file header's "NO PII CROSSES THIS FILE" note. */
export interface OrderAttributionPayload {
  tenantId: string;
  /** The originating webhook topic, kept for the audit trail — never used to bypass `kind`'s routing. */
  topic: string;
  kind: OrderAttributionKind;
  /** Bare decimal order id (`orderNumericIdOf` for order topics, `refundOrderIdOf` for refunds — both
   *  produce the SAME key space, shopify-webhook-identity.ts). Absent ⇒ unattributed. */
  orderId?: string;
  /** The opaque join token (order topics only — a Refund body carries no note_attributes). */
  joinToken?: string;
  /** `total_price` for an order, the summed refund amount for a refund. Absent ⇒ unattributed (never
   *  coerced to 0 — see `moneyAmountOf`'s own doc for why 0 and "unreadable" must never be confused). */
  amount?: number;
  currency?: string;
  at: string;
}

/** Build the queue message for a verified order/refund delivery. `id` is Shopify's own webhook id when
 *  present (so a redelivered id dedups both at the QueuePort layer AND this file's own message-level
 *  dedup); a synthetic per-tenant/topic/order id otherwise — attribution is idempotent either way. */
export function orderAttributionMessage(input: {
  tenantId: string;
  topic: string;
  kind: OrderAttributionKind;
  webhookId: string | undefined;
  nowMs: number;
  orderId?: string;
  joinToken?: string;
  amount?: number;
  currency?: string;
}): QueueMessage {
  const payload: OrderAttributionPayload = {
    tenantId: input.tenantId,
    topic: input.topic,
    kind: input.kind,
    ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
    ...(input.joinToken !== undefined ? { joinToken: input.joinToken } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    at: new Date(input.nowMs).toISOString(),
  };
  return {
    id: input.webhookId ?? `${input.tenantId}:${input.topic}:${input.orderId ?? "unknown"}:${input.nowMs}`,
    type: `order_attribution.${input.topic}`,
    tenantKey: input.tenantId,
    payload,
  };
}

export type AttributionOutcome = "tallied" | "duplicate" | "unattributed";

/**
 * `orders/create` / `orders/updated` — resolve the join token, then tally `{orders:1, revenue:amount}`
 * onto the arm it resolved to. `orders/create` and `orders/updated` are treated as INTERCHANGEABLE
 * completions of the SAME order's attribution (deliberately — see `ORDER_ARM_COLLECTION`'s doc):
 * whichever is delivered first claims the order (covers a missed `orders/create`); every later
 * delivery for the same order — of EITHER topic — is `"duplicate"`, never a second tally.
 */
async function applyOrder(store: RuntimeStatePort, payload: OrderAttributionPayload, now: () => number): Promise<AttributionOutcome> {
  const { tenantId, orderId, joinToken, amount } = payload;
  if (!orderId || !joinToken || amount === undefined) return "unattributed";

  const resolved = await resolveOrderJoinToken(store, tenantId, joinToken);
  if (!resolved) return "unattributed"; // absent/unknown/expired token, or minted for a different tenant
  const { arm, play, period } = resolved;

  // Claim-then-act (file header) — atomic check-and-set inside ONE tx, so two near-simultaneous
  // deliveries (orders/create and orders/updated for the same order) can never both win.
  const claimed = await store.tx({ tenantId }, async (t) => {
    const existing = await t.get<OrderArmRow>(ORDER_ARM_COLLECTION, orderId);
    if (existing?.tallied) return false;
    const row: OrderArmRow = { tenantId, arm, play, period, tallied: true, ...(payload.currency ? { currency: payload.currency } : {}) };
    await t.put(ORDER_ARM_COLLECTION, orderId, row, { ttlSeconds: ORDER_ARM_TTL_SECONDS });
    await t.audit(
      {
        actor: "order-attribution",
        action: "order_attribution.order_tallied",
        input: { topic: payload.topic, orderId, period, arm },
        decision: { orders: 1, revenue: amount, currency: payload.currency ?? null },
        reversalPath:
          `accumulate a compensating negative delta via accumulateArmTally for (tenantId:"${tenantId}", ` +
          `play:"${play}", period:"${period}", arm:"${arm}") of {orders:-1, revenue:${-amount}} — the ` +
          "ledger is a running total and is never mutated in place (same reversal accumulateArmTally's own audit describes).",
      },
      new Date(now()).toISOString(),
    );
    return true;
  });
  if (!claimed) return "duplicate";

  await accumulateArmTally(store, { tenantId, play, period, arm, orders: 1, revenue: amount }, new Date(now()).toISOString());
  return "tallied";
}

/**
 * `refunds/create` — a Refund body carries no join token (only its parent order's `order_id`), so this
 * resolves the arm through the `ORDER_ARM_COLLECTION` row the order's own delivery already wrote. No
 * row (order never resolved a token, or the row TTL'd out) ⇒ `"unattributed"` — never guessed.
 */
async function applyRefund(store: RuntimeStatePort, payload: OrderAttributionPayload, now: () => number): Promise<AttributionOutcome> {
  const { tenantId, orderId, amount } = payload;
  if (!orderId || amount === undefined) return "unattributed";

  const row = await store.get<OrderArmRow>({ tenantId }, ORDER_ARM_COLLECTION, orderId);
  if (!row || !row.tallied) return "unattributed";

  await store.audit(
    { tenantId },
    {
      actor: "order-attribution",
      action: "order_attribution.refund_tallied",
      input: { topic: payload.topic, orderId, period: row.period, arm: row.arm },
      decision: { revenue: -amount, currency: payload.currency ?? row.currency ?? null },
      reversalPath:
        `accumulate a compensating positive delta via accumulateArmTally for (tenantId:"${tenantId}", ` +
        `play:"${row.play}", period:"${row.period}", arm:"${row.arm}") of {revenue:${amount}} if this refund ` +
        "was recorded in error — the ledger is a running total and is never mutated in place.",
    },
    new Date(now()).toISOString(),
  );
  await accumulateArmTally(store, { tenantId, play: row.play, period: row.period, arm: row.arm, revenue: -amount }, new Date(now()).toISOString());
  return "tallied";
}

/**
 * The single entry point the worker (whether reached via `subscribeOrderAttribution`'s QueuePort
 * consumer or a direct call in tests) runs per delivery. `messageId` is the message-level idempotency
 * key (dimension 1, file header) — claimed BEFORE dispatching to `applyOrder`/`applyRefund`.
 */
export async function applyOrderAttribution(
  store: RuntimeStatePort,
  messageId: string,
  payload: OrderAttributionPayload,
  now: () => number = Date.now,
): Promise<AttributionOutcome> {
  const { tenantId } = payload;
  if (!tenantId || !tenantId.trim() || !messageId || !messageId.trim()) return "unattributed";

  const seen = await store.get({ tenantId }, ORDER_ATTRIBUTION_DEDUP_COLLECTION, messageId);
  if (seen) return "duplicate";
  // Claim-then-act (file header): mark BEFORE tallying, trading a rare crash-window under-count for
  // never double-tallying a redelivered message.
  await store.put(
    { tenantId },
    ORDER_ATTRIBUTION_DEDUP_COLLECTION,
    messageId,
    { at: new Date(now()).toISOString() },
    { ttlSeconds: ORDER_ATTRIBUTION_DEDUP_TTL_SECONDS },
  );

  return payload.kind === "refund" ? applyRefund(store, payload, now) : applyOrder(store, payload, now);
}

/**
 * Subscribe the order-attribution worker to the durable queue. A malformed/tenant-less payload is
 * dropped (ack, never retried — retrying can't make a structurally invalid message valid), mirroring
 * `subscribeCatalogReconcile`'s own guard. A thrown `applyOrderAttribution` propagates so the QueuePort
 * retries then dead-letters, exactly like every other worker in this file's family.
 */
export function subscribeOrderAttribution(queue: QueuePort, store: RuntimeStatePort, now: () => number = Date.now): QueueSubscription {
  return queue.subscribe(ORDER_ATTRIBUTION_TOPIC, ORDER_ATTRIBUTION_GROUP, async (msg) => {
    const payload = msg.payload as OrderAttributionPayload | undefined;
    if (!payload || typeof payload.tenantId !== "string" || !payload.tenantId.trim()) return;
    await applyOrderAttribution(store, msg.id, payload, now);
  });
}
