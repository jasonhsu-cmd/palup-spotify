# Win-Back Agent (WB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first *new* run-time agent — the **win-back agent** — that turns a segment of lapsed / abandoned-cart customers into a **real Approval-Center proposal** via E1's `proposeOrExecute`, and, on approval, sends the campaign through a comms port. This is the producer that makes W1 meaningful: it proves "console + engine" end-to-end (agent drafts → merchant approves → send executes → audit).

**Architecture:** The win-back agent is a callable unit in `packages/agent-runtime` (its scheduling host is a later plan). It: (1) finds a lapsed-customer segment from order history (`CommercePort`), (2) drafts a campaign message, (3) calls `proposeOrExecute` with a `send_campaign` action — `category:"campaign"`, `blastRadius = segment.length`, and an **irreversible-containment `reversalPlan`** — which the classifier routes to a proposal (campaigns are approval-required by default; a large segment also trips the mass-send floor). On approval, W1 calls `executeApproved`, whose injected `Executor` sends via a new **`CommsPort`** (sandbox adapter on staging — sends are *recorded*, not really delivered, so staging is safe).

**Tech Stack:** TypeScript, vitest. Depends on `@palup/agent-runtime` (`proposeOrExecute`, `executeApproved`, `Executor`, `AgentAction`, `Proposal`), `@palup/platform-ports` (`CommercePort`, a new `CommsPort`, `RuntimeStatePort`), `@palup/agent-runtime` rules (W4-min `RulesProvider`). ATDD. `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm exec vitest run`.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` — §6.1 (the agents), §6.2 (the loop), §9 W1. Depends on **E1** (the loop) and **W4-min** (`RulesProvider`). Consumed by **W1** (which approves its proposals).

## Global Constraints

- **The agent never sends without approval.** Win-back's send is a boundary-crossing action (marketing + irreversible + mass) → it always produces a proposal; the send only happens through `executeApproved` after a human approves. The agent code path must have **no way** to send directly.
- **Irreversible + mass-send honesty.** The `reversalPlan` for a send is honest containment (`reversible:false`, "one-time send to N; suppress the follow-up, exclude from next wave"), and `blastRadius` is the real recipient count so the mass-send floor (W4-min) engages.
- **Comms via a port** (ADR-0001/ADR-0006) — no email/SMS SDK in the agent; the `CommsPort` sandbox adapter *records* sends on staging (no real delivery) so nothing reaches a real shopper before prod enablement.
- **Tenant isolation** — segment + send are scoped to `RuntimeStateCtx`; recipients come from the tenant's own order data only.
- **Governed run-time agent** — its behavior changes go through the evolution pipeline; the eval gate applies before any live stage. For this plan the agent runs on staging behind the sandbox comms adapter.
- Build-time dev against an APPROVED, owned spec; **security-reviewer** (agent autonomy + customer PII in a segment) required; self-merge on gate-green.

## File Structure

- Create `packages/platform-ports/src/comms-port.ts` — `CommsPort` interface + `SandboxCommsAdapter` (records sends), types.
- Create `packages/agent-runtime/src/agents/win-back.ts` — `proposeWinBack(...)`, `campaignExecutor(comms)`, `findLapsedSegment(...)`, `draftWinBack(...)`.
- Create `packages/merchant-backend/src/routes/internal-winback.ts` — a staging-only trigger `POST /_internal/run-winback` (guarded) that runs the agent for the caller's tenant (removed/replaced by the scheduled host later).
- Tests alongside.

## Interfaces (pin these)

```ts
// comms-port.ts
export interface CommsMessage { channel: "email" | "sms"; to: string; subject?: string; body: string; }
export interface CommsPort { send(msgs: CommsMessage[], ctx: RuntimeStateCtx): Promise<{ sent: number; ids: string[] }>; }
export class SandboxCommsAdapter implements CommsPort { readonly recorded: CommsMessage[]; /* records, never delivers */ }

// agents/win-back.ts
import type { Executor } from "../loop.js";
export interface LapsedCustomer { customerId: string; contact: string; lastOrderAt: string; }
export interface WinBackDraft { channel: "email" | "sms"; subject?: string; body: string; }

export function findLapsedSegment(commerce: CommercePort, ctx: RuntimeStateCtx, opts: { lapsedDays: number; now: string }): Promise<LapsedCustomer[]>;
export function draftWinBack(segment: LapsedCustomer[], brand: string): WinBackDraft;   // deterministic template for v1
export function campaignExecutor(comms: CommsPort): Executor;                            // sends the segment on approval
export function proposeWinBack(args: {
  segment: LapsedCustomer[]; draft: WinBackDraft; ctx: RuntimeStateCtx; now: string;
}, deps: EngineDeps): Promise<{ kind: "proposed"; proposal: Proposal }>;                 // always proposes (never auto)
```

The `send_campaign` action params carry `{ recipients: string[], channel, subject, body }`; `campaignExecutor` reads them and calls `comms.send`. The `Proposal.estimatedImpact` carries `{ reach: segment.length }`.

---

### Task 1: `CommsPort` + `SandboxCommsAdapter`

**Files:** Create `packages/platform-ports/src/comms-port.ts`; export from index; create `packages/platform-ports/test/comms-port.test.ts`.

- [ ] **Step 1: Write the failing test** — the sandbox records sends, never throws, returns ids, and is tenant-agnostic in shape:
```ts
import { describe, it, expect } from "vitest";
import { SandboxCommsAdapter } from "../src/comms-port.js";
describe("SandboxCommsAdapter", () => {
  it("records messages and returns a count + ids without delivering", async () => {
    const c = new SandboxCommsAdapter();
    const r = await c.send([{ channel:"email", to:"a@x.com", subject:"come back", body:"hi" }], { tenantId:"t1" });
    expect(r.sent).toBe(1); expect(r.ids).toHaveLength(1);
    expect(c.recorded[0].to).toBe("a@x.com");
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `comms-port.ts` — the `CommsPort` interface + `SandboxCommsAdapter` that pushes to `recorded` and returns deterministic ids (`sandbox:<index>` — no `Math.random`). Export from `packages/platform-ports/src/index.ts`.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(platform-ports): CommsPort + sandbox adapter (records, never delivers)"`

---

### Task 2: `findLapsedSegment` + `draftWinBack` (the agent's inputs)

**Files:** Create `packages/agent-runtime/src/agents/win-back.ts` (these two functions); create `packages/agent-runtime/test/win-back-segment.test.ts`.

- [ ] **Step 1: Write the failing test** — lapsed = last order older than N days; draft is deterministic and includes the brand:
```ts
import { describe, it, expect } from "vitest";
import { findLapsedSegment, draftWinBack } from "../src/agents/win-back.js";
const ctx = { tenantId: "t1" };
const fakeCommerce = { async listCustomersWithLastOrder() { return [
  { customerId:"c1", contact:"c1@x.com", lastOrderAt:"2026-05-01T00:00:00Z" },   // lapsed
  { customerId:"c2", contact:"c2@x.com", lastOrderAt:"2026-08-20T00:00:00Z" } ]; } } as any; // recent
describe("win-back segment", () => {
  it("selects customers whose last order is older than lapsedDays", async () => {
    const seg = await findLapsedSegment(fakeCommerce, ctx, { lapsedDays: 60, now:"2026-08-23T00:00:00Z" });
    expect(seg.map(s=>s.customerId)).toEqual(["c1"]);
  });
  it("drafts a deterministic message naming the brand", () => {
    const d = draftWinBack([{customerId:"c1",contact:"c1@x.com",lastOrderAt:"2026-05-01T00:00:00Z"}], "Auria");
    expect(d.body).toContain("Auria"); expect(d.channel).toBe("email");
  });
});
```
(Confirm the `CommercePort` method that lists customers/last-order; if none exists, add a minimal `listCustomersWithLastOrder` to the port or derive from `getOrderHistory` — grep `packages/platform-ports/src/commerce-port.ts` and adapt; note any port addition in the plan.)

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the two functions; `findLapsedSegment` filters by `now - lastOrderAt > lapsedDays`; `draftWinBack` returns a fixed template referencing the brand (no LLM in v1 — deterministic; a generated draft is a later governed enhancement).
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): win-back segment finder + deterministic draft"`

---

### Task 3: `proposeWinBack` — always produces a proposal (never auto-sends)

**Files:** Modify `packages/agent-runtime/src/agents/win-back.ts`; create `packages/agent-runtime/test/win-back-propose.test.ts`.

- [ ] **Step 1: Write the failing test** — proposes a campaign, blastRadius = segment size, reversalPlan irreversible, and it is NEVER auto (even with a permissive envelope):
```ts
import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { InMemoryMerchantRulesStore, createRulesProvider } from "../src/rules.js";
import { proposeWinBack } from "../src/agents/win-back.js";
const ctx = { tenantId:"t1" };
const seg = Array.from({length: 3}, (_,i)=>({ customerId:`c${i}`, contact:`c${i}@x.com`, lastOrderAt:"2026-05-01T00:00:00Z" }));
const mkDeps = () => { const state = new InMemoryRuntimeStore();
  return { store:new InMemoryProposalStore(state), state, rules:createRulesProvider(new InMemoryMerchantRulesStore(state)),
    executor: vi.fn(async()=>({ok:true,detail:"sent"})), validate: vi.fn(async()=>({valid:true})) }; };
describe("proposeWinBack", () => {
  it("always creates a pending campaign proposal, never auto-sends", async () => {
    const deps = mkDeps();
    const r = await proposeWinBack({ segment: seg, draft:{channel:"email",subject:"s",body:"Auria: come back"}, ctx, now:"2026-08-23T00:00:00Z" }, deps);
    expect(r.kind).toBe("proposed");
    expect(r.proposal.category).toBe("campaign");
    expect(r.proposal.action.blastRadius).toBe(3);
    expect(r.proposal.reversalPlan.reversible).toBe(false);
    expect(deps.executor).not.toHaveBeenCalled();     // nothing sent yet
    expect(r.proposal.estimatedImpact?.reach).toBe(3);
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `proposeWinBack`: build the `send_campaign` `AgentAction` (`params:{recipients: segment.map(s=>s.contact), channel, subject, body}`, `irreversible:true`, `blastRadius: segment.length`), a `reversalPlan` (`reversible:false`, containment text), `rationale`, `estimatedImpact:{reach}`, and call `proposeOrExecute` with `category:"campaign"`. Assert (defensively) the result is `proposed` — if the loop ever returns `executed` for a campaign, throw (campaigns must never auto-execute).
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): proposeWinBack — always proposes, never auto-sends"`

---

### Task 4: `campaignExecutor` — the approved-send path

**Files:** Modify `packages/agent-runtime/src/agents/win-back.ts`; create `packages/agent-runtime/test/win-back-execute.test.ts`.

- [ ] **Step 1: Write the failing test** — after approval, `executeApproved` drives `campaignExecutor`, which sends via the comms port exactly once (idempotent):
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, SandboxCommsAdapter } from "@palup/platform-ports";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { InMemoryMerchantRulesStore, createRulesProvider } from "../src/rules.js";
import { proposeWinBack, campaignExecutor } from "../src/agents/win-back.js";
import { executeApproved } from "../src/loop.js";
const ctx = { tenantId:"t1" };
const seg = [{customerId:"c1",contact:"c1@x.com",lastOrderAt:"2026-05-01T00:00:00Z"}];
it("sends the campaign once on approval", async () => {
  const state = new InMemoryRuntimeStore(); const comms = new SandboxCommsAdapter();
  const deps = { store:new InMemoryProposalStore(state), state,
    rules:createRulesProvider(new InMemoryMerchantRulesStore(state)),
    executor: campaignExecutor(comms), validate: async()=>({valid:true}) };
  const { proposal } = await proposeWinBack({ segment: seg, draft:{channel:"email",subject:"s",body:"b"}, ctx, now:"2026-08-23T00:00:00Z" }, deps);
  await executeApproved(proposal.id, "owner", "2026-08-23T01:00:00Z", deps);
  await executeApproved(proposal.id, "owner", "2026-08-23T01:00:00Z", deps); // idempotent
  expect(comms.recorded).toHaveLength(1);
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `campaignExecutor(comms)`: returns an `Executor` that reads `action.params.recipients/channel/subject/body`, builds `CommsMessage[]`, calls `comms.send(msgs, ctx)`, returns `{ok:true, detail:`sent ${sent}`}`. Idempotency is guaranteed by `executeApproved`'s `executed` short-circuit (E1 Task 6) — the executor itself need not dedupe, but must be pure w.r.t. its inputs.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): campaignExecutor sends via CommsPort on approval"`

---

### Task 5: Staging trigger — `POST /_internal/run-winback`

**Files:** Create `packages/merchant-backend/src/routes/internal-winback.ts`; register; create test.

- [ ] **Step 1: Write the failing test** — an authed owner triggers a win-back run for their tenant; it creates a pending proposal (visible via the store); it does NOT send:
```ts
// buildServer with injected proposal store + rules + a fake CommercePort yielding one lapsed customer
// + SandboxCommsAdapter. POST /_internal/run-winback as owner → 200 { proposedId }. Assert the store
// has one pending campaign proposal and comms.recorded is empty (nothing sent pre-approval).
// A viewer → 403 (requires agent.operate).
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the route (`preHandler: requirePermission("agent.operate")`): derive `ctx` from `req.principal.merchantId`, `findLapsedSegment` → `draftWinBack` → `proposeWinBack`, return `{ proposedId }`. Mark `// staging trigger; replaced by the scheduled runtime host (later plan)`. Keep the CommercePort/CommsPort/store injectable via `buildServer`.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): staging win-back trigger route"`

---

## Final: gate + PR
- [ ] Full gate green; **security-reviewer pass** (agent autonomy + segment PII); open PR (governance-touching — a run-time agent); auto-merge on green. On staging the comms adapter is the sandbox (records, no delivery) — **no real shopper is contacted** until a real `CommsPort` adapter + prod enablement, which are deferred.

## Self-Review
- **Spec coverage:** the win-back agent (§6.1) ✓; produces a real Approval-Center proposal via the loop (§6.2) ✓; never auto-sends (approval-gated) ✓; irreversible-containment reversalPlan + real blastRadius so the mass-send floor engages ✓; comms via a port with a staging sandbox (nothing delivered) ✓; approved-send is idempotent ✓.
- **Contract fit:** uses E1's `proposeOrExecute`/`executeApproved`/`Executor` unchanged; consumes W4-min's `createRulesProvider`. `send_campaign` action shape is the one W1's execute path drives.
- **Type consistency:** `AgentAction`/`Proposal`/`Executor`/`EngineDeps` from `@palup/agent-runtime`; `CommsPort` newly added to platform-ports and consumed only via the port.
- **Safety:** the agent has no direct send path; `proposeWinBack` defensively throws if the loop ever returns `executed` for a campaign; the sandbox adapter guarantees no real delivery on staging.
- **Placeholder scan:** Task 5's test is described in the F3 route-test style (the one spot to finalize); Task 2 flags confirming the real `CommercePort` customer-listing method before wiring; all other tasks carry full red/green code.
- **Determinism:** deterministic draft + sandbox ids (no `Math.random`); `now`/timestamps injected.
