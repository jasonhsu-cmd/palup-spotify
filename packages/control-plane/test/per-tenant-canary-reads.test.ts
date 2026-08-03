import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type RuntimeStatePort } from "@palup/platform-ports";
import { canaryStats, readTrafficLog } from "../src/canary-controller.js";

// ADR-0014 #4 (blast-radius) — the canary SHADOW/STATS traffic reads must be scoped to the tenant, like
// canaryConfig/startCanary/stopCanary already are. Before T0 they read a hardcoded {tenantId:"demo"}
// partition, so one merchant's shadow-eval/stats saw whatever tenant happened to be "demo". These reds
// prove the reads now isolate per tenant: a canary read for A never counts B's traffic.

const TRAFFIC = "traffic";
const log = (store: RuntimeStatePort, tenantId: string, servedBy: string, escalate: boolean) =>
  store.append({ tenantId }, TRAFFIC, { ts: "2026-08-03T00:00:00Z", servedBy, sessionId: "s", message: "hi there", reply: "hello", mode: "sales", escalate });

describe("per-tenant canary traffic reads (ADR-0014 #4: shadow/stats read ONLY the tenant's own traffic)", () => {
  it("canaryStats(store, tenantId) counts ONLY that tenant's traffic — a read for A never sees B's", async () => {
    const store = new InMemoryRuntimeStore();
    await log(store, "tenant-a", "champion-v0", false);
    await log(store, "tenant-a", "champion-v0", true);
    await log(store, "tenant-b", "canary-warm", false);
    const a = await canaryStats(store, "tenant-a");
    expect(a["champion-v0"].count).toBe(2);
    expect(a["canary-warm"]).toBeUndefined(); // B's policy must never leak into A's stats
    const b = await canaryStats(store, "tenant-b");
    expect(b["canary-warm"].count).toBe(1);
    expect(b["champion-v0"]).toBeUndefined();
  });

  it("readTrafficLog(store, tenantId) returns ONLY that tenant's interactions", async () => {
    const store = new InMemoryRuntimeStore();
    await log(store, "tenant-a", "champion-v0", false);
    await log(store, "tenant-b", "canary-warm", false);
    expect((await readTrafficLog(store, "tenant-a")).every((e) => e.servedBy === "champion-v0")).toBe(true);
    expect((await readTrafficLog(store, "tenant-b")).map((e) => e.servedBy)).toEqual(["canary-warm"]);
  });
});
