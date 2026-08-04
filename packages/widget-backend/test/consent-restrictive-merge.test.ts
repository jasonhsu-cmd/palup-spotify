import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// BLOCK-1 (security-review remediation, PR #152) — sign-in must never silently VOID an explicit
// opt-out. Subject-scoped auth (identity.ts `memorySubjectId`) rebinds the memory subject from the raw
// guest anonId to `acct:<shopperId>` once a shopper is server-verified. Without a restrictive merge, a
// consent record the shopper recorded as a GUEST ("out") simply stops resolving once they sign in — the
// lookup keys off `acct:<shopperId>` (a brand-new KV row, never written) and degrades to the fail-closed
// DEFAULT, which the US opt-out regime (`consent1 !== "out"`) reads as ALLOWED. `decideMemoryWrite`'s own
// logic is unchanged; only ITS INPUT regressed with the subject-derivation change.
//
// Proven by execution (both independent reviews): guest records memoryOrdinary:"out" -> chats as guest
// -> 0 facts written. Same person signs in with a verified shopper token -> 1 ordinary fact written under
// `acct:<shopperId>`. This test reproduces exactly that scenario and must show 0 facts written post-fix.

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const SHOPPER_ID = "shopify:demo:48291";
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET", "MERCHANT_REGION"];
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

describe("BLOCK-1 — restrictive-merge consent across guest/account subjects on sign-in", () => {
  it("THE REVIEWER'S SCENARIO: guest opts OUT, then signs in — the opt-out survives, no ordinary fact is written under acct:<shopperId>", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // 1. As a GUEST (no x-shopper-token), explicitly opt OUT of ordinary memory.
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(consentRes.statusCode).toBe(200);

    // 2. Still as a guest: chats -> nothing is written (sanity — this half already worked pre-fix).
    const guestChat = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "guest-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(guestChat.statusCode).toBe(200);
    expect(upsertSpy).not.toHaveBeenCalled();

    // 3. THE SAME PERSON signs in with a verified shopper token — their browser still legitimately holds
    // the old guest anonId, which the widget continues to send.
    const signedInChat = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: {
        sessionId: "signed-in-1",
        message: "I like fragrance-free stuff",
        signals: { anonId: GUEST_ANON_ID },
        widgetToken: DEMO_WIDGET_TOKEN,
      },
    });
    expect(signedInChat.statusCode).toBe(200);

    // THE ASSERTION THAT WAS FAILING: sign-in must not silently void the guest's recorded opt-out.
    expect(upsertSpy).not.toHaveBeenCalled();
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.ordinary");
  });

  it("a guest 'in' is NEVER adopted for the account — outside the US it stays denied (borrowed opt-in is not honored)", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "borrow-in-1", message: "I like fragrance-free stuff", signals: { anonId: GUEST_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    // The account has no consent record of its own; a guest "in" must not be borrowed for it.
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("the account's OWN 'in' still allows the write (an explicit account-level grant is honored)", async () => {
    armAuth();
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // The shopper records consent WHILE signed in — directly against the account subject.
    await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": shopperToken() },
      payload: { memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "account-in-1", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(upsertSpy).toHaveBeenCalled();
  });

  it("no anonId supplied this turn -> the account record alone governs (no guest lookup attempted)", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const modelPort = distillingModel([{ text: "prefers fragrance-free products" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // A guest record with an "out" exists under GUEST_ANON_ID, but this turn supplies NO anonId at all.
    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { "x-shopper-token": shopperToken() },
      payload: { sessionId: "no-anonid-1", message: "I like fragrance-free stuff", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    // US default region, no account record at all -> opt-out regime allows (unrelated to the guest's out).
    expect(upsertSpy).toHaveBeenCalled();
  });
});
