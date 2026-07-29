import type { SessionStore, SessionState } from "@palup/widget-brain";
import type { RuntimeStatePort } from "@palup/platform-ports";

// Durable, tenant-scoped SessionStore backed by the shared RuntimeStatePort. Replaces the in-process
// Map so a conversation's safety latch (INV-A), open issues (INV-B), and pitch budget (INV-E) survive
// restart / scale-to-zero and are shared across Cloud Run instances — losing them mid-conversation
// silently un-latches safety suppression and resets the governed proactivity cap (assessment blocker).
// The store deep-copies on read/write, so no aliasing across turns.
export function createRuntimeSessionStore(store: RuntimeStatePort, tenantId: string): SessionStore {
  const ctx = { tenantId };
  return {
    load: async (sessionId) => (await store.get<SessionState>(ctx, "session", sessionId)) ?? undefined,
    save: async (sessionId, state) => store.put(ctx, "session", sessionId, state),
  };
}
