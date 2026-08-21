import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { recordHealthDisclosure, lookupHealthDisclosure } from "../src/runtime-disclosure-store.js";

// WS-D task 1 — the disclosure store backing the /memory/merge Art-9 carry-over gate (ADR-0015 Q19(c),
// MED-1 remediation). Mirrors runtime-consent-store.test.ts's own contract style (InMemoryRuntimeStore
// only here; task 1's brief scopes the unit test to the in-memory adapter).

const ACCT = "acct:shopify:demo:1";
const GUEST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

describe("runtime-disclosure-store", () => {
  it("fail-closed: no record -> false", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await lookupHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST })).toBe(false);
  });

  it("record then lookup -> true (same tenant/account/guest)", async () => {
    const store = new InMemoryRuntimeStore();
    await recordHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST });
    expect(await lookupHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST })).toBe(true);
  });

  it("tenant-isolated: a record under tenant A is invisible to tenant B", async () => {
    const store = new InMemoryRuntimeStore();
    await recordHealthDisclosure(store, { tenantId: "A", accountSubject: ACCT, guestAnonId: GUEST });
    expect(await lookupHealthDisclosure(store, { tenantId: "B", accountSubject: ACCT, guestAnonId: GUEST })).toBe(false);
  });

  it("guest-scoped: a disclosure for guest X does not authorize guest Y", async () => {
    const store = new InMemoryRuntimeStore();
    await recordHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST });
    expect(await lookupHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ234567" })).toBe(false);
  });

  // Accessor mirrors runtime-consent-store.test.ts's own audit assertion ("audits the consent write
  // atomically..."), which reads via `store.readAudit({tenantId})` (the real RuntimeStatePort method —
  // there is no `listAudit`).
  it("writes exactly one audit row on record, without leaking the raw ids", async () => {
    const store = new InMemoryRuntimeStore();
    await recordHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST });
    const log = await store.readAudit({ tenantId: "demo" });
    const rows = log.filter((r) => r.action === "memory.health_disclosure.record");
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0]?.input ?? {})).not.toContain(ACCT);
    expect(JSON.stringify(rows[0]?.input ?? {})).not.toContain(GUEST);
  });
});
