// Queue port (ADR-0001; ADR-0006 event backbone + work queue; ADR-0020 A0 / D4): the ONLY way feature
// code enqueues async work / publishes domain events. Feature code depends on this interface; adapters
// (an in-memory reference here; Cloud Tasks + Pub/Sub at deploy time) implement it and swap behind it, so
// no provider SDK leaks into feature code (portability-guard, ADR-0001; ADR-0006 explicitly rejects a
// Pub/Sub SDK in feature code).
//
// Contract this port guarantees (ADR-0006 §Decision.4): messages carry a TENANT KEY; delivery is
// AT-LEAST-ONCE to EACH subscribed consumer group; per-tenant-key publish ORDER is preserved; and a
// handler that keeps failing is DEAD-LETTERED (not retried forever) so a poison message can't wedge the
// queue. Because delivery is at-least-once, **handlers MUST be idempotent** — the in-memory reference
// dedups on `msg.id` per group and delivers exactly once on success, but a real adapter may redeliver.
//
// A0/D4 scope is enqueue + consume + idempotency (webhook ingestion). Delayed/scheduled delivery
// (`scheduleRun`, cadence timers) is deferred to the agent-runtime lane (ADR-0005) — not modelled here.

export interface QueueMessage {
  /** Idempotency key. A message whose id a group has already processed is not re-delivered to that group. */
  id: string;
  /** Vendor-neutral event/task type, e.g. "shopify.products/update". */
  type: string;
  /** The tenant this message belongs to. A handler MUST scope all work to this tenant (no cross-tenant). */
  tenantKey: string;
  /** Neutral payload (no provider/Shopify types cross the port — NN#3). */
  payload: unknown;
}

export type QueueHandler = (msg: QueueMessage) => Promise<void>;

/** Handle to stop a consumer group receiving further messages. */
export interface QueueSubscription {
  unsubscribe(): void;
}

/** A message that exhausted its retries (for inspection; the scheduled reconcile job is the real backstop). */
export interface DeadLetter {
  topic: string;
  group: string;
  msg: QueueMessage;
  error: string;
}

export interface QueuePort {
  /**
   * Publish a message to a topic. Delivered at-least-once to EACH consumer group currently subscribed to
   * the topic, idempotent within a group (dedup on `msg.id`), in per-`tenantKey` publish order. Only groups
   * subscribed BEFORE the publish receive it (no historical replay).
   */
  publish(topic: string, msg: QueueMessage): Promise<void>;
  /**
   * Register a consumer group's handler for a topic. A handler that throws is retried up to the adapter's
   * attempt cap; a message that still fails is dead-lettered (see `deadLettered`) rather than retried
   * forever. Returns an unsubscribe handle.
   */
  subscribe(topic: string, group: string, handler: QueueHandler): QueueSubscription;
  /** Messages that exhausted retries across all topics/groups. */
  deadLettered(): readonly DeadLetter[];
}

/** A non-blank topic + tenantKey are REQUIRED — an empty topic/tenant is a cross-scope wildcard, so we
 *  throw rather than widen scope (mirrors VectorPort's `requireNamespace`). */
function requireTopic(topic: string): string {
  if (!topic || !topic.trim()) throw new Error("QueuePort: a non-blank topic is required");
  return topic;
}
function requireTenantKey(msg: QueueMessage): void {
  if (!msg.tenantKey || !msg.tenantKey.trim())
    throw new Error("QueuePort: message.tenantKey is required (tenant isolation)");
  if (!msg.id || !msg.id.trim()) throw new Error("QueuePort: message.id is required (idempotency key)");
}

interface GroupState {
  handler: QueueHandler;
  processed: Set<string>; // msg ids this group has successfully handled (idempotent dedup)
  active: boolean;
}

/**
 * In-memory reference adapter — the behavioral oracle every durable adapter (Cloud Tasks, Pub/Sub) must
 * match (the contract). Delivery is synchronous-on-publish so tests are deterministic; the observable
 * guarantees (fan-out per group, dedup on id, retry→dead-letter, per-tenant-key order) are what a real
 * async adapter must also satisfy. `maxAttempts` caps retries before dead-lettering (default 3).
 */
export function createInMemoryQueue(opts: { maxAttempts?: number } = {}): QueuePort {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));
  const topics = new Map<string, Map<string, GroupState>>();
  const dlq: DeadLetter[] = [];

  return {
    async publish(topic, msg) {
      const t = requireTopic(topic);
      requireTenantKey(msg);
      const groups = topics.get(t);
      if (!groups) return; // no subscribers → nothing to deliver (no historical replay)
      // Snapshot: delivering to groups in a stable order; per-tenantKey order is preserved because
      // publish() is awaited by callers, so publishes for one tenant serialize in call order.
      for (const [group, state] of groups) {
        if (!state.active || state.processed.has(msg.id)) continue; // idempotent within the group
        let lastErr: unknown;
        let delivered = false;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await state.handler({ ...msg });
            state.processed.add(msg.id);
            delivered = true;
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!delivered) {
          dlq.push({ topic: t, group, msg: { ...msg }, error: lastErr instanceof Error ? lastErr.message : String(lastErr) });
        }
      }
    },
    subscribe(topic, group, handler) {
      const t = requireTopic(topic);
      if (!group || !group.trim()) throw new Error("QueuePort: a non-blank consumer group is required");
      let groups = topics.get(t);
      if (!groups) {
        groups = new Map();
        topics.set(t, groups);
      }
      const state: GroupState = { handler, processed: new Set(), active: true };
      groups.set(group, state);
      return {
        unsubscribe() {
          state.active = false;
        },
      };
    },
    deadLettered() {
      return dlq;
    },
  };
}
