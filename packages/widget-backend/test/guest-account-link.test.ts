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

describe("B12 — server-recorded guest->account link (migration deliberately NOT built; see C1/B12)", () => {
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

  it("IDEMPOTENT: a second verified /consent call presenting the same guest anonId does not re-record the link or re-audit", async () => {
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
    expect(linkCountAfterFirst).toBe(1);

    // Repeat the SAME call.
    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const logAfterSecond = await store.readAudit({ tenantId: "demo" });
    expect(logAfterSecond.filter((r) => r.action === "guest_link.record").length).toBe(linkCountAfterFirst); // no re-record
    await app.close();
  });

  it("KILL SWITCH: an operator halt refuses the WHOLE /consent call — no link and no consent write at all", async () => {
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

  it("DOUBLE-GATE POSTURE: with memory OFF (no memoryEnabled seam), the link is still recorded (it touches no vector data at all)", async () => {
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

// C15(b) — human-owner-directed remedy: the guest->account link is now REVOCABLE and SELF-HEALING
// (docs/MEMORY-GO-LIVE-CHECKLIST.md C15). Previously first-writer-wins with no unlink: any verified
// shopper who obtained a victim's anonId could bind it to their OWN account and durably deny the victim,
// unrevocably. These are the three critical tests the spec calls out by name.
describe("C15(b) — the guest->account link is revocable and self-healing", () => {
  it("SQUAT CLEARED NON-DESTRUCTIVELY: the victim's own verified /consent overwrites an attacker's squatted link, and their signed-out turn is governed by their OWN consent afterward — nothing erased", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const ATTACKER_ID = "shopify:demo:66601";
    const VICTIM_ID = "shopify:demo:66602";
    const attackerToken = mintShopperToken(SHOPPER_SECRET, ATTACKER_ID, "shopify", 3_600);
    const victimToken = mintShopperToken(SHOPPER_SECRET, VICTIM_ID, "shopify", 3_600);

    // ATTACKER obtains the victim's anonId (C1's premise — shared device, storefront XSS) and squats the
    // link: binds it to their OWN account, then sets THEMSELVES "out" — denying the victim's signed-out
    // turns.
    const squat = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": attackerToken },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(squat.statusCode).toBe(200);
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toEqual({ accountSubject: accountSubjectId(ATTACKER_ID) });

    // The victim's signed-out turn is DENIED — the squatted link's "out" narrows it.
    const denied = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "c15-squat-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(denied.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();

    // VICTIM signs in and posts their OWN verified /consent, presenting the SAME anonId — last-VERIFIED-
    // writer-wins overwrites the squatted link. NOTHING is erased anywhere in this flow.
    const reclaim = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": victimToken },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(reclaim.statusCode).toBe(200);
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toEqual({ accountSubject: accountSubjectId(VICTIM_ID) });

    // The victim's signed-out turn is now governed by the VICTIM's OWN consent — memory works again.
    const restored = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "c15-squat-2", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(restored.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
    await app.close();
  });

  // THE TRAP (spec's single most important constraint): an UNRESTRICTED "/forget clears the link" would
  // hand an attacker a PERMISSIVE-direction primitive — clearing a victim's own link would silently stop
  // the victim's account-level "out" from governing their signed-out turns, re-opening C14 against them.
  it("/forget CANNOT clear someone else's link: attacker /forgets the victim's anonId whose link points at the victim → the link SURVIVES", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

    const ATTACKER_ID = "shopify:demo:66701";
    const VICTIM_ID = "shopify:demo:66702";
    const attackerToken = mintShopperToken(SHOPPER_SECRET, ATTACKER_ID, "shopify", 3_600);
    const victimToken = mintShopperToken(SHOPPER_SECRET, VICTIM_ID, "shopify", 3_600);

    // Victim establishes their OWN link.
    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": victimToken },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toEqual({ accountSubject: accountSubjectId(VICTIM_ID) });

    // ATTACKER tries to /forget the victim's anonId while signed in as THEMSELVES.
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": attackerToken },
      payload: { anonId: GUEST_ANON_ID, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    // The link SURVIVES — untouched.
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toEqual({ accountSubject: accountSubjectId(VICTIM_ID) });
    await app.close();
  });

  it("/forget CLEARS your own link: the linked account's own /forget removes the association", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

    const SHOPPER = "shopify:demo:66801";
    const token = mintShopperToken(SHOPPER_SECRET, SHOPPER, "shopify", 3_600);

    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": token },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toEqual({ accountSubject: accountSubjectId(SHOPPER) });

    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": token },
      payload: { anonId: GUEST_ANON_ID, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(await lookupGuestLink(store, { tenantId: "demo", guestAnonId: GUEST_ANON_ID })).toBeUndefined();
    await app.close();
  });

  it("the link consult is audited when it narrows an unverified turn's decision (PII-free)", async () => {
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

    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "c15-consult-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });

    const log = await store.readAudit({ tenantId: "demo" });
    const entry = log.find((r) => r.action === "guest_link.consulted");
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry?.input ?? {});
    expect(serialized).not.toContain(GUEST_ANON_ID);
    expect(serialized).not.toContain(SHOPPER_ID);
    await app.close();
  });

  it("the link consult is NOT audited when no link exists (nothing narrowed)", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "c15-consult-2", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("guest_link.consulted");
    await app.close();
  });
});

// CRITICAL REGRESSION LOCK — the vulnerability the first B12 build shipped, found by probe before review.
// That build migrated the guest namespace's facts into the account on link. Because `validateAnonId` only
// proves an anonId is well-FORMED and never that the caller owns it, a signed-in attacker presenting a
// VICTIM's anonId got the victim's memory MOVED into the attacker's own account (readable via their own
// recall) and destroyed on the victim's side:
//     ATTACKER namespace now holds: ["shopper is allergic to tree nuts"]
//     VICTIM  namespace now holds: []
// The link itself is safe — it can only make an unverified turn's decision MORE restrictive. Moving DATA
// on an unproven id is not, and no proof of anonId ownership exists in this system (that is residual C1).
describe("B12 — a link must NEVER move data (theft/destruction regression lock)", () => {
  it("a verified shopper presenting a stranger's anonId cannot pull that stranger's facts into their own account", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const victimNs = subjectNamespace("demo", GUEST_ANON_ID);
    await vector.upsert(victimNs, [
      {
        id: "victim-secret",
        text: "shopper is allergic to tree nuts",
        metadata: { text: "shopper is allergic to tree nuts", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    ]);

    const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "in", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    // The stranger's facts stay exactly where they were...
    expect((await vector.query(victimNs, { text: "", k: 10 })).map((r) => r.id)).toEqual(["victim-secret"]);
    // ...and nothing landed in the caller's account namespace.
    const callerNs = subjectNamespace("demo", accountSubjectId(SHOPPER_ID));
    expect(await vector.query(callerNs, { text: "", k: 10 })).toEqual([]);
    await app.close();
  });
});
