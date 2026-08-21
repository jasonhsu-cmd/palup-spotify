import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import { recordConsent, armKill, recordHealthDisclosure } from "@palup/state-postgres";
import { subjectNamespace, accountSubjectId } from "@palup/widget-memory";

// `floorNamespace` (widget-memory/src/identity.ts) isn't part of widget-memory's public surface (see
// chat-consent-record.test.ts's own note) — reconstructed here the same documented, stable composition
// its own doc comment guarantees: `${subjectNamespace}::floor`.
const floorNamespace = (tenantId: string, anonId: string) => `${subjectNamespace(tenantId, anonId)}::floor`;
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// Task: guest→account memory merge via a post-sign-in authenticated endpoint (POST /memory/merge).
//
// The guest identity for this route MUST come ONLY from a server-verified signed guest token
// (`guestAnonIdFrom` — the same helper /consent and /forget already use), NEVER a raw `body.anonId`; the
// account identity MUST come ONLY from a verified shopper token (`verifiedShopperIdFor`). This suite's
// "guest id from the verified token, never body.anonId" cases are the crux of the whole endpoint.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const GUEST_SECRET = "gsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
// shopperIdTenant() parses `<source>:<tenant>:<rest>` — the tenant segment must equal the widget token's
// tenant, or the cross-shop check in verifiedShopperIdFor rejects the token.
const SHOPPER_ID = "shopify:demo:shopper-1";
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

function armAuth(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
  process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
}
const shopperToken = () => mintShopperToken(SHOPPER_SECRET, SHOPPER_ID, "shopify", 3_600);

async function postMerge(
  app: Awaited<ReturnType<typeof buildServer>>,
  headers: Record<string, string>,
  payload: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: "/memory/merge",
    headers: { authorization: "Bearer " + DEMO_WIDGET_TOKEN, ...headers },
    payload,
  });
}

describe("POST /memory/merge — guest→account memory carry-over (task 10, R2-2 + Q19(c))", () => {
  it("404s when memory is not live (feature-off, same as the other memory routes)", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() }); // memoryEnabled defaults off
    const res = await postMerge(app, { "x-shopper-token": shopperToken() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("401s an unverified shopper (no x-shopper-token) — a merge requires being signed in", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });
    const upsertSpy = vi.spyOn(vector, "upsert");

    const res = await postMerge(app, {});
    expect(res.statusCode).toBe(401);
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("401s an INVALID x-shopper-token (falls back to anonymous, not authorized to merge)", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore(), memoryEnabled: true });
    const res = await postMerge(app, { "x-shopper-token": "not-a-real-token" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("verified shopper + NO guest token -> 200 {merged:0}, no vector writes (nothing to merge is not an error)", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });
    const upsertSpy = vi.spyOn(vector, "upsert");

    const res = await postMerge(app, { "x-shopper-token": shopperToken() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ merged: 0 });
    expect(upsertSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("verified shopper + valid guest token with ordinary guest facts -> copied into the account namespace, 200", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await vector.upsert(subjectNamespace("demo", GUEST_ANON_ID), [
      { id: "f1", text: "prefers fragrance-free", metadata: { class: "ordinary", text: "prefers fragrance-free" } },
    ]);
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

    const res = await postMerge(app, { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ merged: 1 });

    const acctNs = subjectNamespace("demo", accountSubjectId(SHOPPER_ID));
    const acctFacts = await vector.query(acctNs, { text: "", k: 10 });
    expect(acctFacts.map((f) => f.id)).toEqual(["f1"]);
    await app.close();
  });

  describe("special/floor guest fact — the compound R2-2 + Q19(c) gate", () => {
    async function seedSpecialGuestFact(vector: ReturnType<typeof createInMemoryVectorStore>) {
      await vector.upsert(floorNamespace("demo", GUEST_ANON_ID), [
        { id: "spec-1", text: "has a tree-nut allergy", metadata: { class: "special", text: "has a tree-nut allergy" } },
      ]);
    }

    it("NOT copied when healthDisclosed is omitted, even if both consents are 'in'", async () => {
      armAuth();
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      await seedSpecialGuestFact(vector);
      await recordConsent(store, { tenantId: "demo", anonId: accountSubjectId(SHOPPER_ID), memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      await recordConsent(store, { tenantId: "demo", anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

      const res = await postMerge(app, { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: 0 });
      const acctFloor = await vector.query(floorNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
      expect(acctFloor).toEqual([]);
      await app.close();
    });

    it("SECURITY: a forged body.healthDisclosed:true does NOT carry special rows without a server-recorded disclosure", async () => {
      armAuth();
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      await seedSpecialGuestFact(vector);
      await recordConsent(store, { tenantId: "demo", anonId: accountSubjectId(SHOPPER_ID), memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      await recordConsent(store, { tenantId: "demo", anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      // NO recordHealthDisclosure — the client forges the flag in the body instead.
      const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

      const res = await postMerge(app, { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) }, { healthDisclosed: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: 0 });
      const acctFloor = await vector.query(floorNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
      expect(acctFloor).toEqual([]);
      await app.close();
    });

    it("NOT copied when the guest's own recorded memorySpecial is not 'in', even with account 'in' + healthDisclosed true", async () => {
      armAuth();
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      await seedSpecialGuestFact(vector);
      await recordConsent(store, { tenantId: "demo", anonId: accountSubjectId(SHOPPER_ID), memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      // Guest never recorded consent at all -> lookupConsent's fail-closed default ("unknown").
      const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

      const res = await postMerge(app, { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) }, { healthDisclosed: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: 0 });
      const acctFloor = await vector.query(floorNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
      expect(acctFloor).toEqual([]);
      await app.close();
    });

    it("COPIED to the account FLOOR namespace only when both consents are 'in' AND a disclosure is server-recorded", async () => {
      armAuth();
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      await seedSpecialGuestFact(vector);
      await recordConsent(store, { tenantId: "demo", anonId: accountSubjectId(SHOPPER_ID), memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      await recordConsent(store, { tenantId: "demo", anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      await recordHealthDisclosure(store, { tenantId: "demo", accountSubject: accountSubjectId(SHOPPER_ID), guestAnonId: GUEST_ANON_ID });
      const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

      const res = await postMerge(app, { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: 1 });
      const acctFloor = await vector.query(floorNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
      expect(acctFloor.map((f) => f.id)).toEqual(["spec-1"]);
      const acctMain = await vector.query(subjectNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
      expect(acctMain).toEqual([]);
      await app.close();
    });
  });

  describe("guest id comes ONLY from the verified guest token, never body.anonId", () => {
    it("a bogus body.anonId is ignored when a valid x-guest-token is ALSO presented — merges the TOKEN's subject", async () => {
      armAuth();
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      await vector.upsert(subjectNamespace("demo", GUEST_ANON_ID), [
        { id: "f1", text: "prefers fragrance-free", metadata: { class: "ordinary", text: "prefers fragrance-free" } },
      ]);
      // A well-formed but UNRELATED anonId a "victim" holds — never a valid signed token for it.
      const BOGUS_ANON_ID = "ZYXWVUTSRQPONMLKJIHGFEDCBA765432";
      await vector.upsert(subjectNamespace("demo", BOGUS_ANON_ID), [
        { id: "victim-fact", text: "victim's own secret", metadata: { class: "ordinary", text: "victim's own secret" } },
      ]);
      const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

      const res = await postMerge(
        app,
        { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) },
        { anonId: BOGUS_ANON_ID },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: 1 }); // the TOKEN's subject (f1), not the bogus body anonId

      const acctNs = subjectNamespace("demo", accountSubjectId(SHOPPER_ID));
      const acctFacts = await vector.query(acctNs, { text: "", k: 10 });
      expect(acctFacts.map((f) => f.id)).toEqual(["f1"]);
      expect(acctFacts.map((f) => f.id)).not.toContain("victim-fact"); // the bogus anonId's namespace was never touched
      await app.close();
    });

    it("a request with ONLY a bogus body.anonId (no x-guest-token at all) -> merged:0, victim namespace untouched", async () => {
      armAuth();
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      const BOGUS_ANON_ID = "ZYXWVUTSRQPONMLKJIHGFEDCBA765432";
      await vector.upsert(subjectNamespace("demo", BOGUS_ANON_ID), [
        { id: "victim-fact", text: "victim's own secret", metadata: { class: "ordinary", text: "victim's own secret" } },
      ]);
      const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

      const res = await postMerge(app, { "x-shopper-token": shopperToken() }, { anonId: BOGUS_ANON_ID });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: 0 });

      const victimFacts = await vector.query(subjectNamespace("demo", BOGUS_ANON_ID), { text: "", k: 10 });
      expect(victimFacts.map((f) => f.id)).toEqual(["victim-fact"]); // never read, never touched
      await app.close();
    });
  });

  it("kill-switch armed -> 503, no merge", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await vector.upsert(subjectNamespace("demo", GUEST_ANON_ID), [
      { id: "f1", text: "prefers fragrance-free", metadata: { class: "ordinary", text: "prefers fragrance-free" } },
    ]);
    await armKill(store, "global", "operator-halt");
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

    const res = await postMerge(app, { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) });
    expect(res.statusCode).toBe(503);

    const acctFacts = await vector.query(subjectNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
    expect(acctFacts).toEqual([]);
    await app.close();
  });
});
