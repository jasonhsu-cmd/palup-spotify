import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore, createEnvSecrets, type SecretsPort } from "@palup/platform-ports";
import { createBrain, createSession, MockModelAdapter } from "@palup/widget-brain";
import { createMemoryService } from "../src/service.js";
import { mergeGuestIntoAccount } from "../src/merge.js";
import { subjectNamespace, floorNamespace, accountSubjectId } from "../src/identity.js";
import { subjectRef } from "../src/audit.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// ADR-0015 Tier 2 (Decision: "Signed-up" bullet) + Invariant 9: guest -> account carry-over is an AUDITED
// COPY — repeatable and idempotent by content, NOT a one-time move (B12(b); see merge.ts's header for why
// deleting the guest namespace was a data-theft vector). Special-category facts are NEVER auto-folded into
// the account's sign-up ToS — they follow ONLY when Consent 2 is separately granted for the account,
// otherwise dropped. Copy-not-move specifics live in b12-copy-not-move.test.ts.

function fixedDistiller(facts: string[]): FactDistiller {
  // PR-8: FactDistiller.distill() returns candidate OBJECTS ({text, disposition?}), not bare strings.
  return { async distill() { return facts.map((text) => ({ text })); } };
}

// ADR-0015 Inv 9 (go-live blocker #2): a special-category write is refused without a configured
// encryption key (service.ts, fail closed) — mirrors service.test.ts's own `keyedSecrets` helper.
function keyedSecrets(...tenantIds: string[]): SecretsPort {
  const byTenant: Record<string, Record<string, string>> = {};
  for (const t of tenantIds) byTenant[t] = { MEMORY_ENCRYPTION_KEY: `test-key-for-${t}` };
  return createEnvSecrets(JSON.stringify(byTenant));
}

describe("merge — mergeGuestIntoAccount", () => {
  // B12(b): this used to assert the anon namespace was EMPTIED. It is now deliberately left intact —
  // copy, never move — so that (a) signing out does not wipe guest memory ("the guest remains usable")
  // and (b) an attacker holding a victim's `anonId` cannot DESTROY the victim's facts, which is what made
  // the withdrawn version a data-theft vector rather than the read exposure C1 already accepts. See
  // merge.ts's header and b12-copy-not-move.test.ts.
  it("copies ordinary facts anon -> account and LEAVES the anon namespace intact (guest stays usable)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-merge", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      { tenantId: "acme", anonId: "guest-merge", accountId: "acct-1", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
    );
    expect(result.merged).toBe(1);

    const anonMatches = await vector.query(subjectNamespace("acme", "guest-merge"), { text: "", k: 10 });
    expect(anonMatches, "the guest namespace was emptied — copy-not-move must leave it alone").toHaveLength(1);

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-1", region: "us", consent1: "in", consent2: "unknown" };
    expect(await service.recall(acctCtx)).toEqual([{ text: "prefers fragrance-free", class: "ordinary" }]);
  });

  it("a second merge for the same anonId is a no-op — no double-count (now by CONTENT: the source survives, so only ids the account lacks migrate)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-twice", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const deps = { vector, audit: runtimeStore };
    const mergeCtx = { tenantId: "acme", anonId: "guest-twice", accountId: "acct-2", consent2: "unknown" as const, consent2Source: "unknown" as const, healthDisclosed: false };

    const first = await mergeGuestIntoAccount(deps, mergeCtx);
    expect(first.merged).toBe(1);

    const second = await mergeGuestIntoAccount(deps, mergeCtx);
    expect(second.merged).toBe(0);

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-2", region: "us", consent1: "in", consent2: "unknown" };
    expect(await service.recall(acctCtx)).toHaveLength(1); // not duplicated
  });

  it("special facts are DROPPED (not migrated) when Consent 2 is not granted for the account (Inv 9)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme"),
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-special", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });
    expect(await service.recall(ctx)).toHaveLength(1);

    // Isolates the ACCOUNT-side variable: guest opted in and disclosure happened, but the account itself
    // never granted Consent 2 — still dropped (R2-2/Q19(c) is a compound AND, not an OR).
    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      { tenantId: "acme", anonId: "guest-special", accountId: "acct-3", consent2: "unknown", consent2Source: "in", healthDisclosed: true },
    );
    expect(result.merged).toBe(0); // dropped, never promoted under sign-up ToS

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-3", region: "us", consent1: "in", consent2: "in" };
    expect(await service.recall(acctCtx)).toEqual([]);
  });

  it("special facts DO migrate (to the account FLOOR namespace) when all three hold: account consent2 'in', guest consent2Source 'in', AND healthDisclosed", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme"),
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-special-in", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      { tenantId: "acme", anonId: "guest-special-in", accountId: "acct-4", consent2: "in", consent2Source: "in", healthDisclosed: true },
    );
    expect(result.merged).toBe(1);

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-4", region: "us", consent1: "in", consent2: "in" };
    expect(await service.recall(acctCtx)).toEqual([{ text: "shopper has a tree-nut allergy", class: "special" }]);

    // #125 — recall() above unions main+floor, so it would ALSO pass if merge had wrongly written the
    // special fact to the account's MAIN namespace. Assert directly, mirroring service-dedup.test.ts's
    // vector.list(...) pattern, that the merged row lands in the account's FLOOR namespace specifically —
    // and is ABSENT from the account's MAIN namespace.
    const destAnonId = accountSubjectId("acct-4");
    const floorListed = await vector.list(floorNamespace("acme", destAnonId), { limit: 10 });
    expect(floorListed).toHaveLength(1);
    const mainListed = await vector.list(subjectNamespace("acme", destAnonId), { limit: 10 });
    expect(mainListed).toHaveLength(0);
  });

  it("R2-2 — special facts are DROPPED when the GUEST did not opt in (consent2Source !== 'in'), even though the account did AND disclosure happened", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme"),
    });
    // Written under the GUEST's own consent2 "in" so the fact exists as a special-category row at all —
    // but the case under test is the MERGE-TIME consent2Source, which we deliberately pass as "unknown"
    // below (simulating a guest record that was never actually looked up as "in", e.g. a stale/incomplete
    // guest consent record) to prove R2-2's guest-side leg is independently load-bearing.
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-r22-source", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      { tenantId: "acme", anonId: "guest-r22-source", accountId: "acct-r22", consent2: "in", consent2Source: "unknown", healthDisclosed: true },
    );
    expect(result.merged).toBe(0); // dropped: the GUEST subject's own recorded consent2 was not "in"

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-r22", region: "us", consent1: "in", consent2: "in" };
    expect(await service.recall(acctCtx)).toEqual([]);
  });

  it("Q19(c) — special facts are DROPPED when healthDisclosed is false, even though both consent tiers are 'in'", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme"),
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-q19c", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      { tenantId: "acme", anonId: "guest-q19c", accountId: "acct-q19c", consent2: "in", consent2Source: "in", healthDisclosed: false },
    );
    expect(result.merged).toBe(0); // dropped: sign-in never named health-data carry-over

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-q19c", region: "us", consent1: "in", consent2: "in" };
    expect(await service.recall(acctCtx)).toEqual([]);
  });

  it("ordinary facts still carry regardless of the special-category compound gate (Art-6 vs Art-9 are independent)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free", "shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme"),
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-mixed", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    // All three special-category gates fail (account never opted in, guest never opted in, no
    // disclosure) — the ordinary fact must still migrate untouched.
    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      { tenantId: "acme", anonId: "guest-mixed", accountId: "acct-mixed", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
    );
    expect(result.merged).toBe(1); // ordinary only; the special row was dropped

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-mixed", region: "us", consent1: "in", consent2: "in" };
    expect(await service.recall(acctCtx)).toEqual([{ text: "prefers fragrance-free", class: "ordinary" }]);
  });

  it("emits a merge audit", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-audit", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctx, { message: "m", reply: "r" });

    await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      { tenantId: "acme", anonId: "guest-audit", accountId: "acct-5", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
    );

    const log = await runtimeStore.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("merge");
  });

  // F-8 (ADR-0019 Revision 2, task 7 — corrects C9's "the carry-over records only the SOURCE ref" gap).
  // An operator reading the immutable log must be able to tell WHICH ACCOUNT received a guest's facts,
  // not just which guest was read. Both refs must be the existing keyed-HMAC `subjectRef` — never a raw
  // id, never fact text.
  describe("F-8 — the merge audit carries BOTH the source (guest) and destination (account) subject refs", () => {
    it("a merge that moves facts records subjectRef (source) AND destSubjectRef (destination), both keyed-HMAC", async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: fixedDistiller(["prefers fragrance-free"]),
        enabled: true,
      });
      const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-f8", region: "us", consent1: "in", consent2: "unknown" };
      await service.remember(ctx, { message: "m", reply: "r" });

      await mergeGuestIntoAccount(
        { vector, audit: runtimeStore, hmacKey: "test-key" },
        { tenantId: "acme", anonId: "guest-f8", accountId: "acct-f8", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
      );

      const log = await runtimeStore.readAudit({ tenantId: "acme" });
      const mergeRow = log.find((r) => r.action === "merge");
      expect(mergeRow, "no merge audit row was written").toBeDefined();
      const input = mergeRow!.input as { subjectRef?: string; destSubjectRef?: string };
      expect(input.subjectRef).toBe(subjectRef("acme", "guest-f8", "test-key"));
      expect(input.destSubjectRef).toBe(subjectRef("acme", accountSubjectId("acct-f8"), "test-key"));
      expect(input.destSubjectRef).not.toBe(input.subjectRef);

      // Never the raw id or fact text, in either ref.
      const serialized = JSON.stringify(mergeRow);
      expect(serialized).not.toContain("guest-f8");
      expect(serialized).not.toContain("acct-f8");
      expect(serialized).not.toContain("fragrance-free");
    });

    it("a zero-move merge on an EMPTY guest namespace still audits — count 0, both refs present (C9: an unaudited cross-subject read)", async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();

      const result = await mergeGuestIntoAccount(
        { vector, audit: runtimeStore, hmacKey: "test-key" },
        { tenantId: "acme", anonId: "guest-empty", accountId: "acct-empty", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
      );
      expect(result.merged).toBe(0);

      const log = await runtimeStore.readAudit({ tenantId: "acme" });
      const mergeRow = log.find((r) => r.action === "merge");
      expect(mergeRow, "the empty-namespace read was an unaudited cross-subject read (C9)").toBeDefined();
      expect(mergeRow!.decision).toMatchObject({ count: 0 });
      const input = mergeRow!.input as { subjectRef?: string; destSubjectRef?: string };
      expect(input.subjectRef).toBe(subjectRef("acme", "guest-empty", "test-key"));
      expect(input.destSubjectRef).toBe(subjectRef("acme", accountSubjectId("acct-empty"), "test-key"));
    });

    it("a zero-move merge where every candidate is ALREADY HELD by the account still audits — count 0, both refs present", async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: fixedDistiller(["prefers fragrance-free"]),
        enabled: true,
      });
      const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-f8-dup", region: "us", consent1: "in", consent2: "unknown" };
      await service.remember(ctx, { message: "m", reply: "r" });

      const deps = { vector, audit: runtimeStore, hmacKey: "test-key" };
      const mergeCtx = { tenantId: "acme", anonId: "guest-f8-dup", accountId: "acct-f8-dup", consent2: "unknown" as const, consent2Source: "unknown" as const, healthDisclosed: false };
      await mergeGuestIntoAccount(deps, mergeCtx); // first call moves the fact

      const result = await mergeGuestIntoAccount(deps, mergeCtx); // second call: nothing new to move
      expect(result.merged).toBe(0);

      const log = await runtimeStore.readAudit({ tenantId: "acme" });
      const mergeRows = log.filter((r) => r.action === "merge");
      expect(mergeRows.length, "the second (no-op) call was an unaudited cross-subject read (C9)").toBe(2);
      const secondRow = mergeRows[1];
      expect(secondRow.decision).toMatchObject({ count: 0 });
      const input = secondRow.input as { subjectRef?: string; destSubjectRef?: string };
      expect(input.subjectRef).toBe(subjectRef("acme", "guest-f8-dup", "test-key"));
      expect(input.destSubjectRef).toBe(subjectRef("acme", accountSubjectId("acct-f8-dup"), "test-key"));
    });

    it("a zero-move merge where a special fact is DROPPED by Inv 9 still audits — count 0, both refs present", async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
        enabled: true,
        secrets: keyedSecrets("acme"),
      });
      const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-f8-special", region: "us", consent1: "in", consent2: "in" };
      await service.remember(ctx, { message: "m", reply: "r" });

      const result = await mergeGuestIntoAccount(
        { vector, audit: runtimeStore, hmacKey: "test-key" },
        { tenantId: "acme", anonId: "guest-f8-special", accountId: "acct-f8-special", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
      );
      expect(result.merged).toBe(0); // dropped, never promoted under sign-up ToS

      const log = await runtimeStore.readAudit({ tenantId: "acme" });
      const mergeRow = log.find((r) => r.action === "merge");
      expect(mergeRow, "the Inv-9-dropped read was an unaudited cross-subject read (C9)").toBeDefined();
      expect(mergeRow!.decision).toMatchObject({ count: 0 });
      const input = mergeRow!.input as { subjectRef?: string; destSubjectRef?: string };
      expect(input.subjectRef).toBe(subjectRef("acme", "guest-f8-special", "test-key"));
      expect(input.destSubjectRef).toBe(subjectRef("acme", accountSubjectId("acct-f8-special"), "test-key"));
      // Never the fact text, even though it was read and dropped.
      expect(JSON.stringify(mergeRow)).not.toContain("tree-nut");
    });
  });

  // Shopper-disposition program PR-8 — `SessionState.sessionDisposition` (widget-brain's TRANSIENT,
  // in-session style fallback) is EXCLUDED from this migration by construction: `mergeGuestIntoAccount`
  // only ever reads/writes DURABLE vector-store facts via `MergeCtx` (tenantId/anonId/accountId/consent2)
  // — there is no parameter, and no code path, through which a `SessionState` (let alone its
  // `sessionDisposition` field) could reach it. This proves that structurally, not just by omission: a
  // guest session that accumulated an in-session style disposition still migrates ONLY its durable facts.
  it("SessionState.sessionDisposition (widget-brain, transient) never migrates — merge only ever moves durable vector-store facts, never session state", async () => {
    // A guest session that observes a personaStyle this session (widget-brain, entirely independent of
    // widget-memory) — proves sessionDisposition is populated on the SESSION side of this scenario.
    const brain = createBrain(new MockModelAdapter(), undefined, undefined, undefined, "shopper-demo", undefined, false, true);
    const session = await createSession(brain);
    await session.send("what actives are in this?", { personaStyle: "researcher", cart: "empty" });
    expect(session.state.sessionDisposition).toEqual([{ axis: "style", value: "researcher", provenance: "observed", confidence: 1 }]);

    // Meanwhile, a DURABLE ordinary fact was separately remembered for the SAME conceptual guest —
    // merge.ts only ever knows about THIS, never the SessionState/sessionDisposition above (no shared
    // reference, no import, no parameter connects them).
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-session-disp", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      // Note: MergeCtx has NO field for sessionDisposition/SessionState at all — passing one is not even
      // expressible; this is the "reject-in-full" type-level version of the exclusion.
      { tenantId: "acme", anonId: "guest-session-disp", accountId: "acct-6", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
    );
    expect(result.merged).toBe(1); // only the durable fact migrated

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-6", region: "us", consent1: "in", consent2: "unknown" };
    const migrated = await service.recall(acctCtx);
    expect(migrated).toEqual([{ text: "prefers fragrance-free", class: "ordinary" }]);
    // No trace of the session-side style disposition anywhere in the migrated account data.
    expect(JSON.stringify(migrated)).not.toContain("researcher");
  });

  // N6 (LOW/latent, security review round 3) — `hmacKey` is optional on `MergeDeps` so tests above can
  // construct it without one, but this module has no production caller today; the day one is wired
  // (B12), silently omitting the key would degrade an `acct:` subject's audit ref to a brute-forceable
  // bare hash. `mergeGuestIntoAccount` must fail loudly outside a test runner instead.
  it("N6 — hmacKey is required outside a test runner: omitting it throws rather than silently degrading to a bare hash", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const originalVitest = process.env.VITEST;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        mergeGuestIntoAccount({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-n6", accountId: "acct-n6", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false }),
      ).rejects.toThrow(/hmacKey/);
    } finally {
      if (originalVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = originalVitest;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("N6 — supplying hmacKey works exactly as before, in or out of a test runner", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-n6b", region: "us", consent1: "in", consent2: "unknown" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore, hmacKey: "test-audit-key" },
      { tenantId: "acme", anonId: "guest-n6b", accountId: "acct-n6b", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
    );
    expect(result.merged).toBe(1);
  });
});

describe("merge — PAGINATED migration at scale (semantic-memory-v1 foundation, T2): a guest with >500 facts", () => {
  it(
    "mergeGuestIntoAccount migrates ALL 1500 guest facts into the account namespace — none dropped by " +
      "the old k=500 query cap",
    async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const anonNs = subjectNamespace("acme", "guest-1500-merge");
      const records = Array.from({ length: 1500 }, (_, i) => ({
        id: `g-${String(i).padStart(4, "0")}`,
        text: `fact ${i}`,
        metadata: { text: `fact ${i}`, class: "ordinary" as const },
      }));
      await vector.upsert(anonNs, records);

      const result = await mergeGuestIntoAccount(
        { vector, audit: runtimeStore },
        { tenantId: "acme", anonId: "guest-1500-merge", accountId: "acct-1500", consent2: "unknown", consent2Source: "unknown", healthDisclosed: false },
      );
      expect(result.merged).toBe(1500); // not capped at the old QUERY_LIMIT=500

      const acctNs = subjectNamespace("acme", accountSubjectId("acct-1500"));
      const acctRecords = await vector.query(acctNs, { text: "", k: 2000 });
      expect(acctRecords).toHaveLength(1500);
      expect(new Set(acctRecords.map((r) => r.id))).toEqual(new Set(records.map((r) => r.id))); // every guest id, none dropped

      // Copy-not-move (merge.ts's own header): the guest namespace is untouched.
      expect(await vector.query(anonNs, { text: "", k: 2000 })).toHaveLength(1500);
    },
  );
});

// §5 / security-review LOW-1: a throw between the two upserts must not swallow the audit — a partial
// write (facts already landed in the account main namespace) still has to be logged (NN#5), then rethrown.
describe("merge — partial-failure still audits (LOW-1)", () => {
  it("a throw during the FLOOR upsert records a merge audit for what landed, then rethrows", async () => {
    const base = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const acctFloorNs = floorNamespace("acme", accountSubjectId("acct-low1"));
    // A guest with one ordinary (main) + one special (floor) fact, so BOTH account upserts run.
    await base.upsert(subjectNamespace("acme", "g-low1"), [{ id: "ord", text: "t", metadata: { class: "ordinary", text: "t" } }]);
    await base.upsert(floorNamespace("acme", "g-low1"), [{ id: "spec", text: "h", metadata: { class: "special", text: "h" } }]);
    // Fail ONLY the account FLOOR upsert — the account MAIN upsert lands first, creating the partial state.
    const vector = {
      ...base,
      upsert: async (ns: string, recs: Parameters<typeof base.upsert>[1]) => {
        if (ns === acctFloorNs) throw new Error("floor upsert boom");
        return base.upsert(ns, recs);
      },
    };

    await expect(
      mergeGuestIntoAccount(
        { vector, audit: runtimeStore, hmacKey: "k" },
        { tenantId: "acme", anonId: "g-low1", accountId: "acct-low1", consent2: "in", consent2Source: "in", healthDisclosed: true },
      ),
    ).rejects.toThrow("floor upsert boom");

    // NN#5 — the merge audit row was still written on the failure path (the catch), exactly once.
    const mergeAudits = (await runtimeStore.readAudit({ tenantId: "acme" })).filter((r) => r.action === "merge");
    expect(mergeAudits).toHaveLength(1);
    // The ordinary fact really did land in the account main namespace before the floor upsert threw.
    expect(await base.query(subjectNamespace("acme", accountSubjectId("acct-low1")), { text: "", k: 10 })).toHaveLength(1);
  });
});
