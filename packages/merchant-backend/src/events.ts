// W1-API Task 7: the Approval Center's live-update channel. `EventBus` is an in-process pub/sub
// abstraction — NOT a platform port: it exists purely so the SSE route (`routes/events.ts`) can
// notify an open connection when a mutating route (approve/reject/kill/unkill) changes a proposal or
// the kill state, so the console panel can react without polling. It is explicitly NOT the source of
// truth: `ProposalStore`/`RuntimeStatePort` (via `GET /approvals`, `GET /kill`) always are — a
// dropped/missed SSE event never loses data, because the console reconciles by re-fetching those read
// routes. Best-effort by construction: `publish`/`subscribe` are synchronous and never throw back into
// the caller (a mutating route must never fail an approve/reject/kill because a subscriber's stream
// closed mid-write).
//
// TODO: replace InMemoryEventBus with a pub/sub adapter (e.g. Redis / Cloud Pub/Sub) before running
// more than one merchant-backend instance — today's process-local `Map<tenantId, Set<listener>>` only
// reaches subscribers connected to THIS instance, so an approve landing on instance A never reaches a
// console connected to instance B's `/events`. That gap is documented here, not silently assumed away;
// it does not threaten correctness because the store remains authoritative (see above).

export type ConsoleEvent =
  | { type: "proposal.created"; id: string }
  | { type: "proposal.decided"; id: string; status: string }
  | { type: "kill.changed"; killed: boolean };

export type ConsoleEventListener = (event: ConsoleEvent) => void;

export interface EventBus {
  /** Fire-and-forget: never throws, regardless of subscriber behavior. */
  publish(tenantId: string, event: ConsoleEvent): void;
  /** Returns an `unsubscribe` function. Tenant-isolated: a listener registered for one tenant is
   *  never invoked for another tenant's `publish`. */
  subscribe(tenantId: string, listener: ConsoleEventListener): () => void;
}

export class InMemoryEventBus implements EventBus {
  private readonly subscribers = new Map<string, Set<ConsoleEventListener>>();

  publish(tenantId: string, event: ConsoleEvent): void {
    const listeners = this.subscribers.get(tenantId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving subscriber (e.g. writing to an already-closed SSE connection) must never
        // break the publisher or any other subscriber for this tenant — best-effort delivery only.
      }
    }
  }

  subscribe(tenantId: string, listener: ConsoleEventListener): () => void {
    let listeners = this.subscribers.get(tenantId);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(tenantId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.subscribers.get(tenantId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.subscribers.delete(tenantId);
    };
  }
}
