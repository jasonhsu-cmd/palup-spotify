import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import type { RuntimeStatePort } from "@palup/platform-ports";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import type { Sql } from "../src/sql.js";
import { recordConsent, lookupConsent } from "../src/runtime-consent-store.js";

// PR-11a — server-side consent-record plumbing. Mirrors runtime-kill-registry.ts's own store-port
// contract: recordConsent/lookupConsent are built ENTIRELY on the generic RuntimeStatePort (no new port
// surface), so they must behave IDENTICALLY on the in-memory adapter and a real Postgres engine
// (pglite — same SQL dialect as Cloud SQL / Spanner-pg, ADR-0004) — the same parity property
// postgres-runtime-store.test.ts proves for the port's own primitives.

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

// Security review (PR #152) — the requiredness of `source` is enforced at RUNTIME, not just by the type,
// because nothing in this repo typechecks: no root tsconfig, and CI runs no typecheck step. Without this
// guard a future call site that omits `source` would ship green and silently record `actor: "shopper"`
// for a server-derived write — the exact misattribution the field exists to prevent.
describe.each(adapters)("runtime-consent-store — %s", (_name, makeStore) => {
  it("fail-closed: no record for a subject → lookup returns unknown/unknown", async () => {
    const store = await makeStore();
    expect(await lookupConsent(store, { tenantId: "acme", anonId: "SHOPPER1SUBJECTKEY" })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
  });

  it("records a consent choice and looks it up back", async () => {
    const store = await makeStore();
    await recordConsent(store, {
      tenantId: "acme",
      anonId: "SHOPPER1SUBJECTKEY",
      memoryOrdinary: "in",
      memorySpecial: "out",
      source: "shopper",
    });
    expect(await lookupConsent(store, { tenantId: "acme", anonId: "SHOPPER1SUBJECTKEY" })).toEqual({
      memoryOrdinary: "in",
      memorySpecial: "out",
    });
  });

  it("a fresh choice overwrites the prior one for the same subject", async () => {
    const store = await makeStore();
    await recordConsent(store, { tenantId: "acme", anonId: "S1", memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
    await recordConsent(store, { tenantId: "acme", anonId: "S1", memoryOrdinary: "out", memorySpecial: "unknown", source: "shopper" });
    expect(await lookupConsent(store, { tenantId: "acme", anonId: "S1" })).toEqual({
      memoryOrdinary: "out",
      memorySpecial: "unknown",
    });
  });

  it("is TENANT-SCOPED: tenant A's record is invisible to tenant B for the identical anonId", async () => {
    const store = await makeStore();
    await recordConsent(store, { tenantId: "tenant-a", anonId: "SHARED-SUBJECT-ID", memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
    expect(await lookupConsent(store, { tenantId: "tenant-a", anonId: "SHARED-SUBJECT-ID" })).toEqual({
      memoryOrdinary: "in",
      memorySpecial: "in",
    });
    // Same anonId, different tenant — must NOT see tenant-a's record (fails closed to unknown/unknown).
    expect(await lookupConsent(store, { tenantId: "tenant-b", anonId: "SHARED-SUBJECT-ID" })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
  });

  it("audits the consent write atomically, without leaking the raw anonId into the log", async () => {
    const store = await makeStore();
    await recordConsent(store, { tenantId: "acme", anonId: "SUPER-SECRET-ANON-ID", memoryOrdinary: "in", memorySpecial: "out", source: "shopper" });
    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("consent.record");
    const entry = log.find((r) => r.action === "consent.record");
    expect(JSON.stringify(entry?.input ?? {})).not.toContain("SUPER-SECRET-ANON-ID");
    expect((await store.verifyAudit({ tenantId: "acme" })).ok).toBe(true);
  });

  // MEDIUM finding (security-review remediation, PR #152) — a low-entropy `acct:` subject id routed
  // through a bare/unsalted hash is brute-forceable (widget-backend/src/audit.ts's own `hashShopperRef`
  // rule). `recordConsent`'s `hmacKey` must produce a DIFFERENT subjectRef than the unkeyed default for
  // the identical (tenantId, anonId) — proving the ref is genuinely keyed, not just re-hashed.
  it("hmacKey changes the audited subjectRef for the identical (tenantId, anonId)", async () => {
    const storeA = await makeStore();
    const storeB = await makeStore();
    await recordConsent(storeA, { tenantId: "acme", anonId: "acct:shopify:acme:12345", memoryOrdinary: "in", memorySpecial: "unknown", source: "shopper" });
    await recordConsent(storeB, { tenantId: "acme", anonId: "acct:shopify:acme:12345", memoryOrdinary: "in", memorySpecial: "unknown", hmacKey: "secret-audit-key", source: "shopper" });

    const refFrom = async (store: RuntimeStatePort) => {
      const log = await store.readAudit({ tenantId: "acme" });
      const entry = log.find((r) => r.action === "consent.record");
      return (entry?.input as { subjectRef?: string } | undefined)?.subjectRef;
    };
    const unkeyedRef = await refFrom(storeA);
    const keyedRef = await refFrom(storeB);
    expect(unkeyedRef).toBeTruthy();
    expect(keyedRef).toBeTruthy();
    expect(keyedRef).not.toBe(unkeyedRef);
  });
});

describe("recordConsent — `source` is enforced at runtime, not only by the type", () => {
  it("rejects a call that omits `source` rather than silently attributing it to the shopper", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(
      // Cast away the type exactly as an un-typechecked JS/TS call site would reach this function.
      recordConsent(store, { tenantId: "acme", anonId: "SHOPPER1SUBJECTKEY", memoryOrdinary: "in", memorySpecial: "out" } as never),
    ).rejects.toThrow(/'source' must be/);
    // ...and nothing was written or audited.
    expect(await lookupConsent(store, { tenantId: "acme", anonId: "SHOPPER1SUBJECTKEY" })).toEqual({
      memoryOrdinary: "unknown",
      memorySpecial: "unknown",
    });
    expect(await store.readAudit({ tenantId: "acme" })).toEqual([]);
  });
});
