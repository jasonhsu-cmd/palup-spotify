import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort } from "@palup/platform-ports";

// Deploy-blocking gap fix: `buildServer()` constructs `PostgresMerchantRulesStore` and
// `PostgresMerchantRegistry` (both have their own tables + an idempotent `migrate()`) on the durable
// (`DATABASE_URL` set) boot path, but never called `migrate()` on either — a fresh staging DB would have
// no `pl_merchant_rules`/`pl_merchant` tables, so the first real read/write 500s. `createRuntimeStore()`
// only migrates its OWN `RuntimeStatePort` KV tables (`rs_kv`/`rs_audit`); it has no idea these two
// dedicated tables exist.
//
// `@palup/state-postgres` is mocked here — no real Postgres connection ever happens in this file — so
// this proves the WIRING (migrate is awaited before the server serves), mirroring the
// `memory-auth-boot-guard.test.ts` pattern (widget-backend): mock the module, then dynamic-import
// `buildServer` afterward so it picks up the mocked exports.
const { migrateRulesSpy, migrateRegistrySpy, createRuntimeStoreSpy } = vi.hoisted(() => {
  const migrateRulesSpy = vi.fn(async () => {});
  const migrateRegistrySpy = vi.fn(async () => {});
  const createRuntimeStoreSpy = vi.fn();
  return { migrateRulesSpy, migrateRegistrySpy, createRuntimeStoreSpy };
});

vi.mock("@palup/state-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@palup/state-postgres")>();

  // Postgres-shaped fakes: only `migrate()` matters to this file's assertions. Constructor args are
  // accepted and ignored (the real constructors take `(sql, state?)` / `(sql)` — see
  // merchant-rules-store.ts / postgres-merchant-registry.ts).
  class FakePostgresMerchantRulesStore {
    migrate = migrateRulesSpy;
    get = vi.fn(async () => ({}));
    set = vi.fn();
  }
  class FakePostgresMerchantRegistry {
    migrate = migrateRegistrySpy;
    lookupByShopDomain = vi.fn(async () => null);
    lookupByTenantId = vi.fn(async () => null);
    lookupByEmbedKey = vi.fn(async () => null);
    create = vi.fn();
    setStatus = vi.fn();
    update = vi.fn();
  }

  return {
    ...actual,
    createRuntimeStore: createRuntimeStoreSpy,
    PostgresMerchantRulesStore: FakePostgresMerchantRulesStore,
    PostgresMerchantRegistry: FakePostgresMerchantRegistry,
  };
});

const { buildServer } = await import("../src/server.js");

// Never authenticates anything for real — these tests only exercise BOOT, not auth — so no real Shopify
// secret/session flow is needed even though `opts.identity` is provided (buildServer still builds +
// migrates the registry on the durable path regardless of whether an identity override is injected: the
// table has to exist for ANY future caller, not just the default identity adapter).
const fakeIdentity: MerchantIdentityPort = {
  authenticate: async () => ({ kind: "anonymous" }),
  authorize: () => false,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("durable (Postgres) boot path", () => {
  it("awaits migrate() on both the rules store and the registry before the server is ready", async () => {
    const fakeSql = {} as never; // never queried directly in this file -- only threaded through to the mocked adapters
    createRuntimeStoreSpy.mockResolvedValue({ store: new InMemoryRuntimeStore(), kind: "postgres", sql: fakeSql });

    const app = await buildServer({ identity: fakeIdentity });
    await app.ready();

    expect(migrateRulesSpy).toHaveBeenCalledTimes(1);
    expect(migrateRegistrySpy).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

describe("in-memory boot path (no DATABASE_URL) is unchanged", () => {
  it("never calls migrate — there is no Postgres adapter to migrate — and still boots", async () => {
    createRuntimeStoreSpy.mockResolvedValue({ store: new InMemoryRuntimeStore(), kind: "memory" });

    const app = await buildServer({ identity: fakeIdentity });
    await app.ready();

    expect(migrateRulesSpy).not.toHaveBeenCalled();
    expect(migrateRegistrySpy).not.toHaveBeenCalled();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
