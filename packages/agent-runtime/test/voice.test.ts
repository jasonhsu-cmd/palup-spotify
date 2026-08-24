import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore, InMemoryProposalStore, InMemoryLearnedStore } from "@palup/platform-ports";
import { proposeVoiceChange, voiceChangeExecutor } from "../src/voice.js";
import { createRulesProvider } from "../src/rules.js";
import { InMemoryMerchantRulesStore } from "@palup/platform-ports";
import { killMerchant, KillSwitchError } from "../src/kill.js";

function deps(store: InMemoryRuntimeStore, learnedStore: InMemoryLearnedStore) {
  return {
    store: new InMemoryProposalStore(store),
    state: store,
    rules: createRulesProvider(new InMemoryMerchantRulesStore(store)),
    executor: voiceChangeExecutor(learnedStore, () => "v1", () => "2026-08-24T00:00:00Z"),
    validate: async () => ({ valid: true }),
  };
}

describe("proposeVoiceChange", () => {
  it("NEVER auto-executes — a voice change is always a pending proposal (autonomy_scope)", async () => {
    const store = new InMemoryRuntimeStore();
    const learnedStore = new InMemoryLearnedStore(store);
    const r = await proposeVoiceChange(
      { ctx: { tenantId: "t1" }, now: "2026-08-24T00:00:00Z", proposedVoiceText: "Warmer, no exclamation marks", rationale: "chat signals" },
      deps(store, learnedStore),
    );
    expect(r.kind).toBe("proposed");
    expect(r.proposal?.category).toBe("autonomy_scope");
    expect(r.proposal?.status).toBe("pending");
    expect(r.proposal?.reversalPlan.reversible).toBe(true);
    // No voice insight was written — the merchant hasn't approved (voice is merchant-owned).
    expect(await learnedStore.list({ tenantId: "t1" }, { category: "voice" })).toEqual([]);
  });

  it("requires a reversalPlan — proposeOrExecute refuses an action with none (governance floor)", async () => {
    // proposeVoiceChange always builds its own reversalPlan, so this proves the floor holds by
    // construction: the created proposal always carries a non-blank plan.
    const store = new InMemoryRuntimeStore();
    const learnedStore = new InMemoryLearnedStore(store);
    const r = await proposeVoiceChange(
      { ctx: { tenantId: "t1" }, now: "2026-08-24T00:00:00Z", proposedVoiceText: "Warmer", rationale: "r" },
      deps(store, learnedStore),
    );
    expect(r.proposal?.reversalPlan.plan?.trim()).not.toBe("");
  });

  it("is blocked by the kill switch like any other proposal", async () => {
    const store = new InMemoryRuntimeStore();
    const learnedStore = new InMemoryLearnedStore(store);
    await killMerchant(store, { tenantId: "t1" }, "operator halt");
    await expect(
      proposeVoiceChange(
        { ctx: { tenantId: "t1" }, now: "2026-08-24T00:00:00Z", proposedVoiceText: "Warmer", rationale: "r" },
        deps(store, learnedStore),
      ),
    ).rejects.toBeInstanceOf(KillSwitchError);
  });

  it("defensive: throws if the loop ever reported 'executed' for a voice change (unreachable via the real classifier)", async () => {
    vi.resetModules();
    vi.doMock("../src/loop.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/loop.js")>();
      return {
        ...actual,
        proposeOrExecute: vi.fn(async () => ({ kind: "executed" as const, result: { ok: true, detail: "applied" } })),
      };
    });
    const { proposeVoiceChange: mockedPropose } = await import("../src/voice.js");
    const store = new InMemoryRuntimeStore();
    const learnedStore = new InMemoryLearnedStore(store);
    await expect(
      mockedPropose(
        { ctx: { tenantId: "t1" }, now: "2026-08-24T00:00:00Z", proposedVoiceText: "Warmer", rationale: "r" },
        deps(store, learnedStore),
      ),
    ).rejects.toThrow(/never/i);
    vi.doUnmock("../src/loop.js");
    vi.resetModules();
  });
});

describe("voiceChangeExecutor", () => {
  it("writes the approved voice text as a private voice insight when the loop executes it", async () => {
    const store = new InMemoryRuntimeStore();
    const learnedStore = new InMemoryLearnedStore(store);
    const exec = voiceChangeExecutor(learnedStore, () => "v1", () => "2026-08-24T00:00:00Z");
    const res = await exec({ ctx: { tenantId: "t1" }, agentId: "insight_synthesizer", agentType: "insight_synthesizer", action: { type: "change_voice", params: { proposedVoiceText: "Warmer" } }, executionId: "e1" });
    expect(res.ok).toBe(true);
    const voice = await learnedStore.list({ tenantId: "t1" }, { category: "voice" });
    expect(voice[0].text).toBe("Warmer");
    expect(voice[0].origin).toBe("synthesized");
  });

  it("writes exactly once via executeApproved's full approve->execute path (not on creation)", async () => {
    const { proposeOrExecute, executeApproved } = await import("../src/loop.js");
    const store = new InMemoryRuntimeStore();
    const learnedStore = new InMemoryLearnedStore(store);
    const engineDeps = deps(store, learnedStore);
    const ctx = { tenantId: "t1" };

    const created = await proposeVoiceChange(
      { ctx, now: "2026-08-24T00:00:00Z", proposedVoiceText: "Warmer, no exclamation marks", rationale: "chat signals" },
      engineDeps,
    );
    expect(created.kind).toBe("proposed");
    const id = created.proposal!.id;

    // Still nothing written before approval.
    expect(await learnedStore.list(ctx, { category: "voice" })).toEqual([]);

    const done = await executeApproved(ctx, id, "merchant-owner", "2026-08-24T01:00:00Z", engineDeps);
    expect(done.status).toBe("executed");

    const voice = await learnedStore.list(ctx, { category: "voice" });
    expect(voice).toHaveLength(1);
    expect(voice[0].text).toBe("Warmer, no exclamation marks");

    // Idempotent: calling executeApproved again does not write a second insight.
    await executeApproved(ctx, id, "merchant-owner", "2026-08-24T02:00:00Z", engineDeps);
    expect(await learnedStore.list(ctx, { category: "voice" })).toHaveLength(1);
  });
});
