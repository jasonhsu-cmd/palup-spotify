import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// Task 4 (D2 plan): the `/chat` PRE-FLIGHT — when read-back is ON and the tenant's custodied credential
// is `unreadable`, `/chat` must refuse gracefully with a 503 BEFORE the model runs, rather than silently
// falling through to fixtures or an empty catalog. This is deliberately a DIFFERENT failure than the
// servability 403 (server.ts:1921-1946): a merchant we CAN identify but whose credential we cannot
// decrypt/parse is a transient, operator-fixable problem (bad/rotated key, corrupt row) — not a deliberate
// revocation — hence 503, not 403, and a DIFFERENT flag (`grounding_unavailable`).
//
// `unreadable` is forced WITHOUT exercising crypto at all: a MALFORMED row (`c` not a string) is written
// directly to the shared `InMemoryRuntimeStore` under the exact collection/key
// `createMerchantCredentialStore` reads (merchant-credential-store.ts's `read()`:
// `typeof row.c !== "string" ⇒ { status: "unreadable", reason: "malformed-record" }`). This proves the
// SERVER's own `credReadHandle.read` reaches this exact malformed-record branch, independent of whatever
// crypto/secrets configuration the test process happens to have.
//
// Tenant is the default "demo" (RUNTIME_TENANT, server.ts:82) — reached with NO widget token because
// WIDGET_AUTH_REQUIRED is off by default (server.ts:1866), same as chat-proactivity-dial.test.ts. `demo`'s
// servability passes with no registry/env configuration at all (merchant-resolver.ts: no registry row ⇒
// env-configured ⇒ servable) — the pre-flight this test targets sits AFTER that servability check.

const ENV_KEY = "MERCHANT_CRED_READBACK_ENABLED";
const savedEnv = process.env[ENV_KEY];
const REGION_ENV_KEY = "MERCHANT_REGION";
const savedRegionEnv = process.env[REGION_ENV_KEY];
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (savedRegionEnv === undefined) delete process.env[REGION_ENV_KEY];
  else process.env[REGION_ENV_KEY] = savedRegionEnv;
});

const TENANT = "demo";

/** Writes the exact malformed shape `merchant-credential-store.ts`'s `read()` classifies as
 *  `unreadable`/`malformed-record` — a non-string `c`, never real ciphertext, so no crypto is exercised. */
async function putMalformedCredential(store: InMemoryRuntimeStore, tenantId: string) {
  await store.put({ tenantId }, MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY, {
    c: 12345,
    updatedAt: "x",
  });
}

describe("/chat pre-flight refuses gracefully on an unreadable credential", () => {
  it("flag ON + unreadable credential → 503, grounding_unavailable, graceful copy, no model call", async () => {
    process.env[ENV_KEY] = "true";
    // Force the documented default so the M-1 assertion below (consentMode reports the RESOLVED regime,
    // "opt_out" for region "us", never the pre-resolution UNRESOLVED_CONSENT_MODE which is "opt_in") is
    // deterministic regardless of ambient env.
    delete process.env[REGION_ENV_KEY];
    const store = new InMemoryRuntimeStore();
    await putMalformedCredential(store, TENANT);

    const app = await buildServer({ store });
    // I-2: `buildServer` always constructs Fastify with `logger: false` (server.ts), whose null-logger
    // sets `logger.child = () => logger` — so `req.log` inside the handler is this SAME object, and
    // spying on it here observes exactly what the handler emits.
    const warnSpy = vi.spyOn(app.log, "warn");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-unreadable", message: "hi", signals: {}, idempotencyKey: "unreadable-0" },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.flags).toContain("grounding_unavailable");
      expect(body.reply).toBe("This store's assistant is temporarily unavailable. Please try again shortly.");
      expect(body.mode).toBe("support");
      expect(body.pitch).toBe("none");
      expect(body.escalate).toBe(false);
      // Copy discipline: promises nothing — no human, no export, no erasure.
      expect(body.reply.toLowerCase()).not.toMatch(/human|export|erasure|erase/);

      // M-1: this pre-flight runs AFTER servability resolves the merchant (server.ts's own comment: "from
      // here the merchant IS resolved"), so the 503 must report THEIR resolved consent regime —
      // "opt_out" for the default region "us" — never the pre-resolution UNRESOLVED_CONSENT_MODE
      // ("opt_in", consentModeFor(undefined)). The two differ by construction, so this is discriminating.
      expect(body.consentMode).toBe("opt_out");

      // I-2: the refusal is now observable/alarmable (spec §2.2/§4/§7) — a rate-safe, secret-free warn
      // fires naming the tenant and the closed-set reason.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, reason: "malformed-record" }),
        expect.stringContaining("grounding credential unreadable"),
      );
      // NEVER the token or the raw stored row — assert the negative directly against everything logged.
      const loggedText = JSON.stringify(warnSpy.mock.calls);
      expect(loggedText).not.toMatch(/shpat_/);
      expect(loggedText).not.toContain("12345"); // the malformed row's `c` value (putMalformedCredential)
    } finally {
      await app.close();
    }
  });

  it("flag ON + missing credential (no row at all) → proceeds normally (200)", async () => {
    process.env[ENV_KEY] = "true";
    const store = new InMemoryRuntimeStore(); // no row written for this tenant at all

    const app = await buildServer({ store });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-missing", message: "hi", signals: {}, idempotencyKey: "missing-0" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.flags ?? []).not.toContain("grounding_unavailable");
    } finally {
      await app.close();
    }
  });

  it("flag OFF + the SAME unreadable row present → never reads it, never refuses (200)", async () => {
    process.env[ENV_KEY] = "false";
    const store = new InMemoryRuntimeStore();
    await putMalformedCredential(store, TENANT);

    const app = await buildServer({ store });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: { sessionId: "sess-flag-off", message: "hi", signals: {}, idempotencyKey: "flag-off-0" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.flags ?? []).not.toContain("grounding_unavailable");
    } finally {
      await app.close();
    }
  });
});
