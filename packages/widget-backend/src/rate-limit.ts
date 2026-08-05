import type { RuntimeStatePort } from "@palup/platform-ports";

// Rate limiting on the shared RuntimeStatePort (NN #3 — no vendor SDK/gateway), using the store's
// ATOMIC windowed counter so a concurrent burst can't over-admit past the limit (the per-tenant
// ceiling is the real denial-of-wallet backstop and must hold under concurrency).

/**
 * Bound + validate a client-derived IP into a safe bucket key. `X-Forwarded-For` is attacker-controlled
 * (arbitrary length + content), so an unbounded value could blow the store key size and force an error;
 * we accept only a plausible, length-capped IP and otherwise bucket as "unknown". (Spoofing among
 * valid-looking IPs is still possible — the per-tenant ceiling backstops that; `trustProxy` + req.ip is
 * the fuller fix once the ingress proxy depth is known.)
 */
export function clientIpKey(xForwardedFor: string | undefined, fallback: string): string {
  const first = (String(xForwardedFor ?? "").split(",")[0] ?? "").trim();
  if (first.length > 0 && first.length <= 45 && /^[0-9a-fA-F:.]+$/.test(first)) return first;
  const fb = String(fallback ?? "").trim();
  return fb.length > 0 && fb.length <= 45 ? fb : "unknown";
}

/** True if `key` is still under `limit` in the current window (this call counts). Atomic. */
export async function underLimit(
  store: RuntimeStatePort,
  ctx: { tenantId: string },
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  return (await store.incrementWindow(ctx, key, windowSeconds)) <= limit;
}

export interface RateBuckets {
  sessionId: string;
  ip: string;
  sessionLimit: number;
  ipLimit: number;
  tenantLimit: number;
  windowSeconds: number;
}

/**
 * Evaluate all buckets INDEPENDENTLY (one bucket's store error must not disable the others). The
 * session + IP fairness buckets fail-OPEN on a store error (availability); the per-tenant cost ceiling
 * fails-CLOSED (a cost backstop must never silently switch off). Returns true if the request is allowed.
 */
export async function allowRequest(store: RuntimeStatePort, ctx: { tenantId: string }, b: RateBuckets): Promise<boolean> {
  let allowed = true;
  try {
    if (!(await underLimit(store, ctx, `session:${b.sessionId}`, b.sessionLimit, b.windowSeconds))) allowed = false;
  } catch {
    /* fail-open (fairness bucket) */
  }
  try {
    if (!(await underLimit(store, ctx, `ip:${b.ip}`, b.ipLimit, b.windowSeconds))) allowed = false;
  } catch {
    /* fail-open (fairness bucket) */
  }
  try {
    if (!(await underLimit(store, ctx, "tenant", b.tenantLimit, b.windowSeconds))) allowed = false;
  } catch {
    allowed = false; // fail-CLOSED: the per-tenant cost ceiling must not silently disable
  }
  return allowed;
}
