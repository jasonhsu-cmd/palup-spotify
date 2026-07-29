import type { RuntimeStatePort } from "@palup/platform-ports";
import type { Policy } from "@palup/widget-brain";

// Canary traffic split + traffic logging (the run-time half of shadow/canary), now on the SHARED
// RuntimeStatePort so a canary start/rollback the control plane writes takes effect on EVERY serving
// instance, and shadow-grading reads the same traffic (was a per-instance local file). Config + traffic
// live under the reserved __system__ tenant (rollout is cross-tenant operator state; when real
// multi-tenancy lands, traffic moves per-merchant). Keep the __system__/collection names in sync with
// control-plane/canary-controller.ts.

const SYSTEM = { tenantId: "__system__" };
const CANARY = "canary"; // KV collection (rollout config: operator/cross-instance state)
const CONFIG_KEY = "config";
// Traffic carries shopper messages/replies, so it lives in the SERVING tenant's own partition — NOT
// the cross-tenant __system__ bucket. Single-tenant demo for now; per-merchant when tenancy lands.
// (Retention/TTL + minimization before real multi-tenant — tracked follow-up.)
const SERVING = { tenantId: "demo" };
const TRAFFIC = "traffic"; // append stream

export interface CanaryConfig {
  enabled: boolean;
  pct: number; // 0..N of sessions served by the canary policy
  policy: Policy;
}

// Stable per-session bucket 0..99 — a session always lands the same side of the split (sticky), so a
// shopper never flips policy mid-conversation.
export function bucket(sessionId: string): number {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

export async function readCanaryConfig(store: RuntimeStatePort): Promise<CanaryConfig | null> {
  return (await store.get<CanaryConfig>(SYSTEM, CANARY, CONFIG_KEY)) ?? null;
}

/** The canary config if this session should be served by the canary, else null (→ champion). */
export async function assignCanary(store: RuntimeStatePort, sessionId: string): Promise<CanaryConfig | null> {
  const cfg = await readCanaryConfig(store);
  if (!cfg?.enabled || cfg.pct <= 0) return null;
  return bucket(sessionId) < cfg.pct ? cfg : null;
}

export async function logTraffic(store: RuntimeStatePort, entry: Record<string, unknown>): Promise<void> {
  // Logging must never break serving.
  try {
    await store.append(SERVING, TRAFFIC, { ts: new Date().toISOString(), ...entry });
  } catch {
    /* ignore */
  }
}
