import { createHmac } from "node:crypto";

// Test-only helper for ADR-0019 task 4/9: craft a validly-signed guest token for a SPECIFIC anonId, so
// tests that pin a fixed guest id (e.g. `GUEST_ANON_ID`) can present it the way the server now requires —
// via the `x-guest-token` header — instead of the removed `body.anonId` / `signals.anonId` path. The
// production `mintGuestToken` deliberately generates a RANDOM id (invariant 3), so it cannot be used to
// reproduce a pinned id; this helper signs `{typ:"guest",tid,aid,exp}` with the same HMAC-SHA256 +
// base64url codec the server verifies with. It is the guest-token analogue of the widget/shopper test
// tokens the same suites already mint.
//
// This is NOT a way to bypass the server's verification — the token it produces is only accepted if signed
// with the deployment's real `GUEST_TOKEN_SECRET`, exactly like a genuine one.

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A valid guest token for `anonId` at `tenantId`, signed with `secret`. Default TTL 1h; pass a negative
 *  ttl to craft an already-expired token. */
export function craftGuestToken(secret: string, tenantId: string, anonId: string, ttlSeconds = 3_600): string {
  const body = b64url(Buffer.from(JSON.stringify({ typ: "guest", tid: tenantId, aid: anonId, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
}

/** Convenience: the `x-guest-token` header object for a crafted token. */
export function guestTokenHeader(secret: string, tenantId: string, anonId: string, ttlSeconds = 3_600): Record<string, string> {
  return { "x-guest-token": craftGuestToken(secret, tenantId, anonId, ttlSeconds) };
}
