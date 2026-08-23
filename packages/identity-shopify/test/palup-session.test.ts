import { describe, it, expect } from "vitest";
import { mintMerchantSession, verifyMerchantSession } from "../src/palup-session.js";
import { mintWidgetToken } from "@palup/platform-ports";

const SECRET = "palup-session-secret";
const claims = { merchantId: "acme", userId: "shopify:acme:42", role: "owner" as const,
  authLevel: "session" as const, sid: "sess-abc" };

describe("PalUp merchant session token", () => {
  it("round-trips a principal (mint → verify)", () => {
    const t = mintMerchantSession(SECRET, claims, 1800, 1000);
    const p = verifyMerchantSession(SECRET, t, 1100);
    expect(p.kind).toBe("merchant_user");
    if (p.kind === "merchant_user") {
      expect(p.merchantId).toBe("acme"); expect(p.role).toBe("owner");
      expect(p.userId).toBe("shopify:acme:42"); expect(p.sessionId).toBe("sess-abc");
      expect(p.authLevel).toBe("session");
    }
  });
  it("anonymous on tamper, wrong secret, or expiry (fail closed, never throws)", () => {
    const t = mintMerchantSession(SECRET, claims, 1800, 1000);
    expect(verifyMerchantSession(SECRET, t.slice(0, -2) + "zz", 1100).kind).toBe("anonymous");
    expect(verifyMerchantSession("other", t, 1100).kind).toBe("anonymous");
    expect(verifyMerchantSession(SECRET, t, 5000).kind).toBe("anonymous"); // exp 1000+1800=2800 < 5000
    expect(verifyMerchantSession(undefined, t, 1100).kind).toBe("anonymous");
    expect(verifyMerchantSession(SECRET, undefined, 1100).kind).toBe("anonymous");
  });
  it("REJECTS a widget token presented as a merchant session (typ separation, ADR-0017 F1 parity)", () => {
    const widget = mintWidgetToken(SECRET, "acme", 3600); // same secret, different typ
    expect(verifyMerchantSession(SECRET, widget, 1100).kind).toBe("anonymous");
  });
  it("REJECTS an unknown role value (a forged token cannot smuggle a non-RBAC role)", () => {
    // hand-mint a token with role:"superadmin" using the shared codec, same secret
    // (the verifier must whitelist the 5 roles)
    const t = mintMerchantSession(SECRET, { ...claims, role: "superadmin" as never }, 1800, 1000);
    expect(verifyMerchantSession(SECRET, t, 1100).kind).toBe("anonymous");
  });
});
