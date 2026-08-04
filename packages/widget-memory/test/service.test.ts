import { describe, it, expect, vi } from "vitest";
import {
  createInMemoryVectorStore,
  InMemoryRuntimeStore,
  createEnvSecrets,
  type VectorPort,
  type SecretsPort,
  type CryptoPort,
} from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import { subjectNamespace } from "../src/identity.js";
import { withdrawConsent2 } from "../src/erasure.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// ADR-0015 Inv 9 (go-live blocker #2 — encryption at rest for special-category facts): most tests below
// that write a SPECIAL-category fact via `service.remember` need a configured encryption key, because a
// special-category write is now REFUSED (fail closed) without one — see the dedicated "encryption at
// rest" describe block near the bottom of this file for the tests that exercise that gate directly.
// `keyedSecrets` provisions one `MEMORY_ENCRYPTION_KEY` per tenant id, mirroring how a real deployment
// would provision it (SecretsPort, ADR-0001) — never a hardcoded/global key.
function keyedSecrets(...tenantIds: string[]): SecretsPort {
  const byTenant: Record<string, Record<string, string>> = {};
  for (const t of tenantIds) byTenant[t] = { MEMORY_ENCRYPTION_KEY: `test-key-for-${t}` };
  return createEnvSecrets(JSON.stringify(byTenant));
}

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
  // PR-8: FactDistiller.distill() returns candidate OBJECTS ({text, disposition?}), not bare strings —
  // none of these fixed fixtures carry a disposition.
  return { distill: vi.fn(async () => facts.map((text) => ({ text }))) };
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
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true, secrets: keyedSecrets("acme") });

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
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true, secrets: keyedSecrets("acme-special") });
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
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true, secrets: keyedSecrets("acme-pii") });
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

describe("createMemoryService — the enabled override is a TEST SEAM, not a production bypass (NN#1)", () => {
  it("in production (no test env), deps.enabled:true does NOT bypass the double gate — stays inert", async () => {
    const orig = { v: process.env.VITEST, n: process.env.NODE_ENV };
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    try {
      const vector = spyVector();
      const runtimeStore = new InMemoryRuntimeStore();
      const auditSpy = vi.spyOn(runtimeStore, "audit");
      const service = createMemoryService({ vector, audit: runtimeStore, distiller: fixedDistiller(["x"]), enabled: true });
      const ctx: MemoryCtx = { tenantId: "acme", anonId: "g", region: "us", consent1: "in", consent2: "in" };
      await service.remember(ctx, { message: "a", reply: "b" });
      // MEMORY_ADR_ACCEPTED is hardcoded false, so despite enabled:true the service is inert in prod.
      expect(vector.upsert).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    } finally {
      if (orig.v === undefined) delete process.env.VITEST;
      else process.env.VITEST = orig.v;
      process.env.NODE_ENV = orig.n as string;
    }
  });
});

describe("createMemoryService — per-class TTL (Inv 4; legal 2026: ordinary and special share the 30d window)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("BOTH classes expire together on read after the shared 30d window (no intervening recall to slide them)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["prefers fragrance-free", "allergic to tree nuts"]);
    let nowMs = new Date("2026-01-01T00:00:00Z").getTime();
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true, clock: () => new Date(nowMs), secrets: keyedSecrets("acme-ttl") });
    const ctx: MemoryCtx = { tenantId: "acme-ttl", anonId: "guest-ttl", region: "us", consent1: "in", consent2: "in" };

    const w = await service.remember(ctx, { message: "...", reply: "..." });
    expect(w.written).toContain("ordinary");
    expect(w.written).toContain("special");

    // day 35 with NO intervening recall (so nothing slid the window): both are past the shared 30d TTL.
    nowMs += 35 * DAY;
    const texts = (await service.recall(ctx)).map((f) => f.text);
    expect(texts).not.toContain("prefers fragrance-free"); // ordinary expired at 30d
    expect(texts).not.toContain("allergic to tree nuts"); // special expired at the SAME 30d (no longer earlier)
    expect(texts).toEqual([]);
  });

  it("a return visit before expiry slides BOTH classes forward, so they survive past their original 30d", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["prefers fragrance-free", "allergic to tree nuts"]);
    let nowMs = new Date("2026-01-01T00:00:00Z").getTime();
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true, clock: () => new Date(nowMs), secrets: keyedSecrets("acme-ttl") });
    const ctx: MemoryCtx = { tenantId: "acme-ttl", anonId: "guest-ttl2", region: "us", consent1: "in", consent2: "in" };

    await service.remember(ctx, { message: "...", reply: "..." });

    // day 25 return → both consented facts slide to day 25 + 30 = day 55.
    nowMs += 25 * DAY;
    expect((await service.recall(ctx)).length).toBe(2);

    // day 45 — past the ORIGINAL 30d expiry, but the day-25 return pushed both to day 55, so both survive.
    nowMs += 20 * DAY;
    const texts = (await service.recall(ctx)).map((f) => f.text);
    expect(texts).toContain("prefers fragrance-free");
    expect(texts).toContain("allergic to tree nuts");
  });
});

describe("createMemoryService — encryption at rest (ADR-0015 Inv 9, go-live blocker #2)", () => {
  function noopDistiller(): FactDistiller {
    return { async distill() { return []; } };
  }

  it("a special-category fact is unreadable in the raw store (neither the fact text nor the sourceQuote appear in it), yet round-trips exactly through recall", async () => {
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert"); // captures the EXACT VectorRecord[] handed to the port
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller: FactDistiller = {
      async distill() {
        return [
          {
            text: "shopper has a tree-nut allergy",
            disposition: {
              axis: "communication",
              value: "direct",
              provenance: "stated",
              confidence: 0.9,
              sourceQuote: "I definitely have a nut allergy",
            },
          },
        ];
      },
    };
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller,
      enabled: true,
      secrets: keyedSecrets("acme-enc"),
    });
    const ctx: MemoryCtx = { tenantId: "acme-enc", anonId: "guest-enc", region: "us", consent1: "in", consent2: "in" };

    const written = await service.remember(ctx, { message: "m", reply: "r" });
    expect(written.written).toEqual(["special"]);

    // Inspect the RAW stored record directly via the vector port — bypassing the service entirely, the
    // way a DBA/disk-snapshot/log-shipping path (the exact threat the durable Postgres adapter's own
    // go-live-gap note flagged) would see it.
    const raw = await vector.query(subjectNamespace("acme-enc", "guest-enc"), { text: "", k: 10 });
    expect(raw).toHaveLength(1);
    const rawStr = JSON.stringify(raw);
    expect(rawStr).not.toContain("tree-nut");
    expect(rawStr).not.toContain("allergy");
    expect(rawStr).not.toContain("nut allergy");
    expect(rawStr).not.toContain("I definitely");
    expect(raw[0]?.metadata?.encrypted).toBe(true); // marked, not inferred from shape

    // The vector record's OWN top-level `text` field (not just `metadata.text`) is ciphertext too —
    // `VectorMatch` (what `query()` returns) doesn't surface `text` at all, so assert on the EXACT
    // `VectorRecord[]` the service actually handed to `upsert()`.
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const upserted = upsertSpy.mock.calls[0]?.[1] as Array<{ text?: string }>;
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.text).not.toBe("shopper has a tree-nut allergy");
    expect(upserted[0]?.text).not.toContain("tree-nut");

    const recalled = await service.recall(ctx);
    expect(recalled).toEqual([
      {
        text: "shopper has a tree-nut allergy",
        class: "special",
        disposition: [
          {
            axis: "communication",
            value: "direct",
            provenance: "stated",
            confidence: 0.9,
            sourceQuote: "I definitely have a nut allergy",
          },
        ],
      },
    ]);
  });

  it("no key + memory live ⇒ special-category write is REFUSED: dropped, no plaintext anywhere, and no write.special audit — but a PII-free write.refused audit IS emitted (security review finding 6)", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller = fixedDistiller(["shopper has a tree-nut allergy"]);
    // No `secrets`/`crypto` deps supplied at all — defaults to `createEnvSecrets()` (unset PALUP_SECRETS
    // for this never-used-elsewhere tenant id), i.e. the real "nothing provisioned yet" production state.
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-nokey", anonId: "guest-nokey", region: "us", consent1: "in", consent2: "in" };

    const result = await service.remember(ctx, { message: "m", reply: "r" });
    expect(result.written).toEqual([]); // refused — never silently downgraded to a plaintext write

    expect(await service.recall(ctx)).toEqual([]);
    const raw = await vector.query(subjectNamespace("acme-nokey", "guest-nokey"), { text: "", k: 10 });
    expect(raw).toEqual([]); // nothing persisted at all — not even a plaintext fallback

    const log = await runtimeStore.readAudit({ tenantId: "acme-nokey" });
    expect(log.map((r) => r.action)).not.toContain("write.special");
    // Security review finding 6: the refusal is NOT silent — an operator can see "memory is live, consent
    // was given, and nothing is being stored because no key is provisioned" via a PII-free audit record.
    const refusal = log.find((r) => r.action === "write.refused");
    expect(refusal).toBeDefined();
    expect(refusal?.decision).toMatchObject({ class: "special", count: 1 });
    expect(JSON.stringify(log)).not.toContain("tree-nut"); // still never any fact text in the log
  });

  it("an undecryptable/corrupt encrypted record is dropped on recall, never thrown", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const ns = subjectNamespace("acme-corrupt", "guest-corrupt");
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    await vector.upsert(ns, [
      {
        id: "corrupt-1",
        text: "v1:bm90:cmVhbGx5:bm90LWEtcmVhbC1lbnZlbG9wZQ==", // well-formed SHAPE, wrong key/tampered content
        metadata: {
          text: "v1:bm90:cmVhbGx5:bm90LWEtcmVhbC1lbnZlbG9wZQ==",
          class: "special",
          expiresAt: future,
          encrypted: true, // marked encrypted — recall MUST attempt decryption, not pass it through
        },
      },
    ]);

    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: noopDistiller(),
      enabled: true,
      secrets: keyedSecrets("acme-corrupt"),
    });
    const ctx: MemoryCtx = { tenantId: "acme-corrupt", anonId: "guest-corrupt", region: "us", consent1: "in", consent2: "in" };

    await expect(service.recall(ctx)).resolves.toEqual([]); // dropped, NOT thrown — never crashes the turn
  });

  it("ordinary facts: encrypted opportunistically when a key exists (round trips); falls back to plaintext when no key is configured (documented trade-off, unchanged pre-encryption behavior)", async () => {
    // WITH a key: ordinary text is ALSO encrypted at rest (defense in depth — Inv 9 only mandates it for
    // special-category, but nothing stops applying it to ordinary too when a key is already available).
    const vectorA = createInMemoryVectorStore();
    const svcA = createMemoryService({
      vector: vectorA,
      audit: new InMemoryRuntimeStore(),
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
      secrets: keyedSecrets("acme-ord-enc"),
    });
    const ctxA: MemoryCtx = { tenantId: "acme-ord-enc", anonId: "guest-a", region: "us", consent1: "in", consent2: "unknown" };
    await svcA.remember(ctxA, { message: "m", reply: "r" });
    const rawA = await vectorA.query(subjectNamespace("acme-ord-enc", "guest-a"), { text: "", k: 10 });
    expect(rawA[0]?.metadata?.encrypted).toBe(true);
    expect(JSON.stringify(rawA)).not.toContain("fragrance-free");
    expect(await svcA.recall(ctxA)).toEqual([{ text: "prefers fragrance-free", class: "ordinary" }]);

    // WITHOUT a key: ordinary text falls back to plaintext — NEVER refused (byte-identical to the
    // pre-encryption behavior this package always had for ordinary facts).
    const vectorB = createInMemoryVectorStore();
    const svcB = createMemoryService({
      vector: vectorB,
      audit: new InMemoryRuntimeStore(),
      distiller: fixedDistiller(["prefers fragrance-free"]),
      enabled: true,
    });
    const ctxB: MemoryCtx = { tenantId: "acme-ord-nokey", anonId: "guest-b", region: "us", consent1: "in", consent2: "unknown" };
    const written = await svcB.remember(ctxB, { message: "m", reply: "r" });
    expect(written.written).toEqual(["ordinary"]); // never refused, unlike special-category

    const rawB = await vectorB.query(subjectNamespace("acme-ord-nokey", "guest-b"), { text: "", k: 10 });
    expect(rawB[0]?.metadata?.encrypted).toBe(false);
    expect(rawB[0]?.metadata?.text).toBe("prefers fragrance-free"); // plaintext, unchanged from pre-encryption behavior
    expect(await svcB.recall(ctxB)).toEqual([{ text: "prefers fragrance-free", class: "ordinary" }]);
  });

  it("security review finding 1 — disposition.value is ALSO encrypted on the special-category path, not just text/sourceQuote", async () => {
    const vector = createInMemoryVectorStore();
    const upsertSpy = vi.spyOn(vector, "upsert");
    const runtimeStore = new InMemoryRuntimeStore();
    const distiller: FactDistiller = {
      async distill() {
        return [
          {
            text: "shopper has a tree-nut allergy",
            disposition: { axis: "role", value: "gift", provenance: "stated", confidence: 0.9, sourceQuote: "it's a gift for my nut-allergic friend" },
          },
        ];
      },
    };
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true, secrets: keyedSecrets("acme-dispval") });
    const ctx: MemoryCtx = { tenantId: "acme-dispval", anonId: "guest-dispval", region: "us", consent1: "in", consent2: "in" };

    await service.remember(ctx, { message: "m", reply: "r" });

    const raw = await vector.query(subjectNamespace("acme-dispval", "guest-dispval"), { text: "", k: 10 });
    expect(raw[0]?.metadata?.encrypted).toBe(true);
    // The raw stored disposition.value must NOT be the plaintext "gift" — it's a CryptoPort envelope.
    const upserted = upsertSpy.mock.calls[0]?.[1] as Array<{ metadata?: { disposition?: Array<{ value?: string }> } }>;
    const rawValue = upserted?.[0]?.metadata?.disposition?.[0]?.value;
    expect(rawValue).toBeDefined();
    expect(rawValue).not.toBe("gift");
    expect(rawValue).toMatch(/^v1:/); // a real envelope, not just a differently-cased string

    const recalled = await service.recall(ctx);
    expect(recalled[0]?.disposition).toEqual([
      { axis: "role", value: "gift", provenance: "stated", confidence: 0.9, sourceQuote: "it's a gift for my nut-allergic friend" },
    ]);
  });

  describe("re-review fixes — Inv 11 applies to the quote, and no refusal is silent", () => {
    it("Inv 11 narrow-only: a tenant that dropped the quote's category does NOT get the candidate persisted as special", async () => {
      // The quote ("I'm on tretinoin...") classifies special via health_reaction; the FACT alone is
      // ordinary. Taking only the quote's CLASS and ignoring its `remember` flag would persist a
      // category this tenant explicitly narrowed out — just because it rode in on a sourceQuote.
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const distiller: FactDistiller = {
        async distill() {
          return [{ text: "prefers fragrance-free", disposition: { axis: "style", value: "researcher", provenance: "observed", confidence: 0.8, sourceQuote: "I'm on tretinoin so I need fragrance-free" } }];
        },
      };
      const service = createMemoryService({ vector, audit: runtimeStore, distiller, enabled: true, secrets: keyedSecrets("acme-inv11") });
      const ctx: MemoryCtx = {
        tenantId: "acme-inv11", anonId: "g-inv11", region: "us", consent1: "in", consent2: "in",
        tenantPolicy: { dropCategories: ["health_reaction"] },
      };

      const res = await service.remember(ctx, { message: "m", reply: "r" });
      expect(res.written).toEqual([]); // narrowed out by the tenant's own policy
      expect(await service.recall(ctx)).toEqual([]);
      const actions = (await runtimeStore.readAudit({ tenantId: "acme-inv11" })).map((r) => r.action);
      expect(actions).not.toContain("write.special");
      expect(actions).not.toContain("write.ordinary");
    });

    it("an ORDINARY candidate refused by an encryption failure is not silent either — write.refused{class:ordinary}", async () => {
      // The ordinary refusal path needs the FACT TEXT to encrypt successfully while an AUXILIARY field
      // fails — a partially-failing adapter, the realistic shape once a KMS adapter lands. (A wholly
      // unavailable key is NOT this case: ordinary encryption is best-effort, so it just falls back to
      // plaintext and the fact is still written.) The candidate is then discarded to avoid a
      // half-encrypted record — and that discard must be visible to an operator.
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      let calls = 0;
      const flakyCrypto = {
        async encrypt(_t: string, plaintext: string) {
          calls++;
          if (calls === 1) return `enc(${plaintext})`; // the fact text encrypts fine...
          throw new Error("kms unavailable"); // ...the disposition value does not
        },
        async decrypt() { return undefined; },
      };
      const distiller: FactDistiller = {
        async distill() {
          return [{ text: "prefers fragrance-free", disposition: { axis: "style", value: "researcher", provenance: "observed", confidence: 0.8 } }];
        },
      };
      const service = createMemoryService({
        vector, audit: runtimeStore, distiller, enabled: true,
        secrets: keyedSecrets("acme-ordref"), crypto: flakyCrypto as never,
      });
      const ctx: MemoryCtx = { tenantId: "acme-ordref", anonId: "g-ordref", region: "us", consent1: "in", consent2: "unknown" };

      const res = await service.remember(ctx, { message: "m", reply: "r" });
      expect(res.written).toEqual([]); // dropped rather than persisted half-encrypted
      const log = await runtimeStore.readAudit({ tenantId: "acme-ordref" });
      const refusal = log.find((r) => r.action === "write.refused");
      expect(refusal).toBeDefined(); // previously entirely silent
      expect((refusal!.decision as { class?: string }).class).toBe("ordinary");
    });

    it("an undecryptable record is not silently lost — recall emits a PII-free recall.dropped audit (rotation damage is detectable)", async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const namespace = subjectNamespace("acme-drop", "g-drop");
      // A record marked encrypted whose ciphertext cannot be decrypted (the shape a key rotated without
      // keeping `_previous` produces).
      await vector.upsert(namespace, [
        { id: "r1", text: "v1:deadbeef:AAAA:BBBB:CCCC", metadata: { text: "v1:deadbeef:AAAA:BBBB:CCCC", class: "ordinary", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), encrypted: true } },
      ]);
      const service = createMemoryService({ vector, audit: runtimeStore, distiller: noopDistiller(), enabled: true, secrets: keyedSecrets("acme-drop") });
      const ctx: MemoryCtx = { tenantId: "acme-drop", anonId: "g-drop", region: "us", consent1: "in", consent2: "in" };

      expect(await service.recall(ctx)).toEqual([]); // dropped, never surfaced as garbage
      const log = await runtimeStore.readAudit({ tenantId: "acme-drop" });
      const dropped = log.find((r) => r.action === "recall.dropped");
      expect(dropped).toBeDefined();
      expect((dropped!.decision as { count?: number }).count).toBe(1);
      expect(JSON.stringify(log)).not.toContain("g-drop"); // PII-free: raw anonId never in the log
    });
  });

  describe("security review finding 2 — an unclassified sourceQuote riding an ordinary fact is treated as special end-to-end", () => {
    const ordinaryFactWithArt9Quote: FactDistiller = {
      async distill() {
        return [
          {
            text: "prefers fragrance-free",
            disposition: {
              axis: "style",
              value: "needs_guidance",
              provenance: "stated",
              confidence: 0.9,
              // Art-9 per classifier.ts's medication terms ("tretinoin"/"prescription"), even though the
              // FACT text alone ("prefers fragrance-free") classifies ordinary.
              sourceQuote: "I'm on tretinoin so I need fragrance-free",
            },
          },
        ];
      },
    };

    it("requires Consent 2 (NOT just Consent 1) — Consent 1 alone is not enough to write it", async () => {
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const service = createMemoryService({
        vector,
        audit: runtimeStore,
        distiller: ordinaryFactWithArt9Quote,
        enabled: true,
        secrets: keyedSecrets("acme-q2"),
      });
      const ctx: MemoryCtx = { tenantId: "acme-q2", anonId: "guest-q2", region: "us", consent1: "in", consent2: "unknown" };

      const result = await service.remember(ctx, { message: "m", reply: "r" });
      expect(result.written).toEqual([]); // refused — Consent 1 alone does not cover a special-classed candidate
      expect(await service.recall(ctx)).toEqual([]);
      const log = await runtimeStore.readAudit({ tenantId: "acme-q2" });
      expect(log.map((r) => r.action)).not.toContain("write.ordinary");
      expect(log.map((r) => r.action)).not.toContain("write.special");
    });

    it("with Consent 2 granted: written+audited as SPECIAL, encrypted fail-closed (refused with no key), and stored with class:\"special\"", async () => {
      // No key configured — the candidate must be REFUSED (fail-closed), not silently written ordinary
      // or in the clear, exactly like any other special-category candidate with no key.
      const vector = createInMemoryVectorStore();
      const runtimeStore = new InMemoryRuntimeStore();
      const service = createMemoryService({ vector, audit: runtimeStore, distiller: ordinaryFactWithArt9Quote, enabled: true });
      const ctx: MemoryCtx = { tenantId: "acme-q2-nokey", anonId: "guest-q2-nokey", region: "us", consent1: "in", consent2: "in" };

      const result = await service.remember(ctx, { message: "m", reply: "r" });
      expect(result.written).toEqual([]); // refused fail-closed, not silently downgraded to ordinary/plaintext
      const raw = await vector.query(subjectNamespace("acme-q2-nokey", "guest-q2-nokey"), { text: "", k: 10 });
      expect(raw).toEqual([]);
      const log = await runtimeStore.readAudit({ tenantId: "acme-q2-nokey" });
      expect(log.map((r) => r.action)).toContain("write.refused"); // audited as a SPECIAL refusal
      const refusal = log.find((r) => r.action === "write.refused");
      expect(refusal?.decision).toMatchObject({ class: "special" });

      // Now WITH a key configured: written+audited as special, encrypted, and the record's stored class
      // really is "special" — not "ordinary" (the fact text alone would have classified as).
      const vectorB = createInMemoryVectorStore();
      const runtimeStoreB = new InMemoryRuntimeStore();
      const serviceB = createMemoryService({
        vector: vectorB,
        audit: runtimeStoreB,
        distiller: ordinaryFactWithArt9Quote,
        enabled: true,
        secrets: keyedSecrets("acme-q2-keyed"),
      });
      const ctxB: MemoryCtx = { tenantId: "acme-q2-keyed", anonId: "guest-q2-keyed", region: "us", consent1: "in", consent2: "in" };
      const resultB = await serviceB.remember(ctxB, { message: "m", reply: "r" });
      expect(resultB.written).toEqual(["special"]); // NOT "ordinary"

      const rawB = await vectorB.query(subjectNamespace("acme-q2-keyed", "guest-q2-keyed"), { text: "", k: 10 });
      expect(rawB[0]?.metadata?.class).toBe("special");
      expect(rawB[0]?.metadata?.encrypted).toBe(true);
      expect(JSON.stringify(rawB)).not.toContain("tretinoin");
      expect(JSON.stringify(rawB)).not.toContain("fragrance-free");

      const logB = await runtimeStoreB.readAudit({ tenantId: "acme-q2-keyed" });
      expect(logB.map((r) => r.action)).toContain("write.special");
      expect(logB.map((r) => r.action)).not.toContain("write.ordinary");

      // Recall returns it as class:"special" (round-trips cleanly through decryption).
      const recalled = await serviceB.recall(ctxB);
      expect(recalled).toEqual([
        {
          text: "prefers fragrance-free",
          class: "special",
          disposition: [
            { axis: "style", value: "needs_guidance", provenance: "stated", confidence: 0.9, sourceQuote: "I'm on tretinoin so I need fragrance-free" },
          ],
        },
      ]);

      // Purged by the Consent-2 withdrawal/erasure path (erasure.ts filters on class === "special") —
      // proving the record is REALLY governed as special, not just labeled that way superficially.
      const purge = await withdrawConsent2({ vector: vectorB, audit: runtimeStoreB }, { tenantId: "acme-q2-keyed", anonId: "guest-q2-keyed" });
      expect(purge.purged).toBe(1);
      expect(await serviceB.recall(ctxB)).toEqual([]);
    });
  });

  it("security review finding 4 — a ciphertext relocated onto a DIFFERENT record's text field is dropped on recall, not served", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      enabled: true,
      secrets: keyedSecrets("acme-relocate"),
    });
    const ctx: MemoryCtx = { tenantId: "acme-relocate", anonId: "guest-relocate", region: "us", consent1: "in", consent2: "in" };
    await service.remember(ctx, { message: "m", reply: "r" });

    const ns = subjectNamespace("acme-relocate", "guest-relocate");
    const raw = await vector.query(ns, { text: "", k: 10 });
    expect(raw).toHaveLength(1);
    const stolenCiphertext = (raw[0]!.metadata as { text: string }).text;

    // Simulate an actor with store write access relocating the ciphertext onto a DIFFERENT record id in
    // the SAME namespace (same tenant, so the key derivation alone would not stop this).
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    await vector.upsert(ns, [
      {
        id: "a-different-record-id",
        text: stolenCiphertext,
        metadata: { text: stolenCiphertext, class: "special", expiresAt: future, encrypted: true },
      },
    ]);

    const recalled = await service.recall(ctx);
    // Exactly one fact recalled: the ORIGINAL record. The relocated copy fails aad-bound authentication
    // and is dropped, never served under its new (wrong) record identity.
    expect(recalled).toEqual([{ text: "shopper has a tree-nut allergy", class: "special" }]);
  });

  it("INERT (memory off): even with a configured key, encrypt/decrypt are NEVER called — nothing touched", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const cryptoSpy: CryptoPort = {
      encrypt: vi.fn(async () => "ciphertext-should-never-be-called"),
      decrypt: vi.fn(async () => "plaintext-should-never-be-called"),
    };
    const service = createMemoryService({
      vector,
      audit: runtimeStore,
      distiller: fixedDistiller(["shopper has a tree-nut allergy"]),
      secrets: keyedSecrets("acme-inert"),
      crypto: cryptoSpy,
      enabled: false,
    });
    const ctx: MemoryCtx = { tenantId: "acme-inert", anonId: "guest-inert", region: "us", consent1: "in", consent2: "in" };

    expect(await service.remember(ctx, { message: "m", reply: "r" })).toEqual({ written: [] });
    expect(await service.recall(ctx)).toEqual([]);
    expect(cryptoSpy.encrypt).not.toHaveBeenCalled();
    expect(cryptoSpy.decrypt).not.toHaveBeenCalled();
  });
});
