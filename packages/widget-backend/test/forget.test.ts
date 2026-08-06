import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { guestTokenHeader } from "./helpers/guest-token.js";

// PR-11b — POST /forget: the data-RIGHTS erasure endpoint (widget-memory/src/erasure.ts's `eraseSubject`,
// reused unchanged). Same (tenantId, anonId) derivation + guards as /consent (chat-consent-record.test.ts):
// tenant from the verified widget token (falling back to RUNTIME_TENANT), validateAnonId charset/length
// bound, per-IP + per-tenant rate limit, NN#4 kill-switch. Unlike /consent, it must WORK regardless of the
// double gate (a shopper's right to erase does not depend on the feature's current on/off state) — the
// "works regardless" test below builds TWO server instances sharing the same store+vector, one with the
// memoryEnabled seam (to write a fact) and one WITHOUT it (the real-production default), proving /forget
// on the second instance still erases what the first wrote.

const VALID_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId's charset+length bound

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

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_EMBED_KEYS", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "GUEST_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));
// ADR-0019 task 4/9 — the guest memory subject now comes ONLY from a VERIFIED `x-guest-token`, never
// `body.anonId` (invariant 4). Every case below that used to pin a subject via a client anonId now
// crafts a real guest token for that SAME anonId with this secret instead.
const GUEST_SECRET = "gsecret";

// Security review (Finding 2) — the boot guard now asserts on the SAME predicate that actually arms
// memory in-process (`memoryServiceEnabled`), so every test below using the `memoryEnabled` seam must
// also set WIDGET_AUTH_REQUIRED=true or `buildServer` throws. A "demo"-tenant widget token (the SAME
// tenant the unauthenticated RUNTIME_TENANT fallback these tests relied on before) keeps every
// assertion identical to before this change.
const WIDGET_SECRET = "wsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const SHOPPER_SECRET = "shopper-secret";
const SHOPPER_ID = "shopify:demo:48291";
function armShopperAuth(): void {
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
}
const shopperToken = () => mintShopperToken(SHOPPER_SECRET, SHOPPER_ID, "shopify", 3_600);

describe("POST /forget", () => {
  it("rejects a missing anonId (400) and erases nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const deleteSpy = vi.spyOn(vector, "deleteNamespace");
    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({ method: "POST", url: "/forget", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(deleteSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an invalid anonId (fails validateAnonId's charset/length bound)", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const deleteSpy = vi.spyOn(vector, "deleteNamespace");
    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({ method: "POST", url: "/forget", payload: { anonId: "not-valid!!" } });
    expect(res.statusCode).toBe(400);
    expect(deleteSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("erases a subject's stored fact and audits erase.subject (no raw anonId in the audit trail)", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { sessionId: "forget-1", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);

    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBe(0);

    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).toContain("erase.subject");
    expect(JSON.stringify(log)).not.toContain(VALID_ANON_ID);
    await app.close();
  });

  it("no-ops safely when nothing was ever stored for this subject", async () => {
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector });
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("works regardless of memoryEnabled: a memory-DISABLED instance sharing the same store+vector can still erase what a memory-ENABLED instance wrote", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const writerApp = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    await writerApp.inject({
      method: "POST",
      url: "/chat",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { sessionId: "forget-2", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);
    await writerApp.close();

    // A fresh app instance sharing the SAME store+vector, this time WITHOUT the memoryEnabled seam — the
    // real-production posture (double gate off).
    const disabledApp = await buildServer({ store, vectorPort: vector });
    const res = await disabledApp.inject({
      method: "POST",
      url: "/forget",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBe(0);
    await disabledApp.close();
  });

  it("is tenant-scoped: tenant B's /forget cannot erase tenant A's data for the same anonId", async () => {
    process.env.WIDGET_TOKEN_SECRET = "wsecret";
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "a-key": "tenant-a", "b-key": "tenant-b" });
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    const tokenA = (await app.inject({ method: "GET", url: "/widget/token?key=a-key" })).json().token as string;
    const tokenB = (await app.inject({ method: "GET", url: "/widget/token?key=b-key" })).json().token as string;

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: "Bearer " + tokenA, ...guestTokenHeader(GUEST_SECRET, "tenant-a", VALID_ANON_ID) },
      payload: { sessionId: "forget-3", message: "I like fragrance-free stuff", signals: {} },
    });
    expect((await vector.query("tenant-a::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);

    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { authorization: "Bearer " + tokenB, ...guestTokenHeader(GUEST_SECRET, "tenant-b", VALID_ANON_ID) },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((await vector.query("tenant-a::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);
    await app.close();
  });

  // N1 (HIGH, security review round 3) — a verified shopper's GUEST-ERA facts were previously
  // un-erasable: `/forget` targeted `acct:<shopperId>` only and ignored any supplied `anonId` outright,
  // so a signed-in shopper's "forget everything" left their guest-namespace facts fully intact while the
  // widget still rendered "Done — I've cleared what I remembered and started fresh." Proven by execution:
  // post-fix `acct` ns AND `guest` ns must BOTH end up empty. Safe per the checklist's corrected C6/N1
  // note: the guest path a few lines above already lets an UNAUTHENTICATED caller erase any well-formed
  // anonId with no token at all, so doing the same erase on a VERIFIED turn grants nothing new.
  it("N1 — a signed-in shopper presenting BOTH their shopper token and their validated guest anonId gets BOTH namespaces erased", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    armShopperAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // 1. Facts written into the GUEST namespace, before sign-in.
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { sessionId: "n1-guest-1", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);

    // 2. Facts written into the ACCOUNT namespace, once signed in.
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "n1-acct-1", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    const acctNamespace = "demo::acct:" + SHOPPER_ID;
    expect((await vector.query(acctNamespace, { text: "", k: 10 })).length).toBeGreaterThan(0);

    // 3. "Forget everything" — the widget sends BOTH the shopper token AND the superseded guest anonId,
    // the LATTER now as a validly-signed `x-guest-token` (ADR-0019 task 4/9 — invariant 4 dropped the old
    // `body.anonId`/`prevAnonId` transport; a real client must present its own guest identity the same
    // verified way /chat does).
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID) },
      payload: { widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // BOTH namespaces must now be empty for the widget's "Done — I've cleared what I remembered" to be true.
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBe(0);
    expect((await vector.query(acctNamespace, { text: "", k: 10 })).length).toBe(0);

    // Both erasures are audited (one per subject), never the raw ids.
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.filter((r) => r.action === "erase.subject").length).toBe(2);
    expect(JSON.stringify(log)).not.toContain(VALID_ANON_ID);
    expect(JSON.stringify(log)).not.toContain(SHOPPER_ID);
    await app.close();
  });

  it("N1 — a signed-in shopper's OWN erase still works when NO guest anonId is presented (unchanged behavior)", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    armShopperAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "n1-acct-2", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    const acctNamespace = "demo::acct:" + SHOPPER_ID;
    expect((await vector.query(acctNamespace, { text: "", k: 10 })).length).toBeGreaterThan(0);

    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: { "x-shopper-token": shopperToken() },
      payload: { widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect((await vector.query(acctNamespace, { text: "", k: 10 })).length).toBe(0);
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.filter((r) => r.action === "erase.subject").length).toBe(1); // only the account subject — no guest anonId was supplied
    await app.close();
  });

  it("NN#4 — an operator kill switch halts /forget: 503, nothing erased, no audit entry", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });
    await app.inject({
      method: "POST",
      url: "/chat",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { sessionId: "forget-4", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);

    await armKill(store, "global", "operator-halt");
    const res = await app.inject({
      method: "POST",
      url: "/forget",
      headers: guestTokenHeader(GUEST_SECRET, "demo", VALID_ANON_ID),
      payload: { widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(503);
    expect((await vector.query("demo::" + VALID_ANON_ID, { text: "", k: 10 })).length).toBeGreaterThan(0);
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("erase.subject");
    await app.close();
  });

  it("is rate-limited per IP like /consent — a same-IP flood past the per-IP cap gets 429", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const call = () => app.inject({ method: "POST", url: "/forget", payload: { anonId: VALID_ANON_ID } });
    let got429 = false;
    for (let i = 0; i < 65; i++) {
      const r = await call();
      if (r.statusCode === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
    await app.close();
  });
});
