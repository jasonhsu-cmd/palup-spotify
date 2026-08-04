import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { armKill, lookupConsent, lookupGuestLink } from "@palup/state-postgres";
import { subjectNamespace, accountSubjectId } from "@palup/widget-memory";
import { buildServer } from "../src/server.js";

// B12 — guest->account link + fact/consent migration (docs/MEMORY-GO-LIVE-CHECKLIST.md B12/C6/C7/C14).
// The link itself, and its use to CLOSE C14, are tested in guest-link-store.test.ts (state-postgres) and
// consent-restrictive-merge.test.ts's "C14 CLOSED (B12)" test respectively. This file covers the
// remaining acceptance criteria: fact/consent MIGRATION, link PROVENANCE, IDEMPOTENCY, kill-switch, the
// double-gate posture split (link/consent migration run regardless; FACT migration is gated on
// memoryService), and — the single most important constraint — that an unverified turn presenting a
// LINKED anonId never escalates to reading the ACCOUNT's memory.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const SHOPPER_ID = "shopify:demo:77102";
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "PALUP_SECRETS", "MERCHANT_REGION"];
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

describe("B12 — guest->account fact/consent migration on link", () => {
  it("MIGRATION: an ordinary guest fact lands under the account subject and is then erasable by the signed-in shopper's /forget", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // 1. As a GUEST, a fact gets remembered under the guest anonId (memory defaults on, US opt-out regime).
    const guestChat = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "guest-mig-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(guestChat.statusCode).toBe(200);
    const guestNs = subjectNamespace("demo", GUEST_ANON_ID);
    expect(await vector.query(guestNs, { text: "", k: 10 })).toHaveLength(1);

    // 2. Signs in and calls /consent presenting the same guest anonId — this establishes the B12 link and
    //    triggers the one-time migration (memoryService is live, so the FACT migration runs too).
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(consentRes.statusCode).toBe(200);

    // 3. The guest namespace is now empty; the fact lives under the account namespace instead.
    expect(await vector.query(guestNs, { text: "", k: 10 })).toEqual([]);
    const acctNs = subjectNamespace("demo", accountSubjectId(SHOPPER_ID));
    const migrated = await vector.query(acctNs, { text: "", k: 10 });
    expect(migrated).toHaveLength(1);
    expect((migrated[0].metadata as { text?: string })?.text).toBe("prefers fragrance-free products");

    // 4. The signed-in shopper's OWN /forget now genuinely reaches this migrated fact.
    const forgetRes = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": shopperToken() },
      payload: { widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(forgetRes.statusCode).toBe(200);
    expect(await vector.query(acctNs, { text: "", k: 10 })).toEqual([]);
    await app.close();
  });

  it("MIGRATION: the guest consent row is RETIRED once linked — a later signed-out /consent against the same anonId starts from a clean (unknown) record, not a stale one", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

    // The guest explicitly opted OUT before ever signing in.
    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(await lookupConsent(store, { tenantId: "demo", anonId: GUEST_ANON_ID })).toEqual({ memoryOrdinary: "out", memorySpecial: "unknown" });

    // Signs in and calls /consent presenting that same guest anonId — establishes the link, migrates the
    // guest's "out" onto the (previously record-less) account, then retires the guest row.
    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    // The account's FINAL record is the shopper's own explicit "in" from this same call — a fresh choice
    // always overwrites whatever the migration seeded a moment earlier.
    expect(await lookupConsent(store, { tenantId: "demo", anonId: accountSubjectId(SHOPPER_ID) })).toEqual({ memoryOrdinary: "in", memorySpecial: "unknown" });
    // The GUEST row is retired (deleted) — lookups revert to the fail-closed default.
    expect(await lookupConsent(store, { tenantId: "demo", anonId: GUEST_ANON_ID })).toEqual({ memoryOrdinary: "unknown", memorySpecial: "unknown" });

    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("consent.retire");
    expect(log.map((r) => r.action)).toContain("guest_link.record");
    await app.close();
  });

  it("MIGRATION: a special-category guest fact is DROPPED (not migrated) unless the account has explicit Consent 2 — unchanged merge.ts behavior", async () => {
    armAuth();
    process.env.PALUP_SECRETS = JSON.stringify({ demo: { MEMORY_ENCRYPTION_KEY: "test-key-for-demo-tenant-12345" } });
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "shopper has a tree-nut allergy" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // Guest grants Consent 2 for themselves and remembers a special-category fact.
    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "in", widgetToken: DEMO_WIDGET_TOKEN },
    });
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "guest-special-1", message: "I have a tree-nut allergy", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    const guestNs = subjectNamespace("demo", GUEST_ANON_ID);
    expect(await vector.query(guestNs, { text: "", k: 10 })).toHaveLength(1);

    // Signs in WITHOUT granting Consent 2 for the account (memorySpecial: "unknown") — the special fact
    // must be dropped, never promoted onto the weaker account consent basis (Inv 9, merge.ts unchanged).
    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const acctNs = subjectNamespace("demo", accountSubjectId(SHOPPER_ID));
    expect(await vector.query(acctNs, { text: "", k: 10 })).toEqual([]); // dropped, not migrated
    expect(await vector.query(guestNs, { text: "", k: 10 })).toEqual([]); // guest namespace still fully cleared
    await app.close();
  });

  it("LINK PROVENANCE: a link is NEVER recorded from an unverified request, even with a well-formed anonId", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });

    // No x-shopper-token at all — this is a GUEST's own /consent call.
    const res = await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toBeUndefined();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("guest_link.record");
    await app.close();
  });

  it("LINK PROVENANCE: an invalid/malformed shopper token also never records a link (falls back to the guest path)", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": "not-a-real-token" },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toBeUndefined();
    await app.close();
  });

  it("IDEMPOTENT: a second verified /consent call presenting the same guest anonId does not re-record the link, re-migrate, or re-audit", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    const linkAfterFirst = await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID });
    expect(linkAfterFirst).toEqual({ accountSubject: accountSubjectId(SHOPPER_ID) });
    const logAfterFirst = await store.readAudit({ tenantId: "demo" });
    const linkCountAfterFirst = logAfterFirst.filter((r) => r.action === "guest_link.record").length;
    const retireCountAfterFirst = logAfterFirst.filter((r) => r.action === "consent.retire").length;
    expect(linkCountAfterFirst).toBe(1);
    expect(retireCountAfterFirst).toBe(1);

    // Repeat the SAME call.
    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const logAfterSecond = await store.readAudit({ tenantId: "demo" });
    expect(logAfterSecond.filter((r) => r.action === "guest_link.record").length).toBe(linkCountAfterFirst); // no re-record
    expect(logAfterSecond.filter((r) => r.action === "consent.retire").length).toBe(retireCountAfterFirst); // no re-retire
    await app.close();
  });

  it("KILL SWITCH: an operator halt refuses the WHOLE /consent call — no link, no migration, no consent write at all", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });
    await armKill(store, "global", "operator-halt");

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(503);
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toBeUndefined();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("guest_link.record");
    expect(log.map((r) => r.action)).not.toContain("consent.record");
    await app.close();
  });

  it("DOUBLE-GATE POSTURE: with memory OFF (no memoryEnabled seam), the link + consent migration still run, but the FACT migration does not", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    // No `memoryEnabled: true` — memoryService is never constructed.
    const app = await buildServer({ store, vectorPort: vector });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    // Link + consent migration ran (matching /consent's existing un-gated posture)...
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toEqual({ accountSubject: accountSubjectId(SHOPPER_ID) });
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("guest_link.record");
    expect(log.map((r) => r.action)).toContain("consent.retire");
    // ...but the FACT migration (which touches the vector port) never ran — memoryService is off.
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(log.map((r) => r.action)).not.toContain("merge");
    await app.close();
  });

  // THE LOAD-BEARING CONSTRAINT (spec's single most important requirement): the link governs the
  // CONSENT DECISION ONLY. If an unverified turn holding a linked anonId resolved to the ACCOUNT subject,
  // anyone holding that anonId could read the account's ENTIRE memory — escalating C1 from "the victim's
  // guest preferences" to "the victim's whole account". Modeled directly on subject-scoped-memory-auth.
  // test.ts's "THE ATTACK (recall)".
  it("NO READ ESCALATION: an unverified turn presenting a LINKED anonId never queries the acct: namespace and no account fact text reaches the model port", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();

    // Establish the link (verified shopper, guest anonId presented via /consent).
    const setupApp = await buildServer({ store, vectorPort: vector, memoryEnabled: true });
    await setupApp.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    await setupApp.close();
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toEqual({ accountSubject: accountSubjectId(SHOPPER_ID) });

    // Seed a secret directly into the ACCOUNT's own namespace (what a real signed-in shopper would have
    // accumulated) — never written via this guest anonId.
    const acctNs = subjectNamespace("demo", accountSubjectId(SHOPPER_ID));
    await vector.upsert(acctNs, [
      { id: "acct-secret-1", text: "shopper is allergic to tree nuts", metadata: { text: "shopper is allergic to tree nuts", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString() } },
    ]);

    const queried: string[] = [];
    const origQuery = vector.query.bind(vector);
    vi.spyOn(vector, "query").mockImplementation(async (ns: string, q: never) => {
      queried.push(ns);
      return origQuery(ns, q);
    });
    const modelCalls: ModelRequest[] = [];
    const modelPort: ModelPort = {
      async complete(req: ModelRequest) {
        modelCalls.push(req);
        return { text: "ok", model: "spy" };
      },
    };

    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    // UNVERIFIED turn (no x-shopper-token) presenting the LINKED guest anonId.
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "no-escalation-1", message: "what do you remember about me?", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    // The account namespace must NEVER be queried on this unverified turn...
    expect(queried).not.toContain(acctNs);
    // ...and none of its fact text may reach the model prompt.
    const everythingSent = modelCalls.flatMap((c) => c.messages.map((m) => m.content)).join(" ");
    expect(everythingSent).not.toContain("tree nuts");
    await app.close();
  });
});
