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

    it("TTL: an expired entry is invisible to get + list; a live one is visible", async () => {
      const s = await makeAdapter();
      await s.put(A, "idem", "expired", { v: 1 }, { ttlSeconds: -1 }); // already in the past
      await s.put(A, "idem", "live", { v: 2 }, { ttlSeconds: 300 });
      expect(await s.get(A, "idem", "expired")).toBeNull();
      expect(await s.get(A, "idem", "live")).toEqual({ v: 2 });
      expect((await s.list(A, "idem")).map((r) => r.key)).toEqual(["live"]);
    });

    it("sweepExpired reclaims expired KV rows (leaves live ones)", async () => {
      const s = await makeAdapter();
      await s.put(A, "idem", "gone", { v: 1 }, { ttlSeconds: -1 });
      await s.put(A, "idem", "stay", { v: 2 });
      expect(await s.sweepExpired()).toBeGreaterThanOrEqual(1);
      expect((await s.list(A, "idem")).map((r) => r.key)).toEqual(["stay"]);
    });

    it("trimStream retains only the most recent keepLast entries", async () => {
      const s = await makeAdapter();
      for (let i = 1; i <= 6; i++) await s.append(A, "traffic", { i });
      expect(await s.trimStream(A, "traffic", 2)).toBe(4);
      expect(await s.readStream(A, "traffic")).toEqual([{ i: 5 }, { i: 6 }]);
    });

    it("incrementWindow counts within a window and is atomic under concurrency (no lost update)", async () => {
      const s = await makeAdapter();
      expect(await s.incrementWindow(A, "rl:x", 60)).toBe(1);
      expect(await s.incrementWindow(A, "rl:x", 60)).toBe(2);
      expect(await s.incrementWindow(A, "rl:x", 60)).toBe(3);
      // 5 concurrent increments on a fresh key must yield 5 DISTINCT counts 1..5 (none lost).
      const results = await Promise.all(Array.from({ length: 5 }, () => s.incrementWindow(A, "rl:y", 60)));
      expect(new Set(results).size).toBe(5);
      expect(Math.max(...results)).toBe(5);
      // tenant-isolated: another tenant's same key is independent.
      expect(await s.incrementWindow(B, "rl:x", 60)).toBe(1);
    });

    it("tx.get respects TTL — an expired key is invisible inside a transaction too", async () => {
      const s = await makeAdapter();
      await s.put(A, "kvt", "expired", { v: 1 }, { ttlSeconds: -1 });
      await s.put(A, "kvt", "live", { v: 2 }, { ttlSeconds: 300 });
      await s.tx(A, async (t) => {
        expect(await t.get("kvt", "expired")).toBeNull(); // must not resurrect an expired entry in a RMW
        expect(await t.get("kvt", "live")).toEqual({ v: 2 });
      });
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

    it("append preserves order + returns a monotonic cursor; readStream limit returns the most recent N", async () => {
      const s = await makeAdapter();
      let prev = 0;
      for (let i = 1; i <= 5; i++) {
        const cur = await s.append(A, "traffic", { i });
        expect(cur).toBeGreaterThan(prev); // monotonic cursor (not a stable count)
        prev = cur;
      }
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

    it("REJECTS a blank or missing tenantId on every method (a NULL/empty tenant filter is a cross-tenant wildcard)", async () => {
      const s = await makeAdapter();
      const bad = { tenantId: "" };
      await expect(s.get(bad, "c", "k")).rejects.toThrow();
      await expect(s.put(bad, "c", "k", { x: 1 })).rejects.toThrow();
      await expect(s.delete(bad, "c", "k")).rejects.toThrow();
      await expect(s.list(bad, "c")).rejects.toThrow();
      await expect(s.append(bad, "s", { x: 1 })).rejects.toThrow();
      await expect(s.readStream(bad, "s")).rejects.toThrow();
      await expect(s.audit(bad, { actor: "system", action: "x" })).rejects.toThrow();
      await expect(s.readAudit(bad)).rejects.toThrow();
      await expect(s.verifyAudit(bad)).rejects.toThrow();
      await expect(s.tx(bad, async () => {})).rejects.toThrow();
      await expect(s.get({ tenantId: "   " }, "c", "k")).rejects.toThrow(); // whitespace-only too
    });

    it("a caller mutating the audit input after audit() cannot rewrite the stored record", async () => {
      const s = await makeAdapter();
      const input = { orderId: "1042", pii: "redacted" };
      await s.audit(A, { actor: "system", action: "refund.route", input }, "2026-01-01T00:00:00.000Z");
      input.orderId = "9999"; // mutate the caller's object after committing
      expect((await s.verifyAudit(A)).ok).toBe(true); // stored record + its hash are unaffected
      const [rec] = await s.readAudit(A);
      expect((rec!.input as { orderId: string }).orderId).toBe("1042");
    });

    it("verifyAudit with a trusted head anchor detects truncation/rewrite", async () => {
      const s = await makeAdapter();
      await s.audit(A, { actor: "operator", action: "kill.arm" }, "2026-01-01T00:00:00.000Z");
      const head = await s.audit(A, { actor: "system", action: "guardrail" }, "2026-01-01T00:00:01.000Z");
      expect((await s.verifyAudit(A, { expectedHead: { seq: head.seq, hash: head.hash } })).ok).toBe(true);
      // A stale/mismatched anchor (what a truncated or rewritten chain would produce) is caught.
      expect((await s.verifyAudit(A, { expectedHead: { seq: 5, hash: "0".repeat(64) } })).ok).toBe(false);
    });

    it("serializes concurrent same-tenant transactions (no lost update)", async () => {
      const s = await makeAdapter();
      await s.put(A, "counter", "n", { v: 0 });
      // Read-modify-write ENTIRELY within the tx (via the tx handle) so the read shares the tx's
      // snapshot/connection. Two concurrent bumps must serialize → final 2, neither increment lost.
      const bump = () =>
        s.tx(A, async (t) => {
          const cur = (await t.get<{ v: number }>("counter", "n"))!.v;
          await t.put("counter", "n", { v: cur + 1 });
        });
      await Promise.all([bump(), bump()]);
      expect(await s.get(A, "counter", "n")).toEqual({ v: 2 }); // both applied, neither lost
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
