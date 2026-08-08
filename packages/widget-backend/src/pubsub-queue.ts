import type { QueueMessage, QueuePort, QueueSubscription, DeadLetter } from "@palup/platform-ports";

// P4 (ADR-0020 D4 / ADR-0006) — the durable, async QueuePort adapter over Google Pub/Sub, replacing the
// in-memory reference queue whose synchronous-on-publish delivery blocks the webhook request on a full
// re-index (the A3-part-2 security review's finding B). The provider SDK lives HERE, behind the port
// (ADR-0001 / NN#3) — no @google-cloud import escapes into feature code.
//
// PUSH, NOT PULL — WHY subscribe() THROWS. We deploy on Cloud Run (request-driven, scales to zero), so
// there is no always-on process to run a pull loop. Pub/Sub therefore PUSHES each message as an HTTPS POST
// to an OIDC-verified endpoint (routes/pubsub-push.ts), which wakes the service and runs the reconcile in
// that request. That consumption model does not fit QueuePort's IN-PROCESS `subscribe(handler)`, so this
// adapter implements the PUBLISH side only and `subscribe()` fails loudly rather than silently never
// delivering. The composition root wires the push ROUTE instead of calling subscribe on this adapter.
//
// **UNVERIFIED-LIVE.** Per the go-live decision, the live Pub/Sub path is verified in STAGING, not the
// merge-gate: the message-building + fail-safe here are unit-tested against an injected fake client, but no
// test exercises a real topic. Enabling CATALOG_WEBHOOKS with this adapter is gated on that staging
// verification (docs/A1B-A3-GO-LIVE-CHECKLIST.md P4).

/** The minimal Pub/Sub surface this adapter needs — injectable so the message-building is unit-testable
 *  without the real SDK (the @google-cloud/pubsub `Topic.publishMessage` shape). */
export interface PubSubTopicClient {
  publishMessage(args: { data: Buffer; attributes?: Record<string, string>; orderingKey?: string }): Promise<string>;
}
export interface PubSubClientLike {
  topic(name: string, opts?: { messageOrdering?: boolean }): PubSubTopicClient;
}

export interface PubSubQueueOptions {
  client: PubSubClientLike;
  /** Maps a QueuePort topic (e.g. "catalog.reconcile") to a Pub/Sub topic name. Pub/Sub topic ids allow
   *  `[A-Za-z0-9._~%+-]`, so the QueuePort `.` is fine; a prefix namespaces this app's topics. */
  topicName: (queueTopic: string) => string;
}

/**
 * Pub/Sub-backed QueuePort (publish side). Each `publish` becomes one Pub/Sub message whose body is the
 * JSON payload and whose `id`/`type`/`tenantKey` ride as ATTRIBUTES (so the push route can dedup/route
 * without parsing the body), with `tenantKey` as the ORDERING KEY so per-tenant publish order is preserved
 * end to end (matching the in-memory contract). Non-blank topic + tenantKey + id are required (tenant/scope
 * isolation), exactly like the in-memory reference.
 */
export function createPubSubQueue(opts: PubSubQueueOptions): QueuePort {
  return {
    async publish(topic: string, msg: QueueMessage): Promise<void> {
      if (!topic || !topic.trim()) throw new Error("PubSubQueue: topic is required");
      if (!msg.tenantKey || !msg.tenantKey.trim()) throw new Error("PubSubQueue: message.tenantKey is required (tenant isolation)");
      if (!msg.id || !msg.id.trim()) throw new Error("PubSubQueue: message.id is required (idempotency)");
      const t = opts.client.topic(opts.topicName(topic), { messageOrdering: true });
      await t.publishMessage({
        data: Buffer.from(JSON.stringify(msg.payload ?? null), "utf8"),
        attributes: { id: msg.id, type: msg.type, tenantKey: msg.tenantKey },
        orderingKey: msg.tenantKey,
      });
    },
    subscribe(): QueueSubscription {
      // Push-mode: consumption is the OIDC-verified HTTP route, never an in-process handler. Throwing
      // (rather than a silent no-op) makes a mis-wire fail loudly at composition, not at 3am with lost work.
      throw new Error(
        "PubSubQueue is push-mode: consume via the OIDC-verified push route (routes/pubsub-push.ts), not subscribe().",
      );
    },
    deadLettered(): readonly DeadLetter[] {
      // Pub/Sub handles retry + dead-lettering SERVER-SIDE (a dead-letter topic on the subscription,
      // configured in infra/terraform), so there is no in-process dead-letter buffer to expose here.
      return [];
    },
  };
}
