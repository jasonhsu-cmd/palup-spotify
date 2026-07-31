import { createHmac, timingSafeEqual } from "node:crypto";

// Shared base64url + HMAC-SHA256 codec for the PalUp-signed session tokens (widget-token-identity.ts +
// shopper-token-identity.ts). node:crypto only (portable, ADR-0001) — no external JWT lib. The two
// token TYPES are domain-separated by a mandatory `typ` claim enforced by each adapter (ADR-0017 F1),
// not by using different crypto — sharing this codec is safe and keeps the two mint/verify pairs in sync.

export function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function hmacSign(secret: string, body: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** Constant-time compare of two signature strings (length-guarded — timingSafeEqual throws on a length
 * mismatch, so we check that first rather than let a length-based timing signal leak either way). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
