import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryRuntimeStore, createAesGcmCrypto, createEnvSecrets, keyScopeSecretName } from "@palup/platform-ports";
import type { CryptoPort, PutOpts, RuntimeStateCtx, RuntimeStatePort, RuntimeStateTx } from "@palup/platform-ports";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import type { Sql } from "../src/sql.js";
import {
  createMerchantCredentialStore,
  MERCHANT_CRED_COLLECTION,
  MERCHANT_CRED_RECORD_KEY,
  MERCHANT_CRED_KEY_SCOPE,
} from "../src/merchant-credential-store.js";

// B2 — MerchantCredentialStore. Same dual-adapter discipline as runtime-consent-store.test.ts: the store
// is built ENTIRELY on the existing RuntimeStatePort + CryptoPort, so it must behave IDENTICALLY on the
// in-memory adapter and on a real Postgres engine (pglite — same SQL dialect as Cloud SQL / Spanner-pg,
// ADR-0004). pglite is NOT Cloud SQL: what these tests prove is dialect/semantic parity of the SQL this
// adapter emits, not the privileges, RLS, or connection behaviour of the live instance.
//
// The properties this file exists to hold, in the priority order of the work item:
//   1. A TOKEN NEVER LEAVES THE STORE IN THE CLEAR — not into the KV row, not into an audit record, not
//      into a thrown error. Asserted on the TEXT of errors and on the FULL JSON of audit records, plus an
//      exact-allowlist assertion on the audit payload's keys so a later "just add a token fingerprint"
//      change fails here instead of quietly shipping.
//   2. Per-merchant key separation: a ciphertext written for merchant A is unreadable for merchant B even
//      when the row is copied verbatim into B's tenant (a DBA-level move), and the memory-encryption
//      (default-scope) key can neither write nor read a credential.
//   3. Fail closed: missing / undecryptable / malformed all have DISTINCT, honest outcomes — an absent
//      read never looks like a valid one.

const TOKEN = "shpat_DELEGATE_TOKEN_NEVER_LOGGED_0001";
const CRED_KEY_NAME = keyScopeSecretName("MEMORY_ENCRYPTION_KEY", MERCHANT_CRED_KEY_SCOPE);
const DEFAULT_KEY_NAME = "MEMORY_ENCRYPTION_KEY";
const CRED_MATERIAL_A = "credential-scope-material-tenant-a";
const CRED_MATERIAL_B = "credential-scope-material-tenant-b";
const MEMORY_MATERIAL = "memory-scope-material-not-for-creds";

/** A CryptoPort whose per-tenant, per-scope key material is spelled out per test — no hidden defaults. */
function cryptoFor(secretsByTenant: Record<string, Record<string, string>>): CryptoPort {
  return createAesGcmCrypto(createEnvSecrets(JSON.stringify(secretsByTenant)));
}

/** The ordinary provisioning both tenants get in most tests: a credential-scope key, and a DIFFERENT
 *  default-scope (memory) key, so every cross-scope assertion below is about the SCOPE, not a missing key. */
function standardCrypto(): CryptoPort {
  return cryptoFor({
    "tenant-a": { [DEFAULT_KEY_NAME]: MEMORY_MATERIAL, [CRED_KEY_NAME]: CRED_MATERIAL_A },
    "tenant-b": { [DEFAULT_KEY_NAME]: MEMORY_MATERIAL, [CRED_KEY_NAME]: CRED_MATERIAL_B },
  });
}

function pgliteSql(db: PGlite): Sql {
  const wrap = (runner: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql => ({
    query: async <R = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      const r = await runner.query(text, params);
      return { rows: r.rows as R[] };
    },
    tx: () => {
      throw new Error("nested transactions are not supported");
    },
  });
  return {
    query: wrap(db).query,
    tx: (fn) => db.transaction(async (txCtx) => fn(wrap(txCtx))),
  };
}

async function makePgAdapter(): Promise<RuntimeStatePort> {
  const store = new PostgresRuntimeStore(pgliteSql(new PGlite()));
  await store.migrate();
  return store;
}

const adapters: Array<[string, () => Promise<RuntimeStatePort>]> = [
  ["InMemoryRuntimeStore", async () => new InMemoryRuntimeStore()],
  ["PostgresRuntimeStore (pglite)", makePgAdapter],
];

/** The raw KV row, as any other reader of the store (a DBA, a support script) would see it. */
async function rawRow(state: RuntimeStatePort, tenantId: string): Promise<unknown> {
  return state.get({ tenantId }, MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY);
}

describe.each(adapters)("merchant-credential-store — %s", (_name, makeStore) => {
  it("round-trips a delegate token for the merchant that stored it", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });
    expect(await store.read("tenant-a")).toEqual({ status: "found", token: TOKEN });
  });

  // ---- 1. THE TOKEN IS NEVER IN THE CLEAR, ANYWHERE ------------------------------------------------
  it("stores the token ENCRYPTED: the raw KV row contains no plaintext token, and carries a v2 SCOPED envelope", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });

    const row = await rawRow(state, "tenant-a");
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    // An EXPLICIT key scope, not the byte-identical legacy `v1:` default envelope — the whole point of
    // using the scope: a compromise of the memory key must not also expose merchant credentials.
    expect((row as { c: string }).c.startsWith(`v2:${MERCHANT_CRED_KEY_SCOPE}:`)).toBe(true);
  });

  it("audits the write, and NOTHING derived from the token reaches the audit record", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });

    const log = await state.readAudit({ tenantId: "tenant-a" });
    const entry = log.find((r) => r.action === "credential.store");
    expect(entry).toBeTruthy();
    // The WHOLE record — action, actor, input, decision, reversalPath, hashes.
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
    // Nor any ciphertext: an envelope in an immutable log outlives the row it came from.
    const row = (await rawRow(state, "tenant-a")) as { c: string };
    expect(JSON.stringify(entry)).not.toContain(row.c);
    // EXACT allowlist: a future "just add a token fingerprint / the shop domain" change must fail HERE.
    expect(Object.keys((entry?.input ?? {}) as Record<string, unknown>).sort()).toEqual(["credential", "replaced"]);
    expect((await state.verifyAudit({ tenantId: "tenant-a" })).ok).toBe(true);
  });

  it("a refused write leaks no token into the thrown error, stores nothing, and audits nothing", async () => {
    const state = await makeStore();
    // Credential scope UNCONFIGURED; the default (memory) key IS present — so the refusal is about the
    // scope, and there is no cross-scope fallback to fake-encrypt with.
    const store = createMerchantCredentialStore(state, cryptoFor({ "tenant-a": { [DEFAULT_KEY_NAME]: MEMORY_MATERIAL } }));

    let message = "";
    await expect(
      store.put("tenant-a", TOKEN, { actor: "operator:install-flow" }).catch((err: unknown) => {
        message = err instanceof Error ? err.message : String(err);
        throw err;
      }),
    ).rejects.toThrow(/fail closed/i);
    expect(message).not.toContain(TOKEN);
    expect(message).toContain(MERCHANT_CRED_KEY_SCOPE); // names the scope + the secret it looked for
    expect(message).toContain(CRED_KEY_NAME);
    expect(message).not.toContain(MEMORY_MATERIAL); // never echoes key material either

    expect(await store.read("tenant-a")).toEqual({ status: "missing" });
    expect(await state.readAudit({ tenantId: "tenant-a" })).toEqual([]);
    expect(await rawRow(state, "tenant-a")).toBeNull();
  });

  it("an unreadable row's result carries no token-derived field — only a reason", async () => {
    const state = await makeStore();
    await state.put({ tenantId: "tenant-a" }, MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY, {
      c: "v2:merchant-cred:deadbeef:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const store = createMerchantCredentialStore(state, standardCrypto());
    const read = await store.read("tenant-a");
    expect(Object.keys(read).sort()).toEqual(["reason", "status"]);
    expect(read).toEqual({ status: "unreadable", reason: "undecryptable" });
  });

  // ---- 2. PER-MERCHANT KEY SEPARATION -------------------------------------------------------------
  it("merchant B cannot decrypt merchant A's ciphertext even when the row is copied VERBATIM into B's tenant", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });

    // A DBA-level relocation: the exact stored doc, moved into tenant-b's row. RuntimeStatePort scoping
    // alone would now hand it to B; only the per-(tenant,scope) key + the aad binding refuse it.
    const row = await rawRow(state, "tenant-a");
    await state.put({ tenantId: "tenant-b" }, MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY, row);

    expect(await store.read("tenant-b")).toEqual({ status: "unreadable", reason: "undecryptable" });
    expect(await store.read("tenant-a")).toEqual({ status: "found", token: TOKEN });
  });

  // The same relocation, under the WORST realistic misconfiguration: an operator provisioned both
  // merchants with the IDENTICAL raw secret. Both of the file's isolation mechanisms are in play (HKDF
  // mixes the tenantId into the derived key, and the aad names the tenant), so this test does not isolate
  // WHICH one refused — it asserts that the combination does, which is the property that matters.
  it("…and still cannot, when both merchants were provisioned with the IDENTICAL raw key material", async () => {
    const state = await makeStore();
    const shared = "one-secret-an-operator-pasted-twice";
    const store = createMerchantCredentialStore(
      state,
      cryptoFor({ "tenant-a": { [CRED_KEY_NAME]: shared }, "tenant-b": { [CRED_KEY_NAME]: shared } }),
    );
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });
    await state.put({ tenantId: "tenant-b" }, MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY, await rawRow(state, "tenant-a"));
    expect(await store.read("tenant-b")).toEqual({ status: "unreadable", reason: "undecryptable" });
    expect(await store.read("tenant-a")).toEqual({ status: "found", token: TOKEN });
  });

  it("is TENANT-SCOPED: without any copying, merchant A's credential is simply not there for merchant B", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });
    expect(await store.read("tenant-a")).toEqual({ status: "found", token: TOKEN }); // …and it IS there for A
    expect(await store.read("tenant-b")).toEqual({ status: "missing" });
    expect(await state.readAudit({ tenantId: "tenant-b" })).toEqual([]); // not even the audit crosses over
  });

  it("the DEFAULT-scope (memory) key can neither write nor read a credential — no cross-scope fallback", async () => {
    const state = await makeStore();
    const crypto = standardCrypto();
    // A default-scope envelope, written exactly as widget-memory would (no keyScope), planted in the row.
    const v1 = await crypto.encrypt("tenant-a", TOKEN, `${MERCHANT_CRED_COLLECTION}|tenant-a|${MERCHANT_CRED_RECORD_KEY}`);
    expect(v1.startsWith("v1:")).toBe(true);
    await state.put({ tenantId: "tenant-a" }, MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY, {
      c: v1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const store = createMerchantCredentialStore(state, crypto);
    // NOT `found` — the credential scope never falls back to the default key, even for the same tenant.
    expect(await store.read("tenant-a")).toEqual({ status: "unreadable", reason: "undecryptable" });
  });

  // ---- 3. FAIL CLOSED ------------------------------------------------------------------------------
  it("distinguishes MISSING from UNREADABLE — an absent read never looks like a valid one", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    expect(await store.read("tenant-a")).toEqual({ status: "missing" });

    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });
    // The key is rotated AWAY with no `_previous` kept: the row exists and is intact, the key is gone.
    const orphaned = createMerchantCredentialStore(
      state,
      cryptoFor({ "tenant-a": { [DEFAULT_KEY_NAME]: MEMORY_MATERIAL, [CRED_KEY_NAME]: "a-completely-different-generation" } }),
    );
    expect(await orphaned.read("tenant-a")).toEqual({ status: "unreadable", reason: "undecryptable" });
  });

  it("a malformed stored row is reported as malformed, not as missing and not as a token", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    for (const bad of [{}, { c: 42 }, { c: "" }, { updatedAt: "2026-01-01T00:00:00.000Z" }]) {
      await state.put({ tenantId: "tenant-a" }, MERCHANT_CRED_COLLECTION, MERCHANT_CRED_RECORD_KEY, bad);
      expect(await store.read("tenant-a")).toEqual({ status: "unreadable", reason: "malformed-record" });
    }
  });

  it("refuses a blank tenantId on every operation (a blank tenant is a cross-tenant wildcard)", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await expect(store.put("  ", TOKEN, { actor: "operator:install-flow" })).rejects.toThrow(/non-blank tenantId/);
    await expect(store.read("")).rejects.toThrow(/non-blank tenantId/);
    await expect(store.delete("", { actor: "operator:install-flow" })).rejects.toThrow(/non-blank tenantId/);
  });

  it("refuses a blank token instead of storing a credential that looks configured but cannot work", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await expect(store.put("tenant-a", "   ", { actor: "operator:install-flow" })).rejects.toThrow(
      /refusing to store a blank credential/i,
    );
    expect(await store.read("tenant-a")).toEqual({ status: "missing" });
    expect(await state.readAudit({ tenantId: "tenant-a" })).toEqual([]);
  });

  it("requires an `actor` at RUNTIME, so no write can be attributed to nobody in the immutable log", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    // Cast exactly as an un-typechecked JS call site would reach this function.
    await expect(store.put("tenant-a", TOKEN, {} as never)).rejects.toThrow(/actor/);
    await expect(store.delete("tenant-a", {} as never)).rejects.toThrow(/actor/);
    expect(await store.read("tenant-a")).toEqual({ status: "missing" });
    expect(await state.readAudit({ tenantId: "tenant-a" })).toEqual([]);
  });

  // ---- 4. ROTATION ---------------------------------------------------------------------------------
  it("rotates a merchant's KEY without a re-install: `_previous` keeps the stored credential readable", async () => {
    const state = await makeStore();
    const before = createMerchantCredentialStore(
      state,
      cryptoFor({ "tenant-a": { [DEFAULT_KEY_NAME]: MEMORY_MATERIAL, [CRED_KEY_NAME]: "credential-key-generation-one" } }),
    );
    await before.put("tenant-a", TOKEN, { actor: "operator:install-flow" });

    // Step 1 of the two-step rotation: outgoing value moved to `<name>_previous`, new value at `<name>`.
    const during = createMerchantCredentialStore(
      state,
      cryptoFor({
        "tenant-a": {
          [DEFAULT_KEY_NAME]: MEMORY_MATERIAL,
          [CRED_KEY_NAME]: "credential-key-generation-two",
          [`${CRED_KEY_NAME}_previous`]: "credential-key-generation-one",
        },
      }),
    );
    expect(await during.read("tenant-a")).toEqual({ status: "found", token: TOKEN });

    // Re-putting the SAME token re-encrypts it under the NEW key, which is what lets step 2 (dropping
    // `_previous`) happen without losing the credential — no re-install needed.
    await during.put("tenant-a", TOKEN, { actor: "operator:key-rotation" });
    const after = createMerchantCredentialStore(
      state,
      cryptoFor({ "tenant-a": { [DEFAULT_KEY_NAME]: MEMORY_MATERIAL, [CRED_KEY_NAME]: "credential-key-generation-two" } }),
    );
    expect(await after.read("tenant-a")).toEqual({ status: "found", token: TOKEN });
  });

  // ---- 5. AUDIT ------------------------------------------------------------------------------------
  it("records the actor and whether the write REPLACED an existing credential", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });
    await store.put("tenant-a", "shpat_A_SECOND_DELEGATE_TOKEN_0002", { actor: "agent:reinstall" });

    const log = await state.readAudit({ tenantId: "tenant-a" });
    const stores = log.filter((r) => r.action === "credential.store");
    expect(stores).toHaveLength(2);
    expect(stores[0]?.actor).toBe("operator:install-flow");
    expect(stores[0]?.input).toEqual({ credential: MERCHANT_CRED_RECORD_KEY, replaced: false });
    expect(stores[1]?.actor).toBe("agent:reinstall");
    expect(stores[1]?.input).toEqual({ credential: MERCHANT_CRED_RECORD_KEY, replaced: true });
    expect(JSON.stringify(log)).not.toContain("shpat_A_SECOND_DELEGATE_TOKEN_0002");
    expect((await state.verifyAudit({ tenantId: "tenant-a" })).ok).toBe(true);
  });

  it("deletes the credential and audits it, distinguishing a delete that removed something", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });
    await store.delete("tenant-a", { actor: "operator:uninstall-webhook" });

    expect(await store.read("tenant-a")).toEqual({ status: "missing" });
    await store.delete("tenant-a", { actor: "operator:uninstall-webhook" }); // idempotent

    const deletes = (await state.readAudit({ tenantId: "tenant-a" })).filter((r) => r.action === "credential.delete");
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.input).toEqual({ credential: MERCHANT_CRED_RECORD_KEY, existed: true });
    expect(deletes[1]?.input).toEqual({ credential: MERCHANT_CRED_RECORD_KEY, existed: false });
    expect((await state.verifyAudit({ tenantId: "tenant-a" })).ok).toBe(true);
  });

  // #179: an audit `reversalPath` named a route on a service that nothing deploys. Nothing in this repo
  // deploys a merchant-credential CLI or endpoint (deploy-staging.yml deploys `palup-widget-staging`
  // only), so a reversal string here must NOT name one — the only honest reversal is the install flow.
  it("every reversalPath is something that actually exists — no route, no service, no CLI", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(state, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });
    await store.delete("tenant-a", { actor: "operator:uninstall-webhook" });

    const log = await state.readAudit({ tenantId: "tenant-a" });
    expect(log).not.toHaveLength(0);
    for (const rec of log) {
      expect(rec.reversalPath, `${rec.action} has no reversalPath`).toBeTruthy();
      expect(rec.reversalPath).not.toMatch(/https?:|POST \/|GET \/|DELETE \/|curl |pnpm |gcloud /);
      expect(rec.reversalPath).toMatch(/install/i);
    }
  });

  it("stamps the row with a NON-SECRET last-written time from the injected clock", async () => {
    const state = await makeStore();
    let clock = "2026-03-01T00:00:00.000Z";
    const store = createMerchantCredentialStore(state, standardCrypto(), { now: () => clock });
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });
    expect((await rawRow(state, "tenant-a")) as { updatedAt: string }).toMatchObject({ updatedAt: clock });
    clock = "2026-03-02T00:00:00.000Z";
    await store.put("tenant-a", TOKEN, { actor: "operator:key-rotation" });
    expect((await rawRow(state, "tenant-a")) as { updatedAt: string }).toMatchObject({ updatedAt: clock });
  });

  it("the credential does NOT silently expire: the write sets no TTL", async () => {
    const state = await makeStore();
    const calls: Array<{ method: string; opts?: PutOpts }> = [];
    const spy = recordingStore(state, calls);
    const store = createMerchantCredentialStore(spy, standardCrypto());
    await store.put("tenant-a", TOKEN, { actor: "operator:install-flow" });

    // One transaction, and the KV write inside it carries no ttlSeconds — a credential that quietly
    // vanished would put grounding back on fixtures with nothing to read as a cause.
    expect(calls.filter((c) => c.method === "tx")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "put")).toHaveLength(0); // never written outside the tx
    const txPut = calls.find((c) => c.method === "tx.put");
    expect(txPut).toBeTruthy();
    expect(txPut?.opts).toBeUndefined();
    expect(calls.filter((c) => c.method === "tx.audit")).toHaveLength(1); // …and audited in the SAME tx
  });

  it("the write and its audit commit TOGETHER: an audit failure leaves no stored credential", async () => {
    const state = await makeStore();
    const store = createMerchantCredentialStore(auditFailingStore(state), standardCrypto());
    await expect(store.put("tenant-a", TOKEN, { actor: "operator:install-flow" })).rejects.toThrow(/audit sink/);
    // Rolled back on the underlying store — no unaudited credential survives.
    expect(await rawRow(state, "tenant-a")).toBeNull();
    expect(await createMerchantCredentialStore(state, standardCrypto()).read("tenant-a")).toEqual({ status: "missing" });
  });
});

// --- test doubles ---------------------------------------------------------------------------------

/** Delegates everything, recording which port methods the store actually used (and with what opts). */
function recordingStore(inner: RuntimeStatePort, calls: Array<{ method: string; opts?: PutOpts }>): RuntimeStatePort {
  return {
    get: (ctx, c, k) => inner.get(ctx, c, k),
    put: (ctx, c, k, v, opts) => {
      calls.push({ method: "put", opts });
      return inner.put(ctx, c, k, v, opts);
    },
    delete: (ctx, c, k) => inner.delete(ctx, c, k),
    list: (ctx, c) => inner.list(ctx, c),
    append: (ctx, s, e) => inner.append(ctx, s, e),
    readStream: (ctx, s, o) => inner.readStream(ctx, s, o),
    incrementWindow: (ctx, k, w) => inner.incrementWindow(ctx, k, w),
    sweepExpired: () => inner.sweepExpired(),
    trimStream: (ctx, s, k) => inner.trimStream(ctx, s, k),
    audit: (ctx, e, at) => {
      calls.push({ method: "audit" });
      return inner.audit(ctx, e, at);
    },
    readAudit: (ctx, o) => inner.readAudit(ctx, o),
    verifyAudit: (ctx, o) => inner.verifyAudit(ctx, o),
    tx: (ctx, fn) => {
      calls.push({ method: "tx" });
      return inner.tx(ctx, (t) =>
        fn({
          get: (c, k) => t.get(c, k),
          put: (c, k, v, opts) => {
            calls.push({ method: "tx.put", opts });
            return t.put(c, k, v, opts);
          },
          delete: (c, k) => t.delete(c, k),
          append: (s, e) => t.append(s, e),
          audit: (e, at) => {
            calls.push({ method: "tx.audit" });
            return t.audit(e, at);
          },
        }),
      );
    },
  };
}

/** Same store, but the in-transaction audit sink is broken — the write must not survive it. */
function auditFailingStore(inner: RuntimeStatePort): RuntimeStatePort {
  const base = recordingStore(inner, []);
  return {
    ...base,
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
