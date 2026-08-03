import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore, mintStepUp, type RuntimeStatePort, type RuntimeStateTx } from "@palup/platform-ports";
import { setAutoPromoteOptIn, setPlatformAutoPromote, armKill, recordAutoStage, readOrchestratorState } from "@palup/state-postgres";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { EvolutionEngine, MockGrader, type PolicyMetrics } from "@palup/evolution";
import { servingChampion } from "../src/champion-promoter.js";
import { serveAutoChampion } from "../src/auto-champion-write.js";

// ADR-0014 T4d — the marker+ledger-gated durable serving write. serveAutoChampion refuses unless the
// engine's auto-lane markers say autoPromotable (in-process, engine-enforced) AND the durable ledger
// shows both stages complete (cross-process) AND opt-in is on AND no kill is armed. The served policy is
// bound from the engine record (server-sourced — there is no caller-passed policy to forge). One tx =
// champion put + auto-loop audit + freq-cap stamp; then the external anchor + markAutoPromoted.

const SECRET = "su";
const NOW = 1_754_000_000_000;
const CM = { returnRate: 0.08, complaintRate: 0.03, optOutRate: 0.1, escalationRecall: 1 };
const champMetrics: PolicyMetrics = { policyId: DEFAULT_POLICY.id, safetyPass: true, floorPass: true, qualityScore: 0.7, counterMetrics: CM };
const candMetrics: PolicyMetrics = { policyId: "cand", safetyPass: true, floorPass: true, qualityScore: 0.9, counterMetrics: { ...CM, returnRate: 0.06 }, gating: true };
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });
const POWER = { minN: 100, minWindowMs: 86_400_000, minDelta: 0.05 };
const SHADOW = { n: 8, delta: 0.1, at: "t" };
const CANARY = { n: 200, delta: 0.2, elapsedMs: 90_000_000, at: "t" };

const mkEngine = () => new EvolutionEngine({ champion: { policy: DEFAULT_POLICY, metrics: champMetrics }, grader: new MockGrader({ cand: candMetrics }) });

/** Engine with "cand" driven through begin→shadow→canary so autoPromotable is ok. */
async function drivenEngine(): Promise<EvolutionEngine> {
  const e = mkEngine();
  e.propose(P("cand"));
  await e.evaluate("cand");
  e.beginAutoOptimize("cand");
  e.recordShadow("cand", SHADOW, { maxRegression: 0.05 });
  e.recordCanary("cand", CANARY, POWER);
  return e;
}
async function enable(store: RuntimeStatePort, tenantId: string) {
  await setAutoPromoteOptIn(store, tenantId, true, { actor: "jane.operator", stepUpToken: mintStepUp(SECRET, { action: "autopromote.optin.set", tenantId, iat: NOW, nonce: `o-${tenantId}` }), stepUpSecret: SECRET, now: NOW });
  await setPlatformAutoPromote(store, true, { actor: "jane.operator", stepUpToken: mintStepUp(SECRET, { action: "autopromote.platform.set", tenantId: "__system__", iat: NOW, nonce: `p-${tenantId}` }), stepUpSecret: SECRET, now: NOW });
}
async function ledgerComplete(store: RuntimeStatePort, tenantId: string) {
  await recordAutoStage(store, tenantId, "cand", "shadow", { ...SHADOW, pass: true });
  await recordAutoStage(store, tenantId, "cand", "canary", { ...CANARY, pass: true });
}

describe("serveAutoChampion — marker + ledger + opt-in + kill gated (ADR-0014 T4d)", () => {
  it("REFUSES a candidate the engine says is not auto-promotable — even with opt-in ON + ledger complete", async () => {
    const store = new InMemoryRuntimeStore();
    await enable(store, "acme");
    await ledgerComplete(store, "acme");
    const e = mkEngine();
    e.propose(P("cand"));
    await e.evaluate("cand");
    e.beginAutoOptimize("cand");
    e.recordShadow("cand", SHADOW, { maxRegression: 0.05 }); // NO canary → not autoPromotable
    await expect(serveAutoChampion(e, "cand", store, "acme")).rejects.toThrow(/auto-promotable|canary/i);
    expect(await servingChampion(store, "acme")).toBeNull();
  });

  it("REFUSES when the durable ledger is incomplete even though the engine markers are ok (cross-process guard)", async () => {
    const store = new InMemoryRuntimeStore();
    await enable(store, "acme");
    const e = await drivenEngine(); // engine markers ok...
    // ...but NO ledger recorded (a separate process never wrote it)
    await expect(serveAutoChampion(e, "cand", store, "acme")).rejects.toThrow(/ledger/i);
    expect(await servingChampion(store, "acme")).toBeNull();
  });

  it("REFUSES when opt-in is off, and when a kill is armed (global/tenant) — fail-closed", async () => {
    const noOptin = new InMemoryRuntimeStore();
    await ledgerComplete(noOptin, "acme");
    await expect(serveAutoChampion(await drivenEngine(), "cand", noOptin, "acme")).rejects.toThrow(/not enabled|force-human|opt/i);
    expect(await servingChampion(noOptin, "acme")).toBeNull();
    for (const scope of ["global", "tenant:acme"] as const) {
      const store = new InMemoryRuntimeStore();
      await enable(store, "acme");
      await ledgerComplete(store, "acme");
      await armKill(store, scope, "operator-halt");
      await expect(serveAutoChampion(await drivenEngine(), "cand", store, "acme")).rejects.toThrow(/kill/i);
      expect(await servingChampion(store, "acme")).toBeNull();
    }
  });

  it("happy path: writes serving (auto-loop, engine-bound policy), stamps the freq-cap, emits the anchor, marks the engine", async () => {
    const store = new InMemoryRuntimeStore();
    await enable(store, "acme");
    await ledgerComplete(store, "acme");
    const e = await drivenEngine();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const cfg = await serveAutoChampion(e, "cand", store, "acme", { at: "2026-08-03T00:00:00Z" });
      expect(cfg.approvedBy).toBe("auto-loop");
      const served = await servingChampion(store, "acme");
      expect(served?.policy.id).toBe("cand");
      expect(served?.policy.styleDirective).toBe("voice-cand"); // policy bound from the engine record
      const audit = await store.readAudit({ tenantId: "acme" });
      expect(audit.find((a) => a.action === "champion.auto_promote")?.actor).toBe("auto-loop");
      expect(audit.every((a) => a.actor !== "human")).toBe(true);
      // freq-cap stamped atomically with the write
      expect((await readOrchestratorState(store, "acme")).lastPromotedAt).toBe("2026-08-03T00:00:00Z");
      // external anchor emitted for the committed record
      const head = audit[audit.length - 1];
      const anchor = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("AUDIT_ANCHOR"));
      expect(JSON.parse(anchor!.replace("AUDIT_ANCHOR ", ""))).toMatchObject({ t: "acme", seq: head.seq, hash: head.hash });
      // engine bookkeeping advanced AFTER the durable write
      expect(e.getChampion().policy.id).toBe("cand");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("is ATOMIC: an audit failure rolls back BOTH the champion put AND the freq-cap stamp; no anchor", async () => {
    const inner = new InMemoryRuntimeStore();
    await enable(inner, "acme");
    await ledgerComplete(inner, "acme");
    const e = await drivenEngine();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const auditFails: RuntimeStatePort = new Proxy(inner, {
      get(target, prop, recv) {
        if (prop === "tx") {
          return (ctx: { tenantId: string }, fn: (t: RuntimeStateTx) => Promise<unknown>) =>
            target.tx(ctx, (t) => fn({ get: t.get.bind(t), put: t.put.bind(t), delete: t.delete.bind(t), append: t.append.bind(t), audit: async () => { throw new Error("audit fault"); } } as RuntimeStateTx));
        }
        return Reflect.get(target, prop, recv);
      },
    }) as RuntimeStatePort;
    try {
      await expect(serveAutoChampion(e, "cand", auditFails, "acme")).rejects.toThrow(/audit fault/);
      expect(await servingChampion(inner, "acme")).toBeNull(); // champion rolled back
      expect((await readOrchestratorState(inner, "acme")).lastPromotedAt).toBeUndefined(); // stamp rolled back too
      expect(logSpy.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("AUDIT_ANCHOR"))).toBe(false);
      expect(e.getChampion().policy.id).toBe(DEFAULT_POLICY.id); // engine not advanced (markAutoPromoted never ran)
    } finally {
      logSpy.mockRestore();
    }
  });

  it("blast radius: an auto-promote for tenant A never becomes tenant B's serving champion", async () => {
    const store = new InMemoryRuntimeStore();
    await enable(store, "tenant-a");
    await ledgerComplete(store, "tenant-a");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await serveAutoChampion(await drivenEngine(), "cand", store, "tenant-a");
      expect(await servingChampion(store, "tenant-b")).toBeNull();
    } finally {
      logSpy.mockRestore();
    }
  });
});
