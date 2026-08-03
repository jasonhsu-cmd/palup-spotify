import { hmacSign, b64url, b64urlDecode, constantTimeEqual } from "./token-codec.js";

// Step-up (re-auth) assertion for high-sensitivity control-plane actions — first user: the ADR-0014
// auto-promote opt-in SET (docs/adr/0014, prereq #6: "opt-in SET is step-up + audited"). This is a REAL
// step-up, materially stronger than the standing operator bearer token (operator-identity.ts):
//   • signed with a SEPARATE elevated secret the standing token holder need not possess;
//   • FRESH — a short max-age, so a captured assertion is useless minutes later;
//   • BOUND to an exact `action` + `tenantId`, so it cannot be replayed for a different action or to
//     flip a different merchant's flag (cross-tenant / cross-action replay);
//   • domain-separated by a mandatory `typ`, so a session token (token-codec.ts) can never be presented
//     as a step-up even if it were signed with the same secret;
//   • carries a `nonce` for SINGLE-USE enforcement — the CALLER records the returned nonce atomically
//     with the action (see state-postgres/autopromote-optin.ts) so a replay inside the freshness window
//     is also refused.
// node:crypto only (portable, ADR-0001) — reuses the shared HMAC codec, no external JWT lib. Every
// failure mode returns { ok:false } (never throws): unconfigured secret, missing/malformed token, bad
// signature, wrong typ, action/tenant mismatch, stale/future-dated, missing nonce — all fail CLOSED.

const TYP = "autopromote-stepup";
/** Max assertion age. A step-up must be minted immediately before the action it authorizes. */
export const STEPUP_MAX_AGE_MS = 5 * 60_000;
/** Allowed clock skew for a future-dated `iat` (a small negative age), to tolerate minor clock drift. */
const CLOCK_SKEW_MS = 30_000;

export interface StepUpClaims {
  /** The exact action this assertion authorizes, e.g. "autopromote.optin.set". */
  action: string;
  /** The tenant this assertion is bound to (the merchant whose flag is being set, or a platform id). */
  tenantId: string;
  /** Issued-at, epoch ms. */
  iat: number;
  /** Single-use id; the caller must record it (once) atomically with the action. */
  nonce: string;
}

export type StepUpResult = { ok: true; nonce: string } | { ok: false; reason: string };

/** Mint a signed step-up assertion. Operators/tests call this; the secret is the elevated step-up
 * secret (NOT the standing OPERATOR_TOKEN). */
export function mintStepUp(secret: string, claims: StepUpClaims): string {
  const payload = b64url(Buffer.from(JSON.stringify({ typ: TYP, ...claims })));
  return `${payload}.${hmacSign(secret, payload)}`;
}

/**
 * Verify a step-up assertion against what the action expects. Returns the nonce on success so the caller
 * can enforce single-use. Fails closed on every anomaly. Signature is checked BEFORE the payload is
 * parsed/trusted.
 */
export function verifyStepUp(
  secret: string | undefined,
  token: string | undefined,
  expected: { action: string; tenantId: string; now: number; maxAgeMs?: number },
): StepUpResult {
  if (!secret) return { ok: false, reason: "step-up secret not configured (fail-closed)" };
  if (!token) return { ok: false, reason: "step-up assertion required" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed step-up assertion" };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!constantTimeEqual(sig, hmacSign(secret, payload))) return { ok: false, reason: "bad step-up signature" };

  let claims: Partial<StepUpClaims> & { typ?: string };
  try {
    claims = JSON.parse(b64urlDecode(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "unparseable step-up payload" };
  }
  if (claims.typ !== TYP) return { ok: false, reason: "wrong assertion type" };
  if (claims.action !== expected.action) return { ok: false, reason: "step-up action mismatch" };
  if (claims.tenantId !== expected.tenantId) return { ok: false, reason: "step-up tenant mismatch" };
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) return { ok: false, reason: "missing/invalid iat" };
  const age = expected.now - claims.iat;
  if (age > (expected.maxAgeMs ?? STEPUP_MAX_AGE_MS)) return { ok: false, reason: "step-up assertion expired" };
  if (age < -CLOCK_SKEW_MS) return { ok: false, reason: "step-up assertion issued in the future" };
  if (typeof claims.nonce !== "string" || !claims.nonce) return { ok: false, reason: "missing nonce" };
  return { ok: true, nonce: claims.nonce };
}
