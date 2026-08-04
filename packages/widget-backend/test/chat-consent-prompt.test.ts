import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// PR-11c — contextual in-the-moment health-consent prompt: the deferred follow-up to PR-11b. When
// memory is live AND the shopper's CURRENT message reveals special-category (health/allergy/medical)
// information AND they haven't yet decided on Consent 2 (memorySpecial), /chat surfaces a read-only
// `consentPrompt: "special"` signal so the widget can ask right there — not only via the manage panel.
//
// This is a PROMPT signal only: it must never itself cause a write (the full gated
// distill -> classify -> consent path, `decideMemoryWrite` / `classifyFact` reused UNCHANGED, still
// governs whether anything is actually remembered).

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

const ENV_KEYS = ["MERCHANT_REGION", "WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

// Security review (Finding 2) — the boot guard now asserts on the SAME predicate that actually arms
// memory in-process (`memoryServiceEnabled`), so every test below using the `memoryEnabled` seam must
// also set WIDGET_AUTH_REQUIRED=true or `buildServer` throws. A "demo"-tenant widget token (the SAME
// tenant the unauthenticated RUNTIME_TENANT fallback these tests relied on before) keeps every
// assertion identical to before this change.
const WIDGET_SECRET = "wsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);

describe("PR-11c — /chat carries a contextual consentPrompt='special' signal", () => {
  it("memory ON + no consent record + a health-ish message -> consentPrompt='special'", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s1", message: "I'm allergic to tree nuts", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentPrompt).toBe("special");
    await app.close();
  });

  it("a different health-ish phrasing (eczema) also triggers the prompt", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s1b", message: "I have eczema on my hands", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentPrompt).toBe("special");
    await app.close();
  });

  it("absent when memory is off (real-production default, no seam)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store }); // no memoryEnabled seam
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s2", message: "I'm allergic to tree nuts", signals: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentPrompt).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(res.json(), "consentPrompt")).toBe(false);
    await app.close();
  });

  it("absent when the message is not health-related", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s3", message: "tell me about the vitamin-C serum", signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentPrompt).toBeUndefined();
    await app.close();
  });

  it("absent once memorySpecial is already recorded 'in' (already have it — don't nag)", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const modelPort = distillingModel([{ text: "shopper has a tree-nut allergy" }]);
    const app = await buildServer({ store, modelPort, memoryEnabled: true });
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "unknown", memorySpecial: "in", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(consentRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s4", message: "I'm allergic to tree nuts", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentPrompt).toBeUndefined();
    await app.close();
  });

  it("absent once memorySpecial is already recorded 'out' (they declined — don't nag)", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const consentRes = await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: VALID_ANON_ID, memoryOrdinary: "unknown", memorySpecial: "out", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(consentRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s5", message: "I'm allergic to tree nuts", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentPrompt).toBeUndefined();
    await app.close();
  });

  it("present with an anonId whose memorySpecial is still 'unknown' (not yet decided)", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s6", message: "I'm allergic to tree nuts", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentPrompt).toBe("special");
    await app.close();
  });

  it("is a PROMPT signal only — it never itself triggers a write.special audit entry", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const modelPort = distillingModel([{ text: "shopper has a tree-nut allergy" }]);
    const app = await buildServer({ store, vectorPort: vector, modelPort, memoryEnabled: true });

    // No prior /consent call — memorySpecial stays "unknown" — the prompt fires, but the full gated
    // write path (decideMemoryWrite) still requires explicit consent2="in" before ever writing.
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s7", message: "I have a tree-nut allergy", signals: { anonId: VALID_ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentPrompt).toBe("special");
    const log = await store.readAudit({ tenantId: "demo" });
    expect(log.map((r) => r.action)).not.toContain("write.special");
    await app.close();
  });

  it("carries no consentPrompt on the idempotent replay path either way (baked into the cached response)", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const payload = { sessionId: "s-idem", idempotencyKey: "k-consent-prompt", message: "I'm allergic to tree nuts", signals: {}, widgetToken: DEMO_WIDGET_TOKEN };
    const first = await app.inject({ method: "POST", url: "/chat", payload });
    const second = await app.inject({ method: "POST", url: "/chat", payload });
    expect(first.json().consentPrompt).toBe("special");
    expect(second.json().consentPrompt).toBe("special");
    await app.close();
  });
});
