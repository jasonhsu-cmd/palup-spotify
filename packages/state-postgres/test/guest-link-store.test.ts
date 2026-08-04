import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import type { RuntimeStatePort } from "@palup/platform-ports";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import type { Sql } from "../src/sql.js";
import { recordGuestLink, clearGuestLinkIfOwnedBy, auditGuestLinkConsulted, auditGuestLinkWriteFailure, lookupGuestLink } from "../src/guest-link-store.js";

// B12 — the durable, server-recorded guest anonId -> verified account association (docs/MEMORY-GO-LIVE-
// CHECKLIST.md B12/C14). Mirrors runtime-consent-store.test.ts's own parity contract: built entirely on
// the generic RuntimeStatePort, so it must behave IDENTICALLY on the in-memory adapter and a real
// Postgres engine (pglite).

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

describe.each(adapters)("guest-link-store — %s", (_name, makeStore) => {
  it("no link recorded for an anonId → lookup returns undefined", async () => {
    const store = await makeStore();
    expect(await lookupGuestLink(store, { tenantId: "acme", guestAnonId: "GUESTID1234567890123" })).toBeUndefined();
  });

  it("records a link and looks it up back", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "GUESTID1234567890123", accountSubject: "acct:shopify:acme:1" });
    expect(await lookupGuestLink(store, { tenantId: "acme", guestAnonId: "GUESTID1234567890123" })).toEqual({
      accountSubject: "acct:shopify:acme:1",
    });
  });

  it("a fresh link overwrites a prior one for the same guestAnonId", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G1", accountSubject: "acct:shopify:acme:1" });
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G1", accountSubject: "acct:shopify:acme:2" });
    expect(await lookupGuestLink(store, { tenantId: "acme", guestAnonId: "G1" })).toEqual({ accountSubject: "acct:shopify:acme:2" });
  });

  it("is TENANT-SCOPED: tenant A's link is invisible to tenant B for the identical guestAnonId", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "tenant-a", guestAnonId: "SHARED-GUEST-ID", accountSubject: "acct:shopify:tenant-a:1" });
    expect(await lookupGuestLink(store, { tenantId: "tenant-a", guestAnonId: "SHARED-GUEST-ID" })).toEqual({
      accountSubject: "acct:shopify:tenant-a:1",
    });
    expect(await lookupGuestLink(store, { tenantId: "tenant-b", guestAnonId: "SHARED-GUEST-ID" })).toBeUndefined();
  });

  it("audits the link write atomically, without leaking the raw guestAnonId or accountSubject into the log", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "SUPER-SECRET-GUEST-ID", accountSubject: "acct:shopify:acme:super-secret-999" });
    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("guest_link.record");
    const entry = log.find((r) => r.action === "guest_link.record");
    const serialized = JSON.stringify(entry?.input ?? {});
    expect(serialized).not.toContain("SUPER-SECRET-GUEST-ID");
    expect(serialized).not.toContain("super-secret-999");
    expect((await store.verifyAudit({ tenantId: "acme" })).ok).toBe(true);
  });

  // MEDIUM finding parity (security-review remediation, PR #152) — a low-entropy `acct:` subject id
  // routed through a bare/unsalted hash is brute-forceable. `recordGuestLink`'s `hmacKey` must produce a
  // DIFFERENT ref than the unkeyed default for the identical (tenantId, accountSubject).
  it("hmacKey changes the audited refs for the identical (tenantId, guestAnonId, accountSubject)", async () => {
    const storeA = await makeStore();
    const storeB = await makeStore();
    await recordGuestLink(storeA, { tenantId: "acme", guestAnonId: "G-HMAC", accountSubject: "acct:shopify:acme:12345" });
    await recordGuestLink(storeB, { tenantId: "acme", guestAnonId: "G-HMAC", accountSubject: "acct:shopify:acme:12345", hmacKey: "secret-audit-key" });

    const refsFrom = async (store: RuntimeStatePort) => {
      const log = await store.readAudit({ tenantId: "acme" });
      const entry = log.find((r) => r.action === "guest_link.record");
      return entry?.input as { guestRef?: string; accountRef?: string } | undefined;
    };
    const unkeyed = await refsFrom(storeA);
    const keyed = await refsFrom(storeB);
    expect(unkeyed?.guestRef).toBeTruthy();
    expect(unkeyed?.accountRef).toBeTruthy();
    expect(keyed?.guestRef).not.toBe(unkeyed?.guestRef);
    expect(keyed?.accountRef).not.toBe(unkeyed?.accountRef);
  });
});

// C15(b) — last-VERIFIED-writer-wins, atomically, so a squatted link is recoverable non-destructively by
// the rightful account, and clearing a link is restricted to the account it already belongs to (the
// permissive-direction trap this spec calls out explicitly).
describe.each(adapters)("guest-link-store — C15(b) recordGuestLink is last-verified-writer-wins — %s", (_name, makeStore) => {
  it("recording a link for the first time returns { changed: true } and audits", async () => {
    const store = await makeStore();
    const result = await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G-FIRST", accountSubject: "acct:shopify:acme:1" });
    expect(result).toEqual({ changed: true });
    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.filter((r) => r.action === "guest_link.record").length).toBe(1);
  });

  it("IDEMPOTENT (TOCTOU/compare-and-write): re-recording the IDENTICAL (guestAnonId, accountSubject) is a no-op — no write, no re-audit", async () => {
    const store = await makeStore();
    const first = await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G-IDEM", accountSubject: "acct:shopify:acme:1" });
    expect(first).toEqual({ changed: true });
    const afterFirst = await store.readAudit({ tenantId: "acme" });
    const countAfterFirst = afterFirst.filter((r) => r.action === "guest_link.record").length;
    expect(countAfterFirst).toBe(1);

    const second = await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G-IDEM", accountSubject: "acct:shopify:acme:1" });
    expect(second).toEqual({ changed: false });
    const afterSecond = await store.readAudit({ tenantId: "acme" });
    expect(afterSecond.filter((r) => r.action === "guest_link.record").length).toBe(countAfterFirst); // no re-audit
    expect(await lookupGuestLink(store, { tenantId: "acme", guestAnonId: "G-IDEM" })).toEqual({ accountSubject: "acct:shopify:acme:1" });
  });

  it("SQUAT CLEARED NON-DESTRUCTIVELY: a DIFFERENT accountSubject for the same guestAnonId overwrites the link, returns { changed: true }, and audits the change", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G-SQUAT", accountSubject: "acct:shopify:acme:attacker" });
    expect(await lookupGuestLink(store, { tenantId: "acme", guestAnonId: "G-SQUAT" })).toEqual({ accountSubject: "acct:shopify:acme:attacker" });

    const result = await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G-SQUAT", accountSubject: "acct:shopify:acme:victim" });
    expect(result).toEqual({ changed: true });
    expect(await lookupGuestLink(store, { tenantId: "acme", guestAnonId: "G-SQUAT" })).toEqual({ accountSubject: "acct:shopify:acme:victim" });
    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.filter((r) => r.action === "guest_link.record").length).toBe(2);
  });

  it("the reversalPath on a fresh guest_link.record entry is true when followed literally: does not claim NOT REVERSIBLE, and does not claim the squat class is eliminated", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G-REV", accountSubject: "acct:shopify:acme:1" });
    const log = await store.readAudit({ tenantId: "acme" });
    const entry = log.find((r) => r.action === "guest_link.record");
    expect(entry?.reversalPath).toMatch(/REVERSIBLE/);
    expect(entry?.reversalPath).not.toMatch(/NOT REVERSIBLE/);
    expect(entry?.reversalPath).toMatch(/not eliminated/i);
  });
});

describe.each(adapters)("guest-link-store — C15(b) clearGuestLinkIfOwnedBy — %s", (_name, makeStore) => {
  it("clearing a NON-EXISTENT link is a no-op: { cleared: false }, nothing audited", async () => {
    const store = await makeStore();
    const result = await clearGuestLinkIfOwnedBy(store, { tenantId: "acme", guestAnonId: "G-NONE", accountSubject: "acct:shopify:acme:1" });
    expect(result).toEqual({ cleared: false });
    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).not.toContain("guest_link.clear");
  });

  // THE TRAP (spec's single most important constraint on this function): an UNRESTRICTED clear would let
  // an attacker remove a VICTIM's own link, silently un-narrowing the victim's signed-out turns and
  // re-opening C14 against them. This must never happen regardless of who calls it.
  it("THE TRAP — a caller whose account does NOT own the link cannot clear it: { cleared: false }, the link SURVIVES untouched", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G-VICTIM", accountSubject: "acct:shopify:acme:victim" });

    const result = await clearGuestLinkIfOwnedBy(store, { tenantId: "acme", guestAnonId: "G-VICTIM", accountSubject: "acct:shopify:acme:attacker" });
    expect(result).toEqual({ cleared: false });
    expect(await lookupGuestLink(store, { tenantId: "acme", guestAnonId: "G-VICTIM" })).toEqual({ accountSubject: "acct:shopify:acme:victim" });
    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).not.toContain("guest_link.clear");
  });

  it("the account the link ALREADY points at may clear its own link: { cleared: true }, link removed, audited", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "G-OWN", accountSubject: "acct:shopify:acme:owner" });

    const result = await clearGuestLinkIfOwnedBy(store, { tenantId: "acme", guestAnonId: "G-OWN", accountSubject: "acct:shopify:acme:owner" });
    expect(result).toEqual({ cleared: true });
    expect(await lookupGuestLink(store, { tenantId: "acme", guestAnonId: "G-OWN" })).toBeUndefined();
    const log = await store.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("guest_link.clear");
  });

  it("audits the clear atomically without leaking the raw guestAnonId or accountSubject into the log", async () => {
    const store = await makeStore();
    await recordGuestLink(store, { tenantId: "acme", guestAnonId: "SUPER-SECRET-CLEAR-ID", accountSubject: "acct:shopify:acme:super-secret-clear-1" });
    await clearGuestLinkIfOwnedBy(store, { tenantId: "acme", guestAnonId: "SUPER-SECRET-CLEAR-ID", accountSubject: "acct:shopify:acme:super-secret-clear-1" });
    const log = await store.readAudit({ tenantId: "acme" });
    const entry = log.find((r) => r.action === "guest_link.clear");
    const serialized = JSON.stringify(entry?.input ?? {});
    expect(serialized).not.toContain("SUPER-SECRET-CLEAR-ID");
    expect(serialized).not.toContain("super-secret-clear-1");
    expect((await store.verifyAudit({ tenantId: "acme" })).ok).toBe(true);
  });
});

describe.each(adapters)("guest-link-store — C15(b) auditGuestLinkConsulted / auditGuestLinkWriteFailure — %s", (_name, makeStore) => {
  it("auditGuestLinkConsulted writes a PII-free guest_link.consulted entry", async () => {
    const store = await makeStore();
    await auditGuestLinkConsulted(store, {
      tenantId: "acme",
      guestAnonId: "G-CONSULT-SECRET",
      accountSubject: "acct:shopify:acme:consult-secret",
      narrowedOrdinary: true,
      narrowedSpecial: false,
    });
    const log = await store.readAudit({ tenantId: "acme" });
    const entry = log.find((r) => r.action === "guest_link.consulted");
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry?.input ?? {});
    expect(serialized).not.toContain("G-CONSULT-SECRET");
    expect(serialized).not.toContain("consult-secret");
  });

  it("auditGuestLinkWriteFailure writes a PII-free guest_link.write_failed entry carrying the error's class only", async () => {
    const store = await makeStore();
    await auditGuestLinkWriteFailure(store, {
      tenantId: "acme",
      guestAnonId: "G-FAIL-SECRET",
      accountSubject: "acct:shopify:acme:fail-secret",
      errorClass: "Error",
    });
    const log = await store.readAudit({ tenantId: "acme" });
    const entry = log.find((r) => r.action === "guest_link.write_failed");
    expect(entry).toBeDefined();
    expect((entry?.input as { errorClass?: string })?.errorClass).toBe("Error");
    const serialized = JSON.stringify(entry?.input ?? {});
    expect(serialized).not.toContain("G-FAIL-SECRET");
    expect(serialized).not.toContain("fail-secret");
  });
});
