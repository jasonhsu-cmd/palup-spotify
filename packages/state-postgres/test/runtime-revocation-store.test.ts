import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import type { RuntimeStatePort } from "@palup/platform-ports";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import type { Sql } from "../src/sql.js";
import { revokeGuest, isGuestRevoked } from "../src/runtime-revocation-store.js";

// ADR-0019 Revision 2, Task 5 / R2-7 — guest-credential revocation. Built ENTIRELY on the generic
// RuntimeStatePort (no new port surface), so it must behave IDENTICALLY on the in-memory adapter and a real
// Postgres engine (pglite — same SQL dialect as Cloud SQL / Spanner-pg, ADR-0004) — the same parity property
// runtime-consent-store.test.ts proves for the consent store.

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

const AID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // a well-formed guest aid (base32, validateAnonId-shaped)

describe.each(adapters)("runtime-revocation-store — %s", (_name, makeStore) => {
  it("live by default: an aid with no record is NOT revoked", async () => {
    const store = await makeStore();
    expect(await isGuestRevoked(store, { tenantId: "acme", anonId: AID })).toBe(false);
  });

  it("revokeGuest then isGuestRevoked → true (the record's PRESENCE is the signal)", async () => {
    const store = await makeStore();
    await revokeGuest(store, { tenantId: "acme", anonId: AID });
    expect(await isGuestRevoked(store, { tenantId: "acme", anonId: AID })).toBe(true);
  });

  it("is idempotent: re-revoking the same aid stays revoked (no un-revoke)", async () => {
    const store = await makeStore();
    await revokeGuest(store, { tenantId: "acme", anonId: AID });
    await revokeGuest(store, { tenantId: "acme", anonId: AID });
    expect(await isGuestRevoked(store, { tenantId: "acme", anonId: AID })).toBe(true);
  });

  it("is TENANT-SCOPED: a revocation for tenant A is invisible to tenant B for the identical aid", async () => {
    const store = await makeStore();
    await revokeGuest(store, { tenantId: "tenant-a", anonId: AID });
    expect(await isGuestRevoked(store, { tenantId: "tenant-a", anonId: AID })).toBe(true);
    // Same aid, different tenant — must NOT see tenant-a's revocation (a guest aid is single-tenant).
    expect(await isGuestRevoked(store, { tenantId: "tenant-b", anonId: AID })).toBe(false);
  });

  it("audits the revoke atomically, without leaking the raw aid into the log", async () => {
    const store = await makeStore();
    await revokeGuest(store, { tenantId: "acme", anonId: AID });
    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("guest.revoke");
    const entry = log.find((r) => r.action === "guest.revoke");
    expect(JSON.stringify(entry?.input ?? {})).not.toContain(AID);
    // The reversal path must NOT promise reversibility — revocation is one-way by design (R2-7).
    expect(String(entry?.reversalPath)).toMatch(/NOT reversible/i);
    expect((await store.verifyAudit({ tenantId: "acme" })).ok).toBe(true);
  });

  it("hmacKey changes the audited subjectRef for the identical (tenantId, aid)", async () => {
    const storeA = await makeStore();
    const storeB = await makeStore();
    await revokeGuest(storeA, { tenantId: "acme", anonId: AID });
    await revokeGuest(storeB, { tenantId: "acme", anonId: AID, hmacKey: "secret-audit-key" });
    const refFrom = async (store: RuntimeStatePort) => {
      const log = await store.readAudit({ tenantId: "acme" });
      return (log.find((r) => r.action === "guest.revoke")?.input as { subjectRef?: string } | undefined)?.subjectRef;
    };
    const unkeyedRef = await refFrom(storeA);
    const keyedRef = await refFrom(storeB);
    expect(unkeyedRef).toBeTruthy();
    expect(keyedRef).toBeTruthy();
    expect(keyedRef).not.toBe(unkeyedRef);
  });
});
