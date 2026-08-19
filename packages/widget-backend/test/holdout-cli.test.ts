import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { readHoldoutConfig } from "../src/holdout.js";
import { HoldoutArgsError, parseHoldoutArgv, runHoldout } from "../src/jobs/holdout.js";

// The operator entry point for the business HOLDOUT (Wave 2 / W2-B, ADR-0007). Mirrors
// kill-switch-job.test.ts / cost-cap-cli.test.ts's own shape: does the command an operator actually
// runs write the SAME config the serving path (`readHoldoutConfig`) reads, is it audited, does it read
// back a confirmed end state rather than assuming one, and does a bad fraction get clamped rather than
// silently misread later.

describe("holdout CLI — argument parsing", () => {
  it("an unknown or missing subcommand is refused", () => {
    expect(() => parseHoldoutArgv([])).toThrow(HoldoutArgsError);
    expect(() => parseHoldoutArgv(["enable"])).toThrow(HoldoutArgsError);
  });

  it("set/status both require a tenantId as the first argument", () => {
    expect(() => parseHoldoutArgv(["set"])).toThrow(HoldoutArgsError);
    expect(() => parseHoldoutArgv(["set", "--reason", "x"])).toThrow(HoldoutArgsError);
    expect(() => parseHoldoutArgv(["status"])).toThrow(HoldoutArgsError);
  });

  it("set requires a literal true|false as its second argument", () => {
    expect(() => parseHoldoutArgv(["set", "acme"])).toThrow(HoldoutArgsError);
    expect(() => parseHoldoutArgv(["set", "acme", "yes"])).toThrow(HoldoutArgsError);
    expect(parseHoldoutArgv(["set", "acme", "true"])).toMatchObject({ action: "set", tenantId: "acme", enabled: true });
    expect(parseHoldoutArgv(["set", "acme", "false"])).toMatchObject({ action: "set", tenantId: "acme", enabled: false });
  });

  it("an optional numeric fraction is parsed; a non-numeric one is refused", () => {
    expect(parseHoldoutArgv(["set", "acme", "true", "0.2"])).toMatchObject({ tenantId: "acme", enabled: true, fraction: 0.2 });
    expect(() => parseHoldoutArgv(["set", "acme", "true", "not-a-number"])).toThrow(HoldoutArgsError);
  });

  it("fraction is OMITTED when absent — not defaulted here (runHoldout decides keep-current)", () => {
    expect(parseHoldoutArgv(["set", "acme", "true"])).toEqual({ action: "set", tenantId: "acme", enabled: true });
  });

  it("--reason is accepted with or without an explicit fraction", () => {
    expect(parseHoldoutArgv(["set", "acme", "true", "--reason", "q4 experiment"])).toMatchObject({ reason: "q4 experiment" });
    expect(parseHoldoutArgv(["set", "acme", "true", "0.3", "--reason", "q4 experiment"])).toMatchObject({
      fraction: 0.3,
      reason: "q4 experiment",
    });
    expect(() => parseHoldoutArgv(["set", "acme", "true", "--reason"])).toThrow(HoldoutArgsError);
  });

  it("status takes only a tenantId — no trailing arguments", () => {
    expect(parseHoldoutArgv(["status", "acme"])).toEqual({ action: "status", tenantId: "acme" });
    expect(() => parseHoldoutArgv(["status", "acme", "extra"])).toThrow(HoldoutArgsError);
  });

  it("a trailing unknown argument on set is refused rather than silently ignored", () => {
    expect(() => parseHoldoutArgv(["set", "acme", "true", "0.2", "extra"])).toThrow(HoldoutArgsError);
  });
});

describe("holdout CLI — set writes + audits the config (NN #5)", () => {
  it("writes {enabled, fraction} to the SAME config the serving path reads", async () => {
    const store = new InMemoryRuntimeStore();

    const report = await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "0.25"]));

    expect(report.confirmed).toBe(true);
    expect(report.config).toEqual({ enabled: true, fraction: 0.25 });
    expect(await readHoldoutConfig(store, "acme")).toEqual({ enabled: true, fraction: 0.25 });
  });

  it("writes an audit row with actor/action/input/decision/reversalPath naming a real script", async () => {
    const store = new InMemoryRuntimeStore();

    await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "0.4", "--reason", "incrementality pilot"]));

    const audit = await store.readAudit({ tenantId: "acme" });
    expect(audit).toHaveLength(1);
    const rec = audit[0]!;
    expect(rec.action).toBe("holdout_config.enable");
    expect(rec.actor).toBe("operator");
    expect(rec.input).toMatchObject({ tenantId: "acme", enabled: true, fraction: 0.4, reason: "incrementality pilot" });
    expect(rec.decision).toBe("holdout_enabled");
    expect(rec.reversalPath).toContain("pnpm holdout:set acme false");
    expect((await store.verifyAudit({ tenantId: "acme" })).ok).toBe(true);
  });

  it("disabling audits `holdout_config.disable` with decision `holdout_disabled`", async () => {
    const store = new InMemoryRuntimeStore();
    await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "0.5"]));

    await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "false"]));

    const audit = await store.readAudit({ tenantId: "acme" });
    const rec = audit[audit.length - 1]!;
    expect(rec.action).toBe("holdout_config.disable");
    expect(rec.decision).toBe("holdout_disabled");
    expect(await readHoldoutConfig(store, "acme")).toEqual({ enabled: false, fraction: 0.5 });
  });

  it("a DIFFERENT tenant's config and audit trail are unaffected", async () => {
    const store = new InMemoryRuntimeStore();
    await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "0.3"]));

    expect(await readHoldoutConfig(store, "other")).toEqual({ enabled: false, fraction: 0 });
    expect(await store.readAudit({ tenantId: "other" })).toEqual([]);
  });
});

describe("holdout CLI — omitted fraction keeps the current value", () => {
  it("first-ever set with no fraction keeps the honest default (0)", async () => {
    const store = new InMemoryRuntimeStore();
    const report = await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true"]));
    expect(report.config).toEqual({ enabled: true, fraction: 0 });
  });

  it("a later set with no fraction preserves whatever fraction was already stored", async () => {
    const store = new InMemoryRuntimeStore();
    await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "0.35"]));

    const report = await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "false"]));

    expect(report.config).toEqual({ enabled: false, fraction: 0.35 });
  });

  it("an explicit fraction on a later call DOES override the stored one", async () => {
    const store = new InMemoryRuntimeStore();
    await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "0.35"]));

    const report = await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "0.9"]));

    expect(report.config).toEqual({ enabled: true, fraction: 0.9 });
  });
});

describe("holdout CLI — fraction clamps to [0,1]", () => {
  it("a fraction above 1 is clamped to 1, not written or read back verbatim", async () => {
    const store = new InMemoryRuntimeStore();
    const report = await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "5"]));
    expect(report.config.fraction).toBe(1);
    expect(await readHoldoutConfig(store, "acme")).toEqual({ enabled: true, fraction: 1 });
  });

  it("a negative fraction is clamped to 0", async () => {
    const store = new InMemoryRuntimeStore();
    const report = await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "-3"]));
    expect(report.config.fraction).toBe(0);
  });

  it("the audited input records the CLAMPED value, not the raw operator input", async () => {
    const store = new InMemoryRuntimeStore();
    await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "5"]));
    const audit = await store.readAudit({ tenantId: "acme" });
    expect((audit[0]!.input as { fraction: number }).fraction).toBe(1);
  });
});

describe("holdout CLI — status reads back without mutating", () => {
  it("status on an unconfigured tenant reports the honest default", async () => {
    const store = new InMemoryRuntimeStore();
    const report = await runHoldout({ store }, parseHoldoutArgv(["status", "acme"]));
    expect(report).toMatchObject({ action: "status", tenantId: "acme", config: { enabled: false, fraction: 0 }, confirmed: true });
    expect(await store.readAudit({ tenantId: "acme" })).toEqual([]);
  });

  it("status reflects exactly what set last wrote, and audits nothing new", async () => {
    const store = new InMemoryRuntimeStore();
    await runHoldout({ store }, parseHoldoutArgv(["set", "acme", "true", "0.15"]));

    const report = await runHoldout({ store }, parseHoldoutArgv(["status", "acme"]));

    expect(report.config).toEqual({ enabled: true, fraction: 0.15 });
    expect(await store.readAudit({ tenantId: "acme" })).toHaveLength(1); // only the set, status added nothing
  });
});

describe("holdout CLI — never reports an unverified outcome", () => {
  it("THROWS rather than returning confirmed:false when the write did not take", async () => {
    const store = new InMemoryRuntimeStore();
    const forgetful = {
      ...store,
      tx: store.tx.bind(store),
      get: async () => null, // the read-back never sees the write
    } as unknown as typeof store;

    await expect(runHoldout({ store: forgetful }, parseHoldoutArgv(["set", "acme", "true", "0.2"]))).rejects.toThrow(
      /did NOT take effect|unconfirmed/i,
    );
  });
});
