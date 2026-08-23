import { describe, it, expect } from "vitest";
import { SandboxCommsAdapter, InMemoryRuntimeStore, InMemoryProposalStore } from "@palup/platform-ports";
import { createRulesProvider } from "@palup/agent-runtime";
import { InMemoryMerchantRulesStore } from "@palup/platform-ports";
import { resolveExecutor, resolveValidator, buildEngineDeps } from "../src/engine-wiring.js";

// Task 1 (W1-API): the executor/validator registry the approve path (`executeApproved`) is built
// on. `resolveExecutor`/`resolveValidator` signatures verified against the REAL `Executor` /
// `PreconditionValidator` types in `packages/agent-runtime/src/loop.ts` (single-object `ExecutorInput`
// arg: `{ ctx, agentId, agentType, action, executionId? }` — NOT the two-positional-arg call shown in
// the task-1 brief's sketch, which does not match that type).

describe("resolveExecutor", () => {
  it("routes send_campaign to the campaign executor, which drives the comms sandbox", async () => {
    const comms = new SandboxCommsAdapter();
    const exec = resolveExecutor("send_campaign", { comms });

    const result = await exec({
      ctx: { tenantId: "t1" },
      agentId: "a1",
      agentType: "win_back",
      action: {
        type: "send_campaign",
        params: { recipients: ["a@x.com"], channel: "email", subject: "s", body: "b" },
      },
    });

    expect(result.ok).toBe(true);
    expect(comms.recorded).toHaveLength(1);
    expect(comms.recorded[0]?.to).toBe("a@x.com");
    expect(comms.recorded[0]?.tenantId).toBe("t1");
  });

  it("throws on an unregistered action type — never a silent no-op", () => {
    expect(() => resolveExecutor("mystery", { comms: new SandboxCommsAdapter() })).toThrow(/no executor/i);
  });
});

describe("resolveValidator", () => {
  it("campaign always validates (v1 — no real revalidation yet)", async () => {
    const validator = resolveValidator("campaign", { comms: new SandboxCommsAdapter() });
    const result = await validator(
      {
        id: "p1",
        tenantId: "t1",
        agentId: "a1",
        agentType: "win_back",
        action: { type: "send_campaign", params: {} },
        category: "campaign",
        rationale: "r",
        boundaryReasons: [],
        reversalPlan: { reversible: false, plan: "contain + correct" },
        preconditions: {},
        status: "pending",
        version: 0,
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-01-04T00:00:00Z",
      },
      { tenantId: "t1" },
    );
    expect(result.valid).toBe(true);
  });

  it("throws on an unregistered category — never a silent always-valid", () => {
    expect(() => resolveValidator("discount", { comms: new SandboxCommsAdapter() })).toThrow(/no validator/i);
  });
});

describe("buildEngineDeps", () => {
  it("composes store/state/rules with the resolved executor + validator", async () => {
    const state = new InMemoryRuntimeStore();
    const store = new InMemoryProposalStore(state);
    const rules = createRulesProvider(new InMemoryMerchantRulesStore(state));
    const comms = new SandboxCommsAdapter();

    const deps = buildEngineDeps({
      store,
      state,
      rules,
      actionType: "send_campaign",
      category: "campaign",
      comms,
    });

    expect(deps.store).toBe(store);
    expect(deps.state).toBe(state);
    expect(deps.rules).toBe(rules);
    expect(typeof deps.executor).toBe("function");
    expect(typeof deps.validate).toBe("function");

    const execResult = await deps.executor({
      ctx: { tenantId: "t1" },
      agentId: "a1",
      agentType: "win_back",
      action: { type: "send_campaign", params: { recipients: ["a@x.com"], channel: "email", body: "b" } },
    });
    expect(execResult.ok).toBe(true);
    expect(comms.recorded).toHaveLength(1);
  });

  it("throws building deps for an unregistered action type", () => {
    const state = new InMemoryRuntimeStore();
    expect(() =>
      buildEngineDeps({
        store: new InMemoryProposalStore(state),
        state,
        rules: createRulesProvider(new InMemoryMerchantRulesStore(state)),
        actionType: "mystery",
        category: "campaign",
        comms: new SandboxCommsAdapter(),
      }),
    ).toThrow(/no executor/i);
  });
});
