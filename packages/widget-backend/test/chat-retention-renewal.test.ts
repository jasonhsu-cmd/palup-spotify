import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { subjectNamespace } from "@palup/widget-memory";
import { buildServer } from "../src/server.js";

// THE GAP THIS CLOSES (B7, 2026-08-05). Sliding retention (ADR-0015 Inv 4 amendment) re-stamps a
// still-consented fact's expiry when the shopper RETURNS, so 30 days of INACTIVITY expires it rather
// than 30 days from capture. It was built, unit-tested in widget-memory/test/retention.test.ts, and then
// never actually reachable through /chat: server.ts's recall wrapper hardcoded `consent1/consent2:
// "unknown"`, so service.ts's renewal gate — which required a literal "in" — could not fire for ANY
// shopper, no matter what they had consented to.
//
// It survived because every ttl_renew test lived INSIDE widget-memory, where the hardcoded wrapper does
// not exist. Nothing tested the wiring. These tests do, at the server, through a real /chat turn.
//
// Two independent things had to be true for renewal to work, and both were false:
//   1. the wrapper must pass the turn's REAL consent (it passed "unknown"), and
//   2. the renewal gate must permit it (it demanded literal "in", so US "unknown" failed anyway).
// B7 fixed both. A regression in EITHER makes these tests red.

const WIDGET_SECRET = "wsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DAY_MS = 24 * 60 * 60 * 1000;

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "MERCHANT_REGION"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

const quietModel: ModelPort = { async complete(_req: ModelRequest) { return { text: "Here is a suggestion.", model: "spy" }; } };

/** Seeds one ordinary fact whose expiry sits `daysLeft` in the future. Because the renewal gate derives
 * "when was this last stamped" as `expiresAt - TTL`, a fact with 5 days left was last stamped 25 days
 * ago — comfortably past RENEW_MIN_GAP_MS (1 day), so a return visit SHOULD slide it. Seeded straight at
 * the vector port (plaintext, `encrypted` absent) so the test controls the clock without a time seam. */
async function seedFact(vector: ReturnType<typeof createInMemoryVectorStore>, anonId: string, daysLeft: number) {
  const expiresAt = new Date(Date.now() + daysLeft * DAY_MS).toISOString();
  await vector.upsert(subjectNamespace("demo", anonId), [
    { id: "seeded-fact-1", text: "prefers fragrance-free products", metadata: { text: "prefers fragrance-free products", class: "ordinary", expiresAt } },
  ]);
  return expiresAt;
}

async function expiryOf(vector: ReturnType<typeof createInMemoryVectorStore>, anonId: string): Promise<string | undefined> {
  const matches = await vector.query(subjectNamespace("demo", anonId), { text: "", k: 50 });
  return (matches.find((m) => m.id === "seeded-fact-1")?.metadata as { expiresAt?: string } | undefined)?.expiresAt;
}

describe("B7 — sliding retention actually fires through /chat (it never could before)", () => {
  it("US + consent UNKNOWN: a returning shopper's fact expiry slides forward", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.MERCHANT_REGION = "us";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, modelPort: quietModel, memoryEnabled: true });

    const before = await seedFact(vector, ANON_ID, 5);
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s-renew-us", message: "what do you recommend for dry skin?", signals: { anonId: ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    const after = await expiryOf(vector, ANON_ID);
    expect(after).toBeDefined();
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before).getTime());
    // Slid to a full fresh window, not nudged: ~30 days out (allow a generous margin for test runtime).
    expect(new Date(after!).getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    await app.close();
  });

  it("US + explicit OUT: no slide — an opt-out is never silently extended", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.MERCHANT_REGION = "us";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, modelPort: quietModel, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    const before = await seedFact(vector, ANON_ID, 5);
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s-renew-out", message: "what do you recommend for dry skin?", signals: { anonId: ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });

    expect(await expiryOf(vector, ANON_ID)).toBe(before); // untouched
    await app.close();
  });

  it("EU + consent UNKNOWN: no slide — the GDPR bar is unchanged by B7", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, modelPort: quietModel, memoryEnabled: true });

    const before = await seedFact(vector, ANON_ID, 5);
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s-renew-eu", message: "what do you recommend for dry skin?", signals: { anonId: ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });

    expect(await expiryOf(vector, ANON_ID)).toBe(before); // untouched
    await app.close();
  });

  it("EU + explicit IN: slides — so the EU path is gated on consent, not broken outright", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    process.env.MERCHANT_REGION = "eu";
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    const app = await buildServer({ store, vectorPort: vector, modelPort: quietModel, memoryEnabled: true });

    await app.inject({
      method: "POST",
      url: "/consent",
      payload: { anonId: ANON_ID, memoryOrdinary: "in", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    const before = await seedFact(vector, ANON_ID, 5);
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s-renew-eu-in", message: "what do you recommend for dry skin?", signals: { anonId: ANON_ID }, widgetToken: DEMO_WIDGET_TOKEN },
    });

    const after = await expiryOf(vector, ANON_ID);
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before).getTime());
    await app.close();
  });
});
