import { createHash } from "node:crypto";
import type { RuntimeStatePort } from "@palup/platform-ports";
import { redactPII } from "@palup/platform-ports";
import type { Policy } from "@palup/widget-brain";

// Canary traffic split + traffic logging (the run-time half of shadow/canary), on the SHARED
// RuntimeStatePort so a canary start/rollback the control plane writes takes effect on EVERY serving
// instance, and shadow-grading reads the same traffic (was a per-instance local file). The canary
// config is keyed PER SERVING TENANT (the authenticated merchant) — a canary the control plane starts
// for one merchant must bucket ONLY that merchant's shoppers, and never leak cross-tenant onto every
// merchant's traffic (ADR-0014 blast-radius fix). Keep the collection/key names in sync with
// control-plane/canary-controller.ts.

const CANARY = "canary"; // KV collection (rollout config), keyed per SERVING tenant
const CONFIG_KEY = "config";
// Traffic carries shopper messages/replies, so it lives in the SERVING tenant's own partition (passed
// in — the authenticated merchant tenant).
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

export async function readCanaryConfig(store: RuntimeStatePort, tenantId: string): Promise<CanaryConfig | null> {
  return (await store.get<CanaryConfig>({ tenantId }, CANARY, CONFIG_KEY)) ?? null;
}

/** The SERVING tenant's canary config if this session should be served by the canary, else null (→ champion).
 * Reads ONLY this tenant's config, so a tenant with no canary always gets the champion/DEFAULT_POLICY and
 * a canary started for a DIFFERENT tenant can never bucket this tenant's shoppers (ADR-0014). */
export async function assignCanary(store: RuntimeStatePort, tenantId: string, sessionId: string): Promise<CanaryConfig | null> {
  const cfg = await readCanaryConfig(store, tenantId);
  if (!cfg?.enabled || cfg.pct <= 0) return null;
  return bucket(sessionId) < cfg.pct ? cfg : null;
}

export async function logTraffic(store: RuntimeStatePort, tenantId: string, entry: Record<string, unknown>): Promise<void> {
  // Logging must never break serving. Traffic is written under the serving tenant's partition.
  // This is the SINGLE choke point for at-rest traffic minimization (F3): redaction/hashing happens
  // HERE, not at the call site, so no caller can accidentally persist raw PII. The `message`/`reply`
  // text is PII-redacted (cards/SSNs) and the client-supplied `sessionId` is hashed (F5 — a shopper
  // could otherwise stuff PII into it; the audit log already hashes it). Hash preserves per-session
  // grouping for analytics while removing the raw identifier.
  try {
    const safe: Record<string, unknown> = { ...entry };
    if (typeof safe.message === "string") safe.message = redactPII(safe.message);
    if (typeof safe.reply === "string") safe.reply = redactPII(safe.reply);
    if (typeof safe.sessionId === "string") {
      safe.sessionId = "sess_" + createHash("sha256").update(safe.sessionId).digest("hex").slice(0, 16);
    }
    await store.append({ tenantId }, TRAFFIC, { ts: new Date().toISOString(), ...safe });
  } catch {
    /* ignore */
  }
}
