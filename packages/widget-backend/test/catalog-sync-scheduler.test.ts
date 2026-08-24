import { describe, it, expect, vi } from "vitest";
import {
  InMemoryRuntimeStore,
  createInMemoryCatalogProductStore,
  createInMemoryProductFactsStore,
} from "@palup/platform-ports";
import type { MerchantSummary } from "@palup/platform-ports";
import {
  armKill,
  CATALOG_SYNC_AGENT_TYPE,
  setCatalogRetrievalPlatformEnabled,
  setCatalogRetrievalTenantOptIn,
} from "@palup/state-postgres";
import type { ShopifyAdminClient, BulkStatus } from "../src/shopify-client.js";
import { runCatalogBackfill, type CatalogBackfillDeps, type BackfillReport } from "../src/jobs/catalog-backfill.js";
import type { TenantIndexReport } from "../src/jobs/catalog-index.js";
import { runCatalogSyncScheduler, type CatalogSyncSchedulerDeps } from "../src/jobs/catalog-sync-scheduler.js";

// Task 11 (durable-catalog-sync, ADR-0022 F5) — the fleet catalog-sync scheduler + sync-plane kill scope.
// See task-11-brief.md.

const ONE_PRODUCT_JSONL =
  JSON.stringify({
    id: "gid://shopify/Product/1",
    handle: "alpha-serum",
    title: "Alpha Serum",
    status: "ACTIVE",
    tags: ["hydrating"],
  }) +
  "\n" +
  JSON.stringify({
    id: "gid://shopify/ProductVariant/10",
    __parentId: "gid://shopify/Product/1",
    price: "19.99",
    availableForSale: true,
  }) +
  "\n";

function fakeClient(jsonl: string, opts: { pollsUntilDone?: number; onPoll?: (n: number) => void } = {}): ShopifyAdminClient {
  let polls = 0;
  const pollsUntilDone = opts.pollsUntilDone ?? 1;
  return {
    graphql: vi.fn(),
    runBulkQuery: vi.fn(async () => ({ id: "gid://shopify/BulkOperation/1" })),
    pollBulk: vi.fn(async (): Promise<BulkStatus> => {
      polls++;
      opts.onPoll?.(polls);
      if (polls < pollsUntilDone) return { status: "RUNNING" };
      return { status: "COMPLETED", url: "https://storage.googleapis.com/bucket/result.jsonl", objectCount: 2 };
    }),
    downloadJsonl: vi.fn(async () => jsonl),
  };
}

function makeBackfillDeps(store: InMemoryRuntimeStore, client: ShopifyAdminClient, overrides: Partial<CatalogBackfillDeps> = {}): CatalogBackfillDeps {
  return {
    store,
    catalogProduct: createInMemoryCatalogProductStore(),
    productFacts: createInMemoryProductFactsStore(),
    getFreshAdminToken: vi.fn(async () => "admin-tok"),
    shopDomainOf: vi.fn(async () => "acme.myshopify.com"),
    createClient: () => client,
    sleep: async () => {},
    ...overrides,
  };
}

function makeIndexReport(tenantId: string): TenantIndexReport {
  return { tenantId, outcome: "indexed", products: 1, embedded: 1, written: 1, removed: 0 };
}

describe("runCatalogSyncScheduler — F5 sync-plane kill scope", () => {
  it("skips a tenant whose sync plane is killed (agent:catalog-sync) — backfill never invoked", async () => {
    const store = new InMemoryRuntimeStore();
    await armKill(store, `agent:${CATALOG_SYNC_AGENT_TYPE}`, "maintenance");

    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => ({ tenantId, productCount: 0, truncated: false, outcome: "unchanged" }));
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));
    const deps: CatalogSyncSchedulerDeps = { store, backfill, index };

    const report = await runCatalogSyncScheduler(deps, { tenantIds: ["t1"] });

    expect(report.skipped).toContain("t1");
    expect(backfill).not.toHaveBeenCalled();
    expect(index).not.toHaveBeenCalled();
    expect(report.results).toEqual([{ tenantId: "t1", outcome: "skipped" }]);
  });

  it("a global kill also skips every tenant", async () => {
    const store = new InMemoryRuntimeStore();
    await armKill(store, "global", "incident");
    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => ({ tenantId, productCount: 0, truncated: false, outcome: "unchanged" }));
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));

    const report = await runCatalogSyncScheduler({ store, backfill, index }, { tenantIds: ["t1", "t2"] });

    expect(report.skipped.sort()).toEqual(["t1", "t2"]);
    expect(backfill).not.toHaveBeenCalled();
  });

  it("does NOT skip a tenant when only a DIFFERENT tenant's scope is killed", async () => {
    const store = new InMemoryRuntimeStore();
    await armKill(store, "tenant:other", "unrelated");
    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => ({ tenantId, productCount: 3, truncated: false, outcome: "backfilled" }));
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));

    const report = await runCatalogSyncScheduler({ store, backfill, index }, { tenantIds: ["t1"] });

    expect(report.skipped).toEqual([]);
    expect(backfill).toHaveBeenCalledWith("t1", expect.objectContaining({ shouldAbort: expect.any(Function) }));
  });

  it("aborts an in-flight backfill promptly when the kill arms between poll steps (shouldAbort threaded into runCatalogBackfill)", async () => {
    const store = new InMemoryRuntimeStore();
    let pollCount = 0;
    const client = fakeClient(ONE_PRODUCT_JSONL, {
      pollsUntilDone: 5, // would need 5 successful polls to complete
      onPoll: async (n) => {
        pollCount = n;
        if (n === 1) {
          // Arm the sync-plane kill mid-run, between the 1st and 2nd poll steps.
          await armKill(store, `agent:${CATALOG_SYNC_AGENT_TYPE}`, "mid-run-halt");
        }
      },
    });
    const backfillDeps = makeBackfillDeps(store, client);
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));
    const deps: CatalogSyncSchedulerDeps = {
      store,
      backfill: (tenantId, opts) => runCatalogBackfill(backfillDeps, tenantId, opts),
      index,
    };

    const report = await runCatalogSyncScheduler(deps, { tenantIds: ["acme"] });

    const result = report.results.find((r) => r.tenantId === "acme")!;
    expect(result.outcome).toBe("synced");
    expect(result.backfill?.outcome).toBe("halted");
    // pollBulk was called once (attempt 1, which armed the kill) and never again — the abort was honored
    // on attempt 2's pre-poll check rather than running the poll loop out to completion.
    expect(pollCount).toBe(1);
    expect(client.downloadJsonl).not.toHaveBeenCalled();
    // Nothing was written: the abort fired before any store write.
    expect(await backfillDeps.catalogProduct.listByTenant("acme")).toEqual([]);
  });

  it("bounds concurrency to the configured max", async () => {
    const store = new InMemoryRuntimeStore();
    const tenantIds = ["t1", "t2", "t3", "t4", "t5"];
    let active = 0;
    let maxActive = 0;

    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => {
      active++;
      maxActive = Math.max(maxActive, active);
      // A real timer delay (not a manually-driven promise) so the pool's structural guarantee — at most
      // `maxConcurrent` workers ever call `fn` at once, regardless of how long any one call takes — is
      // what this test exercises, not hand-orchestrated microtask timing.
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { tenantId, productCount: 1, truncated: false, outcome: "backfilled" };
    });
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));

    const report = await runCatalogSyncScheduler({ store, backfill, index }, { tenantIds, maxConcurrent: 2 });

    expect(maxActive).toBe(2);
    expect(active).toBe(0);
    expect(backfill).toHaveBeenCalledTimes(5);
    expect(report.results).toHaveLength(5);
  });

  it("CARRY (Task 7): a retrieval-enabled tenant gets BOTH backfill AND the embed index run", async () => {
    const store = new InMemoryRuntimeStore();
    await setCatalogRetrievalPlatformEnabled(store, true);
    await setCatalogRetrievalTenantOptIn(store, "enabled-tenant", true);
    // "plain-tenant" gets neither platform-master nor opt-in — retrieval stays OFF for it.

    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => ({ tenantId, productCount: 2, truncated: false, outcome: "backfilled" }));
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));
    const deps: CatalogSyncSchedulerDeps = { store, backfill, index };

    const report = await runCatalogSyncScheduler(deps, { tenantIds: ["enabled-tenant", "plain-tenant"] });

    expect(backfill).toHaveBeenCalledWith("enabled-tenant", expect.anything());
    expect(backfill).toHaveBeenCalledWith("plain-tenant", expect.anything());
    expect(index).toHaveBeenCalledWith("enabled-tenant");
    expect(index).not.toHaveBeenCalledWith("plain-tenant");
    expect(index).toHaveBeenCalledTimes(1);

    const enabled = report.results.find((r) => r.tenantId === "enabled-tenant")!;
    const plain = report.results.find((r) => r.tenantId === "plain-tenant")!;
    expect(enabled.outcome).toBe("synced");
    expect(enabled.backfill?.outcome).toBe("backfilled");
    expect(enabled.index?.outcome).toBe("indexed");
    expect(plain.outcome).toBe("synced");
    expect(plain.backfill?.outcome).toBe("backfilled");
    expect(plain.index).toBeUndefined();
  });

  it("one tenant's failure does not abort the run for the rest", async () => {
    const store = new InMemoryRuntimeStore();
    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => {
      if (tenantId === "bad") throw new Error("boom");
      return { tenantId, productCount: 1, truncated: false, outcome: "backfilled" };
    });
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));

    const report = await runCatalogSyncScheduler({ store, backfill, index }, { tenantIds: ["good", "bad"] });

    const bad = report.results.find((r) => r.tenantId === "bad")!;
    const good = report.results.find((r) => r.tenantId === "good")!;
    expect(bad.outcome).toBe("failed");
    expect(bad.errorClass).toBe("Error");
    expect(good.outcome).toBe("synced");
  });
});

// Task 5 (credential-enrollment-unification) — the scheduler discovers tenants via
// `MerchantRegistryPort.listActive`'s keyset cursor instead of a caller-assembled `SHOPIFY_STORES` list.
// ADR-0023 F-E: `listActive` is INTERNAL sync-plane only; this scheduler is one of its two sanctioned
// callers (retention-sweep is the other — see retention-sweep-job.test.ts).
describe("runCatalogSyncScheduler — registry-based tenant discovery (Task 5)", () => {
  function summary(tenantId: string): MerchantSummary {
    return { tenantId, shopDomain: `${tenantId}.myshopify.com`, status: "active" };
  }

  it("given a fake registry with 3 active tenants across 2 listActive pages, processes all 3 — no tenantIds/SHOPIFY_STORES needed", async () => {
    const store = new InMemoryRuntimeStore();
    const listActive = vi
      .fn()
      .mockResolvedValueOnce({ items: [summary("t1"), summary("t2")], nextCursor: "t2" })
      .mockResolvedValueOnce({ items: [summary("t3")] });
    const registry = { listActive };
    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => ({ tenantId, productCount: 1, truncated: false, outcome: "backfilled" }));
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));
    const deps: CatalogSyncSchedulerDeps = { store, backfill, index, registry };

    const report = await runCatalogSyncScheduler(deps, {});

    expect(report.results).toHaveLength(3);
    expect(backfill).toHaveBeenCalledWith("t1", expect.anything());
    expect(backfill).toHaveBeenCalledWith("t2", expect.anything());
    expect(backfill).toHaveBeenCalledWith("t3", expect.anything());
    expect(report.results.every((r) => r.outcome === "synced")).toBe(true);
  });

  it("the nextCursor loop terminates: listActive is called exactly once per page, following the returned cursor", async () => {
    const store = new InMemoryRuntimeStore();
    const listActive = vi
      .fn()
      .mockResolvedValueOnce({ items: [summary("t1"), summary("t2")], nextCursor: "t2" })
      .mockResolvedValueOnce({ items: [summary("t3")] }); // no nextCursor => last page
    const registry = { listActive };
    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => ({ tenantId, productCount: 0, truncated: false, outcome: "unchanged" }));
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));

    await runCatalogSyncScheduler({ store, backfill, index, registry }, {});

    expect(listActive).toHaveBeenCalledTimes(2);
    expect(listActive).toHaveBeenNthCalledWith(1, {});
    expect(listActive).toHaveBeenNthCalledWith(2, { cursor: "t2" });
  });

  it("an explicit opts.tenantIds still wins over registry discovery (single-tenant override)", async () => {
    const store = new InMemoryRuntimeStore();
    const listActive = vi.fn(async () => ({ items: [summary("t1"), summary("t2")] }));
    const registry = { listActive };
    const backfill = vi.fn(async (tenantId: string): Promise<BackfillReport> => ({ tenantId, productCount: 0, truncated: false, outcome: "unchanged" }));
    const index = vi.fn(async (tenantId: string) => makeIndexReport(tenantId));

    const report = await runCatalogSyncScheduler({ store, backfill, index, registry }, { tenantIds: ["only-this-one"] });

    expect(listActive).not.toHaveBeenCalled();
    expect(report.results).toEqual([expect.objectContaining({ tenantId: "only-this-one" })]);
  });

  it("throws a clear error when both opts.tenantIds and deps.registry are absent — never silently syncs nothing", async () => {
    const store = new InMemoryRuntimeStore();
    const backfill = vi.fn();
    const index = vi.fn();

    await expect(runCatalogSyncScheduler({ store, backfill, index }, {})).rejects.toThrow(/registry/i);
  });
});
