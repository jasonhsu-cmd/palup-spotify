import { describe, it, expect, vi } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore, type VectorPort } from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// ADR-0015 PR A (T7): the memory service wires flag -> consent -> classifier -> distiller -> vector
// port + audit. The headline property is INERTNESS while the double gate is off (which it always is in
// this PR — MEMORY_ADR_ACCEPTED is hardcoded false, flag.ts). Everything else here proves the wiring is
// correct so a LATER PR that flips the flag doesn't have to relearn these invariants.

function spyVector(): VectorPort & {
  upsert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  deleteById: ReturnType<typeof vi.fn>;
  deleteNamespace: ReturnType<typeof vi.fn>;
} {
  return {
    upsert: vi.fn(async () => {}),
    query: vi.fn(async () => []),
    deleteById: vi.fn(async () => {}),
    deleteNamespace: vi.fn(async () => {}),
  };
}

function fixedDistiller(facts: string[]): FactDistiller {
  return { distill: vi.fn(async () => facts) };
}

describe("createMemoryService — INERT while the double gate is off (headline property)", () => {
  it("enabled:false → touches NOTHING: no vector calls at all, no audit, remember/recall no-op", async () => {
    const vector = spyVector();
    const runtimeStore = new InMemoryRuntimeStore();
    const auditSpy = vi.spyOn(runtimeStore, "audit");
    const distiller = fixedDistiller(["prefers fragrance-free"]);

    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: false });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-1", region: "us", consent1: "in", consent2: "in" };

    expect(await service.remember(ctx, { message: "I love fragrance-free stuff", reply: "Great!" })).toEqual({
      written: [],
    });
    expect(await service.recall(ctx)).toEqual([]);

    expect(vector.upsert).not.toHaveBeenCalled();
    expect(vector.query).not.toHaveBeenCalled();
    expect(vector.deleteById).not.toHaveBeenCalled();
    expect(vector.deleteNamespace).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("defaults to disabled with NO `enabled` override at all (ADR-0015 not yet Accepted, flag.ts double gate)", async () => {
    const vector = spyVector();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["prefers fragrance-free"]);
    // No `enabled` key passed — falls back to isMemoryEnabled(), which is always false in this PR.
    const service = createMemoryService({ vector, audit: runtimeStore, distiller });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-default", region: "us", consent1: "in", consent2: "in" };

    expect(await service.remember(ctx, { message: "m", reply: "r" })).toEqual({ written: [] });
    expect(vector.upsert).not.toHaveBeenCalled();
  });
});

describe("createMemoryService — consent gating (enabled:true, for wiring correctness ahead of go-live)", () => {
  it("eu region + consent1 unknown → writes nothing; recall stays empty (fail closed)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["prefers fragrance-free"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-eu", region: "eu", consent1: "unknown", consent2: "unknown" };

    expect(await service.remember(ctx, { message: "I love fragrance-free stuff", reply: "Great!" })).toEqual({
      written: [],
    });
    expect(await service.recall(ctx)).toEqual([]);
  });

  it("us region + ordinary consent → fact written and recalled; stored text is DISTILLED, not the raw message", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["prefers fragrance-free"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme", anonId: "guest-us", region: "us", consent1: "in", consent2: "unknown" };

    const result = await service.remember(ctx, { message: "the actual raw shopper message", reply: "ok" });
    expect(result.written).toEqual(["ordinary"]);

    const recalled = await service.recall(ctx);
    expect(recalled).toEqual([{ text: "prefers fragrance-free", class: "ordinary" }]);
    expect(recalled[0]!.text).not.toBe("the actual raw shopper message");
  });

  it("special-category fact requires Consent 2, INDEPENDENTLY of Consent 1 (ordinary consent alone is not enough)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["shopper has a tree-nut allergy"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true });

    const consented: MemoryCtx = { tenantId: "acme", anonId: "guest-a", region: "us", consent1: "in", consent2: "in" };
    const written = await service.remember(consented, { message: "m", reply: "r" });
    expect(written.written).toEqual(["special"]);
    expect(await service.recall(consented)).toEqual([{ text: "shopper has a tree-nut allergy", class: "special" }]);

    const notConsented: MemoryCtx = {
      tenantId: "acme",
      anonId: "guest-b",
      region: "us",
      consent1: "in",
      consent2: "unknown",
    };
    const skipped = await service.remember(notConsented, { message: "m", reply: "r" });
    expect(skipped.written).toEqual([]);
    expect(await service.recall(notConsented)).toEqual([]);
  });

  it("tenant isolation — tenant A's fact is never recalled by tenant B, even with the same anonId", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["prefers fragrance-free"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true });

    const ctxA: MemoryCtx = { tenantId: "tenant-a", anonId: "shared-anon", region: "us", consent1: "in", consent2: "unknown" };
    const ctxB: MemoryCtx = { tenantId: "tenant-b", anonId: "shared-anon", region: "us", consent1: "in", consent2: "unknown" };

    await service.remember(ctxA, { message: "m", reply: "r" });
    expect(await service.recall(ctxA)).toHaveLength(1);
    expect(await service.recall(ctxB)).toEqual([]);
  });
});

describe("createMemoryService — audit (Inv 6: no silent memory action)", () => {
  it("an ordinary write emits write.ordinary (and only write.ordinary)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["prefers fragrance-free"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-ord", anonId: "guest-o", region: "us", consent1: "in", consent2: "unknown" };

    await service.remember(ctx, { message: "m", reply: "r" });
    const log = await runtimeStore.readAudit({ tenantId: "acme-ord" });
    expect(log.map((r) => r.action)).toEqual(["write.ordinary"]);
  });

  it("a special write emits write.special, and recall emits recall", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["shopper has a tree-nut allergy"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-special", anonId: "guest-s", region: "us", consent1: "in", consent2: "in" };

    await service.remember(ctx, { message: "m", reply: "r" });
    await service.recall(ctx);

    const actions = (await runtimeStore.readAudit({ tenantId: "acme-special" })).map((r) => r.action);
    expect(actions).toContain("write.special");
    expect(actions).toContain("recall");
  });

  it("no fact TEXT or raw anonId ever lands in an audit record", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["shopper has a tree-nut allergy"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true });
    const ctx: MemoryCtx = {
      tenantId: "acme-pii",
      anonId: "super-secret-anon-id",
      region: "us",
      consent1: "in",
      consent2: "in",
    };

    await service.remember(ctx, { message: "m", reply: "r" });
    const log = await runtimeStore.readAudit({ tenantId: "acme-pii" });
    const serialized = JSON.stringify(log).toLowerCase();
    expect(serialized).not.toContain("super-secret-anon-id");
    expect(serialized).not.toContain("tree-nut");
  });
});
