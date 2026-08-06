import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore, createEnvSecrets, type SecretsPort } from "@palup/platform-ports";
import { createBrain, createSession, MockModelAdapter } from "@palup/widget-brain";
import { createMemoryService } from "../src/service.js";
import { mergeGuestIntoAccount } from "../src/merge.js";
import { subjectNamespace } from "../src/identity.js";
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
      { tenantId: "acme", anonId: "guest-merge", accountId: "acct-1", consent2: "unknown" },
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
    const mergeCtx = { tenantId: "acme", anonId: "guest-twice", accountId: "acct-2", consent2: "unknown" as const };

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

    const result = await mergeGuestIntoAccount(
      { vector, audit: runtimeStore },
      { tenantId: "acme", anonId: "guest-special", accountId: "acct-3", consent2: "unknown" },
    );
    expect(result.merged).toBe(0); // dropped, never promoted under sign-up ToS

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-3", region: "us", consent1: "in", consent2: "in" };
    expect(await service.recall(acctCtx)).toEqual([]);
  });

  it("special facts DO migrate when Consent 2 is explicitly granted for the account", async () => {
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
      { tenantId: "acme", anonId: "guest-special-in", accountId: "acct-4", consent2: "in" },
    );
    expect(result.merged).toBe(1);

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-4", region: "us", consent1: "in", consent2: "in" };
    expect(await service.recall(acctCtx)).toEqual([{ text: "shopper has a tree-nut allergy", class: "special" }]);
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
      { tenantId: "acme", anonId: "guest-audit", accountId: "acct-5", consent2: "unknown" },
    );

    const log = await runtimeStore.readAudit({ tenantId: "acme" });
    expect(log.map((r) => r.action)).toContain("merge");
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
      { tenantId: "acme", anonId: "guest-session-disp", accountId: "acct-6", consent2: "unknown" },
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
        mergeGuestIntoAccount({ vector, audit: runtimeStore }, { tenantId: "acme", anonId: "guest-n6", accountId: "acct-n6", consent2: "unknown" }),
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
      { tenantId: "acme", anonId: "guest-n6b", accountId: "acct-n6b", consent2: "unknown" },
    );
    expect(result.merged).toBe(1);
  });
});
