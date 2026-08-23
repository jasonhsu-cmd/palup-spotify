import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, InMemoryProposalStore, SandboxCommsAdapter } from "@palup/platform-ports";
import { InMemoryMerchantRulesStore, createRulesProvider } from "../src/rules.js";
import { proposeWinBack, campaignExecutor } from "../src/agents/win-back.js";
import { executeApproved } from "../src/loop.js";
import type { EngineDeps } from "../src/loop.js";

const ctx = { tenantId: "t1" };
const seg = [{ customerId: "c1", contact: "c1@x.com", lastOrderAt: "2026-05-01T00:00:00Z" }];

describe("campaignExecutor", () => {
  it("sends the campaign once on approval (idempotent re-approve is a no-op)", async () => {
    const state = new InMemoryRuntimeStore();
    const comms = new SandboxCommsAdapter();
    const deps: EngineDeps = {
      store: new InMemoryProposalStore(state),
      state,
      rules: createRulesProvider(new InMemoryMerchantRulesStore(state)),
      executor: campaignExecutor(comms),
      validate: async () => ({ valid: true }),
    };
    const { proposal } = await proposeWinBack(
      { segment: seg, draft: { channel: "email", subject: "s", body: "b" }, ctx, now: "2026-08-23T00:00:00Z" },
      deps,
    );
    if (!proposal) throw new Error("expected a pending proposal");

    const done1 = await executeApproved(ctx, proposal.id, "owner", "2026-08-23T01:00:00Z", deps);
    expect(done1.status).toBe("executed");
    const done2 = await executeApproved(ctx, proposal.id, "owner", "2026-08-23T01:00:00Z", deps); // idempotent
    expect(done2.status).toBe("executed");

    expect(comms.recorded).toHaveLength(1);
    expect(comms.recorded[0]?.to).toBe("c1@x.com");
    expect(comms.recorded[0]?.subject).toBe("s");
    expect(comms.recorded[0]?.body).toBe("b");
    expect(comms.recorded[0]?.tenantId).toBe("t1");
  });

  it("sends one message per recipient across a multi-customer segment", async () => {
    const state = new InMemoryRuntimeStore();
    const comms = new SandboxCommsAdapter();
    const multiSeg = [
      { customerId: "c1", contact: "c1@x.com", lastOrderAt: "2026-05-01T00:00:00Z" },
      { customerId: "c2", contact: "c2@x.com", lastOrderAt: "2026-05-02T00:00:00Z" },
    ];
    const deps: EngineDeps = {
      store: new InMemoryProposalStore(state),
      state,
      rules: createRulesProvider(new InMemoryMerchantRulesStore(state)),
      executor: campaignExecutor(comms),
      validate: async () => ({ valid: true }),
    };
    const { proposal } = await proposeWinBack(
      { segment: multiSeg, draft: { channel: "email", body: "b" }, ctx, now: "2026-08-23T00:00:00Z" },
      deps,
    );
    if (!proposal) throw new Error("expected a pending proposal");
    await executeApproved(ctx, proposal.id, "owner", "2026-08-23T01:00:00Z", deps);
    expect(comms.recorded.map((m) => m.to)).toEqual(["c1@x.com", "c2@x.com"]);
  });
});
