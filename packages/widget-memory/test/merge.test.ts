import { describe, it, expect } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore } from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { mergeGuestIntoAccount } from "../src/merge.js";
import { subjectNamespace } from "../src/identity.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// ADR-0015 Tier 2 (Decision: "Signed-up" bullet) + Invariant 9: guest -> account merge is a ONE-TIME,
// AUDITED migration; special-category facts are NEVER auto-folded into the account's sign-up ToS — they
// migrate ONLY when Consent 2 is separately granted for the account, otherwise dropped.

function fixedDistiller(facts: string[]): FactDistiller {
  return { async distill() { return facts; } };
}

describe("merge — mergeGuestIntoAccount", () => {
  it("moves ordinary facts anon -> account and fully empties the anon namespace (one-time migration)", async () => {
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
    expect(anonMatches).toEqual([]);

    const acctCtx: MemoryCtx = { tenantId: "acme", anonId: "acct:acct-1", region: "us", consent1: "in", consent2: "unknown" };
    expect(await service.recall(acctCtx)).toEqual([{ text: "prefers fragrance-free", class: "ordinary" }]);
  });

  it("a second merge for the same anonId is a no-op (anon already gone) — no double-count", async () => {
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
});
