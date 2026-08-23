import { describe, it, expect, vi } from "vitest";

// A module-level mock of loop.js — the only reliable way (real ESM live bindings) to force
// `proposeOrExecute` to return "executed" for this one test file, so the defensive assertion in
// `proposeWinBack` can be proven even though it is UNREACHABLE via the real classifier today
// (AUTO_ELIGIBLE_DIMENSIONS.campaign = [] means classifyAction can never return "auto" for a
// send_campaign action — see win-back-propose.test.ts for the real, unmocked path). Campaigns must
// NEVER auto-execute (§3 HITL non-negotiable); this is belt-and-suspenders on that invariant.
vi.mock("../src/loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/loop.js")>();
  return {
    ...actual,
    proposeOrExecute: vi.fn(async () => ({ kind: "executed" as const, result: { ok: true, detail: "sent" } })),
  };
});

import { InMemoryRuntimeStore, InMemoryProposalStore } from "@palup/platform-ports";
import { InMemoryMerchantRulesStore, createRulesProvider } from "../src/rules.js";
import { proposeWinBack } from "../src/agents/win-back.js";
import type { EngineDeps } from "../src/loop.js";

const ctx = { tenantId: "t1" };
const seg = [{ customerId: "c0", contact: "c0@x.com", lastOrderAt: "2026-05-01T00:00:00Z" }];

describe("proposeWinBack — defensive guard", () => {
  it("throws if the loop ever returns 'executed' for a campaign action", async () => {
    const state = new InMemoryRuntimeStore();
    const deps: EngineDeps = {
      store: new InMemoryProposalStore(state),
      state,
      rules: createRulesProvider(new InMemoryMerchantRulesStore(state)),
      executor: vi.fn(async () => ({ ok: true, detail: "sent" })),
      validate: vi.fn(async () => ({ valid: true })),
    };
    await expect(
      proposeWinBack({ segment: seg, draft: { channel: "email", body: "b" }, ctx, now: "2026-08-23T00:00:00Z" }, deps),
    ).rejects.toThrow(/never/i);
  });
});
