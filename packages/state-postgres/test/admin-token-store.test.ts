import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, createAesGcmCrypto, createEnvSecrets, keyScopeSecretName } from "@palup/platform-ports";
import type { CryptoPort, RuntimeStateCtx, RuntimeStatePort, RuntimeStateTx } from "@palup/platform-ports";
import {
  createAdminTokenStore,
  ADMIN_CRED_KEY_SCOPE,
  ADMIN_CRED_COLLECTION,
  ADMIN_CRED_RECORD_KEY,
} from "../src/admin-token-store.js";
import { MERCHANT_CRED_KEY_SCOPE } from "../src/merchant-credential-store.js";

// Task 4 (ADR-0022 condition F2) — the Admin-token custody store. A PARALLEL of
// merchant-credential-store.test.ts's harness, but this file exists specifically to prove the ONE property
// that store cannot: a distinct key scope + distinct AAD from the storefront delegate token, so a
// compromise/rotation of one credential kind never exposes the other.

const TOKEN = "shpat_ADMIN_OFFLINE_TOKEN_NEVER_LOGGED_0001";
const ADMIN_KEY_NAME = keyScopeSecretName("MEMORY_ENCRYPTION_KEY", ADMIN_CRED_KEY_SCOPE);
const MERCHANT_KEY_NAME = keyScopeSecretName("MEMORY_ENCRYPTION_KEY", MERCHANT_CRED_KEY_SCOPE);
const DEFAULT_KEY_NAME = "MEMORY_ENCRYPTION_KEY";

function cryptoFor(secretsByTenant: Record<string, Record<string, string>>): CryptoPort {
  return createAesGcmCrypto(createEnvSecrets(JSON.stringify(secretsByTenant)));
}

/** t1 provisioned with BOTH an admin-cred key and a merchant-cred key (+ default), so a store that
 *  accidentally used the wrong scope would still "work" — only the distinct-scope assertions catch that. */
function standardCrypto(): CryptoPort {
  return cryptoFor({
    "t1": {
      [DEFAULT_KEY_NAME]: "memory-material",
      [ADMIN_KEY_NAME]: "admin-cred-material-t1",
      [MERCHANT_KEY_NAME]: "merchant-cred-material-t1",
    },
    "t2": {
      [DEFAULT_KEY_NAME]: "memory-material",
      [ADMIN_KEY_NAME]: "admin-cred-material-t2",
      [MERCHANT_KEY_NAME]: "merchant-cred-material-t2",
    },
  });
}

function harness(): { store: RuntimeStatePort; crypto: CryptoPort } {
  return { store: new InMemoryRuntimeStore(), crypto: standardCrypto() };
}

async function readAudits(state: RuntimeStatePort, tenantId: string) {
  return state.readAudit({ tenantId });
}

describe("admin-token-store", () => {
  it("put then read returns the token + expiresAt", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", "atk", { actor: "system:test", expiresAt: "2026-09-01T00:00:00.000Z" });
    expect(await s.read("t1")).toEqual({ status: "found", token: "atk", expiresAt: "2026-09-01T00:00:00.000Z" });
  });

  it("put then read without expiresAt omits it", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", "atk", { actor: "system:test" });
    expect(await s.read("t1")).toEqual({ status: "found", token: "atk" });
  });

  it("uses a DISTINCT key scope from merchant-cred (F2)", () => {
    expect(ADMIN_CRED_KEY_SCOPE).toBe("admin-cred");
    expect(ADMIN_CRED_KEY_SCOPE).not.toBe(MERCHANT_CRED_KEY_SCOPE);
  });

  it("distinct scope is load-bearing: an admin token cannot be read back under the merchant-cred scope", async () => {
    const state = new InMemoryRuntimeStore();
    const crypto = standardCrypto();
    const s = createAdminTokenStore(state, crypto);
    await s.put("t1", TOKEN, { actor: "system:test" });

    // Simulate a caller that (bug) tries to decrypt the admin envelope under the merchant-cred scope +
    // merchant-cred aad. It must NOT succeed — proves the two credential kinds do not share key material.
    const row = (await state.get<{ c: string }>({ tenantId: "t1" }, ADMIN_CRED_COLLECTION, ADMIN_CRED_RECORD_KEY))!;
    const wrongScopeAad = `${ADMIN_CRED_COLLECTION}|t1|${ADMIN_CRED_RECORD_KEY}`;
    const decrypted = await crypto.decrypt("t1", row.c, wrongScopeAad, MERCHANT_CRED_KEY_SCOPE);
    expect(decrypted).toBeUndefined();
  });

  it("the stored envelope is tagged with the admin-cred scope, not a v1/default or merchant-cred envelope", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", TOKEN, { actor: "system:test" });
    const row = (await store.get<{ c: string }>({ tenantId: "t1" }, ADMIN_CRED_COLLECTION, ADMIN_CRED_RECORD_KEY))!;
    expect(row.c.startsWith(`v2:${ADMIN_CRED_KEY_SCOPE}:`)).toBe(true);
  });

  it("tenant isolation: t2 cannot read t1's token", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", "atk", { actor: "system:test" });
    expect(await s.read("t2")).toEqual({ status: "missing" });
  });

  it("delete removes it; read is then missing (not unreadable)", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", "atk", { actor: "system:test" });
    await s.delete("t1", { actor: "system:test" });
    expect(await s.read("t1")).toEqual({ status: "missing" });
  });

  it("delete audits admin_token.delete", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", "atk", { actor: "system:test" });
    await s.delete("t1", { actor: "system:test" });
    const log = await readAudits(store, "t1");
    expect(log.some((a) => a.action === "admin_token.delete")).toBe(true);
  });

  it("put audits admin_token.store, and NOTHING derived from the token reaches the audit record", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", TOKEN, { actor: "system:test" });
    const log = await readAudits(store, "t1");
    const entry = log.find((a) => a.action === "admin_token.store");
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it("refresh replaces the token and writes an admin_token.refresh audit", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", "atk", { actor: "system:test" });
    await s.refresh("t1", "atk2", { actor: "system:refresh", expiresAt: "2026-10-01T00:00:00.000Z" });
    expect(await s.read("t1")).toMatchObject({ token: "atk2" });
    const log = await readAudits(store, "t1");
    expect(log.some((a) => a.action === "admin_token.refresh")).toBe(true);
  });

  it("refresh requires an actor", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await s.put("t1", "atk", { actor: "system:test" });
    await expect(s.refresh("t1", "atk2", {} as never)).rejects.toThrow(/actor/);
  });

  it("refuses a blank tenantId on every operation", async () => {
    const { store, crypto } = harness();
    const s = createAdminTokenStore(store, crypto);
    await expect(s.put("  ", "atk", { actor: "system:test" })).rejects.toThrow(/non-blank tenantId/);
    await expect(s.read("")).rejects.toThrow(/non-blank tenantId/);
    await expect(s.delete("", { actor: "system:test" })).rejects.toThrow(/non-blank tenantId/);
    await expect(s.refresh("", "atk", { actor: "system:test" })).rejects.toThrow(/non-blank tenantId/);
  });

  it("encrypts BEFORE opening the tx: an unconfigured key throws with nothing written or audited", async () => {
    const state = new InMemoryRuntimeStore();
    const crypto = cryptoFor({ t1: { [DEFAULT_KEY_NAME]: "memory-material" } }); // no admin-cred key
    const s = createAdminTokenStore(state, crypto);
    await expect(s.put("t1", TOKEN, { actor: "system:test" })).rejects.toThrow();
    expect(await s.read("t1")).toEqual({ status: "missing" });
    expect(await state.readAudit({ tenantId: "t1" })).toEqual([]);
  });

  // ---- ATOMICITY: the KV write and its audit commit TOGETHER, in every op ---------------------------
  // Copied from merchant-credential-store.test.ts's `auditFailingStore` double (lines ~432-450 there):
  // wraps a real RuntimeStatePort so the in-transaction audit sink throws, proving `writeAndAudit`'s
  // `state.tx(...)` callback is the ONLY place either the KV write or the audit call happen — a future
  // edit that pulled the audit call out of the tx (or reordered it after a bare `state.put`) would leave
  // an unaudited admin token behind, and this is a store with shop-wide admin-API blast radius.
  it("put: an audit failure inside the tx leaves NO stored token behind (rolled back, not partially written)", async () => {
    const state = new InMemoryRuntimeStore();
    const crypto = standardCrypto();
    const failing = createAdminTokenStore(auditFailingStore(state), crypto);
    await expect(failing.put("t1", TOKEN, { actor: "system:test" })).rejects.toThrow(/audit sink/);
    // Verified via a SEPARATE, non-failing store instance over the same underlying state — the read
    // path itself is not what's under test here, only whether anything survived the failed write.
    expect(await createAdminTokenStore(state, crypto).read("t1")).toEqual({ status: "missing" });
    expect(await state.readAudit({ tenantId: "t1" })).toEqual([]);
  });

  it("refresh: an audit failure inside the tx leaves the PRIOR token intact (no partial rotation)", async () => {
    const state = new InMemoryRuntimeStore();
    const crypto = standardCrypto();
    const store = createAdminTokenStore(state, crypto);
    await store.put("t1", "atk", { actor: "system:test" });

    const failing = createAdminTokenStore(auditFailingStore(state), crypto);
    await expect(failing.refresh("t1", "atk2", { actor: "system:refresh" })).rejects.toThrow(/audit sink/);

    expect(await store.read("t1")).toEqual({ status: "found", token: "atk" }); // NOT "atk2"
  });

  it("delete: an audit failure inside the tx leaves the token IN PLACE (not deleted)", async () => {
    const state = new InMemoryRuntimeStore();
    const crypto = standardCrypto();
    const store = createAdminTokenStore(state, crypto);
    await store.put("t1", "atk", { actor: "system:test" });

    const failing = createAdminTokenStore(auditFailingStore(state), crypto);
    await expect(failing.delete("t1", { actor: "system:test" })).rejects.toThrow(/audit sink/);

    expect(await store.read("t1")).toEqual({ status: "found", token: "atk" });
  });
});

// --- test doubles ---------------------------------------------------------------------------------

/** Same store, but the in-transaction audit sink is broken — the write must not survive it. Copied
 *  verbatim (structure-wise) from merchant-credential-store.test.ts's own `auditFailingStore`. */
function auditFailingStore(inner: RuntimeStatePort): RuntimeStatePort {
  return {
    get: (ctx, c, k) => inner.get(ctx, c, k),
    put: (ctx, c, k, v, opts) => inner.put(ctx, c, k, v, opts),
    delete: (ctx, c, k) => inner.delete(ctx, c, k),
    list: (ctx, c) => inner.list(ctx, c),
    append: (ctx, s, e) => inner.append(ctx, s, e),
    readStream: (ctx, s, o) => inner.readStream(ctx, s, o),
    incrementWindow: (ctx, k, w) => inner.incrementWindow(ctx, k, w),
    sweepExpired: () => inner.sweepExpired(),
    trimStream: (ctx, s, k) => inner.trimStream(ctx, s, k),
    audit: (ctx, e, at) => inner.audit(ctx, e, at),
    readAudit: (ctx, o) => inner.readAudit(ctx, o),
    verifyAudit: (ctx, o) => inner.verifyAudit(ctx, o),
    tx: <T>(ctx: RuntimeStateCtx, fn: (t: RuntimeStateTx) => Promise<T>) =>
      inner.tx(ctx, (t) =>
        fn({
          get: (c, k) => t.get(c, k),
          put: (c, k, v, opts) => t.put(c, k, v, opts),
          delete: (c, k) => t.delete(c, k),
          append: (s, e) => t.append(s, e),
          audit: async () => {
            throw new Error("audit sink unavailable");
          },
        }),
      ),
  };
}
