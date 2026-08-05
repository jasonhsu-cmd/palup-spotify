import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { setCostCap, costCapStatus } from "@palup/state-postgres";
import { parseCapArgv, runCostCap, CapArgsError, CAP_USAGE } from "../src/jobs/cost-cap.js";

// THE DEFECT THIS CLOSES, in my own just-merged PR #176.
//
// #176 added `POST /api/cost-cap` / `POST /api/cost-cap/clear` to the CONTROL PLANE and wrote
// `reversalPath: "POST /api/cost-cap/clear"` into the immutable audit record. But
// `.github/workflows/deploy-staging.yml` deploys ONLY `palup-widget-staging`, and NO workflow deploys the
// control plane. So that reversal path named a route an operator cannot reach — exactly the defect #166
// had already found and fixed for the kill switch's own reversalPath, reintroduced one registry later.
//
// #176's test asked the wrong question: it asserted the recorded string matched a route that exists in
// CODE. Reachable in the repo is not reachable in production. The test below asks the right one — does the
// `pnpm <script>` named in the audit actually exist in package.json — which is the check that generalises,
// and the one that would have caught this before merge.

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("the audited reversal path is one an operator can actually run (NN#5)", () => {
  it("every `pnpm <script>` named in a cost_cap audit entry exists in package.json", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "platform COGS");
    const audit = (await store.readAudit({ tenantId: "__system__" })) as { action: string; reversalPath?: string }[];

    const paths = audit.filter((e) => e.action.startsWith("cost_cap.")).map((e) => e.reversalPath ?? "");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const scripts = [...p.matchAll(/pnpm ([a-z0-9:-]+)/g)].map((m) => m[1]!);
      expect(scripts.length, `reversalPath names no runnable pnpm script: "${p}"`).toBeGreaterThan(0);
      for (const s of scripts) {
        expect(Object.keys(pkg.scripts), `reversalPath names "pnpm ${s}" which is not a package.json script`).toContain(s);
      }
    }
  });

  it("the CLI is named BEFORE the HTTP route, because only the CLI works today", async () => {
    const store = new InMemoryRuntimeStore();
    await setCostCap(store, "global", "x");
    const rec = ((await store.readAudit({ tenantId: "__system__" })) as { action: string; reversalPath?: string }[])
      .find((e) => e.action === "cost_cap.set")!;
    expect(rec.reversalPath!.indexOf("pnpm")).toBeLessThan(rec.reversalPath!.indexOf("POST"));
  });
});

describe("argv parsing refuses an implicit scope", () => {
  it.each(["set", "clear"])("%s with no --scope is refused, never defaulted to global", (action) => {
    // A forgotten flag would put EVERY merchant into basic mode.
    expect(() => parseCapArgv([action])).toThrow(CapArgsError);
    expect(() => parseCapArgv([action, "--scope", "  "])).toThrow(CapArgsError);
  });

  it("`set --scope all` does not exist — only clear may widen", () => {
    expect(() => parseCapArgv(["set", "--scope", "all"])).toThrow(/does not exist/);
    expect(parseCapArgv(["clear", "--scope", "all"])).toEqual({ action: "clear", all: true, reason: undefined });
  });

  it("an unparseable scope is refused rather than guessed", () => {
    for (const bad of ["tenant", "tenant:", "TENANT:demo!", "globalish", "tenant:a b"]) {
      expect(() => parseCapArgv(["set", "--scope", bad]), bad).toThrow(CapArgsError);
    }
  });

  it("accepts the two real shapes", () => {
    expect(parseCapArgv(["set", "--scope", "global"])).toMatchObject({ action: "set", scope: "global" });
    expect(parseCapArgv(["set", "--scope", "tenant:demo", "--reason", "plan cap"])).toMatchObject({
      action: "set",
      scope: "tenant:demo",
      reason: "plan cap",
    });
  });

  it("an unknown subcommand is refused, and the usage text points at the kill switch for halting", () => {
    expect(() => parseCapArgv(["halt"])).toThrow(CapArgsError);
    expect(CAP_USAGE).toMatch(/pnpm kill:arm/);
  });

  it("status needs no scope", () => {
    expect(parseCapArgv(["status"])).toEqual({ action: "status" });
  });
});

describe("runCostCap never reports an unverified outcome", () => {
  it("set reads the registry BACK and reports it as confirmed", async () => {
    const store = new InMemoryRuntimeStore();
    const r = await runCostCap({ store }, { action: "set", scope: "tenant:demo" });
    expect(r.confirmed).toBe(true);
    expect(r.capped.map((e) => e.scope)).toEqual(["tenant:demo"]);
  });

  it("a global set is confirmed against an arbitrary tenant, since global binds everyone", async () => {
    const store = new InMemoryRuntimeStore();
    const r = await runCostCap({ store }, { action: "set", scope: "global" });
    expect(r.confirmed).toBe(true);
  });

  it("clear removes only its scope; clear-all empties the registry", async () => {
    const store = new InMemoryRuntimeStore();
    await runCostCap({ store }, { action: "set", scope: "tenant:a" });
    await runCostCap({ store }, { action: "set", scope: "tenant:b" });
    await runCostCap({ store }, { action: "clear", scope: "tenant:a" });
    expect((await costCapStatus(store)).map((e) => e.scope)).toEqual(["tenant:b"]);
    await runCostCap({ store }, { action: "clear", all: true });
    expect(await costCapStatus(store)).toEqual([]);
  });

  it("THROWS rather than returning confirmed:false when the write did not take", async () => {
    // A store whose put silently does nothing — the failure an operator must never see reported as done.
    const store = new InMemoryRuntimeStore();
    const broken = {
      ...store,
      tx: async (_scope: unknown, fn: (t: unknown) => Promise<void>) => {
        await fn({ put: async () => {}, delete: async () => {}, audit: async () => {} });
      },
      list: async () => [],
    } as never;
    await expect(runCostCap({ store: broken }, { action: "set", scope: "global" })).rejects.toThrow(/did not take effect/);
  });

  it("status is read-only — it never changes the registry", async () => {
    const store = new InMemoryRuntimeStore();
    await runCostCap({ store }, { action: "set", scope: "global" });
    const before = await costCapStatus(store);
    await runCostCap({ store }, { action: "status" });
    expect(await costCapStatus(store)).toEqual(before);
  });
});
