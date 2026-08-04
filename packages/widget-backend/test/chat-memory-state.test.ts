import { describe, it, expect, afterEach } from "vitest";
import { InMemoryRuntimeStore, mintWidgetToken } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// PR-11b — the /chat response now carries two READ-ONLY client-facing fields so the (still fully
// inert-by-default) widget can learn the effective memory state without ever being trusted to declare it
// itself: `memoryEnabled` mirrors the SAME double-gated `memoryServiceEnabled` flag that gates whether the
// MemoryService is even constructed (server.ts) — false in real production (MEMORY_ADR_ACCEPTED hardcoded
// false, flag.ts) — and `consentMode` mirrors ADR-0015's region split (US opt-out notice vs. everywhere-
// else opt-in prompt). Style mirrors chat-consent-record.test.ts's env/seam conventions.

const ENV_KEYS = ["MERCHANT_REGION", "WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

// Security review (Finding 2) — the boot guard now asserts on the SAME predicate that actually arms
// memory in-process (`memoryServiceEnabled`), so every test below using the `memoryEnabled` seam must
// also set WIDGET_AUTH_REQUIRED=true or `buildServer` throws. A "demo"-tenant widget token (the SAME
// tenant the unauthenticated RUNTIME_TENANT fallback these tests relied on before) keeps every
// assertion identical to before this change.
const WIDGET_SECRET = "wsecret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);

describe("PR-11b — /chat carries memoryEnabled + consentMode", () => {
  it("real-production default (no seam): memoryEnabled is false — the double gate holds", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store }); // no memoryEnabled seam passed
    const res = await app.inject({ method: "POST", url: "/chat", payload: { sessionId: "s1", message: "hi", signals: {} } });
    expect(res.statusCode).toBe(200);
    expect(res.json().memoryEnabled).toBe(false);
    await app.close();
  });

  it("with the memoryEnabled test seam: the field reflects true", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const res = await app.inject({ method: "POST", url: "/chat", payload: { sessionId: "s2", message: "hi", signals: {}, widgetToken: DEMO_WIDGET_TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json().memoryEnabled).toBe(true);
    await app.close();
  });

  it.each([
    ["us", "opt_out"],
    ["eu", "opt_in"],
    ["uk", "opt_in"],
    ["other", "opt_in"],
  ] as const)("MERCHANT_REGION=%s -> consentMode=%s", async (region, expected) => {
    process.env.MERCHANT_REGION = region;
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: `s-${region}`, message: "hi", signals: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentMode).toBe(expected);
    await app.close();
  });

  it("default region (unset) behaves like 'us' -> opt_out", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const res = await app.inject({ method: "POST", url: "/chat", payload: { sessionId: "s-def", message: "hi", signals: {} } });
    expect(res.statusCode).toBe(200);
    expect(res.json().consentMode).toBe("opt_out");
    await app.close();
  });

  it("carries the fields on early-return / error paths too (oversized input -> 400 input_rejected)", async () => {
    process.env.MERCHANT_REGION = "eu";
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "s-big", message: "a".repeat(5000), signals: {}, widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.flags).toContain("input_rejected");
    expect(body.memoryEnabled).toBe(true);
    expect(body.consentMode).toBe("opt_in");
    await app.close();
  });

  it("the idempotent replay path also carries the fields (they were baked into the cached response)", async () => {
    process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
    process.env.WIDGET_AUTH_REQUIRED = "true";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, memoryEnabled: true });
    const payload = { sessionId: "s-idem", idempotencyKey: "k1", message: "hi", signals: {}, widgetToken: DEMO_WIDGET_TOKEN };
    const first = await app.inject({ method: "POST", url: "/chat", payload });
    const second = await app.inject({ method: "POST", url: "/chat", payload });
    expect(first.json().memoryEnabled).toBe(true);
    expect(second.json().memoryEnabled).toBe(true);
    await app.close();
  });
});
