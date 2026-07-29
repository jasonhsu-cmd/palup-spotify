import type { RuntimeStatePort } from "@palup/platform-ports";

// Fixed-window rate limiter backed by the shared RuntimeStatePort (KV + TTL) — no vendor SDK / gateway
// (NN #3). Best-effort: the get-then-put is mildly racy under high concurrency, which is fine for
// denial-of-wallet protection (approximate limiting; a few extra requests in a race never matters).
// State auto-expires via the entry TTL, so buckets self-clean. Scoped to the serving tenant.

interface Window {
  count: number;
  windowStart: number; // epoch ms
}

/** Returns true if this bucket may proceed (and counts the request), false if it is over the limit. */
export async function allowRequest(
  store: RuntimeStatePort,
  ctx: { tenantId: string },
  bucket: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): Promise<boolean> {
  const rec = await store.get<Window>(ctx, "ratelimit", bucket);
  if (!rec || now - rec.windowStart >= windowSeconds * 1000) {
    await store.put(ctx, "ratelimit", bucket, { count: 1, windowStart: now }, { ttlSeconds: windowSeconds });
    return true;
  }
  if (rec.count >= limit) return false;
  await store.put(ctx, "ratelimit", bucket, { count: rec.count + 1, windowStart: rec.windowStart }, { ttlSeconds: windowSeconds });
  return true;
}
