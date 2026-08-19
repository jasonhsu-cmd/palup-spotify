import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { assignHoldoutArm } from "../src/holdout.js";
import {
  JOIN_TOKEN_COLLECTION,
  JOIN_TOKEN_TTL_SECONDS,
  mintOrderJoinToken,
  resolveOrderJoinToken,
  revokeOrderJoinToken,
} from "../src/order-join-token.js";

// W2-C (item 1) — mint + durable map + no-PII + audited reversal.

const TENANT = "acme";
const IDENTITY = "shopper:1";
const PERIOD = "2026-08";

describe("mintOrderJoinToken — mint NOTHING unless the holdout is on AND the identity has an assignment", () => {
  it("mints nothing when the holdout is off (default, never written)", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD)).toBeNull();
  });

  it("mints nothing when the holdout is enabled but this identity never got a /chat assignment this period", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0.5 });
    expect(await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD)).toBeNull();
  });

  it("mints a real opaque token once the identity has a real holdout assignment", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0 }); // fraction 0 ⇒ always treated
    const arm = await assignHoldoutArm(store, TENANT, { enabled: true, fraction: 0 }, IDENTITY, PERIOD);
    expect(arm).toBe("treated");

    const token = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
    expect(typeof token).toBe("string");
    expect(token!.length).toBeGreaterThan(20); // 24 random bytes, base64url — a real token, not a placeholder
  });

  it("a DIFFERENT tenant's holdout config never leaks into another tenant's mint", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: "other-tenant" }, "holdout", "config", { enabled: true, fraction: 0 });
    await assignHoldoutArm(store, "other-tenant", { enabled: true, fraction: 0 }, IDENTITY, PERIOD);
    // TENANT itself never enabled a holdout — mint must still refuse for TENANT.
    expect(await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD)).toBeNull();
  });
});

describe("the persisted map — token → {tenantId, arm, play, period}, resolvable, TTL'd, NO PII", () => {
  it("resolves back to exactly the arm/play/period it was minted for", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 1 }); // fraction 1 ⇒ always control
    await assignHoldoutArm(store, TENANT, { enabled: true, fraction: 1 }, IDENTITY, PERIOD);

    const token = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
    expect(token).not.toBeNull();
    const resolved = await resolveOrderJoinToken(store, TENANT, token!);
    expect(resolved).toEqual({ tenantId: TENANT, arm: "control", play: "agent", period: PERIOD });
  });

  it("the raw stored value contains ONLY tenantId/arm/play/period — no shopper/session identity anywhere", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0 });
    await assignHoldoutArm(store, TENANT, { enabled: true, fraction: 0 }, IDENTITY, PERIOD);
    const token = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);

    const raw = await store.get<Record<string, unknown>>({ tenantId: TENANT }, JOIN_TOKEN_COLLECTION, token!);
    expect(raw).not.toBeNull();
    expect(Object.keys(raw!).sort()).toEqual(["arm", "period", "play", "tenantId"]);
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(IDENTITY);
    expect(serialized).not.toContain("shopper");
    expect(serialized).not.toContain("sess");
  });

  it("two mints for the same identity/period produce two DIFFERENT tokens (not derived from identity)", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0 });
    await assignHoldoutArm(store, TENANT, { enabled: true, fraction: 0 }, IDENTITY, PERIOD);
    const t1 = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
    const t2 = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    expect(t1).not.toBe(t2);
  });

  it("is written with the documented TTL", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0 });
    await assignHoldoutArm(store, TENANT, { enabled: true, fraction: 0 }, IDENTITY, PERIOD);
    const token = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
    expect(JOIN_TOKEN_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(token).not.toBeNull();
  });

  it("resolveOrderJoinToken is scoped per tenant — a token minted for one tenant is not resolvable under another", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0 });
    await assignHoldoutArm(store, TENANT, { enabled: true, fraction: 0 }, IDENTITY, PERIOD);
    const token = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
    expect(await resolveOrderJoinToken(store, "other-tenant", token!)).toBeNull();
  });

  it("resolveOrderJoinToken is null for an absent/blank/unknown token", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await resolveOrderJoinToken(store, TENANT, "no-such-token")).toBeNull();
    expect(await resolveOrderJoinToken(store, TENANT, "")).toBeNull();
  });

  it("mint audits actor/action/reversalPath and never logs the token itself", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0.2 });
    await assignHoldoutArm(store, TENANT, { enabled: true, fraction: 0.2 }, IDENTITY, PERIOD);
    const token = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
    expect(token).not.toBeNull();

    const audit = await store.readAudit({ tenantId: TENANT });
    const rec = audit.find((a) => a.action === "order_jointoken.mint");
    expect(rec).toBeDefined();
    expect(rec?.actor).toBe("order-join-token");
    expect(typeof rec?.reversalPath).toBe("string");
    expect(rec?.reversalPath?.length ?? 0).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(token);
  });
});

describe("revokeOrderJoinToken — the explicit, audited reversal", () => {
  it("deletes the token so it no longer resolves, and audits the reversal with the given reason", async () => {
    const store = new InMemoryRuntimeStore();
    await store.put({ tenantId: TENANT }, "holdout", "config", { enabled: true, fraction: 0 });
    await assignHoldoutArm(store, TENANT, { enabled: true, fraction: 0 }, IDENTITY, PERIOD);
    const token = await mintOrderJoinToken(store, TENANT, IDENTITY, PERIOD);
    expect(token).not.toBeNull();

    await revokeOrderJoinToken(store, TENANT, token!, "test revocation");
    expect(await resolveOrderJoinToken(store, TENANT, token!)).toBeNull();

    const audit = await store.readAudit({ tenantId: TENANT });
    const rec = audit.find((a) => a.action === "order_jointoken.revoke");
    expect(rec).toBeDefined();
    expect(rec?.input).toEqual({ reason: "test revocation" });
  });
});
