import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { setCostCap, clearCostCap, matchedCostCap, costCapStatus } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// §8a invariant 14 at the ROUTE, plus the registry that feeds it.
//
// The brain-level suite (widget-brain/test/basic-mode-at-cap.test.ts) proves the behaviour given the
// signal. This file proves the signal is REAL: that a cap set through the shared store actually reaches
// /chat, that a client cannot forge it, and that the registry has a genuine writer.
//
// That last point is the whole reason this file exists. This repo's recurring defect is correct, tested
// code with NO PRODUCTION CALLER — `rollbackServing`, `recordKnownGood`, `armKill`, the retention sweep,
// and (found earlier in this same programme) the proactivity dial. A `atCap` signal with no writer would
// have been the next one. So: the control plane sets it, the shared store carries it, /chat reads it.

const chat = (app: Awaited<ReturnType<typeof buildServer>>, message: string, extra: Record<string, unknown> = {}, i = 0) =>
  app.inject({
    method: "POST",
    url: "/chat",
    payload: { sessionId: `s-${i}`, message, idempotencyKey: `k-${message.slice(0, 6)}-${i}`, signals: { cart: "has_items" }, ...extra },
  });

describe("the cost-cap registry", () => {
  it("is empty by default — basic mode is never the default posture", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await costCapStatus(store)).toEqual([]);
    expect(await matchedCostCap(store, { tenantId: "demo" })).toBeNull();
  });

  it("a tenant cap matches that tenant and NOT another (blast-radius isolation)", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "tenant:demo", "plan cap");
    expect(await matchedCostCap(store, { tenantId: "demo" })).not.toBeNull();
    expect(await matchedCostCap(store, { tenantId: "other" })).toBeNull();
  });

  it("a global cap binds every tenant (platform COGS cap)", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "platform COGS");
    expect(await matchedCostCap(store, { tenantId: "anyone" })).not.toBeNull();
  });

  it("global takes precedence over a tenant entry, mirroring matchedKill", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "platform");
    await setCostCap(store, "tenant:demo", "tenant");
    expect((await matchedCostCap(store, { tenantId: "demo" }))!.scope).toBe("global");
  });

  it("setting is idempotent, and clearing one scope leaves the others", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "tenant:a", "x");
    await setCostCap(store, "tenant:a", "x");
    await setCostCap(store, "tenant:b", "y");
    expect((await costCapStatus(store)).length).toBe(2);
    await clearCostCap(store, "tenant:a");
    expect((await costCapStatus(store)).map((e) => e.scope)).toEqual(["tenant:b"]);
  });

  it("clearing with no scope lifts everything", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "x");
    await setCostCap(store, "tenant:a", "y");
    await clearCostCap(store);
    expect(await costCapStatus(store)).toEqual([]);
  });

  it("every set and clear is AUDITED atomically with the write (NN#5)", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "platform COGS reached");
    await clearCostCap(store, "global");
    const entries = await store.verifyAudit({ tenantId: "__system__" });
    expect(entries.ok, "the audit chain did not verify").toBe(true);
    const actions = (await store.readAudit({ tenantId: "__system__" })).map((e: { action: string }) => e.action);
    expect(actions).toContain("cost_cap.set");
    expect(actions).toContain("cost_cap.clear");
  });

  it("the audit's reversalPath names a route that EXISTS in the control plane", async () => {
    // #166 found the kill registry's reversalPath naming a route on an undeployed service. A reversal path
    // in an immutable record has to be one an operator can actually run.
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "x");
    const rec = (await store.readAudit({ tenantId: "__system__" })).find(
      (e: { action: string }) => e.action === "cost_cap.set",
    ) as { reversalPath?: string } | undefined;
    expect(rec?.reversalPath).toBe("POST /api/cost-cap/clear");
  });

  it("a cap set by the breaker is attributed to the breaker; a clear to an operator", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "auto");
    await clearCostCap(store, "global");
    const audit = (await store.readAudit({ tenantId: "__system__" })) as { action: string; actor: string }[];
    expect(audit.find((e) => e.action === "cost_cap.set")!.actor).toBe("cost-circuit-breaker");
    expect(audit.find((e) => e.action === "cost_cap.clear")!.actor).toBe("operator");
  });
});

describe("the cap reaches /chat, and only from the server", () => {
  it("no cap -> the proactive exit-intent nudge is served as normal", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const res = await chat(app, "", { signals: { cart: "has_items", proactiveTrigger: "exit_intent" } });
      expect(res.json().pitch).toBe("cart_recovery");
    } finally {
      await app.close();
    }
  });

  it("THE INVARIANT: a cap in the shared store silences the proactive nudge", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "tenant:demo", "plan cap");
    const app = await buildServer({ store });
    try {
      const body = (await chat(app, "", { signals: { cart: "has_items", proactiveTrigger: "exit_intent" } })).json();
      expect(body.pitch).toBe("none");
      expect(body.flags).toContain("at_cap");
    } finally {
      await app.close();
    }
  });

  it("live chat CONTINUES at cap — the shopper is still answered", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "platform COGS");
    const app = await buildServer({ store });
    try {
      const body = (await chat(app, "do you have a fragrance-free moisturizer?")).json();
      expect(body.reply.length).toBeGreaterThan(0);
      expect(body.flags).not.toContain("kill_switch");
    } finally {
      await app.close();
    }
  });

  it("a shopper CANNOT forge atCap to silence a merchant's agent", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const body = (
        await chat(app, "", { signals: { cart: "has_items", proactiveTrigger: "exit_intent", atCap: true } })
      ).json();
      expect(body.flags, "a client-supplied atCap took effect").not.toContain("at_cap");
      expect(body.pitch).toBe("cart_recovery");
    } finally {
      await app.close();
    }
  });

  it("a cap on ANOTHER tenant does not silence this one", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "tenant:someone-else", "their cap");
    const app = await buildServer({ store });
    try {
      const body = (await chat(app, "", { signals: { cart: "has_items", proactiveTrigger: "exit_intent" } })).json();
      expect(body.pitch).toBe("cart_recovery");
    } finally {
      await app.close();
    }
  });

  it("clearing the cap restores proactive behaviour on the next turn", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "tenant:demo", "plan cap");
    const app = await buildServer({ store });
    try {
      expect((await chat(app, "", { signals: { cart: "has_items", proactiveTrigger: "exit_intent" } }, 1)).json().pitch).toBe("none");
      await clearCostCap(store, "tenant:demo");
      expect((await chat(app, "", { signals: { cart: "has_items", proactiveTrigger: "exit_intent" } }, 2)).json().pitch).toBe("cart_recovery");
    } finally {
      await app.close();
    }
  });
});
