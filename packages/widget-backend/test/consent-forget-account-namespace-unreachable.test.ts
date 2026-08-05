import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { lookupConsent } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// P3 (2) — REGRESSION PIN, not a behavior change.
//
// What was investigated: whether an UNAUTHENTICATED caller can write a consent record for, or erase, a
// subject that is not their own. Findings (server.ts, read end to end):
//   * `/consent` (server.ts) and `/forget` only 401 an unauthenticated caller when WIDGET_AUTH_REQUIRED is
//     "true"; otherwise both proceed under RUNTIME_TENANT="demo".
//   * The SUBJECT is server-derived (`acct:<shopperId>`) whenever a verified shopper principal is
//     presented (`verifiedShopperIdFor` -> `memorySubjectId`), and the supplied `anonId` is then ignored
//     for /consent (additive for /forget — the deliberate N1 behavior).
//   * With no principal presented, the subject IS the caller-supplied `anonId`. That is the KNOWN,
//     NAMED-OWNER-ACCEPTED residual C1 (docs/MEMORY-GO-LIVE-CHECKLIST.md, decided 2026-08-04) — the
//     shopper token is never REQUIRED on either route, and the checklist says so explicitly. It is
//     deliberately NOT "fixed" here: the accepted rationale is that obtaining an `anonId` requires access
//     to the shopper's browser, and the alternative (memory for signed-in shoppers only) was considered
//     and rejected by the owner.
//
// C1's acceptance rests on ONE load-bearing property that no test pinned: the accepted exposure is a
// 128-bit CSPRNG guest id ("not enumerable" — the checklist's own mitigation column). The ACCOUNT subject
// is the opposite: `acct:shopify:<tenant>:<numeric customer id>` is low-entropy and enumerable
// (widget-backend/test/forget-account-subject.test.ts's own note says so). If the client-supplied `anonId`
// could ever name an `acct:` subject, the accepted guest-bearer residual would silently become an
// enumerable attack on every SIGNED-IN shopper — a different, unaccepted risk class.
//
// It cannot today: `memorySubjectId` routes a client `anonId` through `validateAnonId`, whose charset is
// base32 `/^[A-Z2-7]{10,64}$/` (widget-memory/src/identity.ts) — no `:` and no lowercase, so no `acct:`
// id and no `::` namespace-injection string can pass. These tests pin that at the ROUTE level, where the
// property actually has to hold, so a future widening of that charset (or a route that stops going
// through `memorySubjectId`) reddens here instead of shipping.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const SHOPPER_ID = "shopify:demo:77001";
const ACCOUNT_SUBJECT = `acct:${SHOPPER_ID}`;
const ACCOUNT_NS = `demo::${ACCOUNT_SUBJECT}`;
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId

// Every shape an attacker would reach for to name a subject that is not a random guest id.
const FORGED_SUBJECTS = [
  ACCOUNT_SUBJECT, // the account subject verbatim
  `acct:shopify:demo:${77001}`, // enumerated customer id
  "ACCT:SHOPIFY:DEMO:77001", // uppercased — still has ':'
  `demo::${ACCOUNT_SUBJECT}`, // pre-namespaced (`::` injection)
  "other-tenant::ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", // cross-tenant namespace injection
  "abcdefghijklmnop", // lowercase (outside the base32 charset)
];

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

function armAuth(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
}
const shopperToken = () => mintShopperToken(SHOPPER_SECRET, SHOPPER_ID, "shopify", 3_600);

function distillingModel(facts: Array<{ text: string }>): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async complete(req: ModelRequest) {
      calls.push(req);
      return { text: JSON.stringify({ facts }), model: "spy-distiller" };
    },
  };
}

describe("the ACCOUNT namespace is unreachable from the client-supplied anonId (what makes C1's acceptance hold)", () => {
  it("POST /forget cannot name an acct: subject — every forged shape is 400 and erases nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const deleteNamespace = vi.spyOn(vector, "deleteNamespace");
    const deleteById = vi.spyOn(vector, "deleteById");
    // Rollout posture: WIDGET_AUTH_REQUIRED unset, so this caller is fully unauthenticated.
    const app = await buildServer({ store, vectorPort: vector });

    for (const anonId of FORGED_SUBJECTS) {
      const res = await app.inject({ method: "POST", url: "/forget", payload: { anonId } });
      expect(res.statusCode, `anonId=${anonId}`).toBe(400);
    }
    expect(deleteNamespace).not.toHaveBeenCalled();
    expect(deleteById).not.toHaveBeenCalled();
    expect((await store.readAudit({ tenantId: "demo" })).map((r) => r.action)).not.toContain("erase.subject");

    await app.close();
  });

  it("POST /consent cannot name an acct: subject — every forged shape is 400 and records nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });

    for (const anonId of FORGED_SUBJECTS) {
      const res = await app.inject({
        method: "POST",
        url: "/consent",
        payload: { anonId, memoryOrdinary: "out", memorySpecial: "out" },
      });
      expect(res.statusCode, `anonId=${anonId}`).toBe(400);
    }
    // Nothing landed on the account subject — it still reads the fail-closed default.
    expect(await lookupConsent(store, { tenantId: "demo", anonId: ACCOUNT_SUBJECT })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
    expect((await store.readAudit({ tenantId: "demo" })).map((r) => r.action)).not.toContain("consent.record");

    await app.close();
  });

  it("END TO END: a real signed-in shopper's stored fact survives an unauthenticated /forget aimed at their acct: subject", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // The shopper signs in and chats — a fact is written under acct:<shopperId>.
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "acct-write-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect((await vector.query(ACCOUNT_NS, { text: "", k: 10 })).length).toBeGreaterThan(0);

    // The attacker holds the tenant's PUBLISHABLE embed key, so it can mint a widget token (that is the
    // documented C1/C10 reach) — but it cannot name the victim's account subject.
    const attackerWidgetToken = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
    for (const anonId of FORGED_SUBJECTS) {
      const res = await app.inject({
        method: "POST",
        url: "/forget",
        payload: { anonId, widgetToken: attackerWidgetToken },
      });
      expect(res.statusCode, `anonId=${anonId}`).toBe(400);
    }

    // The victim's fact is untouched.
    expect((await vector.query(ACCOUNT_NS, { text: "", k: 10 })).length).toBeGreaterThan(0);
    await app.close();
  });

  it("the accepted C1 residual is unchanged and still disclosed: a well-formed GUEST id needs no token at all", async () => {
    // Deliberately asserts the ACCEPTED exposure so this file cannot be read as claiming more than is
    // true. If a later change ever closes C1, this expectation is the one that must be revisited —
    // consciously, with the checklist row.
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({ method: "POST", url: "/forget", payload: { anonId: GUEST_ANON_ID } });
    expect(res.statusCode).toBe(200);
    expect((await store.readAudit({ tenantId: "demo" })).map((r) => r.action)).toContain("erase.subject");
    await app.close();
  });
});
