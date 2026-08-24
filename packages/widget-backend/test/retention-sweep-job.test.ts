import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryRuntimeStore, createInMemoryVectorStore } from "@palup/platform-ports";
import type { MerchantSummary } from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { recordSubject, listSubjects, subjectNamespace } from "@palup/widget-memory";
import { runRetentionSweep, tenantsToSweep, tenantsToSweepViaRegistry } from "../src/jobs/retention-sweep.js";

// B4 — the scheduled retention sweep job. The behaviour that matters here is not "does it delete"
// (widget-memory/test/subject-index-sweep.test.ts covers that) but the SAFETY WRAPPER around a bulk
// delete: does an operator halt actually stop it, is one tenant's failure contained, is a truncated run
// reported rather than silently passing as complete.

const DAY_MS = 24 * 60 * 60 * 1000;
const ENV_KEYS = ["SHOPIFY_STORES", "SWEEP_TENANTS"];
afterEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  vi.restoreAllMocks();
});

async function seedExpired(vector: ReturnType<typeof createInMemoryVectorStore>, tenantId: string, subject: string) {
  await vector.upsert(subjectNamespace(tenantId, subject), [
    { id: `${subject}-f1`, text: "x", metadata: { text: "x", class: "ordinary", expiresAt: new Date(Date.now() - DAY_MS).toISOString() } },
  ]);
}

const countIn = async (vector: ReturnType<typeof createInMemoryVectorStore>, tenantId: string, subject: string) =>
  (await vector.query(subjectNamespace(tenantId, subject), { text: "", k: 100 })).length;

describe("B4 job — the kill switch stops a scheduled mass delete", () => {
  it("A GLOBAL KILL HALTS THE SWEEP — nothing is deleted, and the halt is reported not swallowed", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await recordSubject(store, { tenantId: "demo", subject: "GONEFOREVER" });
    await seedExpired(vector, "demo", "GONEFOREVER");
    await armKill(store, "global", "operator-halt");

    const reports = await runRetentionSweep({ store, vector }, ["demo"]);

    expect(reports).toEqual([{ tenantId: "demo", outcome: "halted" }]);
    expect(await countIn(vector, "demo", "GONEFOREVER")).toBe(1); // untouched
  });

  it("a TENANT-SCOPED kill halts only that tenant — the others are still swept", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    for (const t of ["halted-co", "healthy-co"]) {
      await recordSubject(store, { tenantId: t, subject: "GONEFOREVER" });
      await seedExpired(vector, t, "GONEFOREVER");
    }
    await armKill(store, "tenant:halted-co", "operator-halt");

    const reports = await runRetentionSweep({ store, vector }, ["halted-co", "healthy-co"]);

    expect(reports.find((r) => r.tenantId === "halted-co")?.outcome).toBe("halted");
    expect(reports.find((r) => r.tenantId === "healthy-co")?.outcome).toBe("swept");
    expect(await countIn(vector, "halted-co", "GONEFOREVER")).toBe(1); // untouched
    expect(await countIn(vector, "healthy-co", "GONEFOREVER")).toBe(0); // reclaimed
  });
});

describe("B4 job — containment and honest reporting", () => {
  it("reclaims a departed subject's expired facts across tenants and reports per tenant", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    for (const t of ["alpha-co", "beta-co"]) {
      await recordSubject(store, { tenantId: t, subject: "GONEFOREVER" });
      await seedExpired(vector, t, "GONEFOREVER");
    }

    const reports = await runRetentionSweep({ store, vector }, ["alpha-co", "beta-co"]);

    expect(reports.map((r) => r.outcome)).toEqual(["swept", "swept"]);
    expect(reports.every((r) => r.deleted === 1 && r.retired === 1)).toBe(true);
    expect(await listSubjects(store, "alpha-co")).toHaveLength(0);
  });

  it("one tenant throwing does not abort the run — it is reported and the next tenant still runs", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    for (const t of ["broken-co", "healthy-co"]) {
      await recordSubject(store, { tenantId: t, subject: "GONEFOREVER" });
      await seedExpired(vector, t, "GONEFOREVER");
    }
    const realList = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementation(async (ctx: { tenantId: string }, collection: string) => {
      if (ctx.tenantId === "broken-co" && collection === "memory_subjects") throw new Error("kv down");
      return realList(ctx as never, collection);
    });

    const reports = await runRetentionSweep({ store, vector }, ["broken-co", "healthy-co"]);

    expect(reports.find((r) => r.tenantId === "broken-co")?.outcome).toBe("failed");
    expect(reports.find((r) => r.tenantId === "broken-co")?.errorClass).toBe("Error");
    expect(reports.find((r) => r.tenantId === "healthy-co")?.outcome).toBe("swept");
    expect(await countIn(vector, "healthy-co", "GONEFOREVER")).toBe(0);
  });

  it("a bounded run REPORTS what it left behind rather than reading as complete", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    for (const s of ["SUBJECTAAA", "SUBJECTBBB", "SUBJECTCCC"]) {
      await recordSubject(store, { tenantId: "demo", subject: s });
      await seedExpired(vector, "demo", s);
    }

    const reports = await runRetentionSweep({ store, vector }, ["demo"], { maxSubjects: 1 });

    expect(reports[0]!.visited).toBe(1);
    expect(reports[0]!.remaining).toBe(2);
  });

  it("live facts survive a sweep — this is expiry reclamation, not a bulk delete", async () => {
    const store = new InMemoryRuntimeStore();
    const vector = createInMemoryVectorStore();
    await recordSubject(store, { tenantId: "demo", subject: "STILLVALID" });
    await vector.upsert(subjectNamespace("demo", "STILLVALID"), [
      { id: "live", text: "x", metadata: { text: "x", class: "ordinary", expiresAt: new Date(Date.now() + 10 * DAY_MS).toISOString() } },
    ]);

    const reports = await runRetentionSweep({ store, vector }, ["demo"]);

    expect(reports[0]!.deleted).toBe(0);
    expect(await countIn(vector, "demo", "STILLVALID")).toBe(1);
  });
});

describe("B4 job — tenant selection", () => {
  // SHOPIFY_STORES is a JSON tenant→shopDomain map (merchant-store.ts `parseStoreDomains`), the same env
  // the server resolves storefronts from — reused rather than introducing a second tenant list that
  // could drift out of sync with what the deployment actually serves.
  it("takes tenants from SHOPIFY_STORES, adds SWEEP_TENANTS, and dedupes", () => {
    const stores = JSON.stringify({ "alpha-co": "alpha.myshopify.com", "beta-co": "beta.myshopify.com" });
    expect(tenantsToSweep({ SHOPIFY_STORES: stores } as NodeJS.ProcessEnv).sort()).toEqual(["alpha-co", "beta-co"]);

    expect(
      tenantsToSweep({
        SHOPIFY_STORES: JSON.stringify({ "alpha-co": "alpha.myshopify.com" }),
        SWEEP_TENANTS: "gamma-co, alpha-co",
      } as NodeJS.ProcessEnv).sort(),
    ).toEqual(["alpha-co", "gamma-co"]);
  });

  it("returns nothing when neither is configured — the job refuses to guess at deletion targets", () => {
    expect(tenantsToSweep({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("malformed SHOPIFY_STORES yields no tenants rather than a partial or wrong list", () => {
    expect(tenantsToSweep({ SHOPIFY_STORES: "not json" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

// Task 5 (credential-enrollment-unification) — retention-sweep discovers tenants via
// `MerchantRegistryPort.listActive`'s keyset cursor instead of `SHOPIFY_STORES`. `SWEEP_TENANTS` (an
// explicit list for a tenant the registry does not yet know about) is preserved, unioned with the
// registry walk. `tenantsToSweep` (above) stays exported but is no longer the live enumeration path —
// kept dormant for a one-release rollback.
describe("B4 job — tenant selection via registry (Task 5)", () => {
  function summary(tenantId: string): MerchantSummary {
    return { tenantId, shopDomain: `${tenantId}.myshopify.com`, status: "active" };
  }

  it("given a fake registry with 3 active tenants across 2 listActive pages, returns all 3 — no SHOPIFY_STORES needed", async () => {
    const listActive = vi
      .fn()
      .mockResolvedValueOnce({ items: [summary("alpha-co"), summary("beta-co")], nextCursor: "beta-co" })
      .mockResolvedValueOnce({ items: [summary("gamma-co")] });
    const registry = { listActive };

    const tenantIds = await tenantsToSweepViaRegistry(registry, {} as NodeJS.ProcessEnv);

    expect(tenantIds.sort()).toEqual(["alpha-co", "beta-co", "gamma-co"]);
    expect(listActive).toHaveBeenCalledTimes(2);
  });

  it("the nextCursor loop terminates on the first page without a nextCursor", async () => {
    const listActive = vi
      .fn()
      .mockResolvedValueOnce({ items: [summary("t1")], nextCursor: "t1" })
      .mockResolvedValueOnce({ items: [] }); // empty, no nextCursor => last page
    const registry = { listActive };

    const tenantIds = await tenantsToSweepViaRegistry(registry, {} as NodeJS.ProcessEnv);

    expect(tenantIds).toEqual(["t1"]);
    expect(listActive).toHaveBeenCalledTimes(2);
    expect(listActive).toHaveBeenNthCalledWith(1, {});
    expect(listActive).toHaveBeenNthCalledWith(2, { cursor: "t1" });
  });

  it("SWEEP_TENANTS is preserved: unioned with the registry walk and deduped", async () => {
    const listActive = vi.fn(async () => ({ items: [summary("alpha-co")] }));
    const registry = { listActive };

    const tenantIds = await tenantsToSweepViaRegistry(registry, { SWEEP_TENANTS: "gamma-co, alpha-co" } as NodeJS.ProcessEnv);

    expect(tenantIds.sort()).toEqual(["alpha-co", "gamma-co"]);
  });

  it("an empty registry with no SWEEP_TENANTS yields nothing — the job still refuses to guess", async () => {
    const listActive = vi.fn(async () => ({ items: [] }));
    const registry = { listActive };

    expect(await tenantsToSweepViaRegistry(registry, {} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
