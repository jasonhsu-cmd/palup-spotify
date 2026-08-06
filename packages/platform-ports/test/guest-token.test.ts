import { describe, it, expect } from "vitest";
import { mintGuestToken, renewGuestToken, createGuestTokenIdentity } from "../src/guest-token-identity.js";
import { mintWidgetToken } from "../src/widget-token-identity.js";
import { mintShopperToken } from "../src/shopper-token-identity.js";
import { b64url, b64urlDecode, hmacSign } from "../src/token-codec.js";

// ADR-0019 Revision 2, Task 1 — the server-issued guest identity token. Contract tests for the revised
// invariants this piece is responsible for: 1, 2, 6, 7 (and the structural half of 3/11).
//
// WHY THIS EXISTS. The guest `anonId` was client-minted, so the server could not tell whether a presented
// id belonged to its caller — that is C1, and it is why the naive B12(b) carry-over failed the F1 attack
// test. A PalUp-signed guest token makes the id a VERIFIED claim: an attacker who types a victim's id has
// no valid token for it. Mirrors widget-token-identity.ts / shopper-token-identity.ts exactly (same
// HMAC-SHA256 + base64url codec) with two differences the review required: a SEPARATE secret (R2-4, so a
// widget-secret compromise cannot forge guest tokens) and a mandatory `tid` tenant claim (R2-5).

const SECRET = "guest-signing-secret";
const OTHER_SECRET = "a-different-secret";
const TID = "acme";

/** A validly-SIGNED token with an arbitrary body — proves the `typ`/`tid` guards, not mere field absence,
 *  are what reject a token. */
function craftSigned(secret: string, payload: Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${hmacSign(secret, body)}`;
}

describe("guest token — mint + verify round-trip (invariant 1)", () => {
  it("mint returns a fresh server-generated anonId and a token that verifies back to it", async () => {
    const id = createGuestTokenIdentity(SECRET);
    const { token, anonId } = mintGuestToken(SECRET, TID, 300);
    // The id is base32 in validateAnonId's charset/length, so it is a legal namespace component.
    expect(anonId).toMatch(/^[A-Z2-7]{10,64}$/);
    expect(await id.verify(token)).toEqual({ anonId, tid: TID });
  });

  it("INVARIANT 1: a token minted for anonId A never verifies as anonId B", async () => {
    const id = createGuestTokenIdentity(SECRET);
    const a = mintGuestToken(SECRET, TID, 300);
    const b = mintGuestToken(SECRET, TID, 300);
    expect(a.anonId).not.toBe(b.anonId); // fresh each mint
    expect((await id.verify(a.token))?.anonId).toBe(a.anonId);
    // Tampering the aid in the body invalidates the signature → anonymous, never B's id.
    const [body] = a.token.split(".");
    const claims = JSON.parse(b64urlDecode(body).toString("utf8"));
    const forged = craftSigned(SECRET, { ...claims, aid: b.anonId }); // re-signed with the right secret…
    // …but this IS a valid token for b.anonId now — that only means "whoever mints can mint"; the real
    // property is that an ATTACKER without the secret cannot: re-sign with the wrong secret and it fails.
    const attackerForged = `${b64url(Buffer.from(JSON.stringify({ ...claims, aid: b.anonId })))}.${hmacSign(OTHER_SECRET, body)}`;
    expect(await id.verify(attackerForged)).toBeNull();
    expect((await id.verify(forged))?.anonId).toBe(b.anonId); // sanity: the codec works; the guard is the secret
  });

  it("every mint produces a distinct id (structural half of invariant 3 — no client input to the id)", () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintGuestToken(SECRET, TID, 300).anonId));
    expect(ids.size).toBe(200);
    // mintGuestToken has NO anonId parameter — there is no seam through which a client id could enter.
    expect(mintGuestToken).toHaveLength(3); // (secret, tid, ttlSeconds) + optional nowSec default
  });
});

describe("guest token — token-type + secret separation (invariant 2, R2-4)", () => {
  it("a widget token presented as a guest token yields null (wrong secret AND wrong typ)", async () => {
    const id = createGuestTokenIdentity(SECRET);
    // Even if the deployment mistakenly reused one secret, the typ guard still rejects it:
    const widgetUnderGuestSecret = mintWidgetToken(SECRET, TID, 300);
    expect(await id.verify(widgetUnderGuestSecret)).toBeNull();
    // And a widget token under its own (different) secret fails on the signature first.
    expect(await id.verify(mintWidgetToken(OTHER_SECRET, TID, 300))).toBeNull();
  });

  it("a shopper token presented as a guest token yields null", async () => {
    const id = createGuestTokenIdentity(SECRET);
    expect(await id.verify(mintShopperToken(SECRET, "shopify:acme:1", "shopify", 300))).toBeNull();
  });

  it("a guest token verified under the WRONG secret yields null (R2-4 separation is real)", async () => {
    const { token } = mintGuestToken(SECRET, TID, 300);
    expect(await createGuestTokenIdentity(OTHER_SECRET).verify(token)).toBeNull();
  });

  it("a validly-signed body with typ != 'guest' is rejected by the guard, not accepted for its aid", async () => {
    const id = createGuestTokenIdentity(SECRET);
    const forged = craftSigned(SECRET, { typ: "widget", tid: TID, aid: "AAAAAAAAAAAAAAAAAAAAAAAAAA", exp: 9999999999 });
    expect(await id.verify(forged)).toBeNull();
  });
});

describe("guest token — expiry + renew (invariant 6)", () => {
  it("an expired token verifies as null", async () => {
    const id = createGuestTokenIdentity(SECRET);
    const past = () => 1000; // mint at t=1000 with ttl 10 → exp 1010
    const { token } = mintGuestToken(SECRET, TID, 10, past());
    // verify at t=2000 → expired
    const idAtFuture = createGuestTokenIdentity(SECRET, () => 2000);
    expect(await idAtFuture.verify(token)).toBeNull();
    // sanity: verifies while still valid
    const idInWindow = createGuestTokenIdentity(SECRET, () => 1005);
    expect((await idInWindow.verify(token))?.anonId).toBeTruthy();
  });

  it("INVARIANT 6: renew preserves the same aid, issues a new exp", async () => {
    const { token, anonId } = mintGuestToken(SECRET, TID, 3600, 1000);
    const renewed = renewGuestToken(SECRET, token, 3600, 2000);
    expect(renewed).not.toBeNull();
    expect(renewed!.anonId).toBe(anonId); // SAME id — memory does not orphan
    // new token carries a later exp
    const claimsOf = (t: string) => JSON.parse(b64urlDecode(t.split(".")[0]).toString("utf8"));
    expect(claimsOf(renewed!.token).exp).toBeGreaterThan(claimsOf(token).exp);
    expect(claimsOf(renewed!.token).tid).toBe(TID); // tid preserved
  });

  it("INVARIANT 6: renew REFUSES an expired token (a stolen token is not renewable forever)", async () => {
    const { token } = mintGuestToken(SECRET, TID, 10, 1000); // exp 1010
    expect(renewGuestToken(SECRET, token, 3600, 5000)).toBeNull(); // expired at renewal time
  });

  it("renew refuses a forged/wrong-secret/wrong-typ token", async () => {
    const { token } = mintGuestToken(SECRET, TID, 3600, 1000);
    expect(renewGuestToken(OTHER_SECRET, token, 3600, 1500)).toBeNull();
    expect(renewGuestToken(SECRET, mintWidgetToken(SECRET, TID, 3600, 1000), 3600, 1500)).toBeNull();
  });
});

describe("guest token — tenant binding (invariant 7, R2-5)", () => {
  it("verify with a matching expected tenant succeeds", async () => {
    const id = createGuestTokenIdentity(SECRET);
    const { token, anonId } = mintGuestToken(SECRET, TID, 300);
    expect(await id.verify(token, { tenantId: TID })).toEqual({ anonId, tid: TID });
  });

  it("INVARIANT 7: a guest token is rejected at a DIFFERENT tenant", async () => {
    const id = createGuestTokenIdentity(SECRET);
    const { token } = mintGuestToken(SECRET, TID, 300);
    expect(await id.verify(token, { tenantId: "other-shop" })).toBeNull();
  });

  it("a token minted with no/blank tid never verifies (an untenanted guest token cannot exist)", async () => {
    const id = createGuestTokenIdentity(SECRET);
    const forged = craftSigned(SECRET, { typ: "guest", tid: "", aid: "AAAAAAAAAAAAAAAAAAAAAAAAAA", exp: 9999999999 });
    expect(await id.verify(forged)).toBeNull();
    expect(await id.verify(forged, { tenantId: "acme" })).toBeNull();
  });
});

describe("guest token — never throws (adapter contract)", () => {
  it("garbage, empty, and unconfigured-secret inputs all yield null rather than throwing", async () => {
    const id = createGuestTokenIdentity(SECRET);
    for (const bad of ["", "no-dot", "a.b.c.d", "!!!.???", undefined as unknown as string]) {
      expect(await id.verify(bad)).toBeNull();
    }
    expect(await createGuestTokenIdentity(undefined).verify("anything")).toBeNull();
  });
});
