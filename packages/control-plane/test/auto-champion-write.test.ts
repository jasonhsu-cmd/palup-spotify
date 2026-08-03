import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, mintStepUp, type RuntimeStatePort, type RuntimeStateTx } from "@palup/platform-ports";
import { setAutoPromoteOptIn, setPlatformAutoPromote, armKill } from "@palup/state-postgres";
import { type Policy } from "@palup/widget-brain";
import { servingChampion } from "../src/champion-promoter.js";
import { writeAutoChampion, verifyAutoChampionAudit, readAuditAnchor } from "../src/auto-champion-write.js";

// ADR-0014 prereq #8 — the durable, externally-anchored AUTO-promote write primitive the T4 orchestrator
// calls AFTER all gates pass. The champion put + an actor:"auto-loop" audit + the head-anchor advance
// commit in ONE tx (atomic). It fails CLOSED (no write) unless the T1 opt-in gate is enabled AND no kill
// is armed — defense in depth, so even a mis-wired orchestrator can't write past a disabled/killed tenant.
// Ships dormant: nothing calls it yet.

const SECRET = "su";
const NOW = 1_754_000_000_000;
const P = (id: string): Policy => ({ id, label: id, styleDirective: `voice-${id}`, proactivityDefault: "balanced" });

/** Turn BOTH switches on for a tenant (real T1 SET path: operator + step-up). */
async function enableAutoPromote(store: RuntimeStatePort, tenantId: string) {
  await setAutoPromoteOptIn(store, tenantId, true, { actor: "jane.operator", stepUpToken: mintStepUp(SECRET, { action: "autopromote.optin.set", tenantId, iat: NOW, nonce: `o-${tenantId}` }), stepUpSecret: SECRET, now: NOW });
  await setPlatformAutoPromote(store, true, { actor: "jane.operator", stepUpToken: mintStepUp(SECRET, { action: "autopromote.platform.set", tenantId: "__system__", iat: NOW, nonce: `p-${tenantId}` }), stepUpSecret: SECRET, now: NOW });
}

describe("writeAutoChampion — durable, anchored, auto-loop-attributed (ADR-0014 #8)", () => {
  it("refuses to write when auto-promote is NOT enabled (dormancy defense, fail-closed)", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(writeAutoChampion(store, "acme", P("cand"), {})).rejects.toThrow(/not enabled|force-human|opt/i);
    expect(await servingChampion(store, "acme")).toBeNull(); // nothing served
  });

  it("refuses to write when a kill is armed, even if enabled (fail-closed on the shared registry)", async () => {
    const store = new InMemoryRuntimeStore();
    await enableAutoPromote(store, "acme");
    await armKill(store, "global", "operator-halt");
    await expect(writeAutoChampion(store, "acme", P("cand"), {})).rejects.toThrow(/kill/i);
    expect(await servingChampion(store, "acme")).toBeNull();
  });

  it("writes the serving champion attributed to auto-loop (never human) + advances the head anchor", async () => {
    const store = new InMemoryRuntimeStore();
    await enableAutoPromote(store, "acme");
    const cfg = await writeAutoChampion(store, "acme", P("cand"), { promotedFrom: "champion-v0", at: "2026-08-03T00:00:00Z" });
    expect(cfg.approvedBy).toBe("auto-loop");
    const served = await servingChampion(store, "acme");
    expect(served?.policy.id).toBe("cand"); // reaches the slot serving reads
    const audit = await store.readAudit({ tenantId: "acme" });
    const entry = audit.find((a) => a.action === "champion.auto_promote");
    expect(entry?.actor).toBe("auto-loop"); // NEVER "human"
    expect(audit.every((a) => a.actor !== "human")).toBe(true);
    // The persisted anchor equals the chain head, and the chain verifies against it.
    const head = audit[audit.length - 1];
    const anchor = await readAuditAnchor(store, "acme");
    expect(anchor).toEqual({ seq: head.seq, hash: head.hash });
    expect((await verifyAutoChampionAudit(store, "acme")).ok).toBe(true);
  });

  it("is ATOMIC: an audit failure inside the tx rolls back the champion put (nothing served)", async () => {
    const inner = new InMemoryRuntimeStore();
    await enableAutoPromote(inner, "acme");
    // Wrap the store so the tx's audit throws — the tx must roll back the champion put with it.
    const auditFails: RuntimeStatePort = new Proxy(inner, {
      get(target, prop, recv) {
        if (prop === "tx") {
          return (ctx: { tenantId: string }, fn: (t: RuntimeStateTx) => Promise<unknown>) =>
            target.tx(ctx, (t) => fn({ get: t.get.bind(t), put: t.put.bind(t), delete: t.delete.bind(t), append: t.append.bind(t), audit: async () => { throw new Error("audit fault"); } } as RuntimeStateTx));
        }
        return Reflect.get(target, prop, recv);
      },
    }) as RuntimeStatePort;
    await expect(writeAutoChampion(auditFails, "acme", P("cand"), {})).rejects.toThrow(/audit fault/);
    expect(await servingChampion(inner, "acme")).toBeNull(); // champion put rolled back with the failed audit
    expect(await readAuditAnchor(inner, "acme")).toBeNull(); // anchor never advanced
  });

  it("an auto-promote for tenant A never becomes tenant B's serving champion (blast radius)", async () => {
    const store = new InMemoryRuntimeStore();
    await enableAutoPromote(store, "tenant-a");
    await writeAutoChampion(store, "tenant-a", P("cand"), {});
    expect(await servingChampion(store, "tenant-b")).toBeNull();
  });
});
