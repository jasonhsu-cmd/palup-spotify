import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "../src/in-memory-runtime-store.js";
import type { AuditRecord } from "../src/runtime-state-port.js";
import { runRuntimeStatePortContract } from "../src/contract/runtime-state-port.contract.js";

// The in-memory adapter is the behavioral oracle for the port: it must pass the full contract.
runRuntimeStatePortContract(() => new InMemoryRuntimeStore());

describe("InMemoryRuntimeStore audit tamper-detection (white-box)", () => {
  it("verifyAudit catches a mutated record", async () => {
    const s = new InMemoryRuntimeStore();
    const ctx = { tenantId: "t" };
    await s.audit(ctx, { actor: "operator", action: "kill.arm" }, "2026-01-01T00:00:00.000Z");
    await s.audit(ctx, { actor: "system", action: "guardrail.injection_blocked" }, "2026-01-01T00:00:01.000Z");
    expect((await s.verifyAudit(ctx)).ok).toBe(true);

    // Reach into the private chain and forge the decision on record #1 without recomputing its hash.
    const chain = (s as unknown as { tenants: Map<string, { audit: AuditRecord[] }> }).tenants.get("t")!.audit;
    chain[0].decision = "TAMPERED";

    const v = await s.verifyAudit(ctx);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  it("audit hash is deterministic regardless of input key order", async () => {
    const mk = () => new InMemoryRuntimeStore();
    const a = mk();
    const b = mk();
    const ctx = { tenantId: "t" };
    const r1 = await a.audit(ctx, { actor: "op", action: "x", input: { a: 1, b: 2 }, decision: { ok: true } }, "2026-01-01T00:00:00.000Z");
    const r2 = await b.audit(ctx, { actor: "op", action: "x", decision: { ok: true }, input: { b: 2, a: 1 } }, "2026-01-01T00:00:00.000Z");
    expect(r1.hash).toBe(r2.hash);
  });
});
