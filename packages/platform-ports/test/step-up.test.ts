import { describe, it, expect } from "vitest";
import { mintStepUp, verifyStepUp, STEPUP_MAX_AGE_MS } from "../src/step-up.js";
import { hmacSign, b64url } from "../src/token-codec.js";

// ADR-0014 prereq #6 — a REAL step-up primitive for the opt-in SET (owner chose to build it now, not
// defer). Materially stronger than the standing operator bearer token: a SEPARATE elevated secret, a
// FRESH (short-TTL) assertion, BOUND to an exact action+tenant (no cross-tenant / cross-action replay),
// single-use via a nonce, domain-separated by `typ`. Every failure mode fails CLOSED.

const SECRET = "elevated-stepup-secret";
const T0 = 1_754_000_000_000; // fixed epoch ms (tests must not use Date.now())
const claims = (over: Partial<{ action: string; tenantId: string; iat: number; nonce: string }> = {}) => ({
  action: "autopromote.optin.set",
  tenantId: "acme",
  iat: T0,
  nonce: "n1",
  ...over,
});
const expect_ = (over: Partial<{ action: string; tenantId: string; now: number }> = {}) => ({
  action: "autopromote.optin.set",
  tenantId: "acme",
  now: T0 + 1000,
  ...over,
});

describe("step-up assertion (ADR-0014 #6: elevated, fresh, action+tenant-bound, single-use)", () => {
  it("accepts a well-formed, fresh, matching assertion and returns its nonce", () => {
    const r = verifyStepUp(SECRET, mintStepUp(SECRET, claims()), expect_());
    expect(r.ok).toBe(true);
    expect(r.ok && r.nonce).toBe("n1");
  });

  it("fails CLOSED when the secret is not configured", () => {
    const r = verifyStepUp(undefined, mintStepUp(SECRET, claims()), expect_());
    expect(r.ok).toBe(false);
  });

  it("rejects a missing assertion", () => {
    expect(verifyStepUp(SECRET, undefined, expect_()).ok).toBe(false);
  });

  it("rejects a wrong/forged signature (secret mismatch)", () => {
    expect(verifyStepUp(SECRET, mintStepUp("different-secret", claims()), expect_()).ok).toBe(false);
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const tok = mintStepUp(SECRET, claims());
    const [, sig] = tok.split(".");
    const forgedPayload = b64url(Buffer.from(JSON.stringify({ typ: "autopromote-stepup", ...claims({ tenantId: "victim" }) })));
    expect(verifyStepUp(SECRET, `${forgedPayload}.${sig}`, expect_({ tenantId: "victim" })).ok).toBe(false);
  });

  it("rejects the wrong assertion type (a session token can't be reused as a step-up)", () => {
    const payload = b64url(Buffer.from(JSON.stringify({ typ: "widget-session", ...claims() })));
    const tok = `${payload}.${hmacSign(SECRET, payload)}`; // correctly signed, but wrong typ
    expect(verifyStepUp(SECRET, tok, expect_()).ok).toBe(false);
  });

  it("rejects an action mismatch (a step-up minted for another action can't be replayed here)", () => {
    const tok = mintStepUp(SECRET, claims({ action: "kill.arm" }));
    expect(verifyStepUp(SECRET, tok, expect_({ action: "autopromote.optin.set" })).ok).toBe(false);
  });

  it("rejects a tenant mismatch (tenant A's step-up can't set tenant B — cross-tenant replay)", () => {
    const tok = mintStepUp(SECRET, claims({ tenantId: "acme" }));
    expect(verifyStepUp(SECRET, tok, expect_({ tenantId: "other" })).ok).toBe(false);
  });

  it("rejects an expired assertion (older than the max age)", () => {
    const tok = mintStepUp(SECRET, claims({ iat: T0 }));
    expect(verifyStepUp(SECRET, tok, expect_({ now: T0 + STEPUP_MAX_AGE_MS + 1 })).ok).toBe(false);
  });

  it("rejects a future-dated assertion (beyond clock skew)", () => {
    const tok = mintStepUp(SECRET, claims({ iat: T0 + 10 * 60_000 }));
    expect(verifyStepUp(SECRET, tok, { action: "autopromote.optin.set", tenantId: "acme", now: T0 }).ok).toBe(false);
  });

  it("rejects a missing nonce", () => {
    const payload = b64url(Buffer.from(JSON.stringify({ typ: "autopromote-stepup", action: "autopromote.optin.set", tenantId: "acme", iat: T0 })));
    const tok = `${payload}.${hmacSign(SECRET, payload)}`;
    expect(verifyStepUp(SECRET, tok, expect_()).ok).toBe(false);
  });
});
