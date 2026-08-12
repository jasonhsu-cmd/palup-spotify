import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  createInMemoryMerchantRegistry,
  type MerchantGroundingMode,
  type MerchantRegion,
  type MerchantStatus,
  type NewMerchant,
} from "@palup/platform-ports";
import { runMerchantRegistryPortContract } from "@palup/platform-ports/contract/merchant-registry";
import { PostgresMerchantRegistry } from "../src/postgres-merchant-registry.js";
import type { Sql } from "../src/sql.js";

// Postgres adapter for MerchantRegistryPort (work item B1), verified against a REAL Postgres engine
// (pglite = Postgres compiled to WASM, in-process, no server/Docker) — the SAME precedent as
// postgres-runtime-store.test.ts and postgres-vector-store.test.ts, so the SQL is genuinely exercised
// rather than mocked.
//
// HONEST LIMIT OF THIS FILE (mirrors the framing of the "PostgresRuntimeStore ↔ InMemoryRuntimeStore hash
// parity" test's own scope note): pglite is the same *dialect* and the same adapter surface as Cloud SQL,
// NOT the same deployment. What these tests DO verify: the DDL executes, the constraints fire, the
// statements are parameterised, and behavior matches the in-memory oracle. What they DO NOT and CANNOT
// verify here: behavior under genuine concurrency (pglite is in-process and serialises requests, so the
// two-installs-at-once race that the UNIQUE indexes exist for is argued from the constraint, not
// demonstrated), connection-pool/timeout behavior, RLS, and anything about a real Cloud SQL instance's
// configuration. Those stay UNVERIFIED until something actually deploys this table.

function pgliteSql(db: PGlite): Sql {
  const wrap = (runner: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Sql => ({
    query: async <R = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      const r = await runner.query(text, params);
      return { rows: r.rows as R[] };
    },
    tx: () => {
      throw new Error("nested transactions are not supported");
    },
  });
  return {
    query: wrap(db).query,
    tx: (fn) => db.transaction(async (txCtx) => fn(wrap(txCtx))),
  };
}

async function makePgAdapter(): Promise<PostgresMerchantRegistry> {
  const reg = new PostgresMerchantRegistry(pgliteSql(new PGlite()));
  await reg.migrate();
  return reg;
}

/** A migrated adapter plus the raw db, for the tests that must look at the actual table. */
async function makeWithDb(): Promise<{ reg: PostgresMerchantRegistry; db: PGlite }> {
  const db = new PGlite();
  const reg = new PostgresMerchantRegistry(pgliteSql(db));
  await reg.migrate();
  return { reg, db };
}

const ACME: NewMerchant = {
  tenantId: "acme",
  shopDomain: "acme.myshopify.com",
  embedKey: "pk-acme",
  region: "us",
};

// The adapter must pass the SAME contract as the in-memory reference — behavior-equivalence (ADR-0001).
runMerchantRegistryPortContract(makePgAdapter);

// ---------------------------------------------------------------------------------------------------
// Schema: the table, its constraints, and what must NEVER be a column in it.
// ---------------------------------------------------------------------------------------------------

describe("PostgresMerchantRegistry — pl_merchant schema", () => {
  it("migrate() creates pl_merchant idempotently and does not lose data on re-run (every process boot)", async () => {
    const { reg, db } = await makeWithDb();
    await reg.create(ACME);
    await reg.migrate(); // re-run, as happens on every boot
    expect((await reg.lookupByTenantId("acme"))?.shopDomain).toBe("acme.myshopify.com");
    const { rows } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM pl_merchant");
    expect(rows[0]?.n).toBe("1");
  });

  it("migrate() ADDS primary_domain to a table that PREDATES this column, without losing data — the " +
    "explicit ALTER TABLE path, since CREATE TABLE IF NOT EXISTS alone would silently no-op here", async () => {
    const db = new PGlite();
    // A table shaped by an OLDER version of this file's migrate(), before primaryDomain existed.
    await db.query(
      `CREATE TABLE pl_merchant (
         tenant_id text PRIMARY KEY, shop_domain text NOT NULL, embed_key text NOT NULL,
         status text NOT NULL, region text NOT NULL, grounding_mode text NOT NULL,
         plan text, status_reason text, created_at text NOT NULL, updated_at text NOT NULL)`,
    );
    await db.query(
      `INSERT INTO pl_merchant (tenant_id, shop_domain, embed_key, status, region, grounding_mode, created_at, updated_at)
       VALUES ('acme','acme.myshopify.com','pk-acme','active','us','full','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    );
    const reg = new PostgresMerchantRegistry(pgliteSql(db));
    await reg.migrate();
    expect((await reg.lookupByTenantId("acme"))?.shopDomain).toBe("acme.myshopify.com"); // pre-existing row survived
    expect((await reg.lookupByTenantId("acme"))?.primaryDomain).toBeUndefined(); // new column, no data yet
    const updated = await reg.update("acme", { primaryDomain: "shop.example.com" });
    expect(updated.primaryDomain).toBe("shop.example.com");
    expect((await reg.lookupByTenantId("acme"))?.primaryDomain).toBe("shop.example.com");
  });

  it("holds NO secret material: the column set is an exact allowlist (a Storefront/delegate token lives " +
    "in SecretsPort, never here)", async () => {
    const { db } = await makeWithDb();
    const { rows } = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name",
      ["pl_merchant"],
    );
    // `embed_key` is the PUBLISHABLE key that ships in the storefront snippet (merchant-registry-port.ts:74)
    // — explicitly not a secret. Any future column that would carry credential material (access_token,
    // storefront_token, api_secret, …) fails this test rather than silently shipping a credential into a
    // table nobody treats as a secret store.
    expect(rows.map((r) => r.column_name)).toEqual([
      "created_at",
      "embed_key",
      "grounding_mode",
      "plan",
      "primary_domain",
      "region",
      "shop_domain",
      "status",
      "status_reason",
      "tenant_id",
      "updated_at",
    ]);
  });

  it("the engine itself rejects a blank identifier row, not just the app guard", async () => {
    const { db } = await makeWithDb();
    const insert = (tenantId: string, domain: string, key: string) =>
      db.query(
        `INSERT INTO pl_merchant (tenant_id, shop_domain, embed_key, status, region, grounding_mode, created_at, updated_at)
         VALUES ($1,$2,$3,'active','us','full','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        [tenantId, domain, key],
      );
    await expect(insert("   ", "a.myshopify.com", "pk-a")).rejects.toThrow();
    await expect(insert("t", "   ", "pk-a")).rejects.toThrow();
    await expect(insert("t", "a.myshopify.com", "")).rejects.toThrow();
  });

  it("the engine itself rejects an out-of-range status / region / groundingMode (the DB-side twin of the " +
    "port's requireEnum — a manual UPDATE cannot invent a residency)", async () => {
    const { db } = await makeWithDb();
    const insertWith = (status: string, region: string, mode: string) =>
      db.query(
        `INSERT INTO pl_merchant (tenant_id, shop_domain, embed_key, status, region, grounding_mode, created_at, updated_at)
         VALUES ('t','t.myshopify.com','pk-t',$1,$2,$3,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        [status, region, mode],
      );
    await expect(insertWith("deleted", "us", "full")).rejects.toThrow();
    await expect(insertWith("active", "atlantis", "full")).rejects.toThrow();
    await expect(insertWith("active", "us", "everything")).rejects.toThrow();
  });

  it("…and accepts EVERY value the port's unions allow (so a widened union with a stale CHECK fails here, " +
    "not in production)", async () => {
    const statuses: MerchantStatus[] = ["active", "suspended", "uninstalled"];
    const regions: MerchantRegion[] = ["us", "eu", "uk", "other"];
    const modes: MerchantGroundingMode[] = ["off", "general", "full"];
    const reg = await makePgAdapter();
    let n = 0;
    for (const status of statuses) {
      for (const region of regions) {
        for (const groundingMode of modes) {
          const id = `t${n++}`;
          const created = await reg.create({
            tenantId: id,
            shopDomain: `${id}.example.com`,
            embedKey: `pk-${id}`,
            status,
            region,
            groundingMode,
          });
          expect(created.status).toBe(status);
          expect(created.region).toBe(region);
          expect(created.groundingMode).toBe(groundingMode);
        }
      }
    }
    expect(n).toBe(36);
  });
});

// ---------------------------------------------------------------------------------------------------
// The cross-tenant read. This adapter is one of the very few places that legitimately reads across
// tenants, so "could this return the WRONG merchant?" is the question every test below asks.
// ---------------------------------------------------------------------------------------------------

describe("PostgresMerchantRegistry — cross-tenant lookup cannot resolve the wrong merchant", () => {
  it("UNIQUE on lower(shop_domain) is enforced by the ENGINE, so a writer that skips the app-level " +
    "normalisation still cannot hand one shop to two tenants", async () => {
    const { reg, db } = await makeWithDb();
    await reg.create(ACME);
    // A raw insert bypassing the adapter entirely (a migration script, a support fix, a future caller
    // that forgot to lowercase). Only a DB constraint can stop this one.
    await expect(
      db.query(
        `INSERT INTO pl_merchant (tenant_id, shop_domain, embed_key, status, region, grounding_mode, created_at, updated_at)
         VALUES ('acme-2','ACME.MyShopify.COM','pk-acme-2','active','us','full','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      ),
    ).rejects.toThrow();
    expect((await reg.lookupByShopDomain("acme.myshopify.com"))?.tenantId).toBe("acme");
  });

  it("UNIQUE on embed_key is enforced by the ENGINE too (a shared key would mint widget tokens for the " +
    "wrong tenant)", async () => {
    const { reg, db } = await makeWithDb();
    await reg.create(ACME);
    await expect(
      db.query(
        `INSERT INTO pl_merchant (tenant_id, shop_domain, embed_key, status, region, grounding_mode, created_at, updated_at)
         VALUES ('acme-2','other.myshopify.com','pk-acme','active','us','full','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      ),
    ).rejects.toThrow();
    expect((await reg.lookupByEmbedKey("pk-acme"))?.tenantId).toBe("acme");
  });

  it("an AMBIGUOUS reverse lookup throws instead of picking one — a table that predates the unique index " +
    "must fail closed, never serve an arbitrary tenant", async () => {
    // Stand in for a table created by an older/hand-rolled DDL that lacked the unique index.
    const db = new PGlite();
    await db.query(
      `CREATE TABLE pl_merchant (
         tenant_id text PRIMARY KEY, shop_domain text NOT NULL, embed_key text NOT NULL,
         status text NOT NULL, region text NOT NULL, grounding_mode text NOT NULL,
         plan text, status_reason text, created_at text NOT NULL, updated_at text NOT NULL, primary_domain text)`,
    );
    const seed = (tenantId: string, domain: string, key: string) =>
      db.query(
        `INSERT INTO pl_merchant (tenant_id, shop_domain, embed_key, status, region, grounding_mode, created_at, updated_at)
         VALUES ($1,$2,$3,'active','us','full','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        [tenantId, domain, key],
      );
    await seed("first", "acme.myshopify.com", "pk-1");
    await seed("second", "acme.myshopify.com", "pk-2");

    const reg = new PostgresMerchantRegistry(pgliteSql(db)); // deliberately NOT migrated
    await expect(reg.lookupByShopDomain("acme.myshopify.com")).rejects.toThrow(/multiple/i);
    // …and migrate() refuses to pretend the invariant holds: it cannot add the unique index over the
    // duplicate rows, so it surfaces that instead of continuing silently.
    await expect(reg.migrate()).rejects.toThrow();
  });

  it("an ambiguous embed-key lookup fails closed the same way", async () => {
    const db = new PGlite();
    await db.query(
      `CREATE TABLE pl_merchant (
         tenant_id text PRIMARY KEY, shop_domain text NOT NULL, embed_key text NOT NULL,
         status text NOT NULL, region text NOT NULL, grounding_mode text NOT NULL,
         plan text, status_reason text, created_at text NOT NULL, updated_at text NOT NULL, primary_domain text)`,
    );
    for (const [t, d] of [
      ["first", "a.myshopify.com"],
      ["second", "b.myshopify.com"],
    ]) {
      await db.query(
        `INSERT INTO pl_merchant (tenant_id, shop_domain, embed_key, status, region, grounding_mode, created_at, updated_at)
         VALUES ($1,$2,'pk-shared','active','us','full','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        [t, d],
      );
    }
    const reg = new PostgresMerchantRegistry(pgliteSql(db));
    await expect(reg.lookupByEmbedKey("pk-shared")).rejects.toThrow(/multiple/i);
  });

  it("two merchants differing ONLY by case: the second registration is refused and the first keeps its " +
    "shop (no hijack, no stray row)", async () => {
    const { reg, db } = await makeWithDb();
    await reg.create(ACME);
    await expect(
      reg.create({ tenantId: "impostor", shopDomain: "ACME.MYSHOPIFY.COM", embedKey: "pk-impostor", region: "us" }),
    ).rejects.toThrow();
    expect((await reg.lookupByShopDomain("acme.myshopify.com"))?.tenantId).toBe("acme");
    expect((await reg.lookupByShopDomain("Acme.MyShopify.Com"))?.tenantId).toBe("acme");
    expect(await reg.lookupByTenantId("impostor", { includeInactive: true })).toBeNull();
    const { rows } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM pl_merchant");
    expect(rows[0]?.n).toBe("1"); // the refused create left NOTHING behind
  });

  it("two merchants differing only by a TRAILING DOT are distinct keys, and neither lookup can return " +
    "the other (documents the port's normalisation, which does not strip the DNS root dot)", async () => {
    const reg = await makePgAdapter();
    await reg.create(ACME);
    // The port's normalizeShopDomain (merchant-registry-port.ts:163-165) trims + lowercases ONLY, so
    // "acme.myshopify.com." is a DIFFERENT key from "acme.myshopify.com" even though DNS treats the
    // trailing dot as the same host. This asserts the adapter matches that behaviour exactly rather than
    // inventing its own normalisation (which would fork from the in-memory oracle) — see the module note
    // in postgres-merchant-registry.ts for why that belongs in the port, not here.
    const dotted = await reg.create({
      tenantId: "acme-dot",
      shopDomain: "acme.myshopify.com.",
      embedKey: "pk-acme-dot",
      region: "us",
    });
    expect(dotted.tenantId).toBe("acme-dot");
    expect((await reg.lookupByShopDomain("acme.myshopify.com"))?.tenantId).toBe("acme");
    expect((await reg.lookupByShopDomain("acme.myshopify.com."))?.tenantId).toBe("acme-dot");
    expect((await reg.lookupByShopDomain("ACME.MYSHOPIFY.COM."))?.tenantId).toBe("acme-dot");
  });

  it("a wildcard is DATA, never a pattern: lookups are bound equality, not LIKE/prefix matching", async () => {
    const reg = await makePgAdapter();
    await reg.create(ACME);
    expect(await reg.lookupByShopDomain("%")).toBeNull();
    expect(await reg.lookupByShopDomain("%.myshopify.com")).toBeNull();
    expect(await reg.lookupByShopDomain("acme%")).toBeNull();
    expect(await reg.lookupByEmbedKey("pk-%")).toBeNull();
    expect(await reg.lookupByTenantId("_cme")).toBeNull();
  });

  it("SQL metacharacters in an externally-influenced key are data, not SQL (shopDomain arrives from a " +
    "Shopify redirect in C1)", async () => {
    const { reg, db } = await makeWithDb();
    await reg.create(ACME);
    const evil = "acme.myshopify.com'; DROP TABLE pl_merchant; --";
    expect(await reg.lookupByShopDomain(evil)).toBeNull();
    expect(await reg.lookupByEmbedKey("pk'; DROP TABLE pl_merchant; --")).toBeNull();
    expect(await reg.lookupByTenantId("acme'); DROP TABLE pl_merchant; --")).toBeNull();
    // The table and its row survived, and such a string round-trips as an ordinary value.
    const stored = await reg.create({
      tenantId: "quoted",
      shopDomain: "o'malley's-shop.example.com",
      embedKey: "pk-o'malley",
      region: "uk",
    });
    expect(stored.shopDomain).toBe("o'malley's-shop.example.com");
    expect((await reg.lookupByShopDomain("O'Malley's-Shop.example.com"))?.tenantId).toBe("quoted");
    expect((await reg.lookupByEmbedKey("pk-o'malley"))?.tenantId).toBe("quoted");
    await reg.setStatus("quoted", "suspended", { reason: "reason with ' quote; --" });
    expect((await reg.lookupByTenantId("quoted", { includeInactive: true }))?.statusReason).toBe(
      "reason with ' quote; --",
    );
    const { rows } = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM pl_merchant");
    expect(rows[0]?.n).toBe("2");
  });

  it("a second adapter instance over the SAME database resolves the same merchant (what env-var tenancy " +
    "cannot do: one process's map is invisible to another)", async () => {
    const db = new PGlite();
    const first = new PostgresMerchantRegistry(pgliteSql(db));
    await first.migrate();
    await first.create(ACME);

    const second = new PostgresMerchantRegistry(pgliteSql(db));
    expect((await second.lookupByShopDomain("acme.myshopify.com"))?.tenantId).toBe("acme");
    expect((await second.lookupByEmbedKey("pk-acme"))?.tenantId).toBe("acme");
  });
});

// ---------------------------------------------------------------------------------------------------
// Revocation. A revoked merchant that is still servable is exactly the failure `status` exists to
// prevent, so it gets tested at the ENGINE level too: the row is still there, and it is still inert.
// ---------------------------------------------------------------------------------------------------

describe("PostgresMerchantRegistry — revocation is inert by default", () => {
  it("an uninstalled merchant's row REMAINS in the table (audit/billing/erasure need it) while every " +
    "default lookup resolves to null", async () => {
    const { reg, db } = await makeWithDb();
    await reg.create(ACME);
    await reg.setStatus("acme", "uninstalled", { reason: "app/uninstalled webhook" });

    const { rows } = await db.query<{ status: string; status_reason: string | null }>(
      "SELECT status, status_reason FROM pl_merchant WHERE tenant_id = $1",
      ["acme"],
    );
    expect(rows[0]?.status).toBe("uninstalled");
    expect(rows[0]?.status_reason).toBe("app/uninstalled webhook");

    expect(await reg.lookupByTenantId("acme")).toBeNull();
    expect(await reg.lookupByShopDomain("acme.myshopify.com")).toBeNull();
    expect(await reg.lookupByEmbedKey("pk-acme")).toBeNull();
  });

  it("the inert rule is applied by the ADAPTER, not delegated: a fresh instance over the same db is " +
    "equally inert (no per-instance cache of servability)", async () => {
    const db = new PGlite();
    const writer = new PostgresMerchantRegistry(pgliteSql(db));
    await writer.migrate();
    await writer.create(ACME);
    await writer.setStatus("acme", "suspended", { reason: "billing hold" });

    const fresh = new PostgresMerchantRegistry(pgliteSql(db));
    expect(await fresh.lookupByEmbedKey("pk-acme")).toBeNull();
    expect((await fresh.lookupByEmbedKey("pk-acme", { includeInactive: true }))?.status).toBe("suspended");
  });

  it("a status set out-of-band to an unrecognised value is ALSO inert (only `active` is ever served)", async () => {
    // The CHECK constraint stops the adapter and any well-formed writer from doing this; the read path
    // still fails closed rather than trusting the column, because "not active" is the servable test.
    const db = new PGlite();
    await db.query(
      `CREATE TABLE pl_merchant (
         tenant_id text PRIMARY KEY, shop_domain text NOT NULL, embed_key text NOT NULL,
         status text NOT NULL, region text NOT NULL, grounding_mode text NOT NULL,
         plan text, status_reason text, created_at text NOT NULL, updated_at text NOT NULL, primary_domain text)`,
    );
    await db.query(
      `INSERT INTO pl_merchant (tenant_id, shop_domain, embed_key, status, region, grounding_mode, created_at, updated_at)
       VALUES ('acme','acme.myshopify.com','pk-acme','frozen','us','full','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    );
    const reg = new PostgresMerchantRegistry(pgliteSql(db));
    expect(await reg.lookupByShopDomain("acme.myshopify.com")).toBeNull();
    expect(await reg.lookupByEmbedKey("pk-acme")).toBeNull();
    expect(await reg.lookupByTenantId("acme")).toBeNull();
  });

  it("setStatus without a reason CLEARS the previous reason (a new status must not inherit the old " +
    "one's justification) — not covered by the shared contract", async () => {
    const reg = await makePgAdapter();
    await reg.create(ACME);
    await reg.setStatus("acme", "suspended", { reason: "billing hold" });
    const reactivated = await reg.setStatus("acme", "active");
    expect(reactivated.status).toBe("active");
    expect(reactivated.statusReason).toBeUndefined();
    expect((await reg.lookupByTenantId("acme"))?.statusReason).toBeUndefined();
  });

  it("a failed setStatus/update leaves the row exactly as it was (validate before write)", async () => {
    const reg = await makePgAdapter();
    const created = await reg.create({ ...ACME, plan: "growth" });
    await expect(reg.setStatus("acme", "deleted" as MerchantStatus)).rejects.toThrow();
    await expect(reg.update("acme", { region: "atlantis" as MerchantRegion })).rejects.toThrow();
    expect(await reg.lookupByTenantId("acme")).toEqual(created); // updatedAt did not move either
  });
});

// ---------------------------------------------------------------------------------------------------
// Timestamps + field fidelity, with an injected clock.
// ---------------------------------------------------------------------------------------------------

describe("PostgresMerchantRegistry — timestamps and field fidelity", () => {
  it("createdAt is written once and never rewritten; updatedAt moves on each accepted mutation", async () => {
    const clock = { at: "2026-01-01T00:00:00.000Z" };
    const reg = new PostgresMerchantRegistry(pgliteSql(new PGlite()), { now: () => clock.at });
    await reg.migrate();
    const created = await reg.create(ACME);
    expect(created.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(created.updatedAt).toBe("2026-01-01T00:00:00.000Z");

    clock.at = "2026-02-02T03:04:05.678Z";
    const updated = await reg.update("acme", { plan: "scale" });
    expect(updated.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-02-02T03:04:05.678Z");

    clock.at = "2026-03-03T00:00:00.000Z";
    const revoked = await reg.setStatus("acme", "uninstalled");
    expect(revoked.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(revoked.updatedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  it("optional fields are ABSENT rather than null when unset (strict-equal parity with the oracle's shape)", async () => {
    const reg = await makePgAdapter();
    const created = await reg.create(ACME);
    expect(Object.hasOwn(created, "plan")).toBe(false);
    expect(Object.hasOwn(created, "statusReason")).toBe(false);
    const fetched = await reg.lookupByTenantId("acme");
    expect(fetched).toStrictEqual(created);
  });
});

// ---------------------------------------------------------------------------------------------------
// Parity with the in-memory oracle. The port's guards (requireId / normalizeShopDomain / requireEnum)
// are module-private, so EVERY adapter re-implements them — a silent divergence (a forgotten trim or
// lowercase) is precisely the cross-tenant hazard. This is the countermeasure: same inputs, both
// adapters, compared. Same spirit as the runtime store's hash-parity test.
// ---------------------------------------------------------------------------------------------------

describe("PostgresMerchantRegistry ↔ InMemoryMerchantRegistry parity on the tricky inputs", () => {
  const now = () => "2026-01-01T00:00:00.000Z";

  async function bothWith(input: NewMerchant) {
    const pg = new PostgresMerchantRegistry(pgliteSql(new PGlite()), { now });
    await pg.migrate();
    const mem = createInMemoryMerchantRegistry({ now });
    return { pg: await pg.create(input), mem: await mem.create(input), pgReg: pg, memReg: mem };
  }

  it("a padded tenantId/shopDomain/embedKey is trimmed identically by both adapters", async () => {
    const { pg, mem, pgReg, memReg } = await bothWith({
      tenantId: "  acme  ",
      shopDomain: "  Acme.MyShopify.com  ",
      embedKey: "  pk-acme  ",
      region: "us",
    });
    expect(pg).toStrictEqual(mem);
    expect(await pgReg.lookupByTenantId("acme")).toStrictEqual(await memReg.lookupByTenantId("acme"));
    expect(await pgReg.lookupByShopDomain("ACME.myshopify.com")).toStrictEqual(
      await memReg.lookupByShopDomain("ACME.myshopify.com"),
    );
    expect(await pgReg.lookupByEmbedKey("pk-acme")).toStrictEqual(await memReg.lookupByEmbedKey("pk-acme"));
  });

  it("the same record shape comes back from both, including optional fields", async () => {
    const { pg, mem } = await bothWith({ ...ACME, plan: "growth", groundingMode: "off", status: "suspended" });
    expect(pg).toStrictEqual(mem);
  });

  it("a trailing-dot domain, a unicode host and a very long id resolve the same way in both", async () => {
    for (const shopDomain of ["acme.myshopify.com.", "bücher.example.com", `${"a".repeat(200)}.example.com`]) {
      const { pg, mem, pgReg, memReg } = await bothWith({ ...ACME, shopDomain });
      expect(pg).toStrictEqual(mem);
      expect(await pgReg.lookupByShopDomain(shopDomain)).toStrictEqual(await memReg.lookupByShopDomain(shopDomain));
      expect(await pgReg.lookupByShopDomain(shopDomain.toUpperCase())).toStrictEqual(
        await memReg.lookupByShopDomain(shopDomain.toUpperCase()),
      );
    }
    // This test spins up THREE fresh in-WASM Postgres (pglite) instances — one per tricky domain — so it
    // is materially slower than its siblings. It stays well under the 5s default locally but exceeded it on
    // CI's slower runner (main went red on a timeout, not a logic failure). A generous per-test timeout
    // keeps it robust in CI without masking anything: the assertions are unchanged.
  }, 30_000);

  it("both adapters reject the same bad inputs (blank ids, unknown region, duplicate keys)", async () => {
    const pg = new PostgresMerchantRegistry(pgliteSql(new PGlite()), { now });
    await pg.migrate();
    const mem = createInMemoryMerchantRegistry({ now });
    const bad: NewMerchant[] = [
      { ...ACME, tenantId: " " },
      { ...ACME, shopDomain: "" },
      { ...ACME, embedKey: "\t" },
      { ...ACME, region: "atlantis" as MerchantRegion },
      { ...ACME, groundingMode: "everything" as MerchantGroundingMode },
      { ...ACME, status: "deleted" as MerchantStatus },
    ];
    for (const input of bad) {
      await expect(pg.create(input)).rejects.toThrow();
      await expect(mem.create(input)).rejects.toThrow();
    }
    await pg.create(ACME);
    await mem.create(ACME);
    for (const dup of [
      { ...ACME, shopDomain: "other.myshopify.com", embedKey: "pk-other" }, // dup tenantId
      { ...ACME, tenantId: "other", embedKey: "pk-other" }, // dup shopDomain
      { ...ACME, tenantId: "other", shopDomain: "other.myshopify.com" }, // dup embedKey
    ]) {
      await expect(pg.create(dup)).rejects.toThrow();
      await expect(mem.create(dup)).rejects.toThrow();
    }
    // …and a mutation of an absent tenant throws in both, creating nothing.
    await expect(pg.setStatus("ghost", "suspended")).rejects.toThrow();
    await expect(mem.setStatus("ghost", "suspended")).rejects.toThrow();
    await expect(pg.update("ghost", { plan: "x" })).rejects.toThrow();
    await expect(mem.update("ghost", { plan: "x" })).rejects.toThrow();
    expect(await pg.lookupByTenantId("ghost", { includeInactive: true })).toBeNull();
    expect(await mem.lookupByTenantId("ghost", { includeInactive: true })).toBeNull();
  });
});
