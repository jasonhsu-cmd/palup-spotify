import { describe, it, expect, afterEach } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryVectorStore,
  mintWidgetToken,
  mintShopperToken,
} from "@palup/platform-ports";
import { lookupConsent } from "@palup/state-postgres";
import { subjectNamespace, accountSubjectId } from "@palup/widget-memory";
import { buildServer } from "../src/server.js";

// SUBJECT-SCOPED AUTH — the memory subject is now derived from the SERVER-VERIFIED shopper principal
// (`acct:<shopperId>`), not from a client-supplied `anonId`.
//
// The hole this closes: `validateAnonId` proves a string is well-FORMED, never that the caller owns it,
// and widget auth binds only the TENANT. So within one tenant, possession of another shopper's `anonId`
// was enough to record THEIR consent and — via the destructive /forget — DELETE their memory. Two prior
// security reviews recorded that as go-live residuals C1/C2.
//
// The tests that matter here are the two "attacker" cases: an authenticated shopper who supplies a
// VICTIM's anonId must not touch the victim's subject at all.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
// shopperIdTenant() parses `<source>:<tenant>:<rest>` — the tenant segment must equal the widget
// token's tenant or the cross-shop check rejects the token.
const ATTACKER_SHOPPER_ID = "shopify:demo:attacker-1";
const VICTIM_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // a well-formed anonId the attacker "obtained"

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

function armAuth(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
}
const attackerToken = () => mintShopperToken(SHOPPER_SECRET, ATTACKER_SHOPPER_ID, "shopify", 3_600);

describe("subject-scoped auth — a verified shopper keys off acct:<shopperId>, not a client anonId", () => {
  it("POST /consent records under the ACCOUNT subject and leaves the supplied anonId's record untouched", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": attackerToken() },
      payload: {
        anonId: VICTIM_ANON_ID, // ignored: a verified principal wins
        memoryOrdinary: "in",
        memorySpecial: "in",
        widgetToken: DEMO_WIDGET_TOKEN,
      },
    });
    expect(res.statusCode).toBe(200);

    // recorded against the account subject...
    expect(await lookupConsent(store, { tenantId: "demo", anonId: accountSubjectId(ATTACKER_SHOPPER_ID) })).toEqual({
      memoryOrdinary: "in",
      memorySpecial: "in",
    });
    // ...and the victim's own subject is completely untouched (fail-closed default).
    expect(await lookupConsent(store, { tenantId: "demo", anonId: VICTIM_ANON_ID })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
    await app.close();
  });

  it("THE ATTACK: POST /forget by a verified shopper supplying a victim's anonId does NOT erase the victim", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    // The victim has a stored fact under their own guest subject.
    const victimNs = subjectNamespace("demo", VICTIM_ANON_ID);
    await vector.upsert(victimNs, [
      {
        id: "victim-1",
        text: "prefers fragrance-free",
        metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    ]);

    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": attackerToken() },
      payload: { anonId: VICTIM_ANON_ID, widgetToken: DEMO_WIDGET_TOKEN },
    });

    expect(res.statusCode).toBe(200); // the attacker successfully erased… their OWN (empty) subject
    // The victim's fact SURVIVES — this is the whole point of the change.
    const survivors = await vector.query(victimNs, { text: "", k: 10 });
    expect(survivors.map((r) => r.id)).toEqual(["victim-1"]);
    await app.close();
  });

  it("an ANONYMOUS guest is unchanged — no verified principal, so the validated anonId is still the subject", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const ns = subjectNamespace("demo", VICTIM_ANON_ID);
    await vector.upsert(ns, [
      {
        id: "guest-1",
        text: "prefers fragrance-free",
        metadata: { text: "prefers fragrance-free", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    ]);

    const app = await buildServer({ store, vectorPort: vector });
    // No x-shopper-token at all ⇒ the guest owns this subject and may erase it.
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      payload: { anonId: VICTIM_ANON_ID, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(await vector.query(ns, { text: "", k: 10 })).toEqual([]); // genuinely erased
    await app.close();
  });

  it("an UNVERIFIED / invalid shopper token does not authorize an account subject — it falls back to the guest path", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": "not-a-real-token" },
      payload: { anonId: VICTIM_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    // Recorded against the ANON subject (guest path), and no account subject was invented.
    expect((await lookupConsent(store, { tenantId: "demo", anonId: VICTIM_ANON_ID })).memoryOrdinary).toBe("in");
    await app.close();
  });

  it("a shopper token minted for ANOTHER tenant is rejected (cross-shop replay) — no account subject is used", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });
    const foreignToken = mintShopperToken(SHOPPER_SECRET, "shopify:other-tenant:x", "shopify", 3_600);

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": foreignToken },
      payload: { anonId: VICTIM_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    // Fell back to the guest path; nothing was written under the foreign shopper's account subject.
    expect(await lookupConsent(store, { tenantId: "demo", anonId: accountSubjectId("shopify:other-tenant:x") })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
    await app.close();
  });
});
