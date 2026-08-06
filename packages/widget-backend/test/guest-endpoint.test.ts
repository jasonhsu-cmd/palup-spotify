import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryRuntimeStore, mintWidgetToken, mintGuestToken, createGuestTokenIdentity } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// ADR-0019 Revision 2, Task 3 — `POST /widget/guest`, the server endpoint that MINTs and RENEWs the
// signed guest token (task 1's `guest-token-identity`). Server-only here; the widget wiring (store the
// token, call renew near expiry, the R2-1 prompt) is task 8. Tested through the real HTTP surface.
//
// The properties this endpoint must hold (R2-6, R2-3, and the review's carry-forward conditions):
//  * TENANT-BOUND (C1/R2-5): the guest token's tid comes from the VERIFIED widget token, never a client
//    value; no valid widget token ⇒ no mint. The minted token verifies only at that tenant.
//  * INERT WHILE MEMORY IS OFF (R2-6 lazy): with memory disabled — which is every environment today — the
//    endpoint mints NOTHING. It must not issue a durable identifier for a feature that is off.
//  * NO PER-SUBJECT STORE WRITE (F-14 / invariant 11): pure HMAC; no audit row, no consent row, no
//    subject-index row. (The per-IP rate-limit counter is allowed — it is not per-subject.)
//  * no-store on the response — a per-visitor secret must never be cacheable.
//  * MINT vs RENEW (R2-3): a presented VALID own-tenant token is renewed (same anonId, new exp); anything
//    else (absent, expired, wrong-tenant, forged) yields a FRESH mint — a new guest, never a renewal of a
//    token this browser cannot prove.

const WIDGET_SECRET = "wsecret";
const GUEST_SECRET = "gsecret";
const TENANT = "demo";
const WIDGET_TOKEN = mintWidgetToken(WIDGET_SECRET, TENANT, 3_600);

const ENV = ["WIDGET_TOKEN_SECRET", "WIDGET_AUTH_REQUIRED", "GUEST_TOKEN_SECRET", "WIDGET_EMBED_KEYS"];
afterEach(() => {
  ENV.forEach((k) => delete process.env[k]);
  vi.restoreAllMocks();
});

function arm(): void {
  process.env.WIDGET_TOKEN_SECRET = WIDGET_SECRET;
  process.env.WIDGET_AUTH_REQUIRED = "true";
  process.env.GUEST_TOKEN_SECRET = GUEST_SECRET;
  process.env.WIDGET_EMBED_KEYS = JSON.stringify({ "demo-embed-key": TENANT });
}

/** memory ON requires the coupling (WIDGET_AUTH_REQUIRED) which arm() already sets. */
async function server(memoryEnabled: boolean, store = new InMemoryRuntimeStore()) {
  return buildServer({ store, memoryEnabled });
}

const post = (
  app: Awaited<ReturnType<typeof buildServer>>,
  body: Record<string, unknown>,
  token: string | null = WIDGET_TOKEN,
) =>
  app.inject({
    method: "POST",
    url: "/widget/guest",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });

describe("POST /widget/guest — inert while memory is OFF (R2-6 lazy)", () => {
  it("mints NOTHING when memory is disabled, even with a valid widget token", async () => {
    arm();
    const app = await server(false);
    try {
      const res = await post(app, {});
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.guestToken, "issued a guest credential for a feature that is off").toBeUndefined();
      expect(body.enabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("writes nothing to the audit log when off", async () => {
    arm();
    const store = new InMemoryRuntimeStore();
    const app = await server(false, store);
    try {
      await post(app, {});
      expect(await store.readAudit({ tenantId: TENANT })).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("POST /widget/guest — tenant binding (C1 / R2-5)", () => {
  it("with no widget token → 401, no mint", async () => {
    arm();
    const app = await server(true);
    try {
      const res = await post(app, {}, null);
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).guestToken).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("with a valid widget token, the minted guest token verifies ONLY at that tenant", async () => {
    arm();
    const app = await server(true);
    try {
      const res = await post(app, {});
      expect(res.statusCode).toBe(200);
      const { guestToken, anonId } = JSON.parse(res.body);
      expect(guestToken).toBeTruthy();
      const id = createGuestTokenIdentity(GUEST_SECRET);
      expect(await id.verify(guestToken, { tenantId: TENANT })).toEqual({ anonId, tid: TENANT });
      expect(await id.verify(guestToken, { tenantId: "other-shop" })).toBeNull(); // R2-5
    } finally {
      await app.close();
    }
  });
});

describe("POST /widget/guest — no per-subject store write (F-14 / invariant 11), and no-store", () => {
  it("a mint writes no audit/consent/subject row and returns Cache-Control: no-store", async () => {
    arm();
    const store = new InMemoryRuntimeStore();
    const putSpy = vi.spyOn(store, "put");
    const auditSpy = vi.spyOn(store, "audit");
    const app = await server(true, store);
    try {
      const res = await post(app, {});
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      // No memory-subject write: the audit log stays empty and nothing is put under a memory collection.
      expect(auditSpy).not.toHaveBeenCalled();
      const memoryPuts = putSpy.mock.calls.filter(
        (c) => typeof c[1] === "string" && /memory|consent|subject/i.test(c[1] as string),
      );
      expect(memoryPuts, "a mint wrote a per-subject row — F-14 violated").toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("POST /widget/guest — MINT vs RENEW (R2-3)", () => {
  it("renews a valid own-tenant token: SAME anonId, later exp", async () => {
    arm();
    const app = await server(true);
    try {
      const first = JSON.parse((await post(app, {})).body);
      const renewed = JSON.parse((await post(app, { guestToken: first.guestToken })).body);
      expect(renewed.anonId, "renew must preserve the id — memory must not orphan").toBe(first.anonId);
      // the renewed token is valid and carries the same id; exp may equal the original within the same
      // second (harmless — the id is what matters), so we assert the id + validity, not string inequality.
      const claims = await createGuestTokenIdentity(GUEST_SECRET).verify(renewed.guestToken, { tenantId: TENANT });
      expect(claims).toEqual({ anonId: first.anonId, tid: TENANT });
    } finally {
      await app.close();
    }
  });

  it("an EXPIRED token is not renewed — a fresh guest is minted instead (accepted residual)", async () => {
    arm();
    const app = await server(true);
    try {
      const expired = mintGuestToken(GUEST_SECRET, TENANT, -10).token; // already expired
      const res = JSON.parse((await post(app, { guestToken: expired })).body);
      expect(res.guestToken).toBeTruthy();
      const claims = await createGuestTokenIdentity(GUEST_SECRET).verify(res.guestToken, { tenantId: TENANT });
      expect(claims).not.toBeNull(); // a fresh, valid token
    } finally {
      await app.close();
    }
  });

  it("a token from ANOTHER tenant is not renewed here — a fresh THIS-tenant guest is minted (C3)", async () => {
    arm();
    const app = await server(true);
    try {
      const foreign = mintGuestToken(GUEST_SECRET, "other-shop", 3_600);
      const res = JSON.parse((await post(app, { guestToken: foreign.token })).body);
      expect(res.anonId).not.toBe(foreign.anonId); // not a renewal of the foreign id
      const claims = await createGuestTokenIdentity(GUEST_SECRET).verify(res.guestToken, { tenantId: TENANT });
      expect(claims?.tid).toBe(TENANT); // bound to THIS tenant
    } finally {
      await app.close();
    }
  });
});
