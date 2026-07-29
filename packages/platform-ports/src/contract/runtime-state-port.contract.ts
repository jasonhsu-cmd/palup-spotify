import { describe, it, expect } from "vitest";
import { AUDIT_GENESIS_HASH, type RuntimeStatePort } from "../runtime-state-port.js";

// Port contract (ADR-0001): every RuntimeStatePort adapter (in-memory, Postgres, …) MUST pass this,
// so adapters stay behavior-equivalent and the engine stays swappable (ADR-0004). Import into an
// adapter's test and call runRuntimeStatePortContract(() => new MyAdapter()).
//
// `makeAdapter` must return a FRESH, empty adapter each call. Async so a Postgres adapter can
// truncate/migrate a scratch schema per test.
export function runRuntimeStatePortContract(makeAdapter: () => RuntimeStatePort | Promise<RuntimeStatePort>): void {
  const A = { tenantId: "tenant-a" };
  const B = { tenantId: "tenant-b" };

  describe("RuntimeStatePort contract", () => {
    it("put/get round-trips a JSON doc", async () => {
      const s = await makeAdapter();
      await s.put(A, "session", "s1", { latched: true, pitches: 2 });
      expect(await s.get(A, "session", "s1")).toEqual({ latched: true, pitches: 2 });
    });

    it("get returns null for an absent key", async () => {
      const s = await makeAdapter();
      expect(await s.get(A, "session", "nope")).toBeNull();
    });

    it("delete removes a key", async () => {
      const s = await makeAdapter();
      await s.put(A, "session", "s1", { x: 1 });
      await s.delete(A, "session", "s1");
      expect(await s.get(A, "session", "s1")).toBeNull();
    });

    it("list returns all entries in a collection", async () => {
      const s = await makeAdapter();
      await s.put(A, "kill", "global", { reason: "r" });
      await s.put(A, "kill", "agent:shopper", { reason: "q" });
      const rows = await s.list(A, "kill");
      expect(rows.map((r) => r.key).sort()).toEqual(["agent:shopper", "global"]);
    });

    it("ENFORCES TENANT ISOLATION — a tenant never sees another tenant's data", async () => {
      const s = await makeAdapter();
      await s.put(A, "session", "s1", { secret: "A-only" });
      await s.append(A, "traffic", { msg: "A" });
      await s.audit(A, { actor: "system", action: "test" }, "2026-01-01T00:00:00.000Z");
      expect(await s.get(B, "session", "s1")).toBeNull();
      expect(await s.list(B, "session")).toEqual([]);
      expect(await s.readStream(B, "traffic")).toEqual([]);
      expect(await s.readAudit(B)).toEqual([]);
    });

    it("stored values are isolated from later caller mutation (deep copy)", async () => {
      const s = await makeAdapter();
      const v = { openIssues: ["order-status"] };
      await s.put(A, "session", "s1", v);
      v.openIssues.push("MUTATED"); // mutate the caller's object after storing
      const got = await s.get<{ openIssues: string[] }>(A, "session", "s1");
      expect(got?.openIssues).toEqual(["order-status"]);
    });

    it("append preserves order; readStream limit returns the most recent N", async () => {
      const s = await makeAdapter();
      for (let i = 1; i <= 5; i++) expect(await s.append(A, "traffic", { i })).toBe(i);
      expect(await s.readStream(A, "traffic")).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]);
      expect(await s.readStream(A, "traffic", { limit: 2 })).toEqual([{ i: 4 }, { i: 5 }]);
    });

    it("audit is hash-chained: genesis prevHash, monotonic seq, verifiable chain", async () => {
      const s = await makeAdapter();
      const r1 = await s.audit(A, { actor: "operator", action: "kill.arm", reversalPath: "disarm" }, "2026-01-01T00:00:00.000Z");
      const r2 = await s.audit(A, { actor: "system", action: "guardrail.injection_blocked" }, "2026-01-01T00:00:01.000Z");
      expect(r1.seq).toBe(1);
      expect(r1.prevHash).toBe(AUDIT_GENESIS_HASH);
      expect(r1.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r2.seq).toBe(2);
      expect(r2.prevHash).toBe(r1.hash); // chained
      expect((await s.verifyAudit(A)).ok).toBe(true);
      expect(await s.readAudit(A)).toHaveLength(2);
    });

    it("tx commits action + audit together on success", async () => {
      const s = await makeAdapter();
      await s.tx(A, async (t) => {
        await t.put("kill", "global", { reason: "maintenance" });
        await t.audit({ actor: "operator", action: "kill.arm", reversalPath: "runtime-unkill" }, "2026-01-01T00:00:00.000Z");
      });
      expect(await s.get(A, "kill", "global")).toEqual({ reason: "maintenance" });
      expect(await s.readAudit(A)).toHaveLength(1);
    });

    it("tx ROLLS BACK all writes + audit when the body throws (atomicity)", async () => {
      const s = await makeAdapter();
      await s.put(A, "kill", "global", { reason: "pre-existing" });
      await expect(
        s.tx(A, async (t) => {
          await t.put("kill", "global", { reason: "should-not-persist" });
          await t.append("traffic", { should: "not-persist" });
          await t.audit({ actor: "operator", action: "kill.arm" }, "2026-01-01T00:00:00.000Z");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      // Nothing from the failed tx persisted; the pre-existing value is intact.
      expect(await s.get(A, "kill", "global")).toEqual({ reason: "pre-existing" });
      expect(await s.readStream(A, "traffic")).toEqual([]);
      expect(await s.readAudit(A)).toEqual([]);
      expect((await s.verifyAudit(A)).ok).toBe(true);
    });
  });
}
