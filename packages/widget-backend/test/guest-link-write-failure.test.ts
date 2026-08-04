import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore, mintWidgetToken, mintShopperToken } from "@palup/platform-ports";
import { lookupConsent } from "@palup/state-postgres";
import { accountSubjectId } from "@palup/widget-memory";

// C15(b) item 4 (security MEDIUM) — `recordGuestLink` failures on /consent used to be swallowed with
// `console.error` only (docs/MEMORY-GO-LIVE-CHECKLIST.md C15). This forces `recordGuestLink` itself to
// throw (everything else in @palup/state-postgres stays the REAL implementation, via `importOriginal`) and
// proves: (1) the shopper's OWN consent choice still lands despite the link-write failure, (2) an operator
// signal still reaches the console, and (3) — the fix under test — a PII-free `guest_link.write_failed`
// audit entry now also lands in the immutable log.
vi.mock("@palup/state-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@palup/state-postgres")>();
  return {
    ...actual,
    recordGuestLink: async () => {
      throw new Error("simulated guest-link store failure");
    },
  };
});

const { buildServer } = await import("../src/server.js");

const WIDGET_SECRET = "wsecret";
const SHOPPER_SECRET = "shopper-secret";
const DEMO_WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, "demo", 3_600);
const SHOPPER_ID = "shopify:demo:88801";
const GUEST_ANON_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32, passes validateAnonId

const ENV_KEYS = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "SHOPPER_AUTH", "SHOPPER_TOKEN_SECRET"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

function armAuth(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.SHOPPER_AUTH = "true";
  process.env.SHOPPER_TOKEN_SECRET = SHOPPER_SECRET;
}

describe("C15(b) item 4 — a FAILED recordGuestLink write is audited, not just console-logged", () => {
  it("the shopper's own consent still lands, a console signal fires, and a PII-free guest_link.write_failed audit entry is written", async () => {
    armAuth();
    const store = new InMemoryRuntimeStore();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = await buildServer({ store, vectorPort: createInMemoryVectorStore() });

    const res = await app.inject({
      method: "POST",
      url: "/consent",
      headers: { "x-shopper-token": mintShopperToken(SHOPPER_SECRET, SHOPPER_ID, "shopify", 3_600) },
      payload: { anonId: GUEST_ANON_ID, memoryOrdinary: "out", memorySpecial: "unknown", widgetToken: DEMO_WIDGET_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    // The shopper's OWN consent choice must not be blocked by the link-write failure.
    expect(await lookupConsent(store, { tenantId: "demo", anonId: accountSubjectId(SHOPPER_ID) })).toEqual({
      memoryOrdinary: "out",
      memorySpecial: "unknown",
    });

    // An operator console signal still fires (pre-existing behavior, unchanged).
    expect(errorSpy).toHaveBeenCalled();

    // NEW — a PII-free audit entry now also lands in the immutable log.
    const log = await store.readAudit({ tenantId: "demo" });
    const entry = log.find((r) => r.action === "guest_link.write_failed");
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry?.input ?? {});
    expect(serialized).not.toContain(GUEST_ANON_ID);
    expect(serialized).not.toContain(SHOPPER_ID);
    expect((entry?.input as { errorClass?: string })?.errorClass).toBe("Error");
    await app.close();
  });
});
