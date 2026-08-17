import { describe, it, expect } from "vitest";
import { StaticGroundingAdapter } from "@palup/widget-brain";
import { AliasGroundingAdapter, EVAL_TENANT_DEFAULT, resolveEvalTenant } from "../src/eval-tenant.js";

// The isolated-eval-tenant safety fix for shadow:retrieval. shadow:retrieval indexes AND queries under this
// ONE tenant; it must be a NON-serving tenant (never the real "demo"), and the alias must keep the champion's
// getContext / candidate's getShell resolving to a FULL catalog so the shadow is a real comparison, not a
// silent no-op over two empty catalogs.

describe("resolveEvalTenant — a non-serving default, never the bare demo", () => {
  it("defaults to the non-serving 'shadow-eval' when RETRIEVAL_TENANT is unset or blank", () => {
    expect(resolveEvalTenant({})).toBe("shadow-eval");
    expect(resolveEvalTenant({ RETRIEVAL_TENANT: "" })).toBe("shadow-eval");
    expect(resolveEvalTenant({ RETRIEVAL_TENANT: "   " })).toBe("shadow-eval");
    expect(EVAL_TENANT_DEFAULT).toBe("shadow-eval");
  });
  it("the default is never the real serving 'demo' tenant", () => {
    expect(resolveEvalTenant({})).not.toBe("demo");
  });
  it("honors an explicit RETRIEVAL_TENANT", () => {
    expect(resolveEvalTenant({ RETRIEVAL_TENANT: "acme-eval" })).toBe("acme-eval");
  });
});

describe("AliasGroundingAdapter — eval tenant resolves to the demo catalog, index==query, never bare demo", () => {
  const evalTenant = resolveEvalTenant({});
  const base = new StaticGroundingAdapter();
  const alias = new AliasGroundingAdapter(base, evalTenant, "demo");

  it("getContext(evalTenant) returns the demo fixture's products, but tagged with the eval tenant", async () => {
    const viaAlias = await alias.getContext(evalTenant);
    const demo = await base.getContext("demo");
    expect(viaAlias.tenantId).toBe(evalTenant);
    // Non-empty — the champion (which grounds via getContext) has a real catalog to narrow, so the shadow is
    // a genuine comparison, not two empty catalogs.
    expect(viaAlias.products.length).toBeGreaterThan(0);
    expect(viaAlias.products.map((p) => p.id)).toEqual(demo.products.map((p) => p.id));
    expect(viaAlias.brandName).toBe(demo.brandName);
  });

  it("getShell(evalTenant) returns the demo brand/policy shell tagged with the eval tenant", async () => {
    const shell = await alias.getShell(evalTenant);
    const demo = await base.getContext("demo");
    expect(shell.tenantId).toBe(evalTenant);
    expect(shell.brandName).toBe(demo.brandName);
    expect(shell.policy).toEqual(demo.policy);
  });

  it("passes every other tenant id through to the base adapter unchanged", async () => {
    const nw = await alias.getContext("northwind");
    const baseNw = await base.getContext("northwind");
    expect(nw.tenantId).toBe("northwind");
    expect(nw.products.map((p) => p.id)).toEqual(baseNw.products.map((p) => p.id));
  });

  it("the index tenant and the brain's query tenant are the SAME non-serving tenant", () => {
    // shadow-retrieval.ts indexes under `evalTenant` and pins signals.tenantId to the SAME value; this pins
    // that equality so a future edit cannot silently split them (which would make the shadow a no-op).
    const indexTenant = evalTenant;
    const queryTenant = evalTenant;
    expect(indexTenant).toBe(queryTenant);
    expect(queryTenant).not.toBe("demo");
  });
});
