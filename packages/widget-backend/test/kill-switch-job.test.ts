import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { InMemoryRuntimeStore, type RuntimeStatePort } from "@palup/platform-ports";
import { killStatus } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import {
  KillArgsError,
  parseKillArgv,
  parseKillScope,
  resolveKillStore,
  runKillSwitch,
} from "../src/jobs/kill-switch.js";

// The OPS CLI behind governance non-negotiable #4 ("any agent, at any scope, can be halted instantly").
//
// WHY THIS SUITE EXISTS. The kill-switch HONOR path was already thorough and tested (kill-switch.test.ts
// proves /chat halts) — but the only ARMING caller was the control-plane HTTP server, which this repo
// does not deploy. Halting the live widget meant hand-writing a row into Cloud SQL. So what is under test
// here is not "does a kill halt serving" (already covered) but the OPERATOR ENTRY POINT: does the command
// an operator actually runs arm the registry the serving path reads, is it audited, is it reversible, and
// is it impossible to arm the wrong (wider) scope by accident.

const SYSTEM = { tenantId: "__system__" };

describe("kill-switch CLI — argument parsing refuses to guess a scope (NN #4)", () => {
  it("ABSENT --scope IS REFUSED, never silently widened to global", async () => {
    // The single most dangerous default in an ops tool: `pnpm kill:arm` with a forgotten flag halting
    // every merchant on the platform. The control-plane's HTTP route defaults `scope ?? "global"`; this
    // entry point deliberately does NOT.
    expect(() => parseKillArgv(["arm"])).toThrow(KillArgsError);
    expect(() => parseKillArgv(["arm"])).toThrow(/--scope/);
    expect(() => parseKillArgv(["disarm"])).toThrow(KillArgsError);
  });

  it("a --scope flag with no value, or an unparseable scope, is refused", () => {
    expect(() => parseKillArgv(["arm", "--scope"])).toThrow(KillArgsError);
    expect(() => parseKillArgv(["arm", "--scope", "everything"])).toThrow(KillArgsError);
    expect(() => parseKillArgv(["arm", "--scope", "--reason"])).toThrow(KillArgsError);
    expect(() => parseKillScope("tenant:")).toThrow(KillArgsError); // empty tenant id
    expect(() => parseKillScope("agent:")).toThrow(KillArgsError);
    expect(() => parseKillScope("tenant")).toThrow(KillArgsError);
    expect(() => parseKillScope("GLOBAL")).toThrow(KillArgsError); // case-exact, no fuzzy matching
  });

  it("accepts exactly the three governed scopes, in both flag spellings", () => {
    expect(parseKillArgv(["arm", "--scope", "global"])).toMatchObject({ action: "arm", scope: "global" });
    expect(parseKillArgv(["arm", "--scope=tenant:demo"])).toMatchObject({ action: "arm", scope: "tenant:demo" });
    expect(parseKillArgv(["arm", "--scope", "agent:shopper"])).toMatchObject({ action: "arm", scope: "agent:shopper" });
    expect(parseKillArgv(["arm", "--scope", "global", "--reason", "vendor outage"]).reason).toBe("vendor outage");
  });

  it("an unknown or missing subcommand is refused rather than assumed", () => {
    expect(() => parseKillArgv([])).toThrow(KillArgsError);
    expect(() => parseKillArgv(["halt", "--scope", "global"])).toThrow(KillArgsError);
    expect(() => parseKillArgv(["--scope", "global"])).toThrow(KillArgsError);
  });

  it("status takes no scope; disarm-everything requires the EXPLICIT `--scope all`", () => {
    expect(parseKillArgv(["status"])).toEqual({ action: "status" });
    expect(parseKillArgv(["disarm", "--scope", "all"])).toEqual({ action: "disarm", scope: undefined, all: true });
    expect(parseKillArgv(["disarm", "--scope", "tenant:demo"])).toMatchObject({ action: "disarm", scope: "tenant:demo" });
    expect(() => parseKillArgv(["arm", "--scope", "all"])).toThrow(KillArgsError); // "all" is not armable
  });
});

describe("kill-switch CLI — arming (governance NN #4 + audit NN #5)", () => {
  it("arming via the CLI entry point writes the `runtime_kill.arm` audit row", async () => {
    const store = new InMemoryRuntimeStore();

    await runKillSwitch({ store }, parseKillArgv(["arm", "--scope", "tenant:demo", "--reason", "spike"]));

    const audit = await store.readAudit(SYSTEM);
    expect(audit.map((a) => a.action)).toEqual(["runtime_kill.arm"]);
    expect(audit[0]!.actor).toBe("operator");
    expect(audit[0]!.input).toMatchObject({ scope: "tenant:demo", reason: "spike" });
    expect(audit[0]!.decision).toBe("armed");
    // The logged reversal path must name a command that EXISTS (NN #5): it used to name only
    // `POST /api/runtime-unkill`, a route on a service this repo does not deploy.
    expect(audit[0]!.reversalPath).toContain("pnpm kill:disarm");
    expect((await store.verifyAudit(SYSTEM)).ok).toBe(true);
  });

  it("the report READS BACK the registry, so a halt is confirmed rather than assumed", async () => {
    const store = new InMemoryRuntimeStore();

    const report = await runKillSwitch({ store }, { action: "arm", scope: "global", reason: "drill" });

    expect(report.action).toBe("arm");
    expect(report.confirmed).toBe(true);
    expect(report.armed.map((e) => e.scope)).toEqual(["global"]);
    expect(await killStatus(store)).toHaveLength(1);
  });

  it("a store that accepts the write but does not surface the scope FAILS LOUDLY, never no-ops", async () => {
    // A halt reported as done but not actually armed is the worst possible outcome for NN #4, so the
    // read-back is a hard assertion, not a log line.
    const store = new InMemoryRuntimeStore();
    const forgetful = {
      tx: store.tx.bind(store), // the write itself succeeds (and is audited)…
      list: async () => [], // …but the registry never surfaces the scope
    } as unknown as RuntimeStatePort;

    await expect(runKillSwitch({ store: forgetful }, { action: "arm", scope: "global" })).rejects.toThrow(
      /not armed|unconfirmed/i,
    );
  });

  it("an agent type nothing runs under is REFUSED — it would read as armed and halt nothing", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(runKillSwitch({ store }, parseKillArgv(["arm", "--scope", "agent:shoper"]))).rejects.toThrow(
      /no run-time agent type "shoper"/,
    );
    expect(await killStatus(store)).toEqual([]);
    // the real one still works
    const ok = await runKillSwitch({ store }, parseKillArgv(["arm", "--scope", "agent:shopper"]));
    expect(ok.armed.map((e) => e.scope)).toEqual(["agent:shopper"]);
  });

  it("a tenant this deployment does not serve is ARMED BUT FLAGGED — never blocked, never silent", async () => {
    // Refusing would be worse: the tenant list is env config, and an emergency halt must not depend on
    // this tool's view of it being complete. So it arms and warns.
    const store = new InMemoryRuntimeStore();
    const env = { SHOPIFY_STORES: JSON.stringify({ "alpha-co": "alpha.myshopify.com" }) } as NodeJS.ProcessEnv;

    const typo = await runKillSwitch({ store, env }, parseKillArgv(["arm", "--scope", "tenant:alpha-c"]));
    expect(typo.armed.map((e) => e.scope)).toEqual(["tenant:alpha-c"]); // armed regardless
    expect(typo.warnings.join(" ")).toMatch(/not in this deployment's configured tenants/);

    const known = await runKillSwitch({ store, env }, parseKillArgv(["arm", "--scope", "tenant:alpha-co"]));
    expect(known.warnings).toEqual([]);
  });

  it("programmatic callers cannot arm without a scope either — the guard is not CLI-only", async () => {
    const store = new InMemoryRuntimeStore();
    await expect(runKillSwitch({ store }, { action: "arm" })).rejects.toThrow(KillArgsError);
    expect(await killStatus(store)).toEqual([]);
  });
});

describe("kill-switch CLI — end-to-end against the live serving path", () => {
  it("ARM VIA THE CLI, THEN /chat IS HALTED — the ops path reaches the shopper-facing agent", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });

    await runKillSwitch({ store }, parseKillArgv(["arm", "--scope", "global", "--reason", "e2e"]));

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "cli-1", message: "help me pick a serum", signals: {} },
    });
    const body = res.json();
    expect(body.flags).toContain("kill_switch");
    expect(body.escalate).toBe(true);
    expect(body.pitch).toBe("none");
    await app.close();
  });

  it("DISARM VIA THE CLI REVERSES IT — serving resumes and the reversal is audited", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    await runKillSwitch({ store }, parseKillArgv(["arm", "--scope", "global", "--reason", "e2e"]));

    const report = await runKillSwitch({ store }, parseKillArgv(["disarm", "--scope", "global"]));

    expect(report.armed).toEqual([]);
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "cli-2", message: "help me pick a serum", signals: {} },
    });
    expect(res.json().flags).not.toContain("kill_switch");
    expect((await store.readAudit(SYSTEM)).map((a) => a.action)).toEqual(["runtime_kill.arm", "runtime_kill.disarm"]);
    await app.close();
  });

  it("a tenant-scoped CLI arm halts that merchant only — the narrow scopes really are usable", async () => {
    const store = new InMemoryRuntimeStore();
    await runKillSwitch({ store }, parseKillArgv(["arm", "--scope", "tenant:other-co"]));
    const app = await buildServer({ store });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "cli-3", message: "help me pick a serum", signals: {} },
    });
    expect(res.json().flags).not.toContain("kill_switch"); // default tenant is `demo`, not `other-co`
    await app.close();
  });
});

describe("kill-switch CLI — status and scoped disarm", () => {
  it("status reports every armed scope with its reason, and mutates nothing", async () => {
    const store = new InMemoryRuntimeStore();
    await runKillSwitch({ store }, { action: "arm", scope: "global", reason: "platform freeze" });
    await runKillSwitch({ store }, { action: "arm", scope: "tenant:demo", reason: "merchant request" });

    const report = await runKillSwitch({ store }, parseKillArgv(["status"]));

    expect(report.armed.map((e) => e.scope).sort()).toEqual(["global", "tenant:demo"]);
    expect(report.armed.find((e) => e.scope === "tenant:demo")?.reason).toBe("merchant request");
    expect(report.armed.every((e) => typeof e.at === "string")).toBe(true);
    // status is read-only: only the two arms are audited, no third entry.
    expect((await store.readAudit(SYSTEM)).map((a) => a.action)).toEqual(["runtime_kill.arm", "runtime_kill.arm"]);
  });

  it("status on a clean registry reports nothing armed", async () => {
    const report = await runKillSwitch({ store: new InMemoryRuntimeStore() }, { action: "status" });
    expect(report.armed).toEqual([]);
    expect(report.confirmed).toBe(true);
  });

  it("a scoped disarm lifts ONE scope and leaves the others armed", async () => {
    const store = new InMemoryRuntimeStore();
    await runKillSwitch({ store }, { action: "arm", scope: "global" });
    await runKillSwitch({ store }, { action: "arm", scope: "tenant:demo" });

    const report = await runKillSwitch({ store }, parseKillArgv(["disarm", "--scope", "tenant:demo"]));

    expect(report.armed.map((e) => e.scope)).toEqual(["global"]);
  });

  it("`disarm --scope all` lifts everything — the explicit form does work", async () => {
    const store = new InMemoryRuntimeStore();
    await runKillSwitch({ store }, { action: "arm", scope: "global" });
    await runKillSwitch({ store }, { action: "arm", scope: "agent:shopper" });

    const report = await runKillSwitch({ store }, parseKillArgv(["disarm", "--scope", "all"]));

    expect(report.armed).toEqual([]);
    expect(await killStatus(store)).toEqual([]);
  });
});

describe("kill-switch CLI — it refuses to operate on a store nobody else can see (NN #4)", () => {
  it("NO DATABASE_URL ⇒ HARD FAILURE, not a per-process in-memory store that silently no-ops", async () => {
    // `createRuntimeStore()` falls back to an in-memory store when DATABASE_URL is unset. For the SERVER
    // that is a usable dev default; for THIS tool it is the failure mode the whole PR exists to remove —
    // the operator would see "armed", and the deployed backend (a different process, a different store)
    // would keep serving shoppers.
    await expect(resolveKillStore({} as NodeJS.ProcessEnv)).rejects.toThrow(/DATABASE_URL/);
    await expect(resolveKillStore({ DATABASE_URL: "" } as NodeJS.ProcessEnv)).rejects.toThrow(/DATABASE_URL/);
  });
});

describe("docs/DEPLOY.md runbook", () => {
  const root = new URL("../../../", import.meta.url);
  const scripts = Object.keys(JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts);
  const deployDoc = readFileSync(new URL("docs/DEPLOY.md", root), "utf8");

  it("documents how to halt the live agent, naming the kill scripts", () => {
    expect(deployDoc).toContain("How to halt the live agent");
    for (const s of ["kill:arm", "kill:status", "kill:disarm"]) {
      expect(scripts).toContain(s);
      expect(deployDoc).toContain(`pnpm ${s}`);
    }
  });

  it("the reversal path recorded in the audit log names a script that exists", async () => {
    const store = new InMemoryRuntimeStore();
    await runKillSwitch({ store }, { action: "arm", scope: "global" });
    await runKillSwitch({ store }, { action: "disarm", scope: "global" });
    const paths = (await store.readAudit(SYSTEM)).map((a) => a.reversalPath ?? "");
    for (const p of paths) {
      const named = [...p.matchAll(/\bpnpm ([a-z][a-z0-9:]*)/g)].map((m) => m[1]!);
      expect(named.length).toBeGreaterThan(0);
      expect(named.filter((s) => !scripts.includes(s))).toEqual([]);
    }
  });

  it("every `pnpm <script>` the runbook names actually exists in package.json", () => {
    // A runbook is only useful in an incident if its commands run. pnpm's own subcommands are excluded.
    const builtin = new Set(["install", "run", "exec", "dlx", "add", "remove", "why", "list"]);
    const named = [...deployDoc.matchAll(/\bpnpm ((?:[a-z][a-z0-9]*)(?::[a-z0-9:_-]+)*)\b/g)]
      .map((m) => m[1]!)
      .filter((s) => !builtin.has(s));
    expect(named.length).toBeGreaterThan(0);
    expect([...new Set(named)].filter((s) => !scripts.includes(s))).toEqual([]);
  });
});
