# Engine Core — Proposal Loop, Audit, Kill Switch (E1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared engine primitives every run-time agent uses to cross a governance boundary safely: the **Proposal** model + store, the **`classifyAction` → propose-or-execute** loop, **Kill-Switch** enforcement, and **hash-chained audit** — as a new `packages/agent-runtime` package. This is the contract that W1 (Approval Center), Minimal W4 (Rules), and the Win-back agent all consume.

**Architecture:** `agent-runtime` composes existing primitives rather than reinventing them — the three-scope Kill-Switch registry and the hash-chained audit chain already live in `@palup/state-postgres` / `@palup/platform-ports`, and the Proposal store follows the established **registry-over-`RuntimeStatePort`** pattern (mirroring `outcome-ledger`, `cost-cap-registry`). It exposes: a `Proposal` domain model + lifecycle, a `ProposalStore` (in-memory + Postgres adapters), `classifyAction()` (the HITL classifier — the `hitl-approval-gate` pattern, reading a `RulesProvider` seam that Minimal W4 implements), `proposeOrExecute()` (the loop), `executeApproved()` (re-validate + idempotent execute, called by W1), and Kill-Switch guards. No GKE/deploy concerns here — this is the pure engine library; the runtime host process and its deploy are a later plan.

**Tech Stack:** TypeScript, vitest. Depends on `@palup/platform-ports` (`RuntimeStatePort`, audit-hash) and `@palup/state-postgres` (the kill registry, the Postgres store). ATDD. `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm exec vitest run`.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` — §6 (the engine), §6.2 (proposal→approval loop), §6.3 (governance rails). Governed by ADR-0005 (agent-runtime execution model, Accepted), ADR-0002 (two-plane), the `hitl-approval-gate` skill.

## Global Constraints

- **Reuse, don't reinvent.** The Kill-Switch is the existing shared three-scope registry in `@palup/state-postgres` (`armKill`/`disarmKill`/`killStatus`/`matchedKill`, `KillScope`, `KillEntry`, `RUNTIME_AGENT_TYPE`). The audit chain is the existing `RuntimeStatePort.audit` hash chain (canonical hashing in `packages/platform-ports/src/audit-hash.ts`; verified by `verifyAuditChain` in `@palup/evolution`). Do NOT create a second kill mechanism or a second audit chain.
- **A proposal without a `reversalPlan` is invalid** — `proposeOrExecute` rejects it at creation (§3 / `hitl-approval-gate`).
- **`classifyAction` defaults to `requires_approval` when uncertain.** Ambiguity is never auto-allowed.
- **Permanent floors are inviolable** — the mass-send approval floor (spec W1 decision, ratified) and PalUp safety floors (W4) force `requires_approval` regardless of the merchant's rules.
- **Tenant isolation** — every store/audit call is tenant-scoped via `RuntimeStateCtx`; tenant is never derived from caller input beyond the authenticated ctx.
- **Portability (ADR-0001)** — no provider SDK here; storage via `RuntimeStatePort`.
- **This is build-time dev against an APPROVED, owned spec** — self-merge on gate-green after the §4 reviews; security-reviewer required (this touches agent autonomy + audit).

## File Structure

- Create `packages/agent-runtime/package.json`, `tsconfig.json` — new package `@palup/agent-runtime`, mirroring `packages/widget-brain` conventions.
- Create `packages/agent-runtime/src/types.ts` — `AgentAction`, `Proposal`, `ProposalStatus`, `ProposalCategory`, `BoundaryReason`, `ReversalPlan`. The consumed contract.
- Create `packages/agent-runtime/src/proposal-store.ts` — `ProposalStore` interface + `InMemoryProposalStore` (registry over `RuntimeStatePort`, mirroring `outcome-ledger`).
- Create `packages/agent-runtime/src/classify.ts` — `classifyAction()`, `RulesProvider` seam, the floors.
- Create `packages/agent-runtime/src/loop.ts` — `proposeOrExecute()`, `executeApproved()`, the `Executor`/`PreconditionValidator` seams, kill guards, audit writes.
- Create `packages/agent-runtime/src/kill.ts` — thin merchant-scope wrappers over the state-postgres kill registry (`assertNotKilled`, `killMerchant`, `unkillMerchant`, `merchantKillStatus`).
- Create `packages/agent-runtime/src/index.ts` — package exports.
- Create `packages/state-postgres/src/proposal-store.ts` — `PostgresProposalStore` (Postgres adapter, mirroring the existing registry stores) + migration.
- Tests alongside: `packages/agent-runtime/test/*.test.ts`.

## Interfaces (the contract W1 / W4 / Win-back import — pin these exactly)

```ts
// types.ts
export type ProposalCategory = "discount" | "ad_spend" | "refund" | "campaign" | "autonomy_scope" | "subscription";
export type ProposalStatus =
  | "pending" | "approved" | "executing" | "executed" | "execution_failed"
  | "rejected" | "expired" | "withdrawn" | "killed";

export interface AgentAction {
  type: string;                         // e.g. "send_campaign" | "issue_discount" | "issue_refund"
  params: Record<string, unknown>;
  irreversible?: boolean;               // e.g. an email send
  blastRadius?: number;                 // e.g. recipient count — drives the mass-send floor
}

export interface BoundaryReason { rule: string; detail: string; }   // traceable to a HITL rule
export interface ReversalPlan { reversible: boolean; plan: string; } // plan = the way back, or honest containment

export interface Proposal {
  id: string;
  tenantId: string;
  agentId: string;
  agentType: string;                    // RUNTIME_AGENT_TYPE-compatible
  action: AgentAction;
  category: ProposalCategory;
  rationale: string;
  boundaryReasons: BoundaryReason[];
  estimatedImpact?: { amountUsd?: number; reach?: number; note?: string };
  reversalPlan: ReversalPlan;           // REQUIRED — creation throws without it
  preconditions: Record<string, unknown>; // re-validated at approve time
  status: ProposalStatus;
  version: number;                      // optimistic lock
  createdAt: string;                    // ISO; supplied by caller (no Date.now in pure code)
  expiresAt: string;                    // ISO; category-derived TTL
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  executionId?: string;                 // idempotency key
  executedAt?: string;
  executionResult?: { ok: boolean; detail: string };
}

// classify.ts
export interface RulesProvider {  // Minimal W4 implements this; the classifier reads it live
  autoActLimit(ctx: RuntimeStateCtx, category: ProposalCategory): Promise<{ maxUsd?: number; maxPct?: number; allowedAuto: boolean }>;
  palupFloor(category: ProposalCategory): { maxAutoUsd?: number; maxAutoPct?: number; massSendRecipientFloor: number };
}
export interface Classification { decision: "auto" | "requires_approval"; category: ProposalCategory; boundaryReasons: BoundaryReason[]; }
export function classifyAction(action: AgentAction, ctx: RuntimeStateCtx, rules: RulesProvider): Promise<Classification>;

// loop.ts
export interface Executor { (action: AgentAction, ctx: RuntimeStateCtx): Promise<{ ok: boolean; detail: string }>; }
export interface PreconditionValidator { (p: Proposal, ctx: RuntimeStateCtx): Promise<{ valid: boolean; reason?: string }>; }
export interface ProposeInput {
  action: AgentAction; ctx: RuntimeStateCtx; agentId: string; agentType: string;
  category: ProposalCategory; rationale: string; reversalPlan: ReversalPlan;
  preconditions?: Record<string, unknown>; estimatedImpact?: Proposal["estimatedImpact"];
  now: string;                          // ISO, injected
}
// auto → executes + audits, returns {kind:"executed"}; else creates a pending Proposal, returns {kind:"proposed", proposal}
export function proposeOrExecute(input: ProposeInput, deps: EngineDeps): Promise<{ kind: "executed" | "proposed"; proposal?: Proposal }>;
// called by W1's approve route: re-validate → idempotent execute → audit
export function executeApproved(id: string, decidedBy: string, now: string, deps: EngineDeps): Promise<Proposal>;

export interface EngineDeps { store: ProposalStore; state: RuntimeStatePort; rules: RulesProvider; executor: Executor; validate: PreconditionValidator; }
```

`ProposalStore`: `create(p): Promise<Proposal>` · `get(ctx,id): Promise<Proposal|null>` · `list(ctx,{status?,category?,cursor?}): Promise<{items:Proposal[];cursor?:string}>` · `transition(ctx,id,expectedVersion,patch): Promise<Proposal>` (throws `VersionConflictError` on stale version).

TTL-by-category (constant): `discount|ad_spend 24h`, `campaign|refund 72h`, `subscription|autonomy_scope 7d` (from spec W1: 72h default, category-tuned).

---

### Task 1: Scaffold `@palup/agent-runtime` + the domain types

**Files:** Create `packages/agent-runtime/{package.json,tsconfig.json}`, `packages/agent-runtime/src/types.ts`, `packages/agent-runtime/src/index.ts`, `packages/agent-runtime/test/types.test.ts`.

**Interfaces:** Produces every type in the Interfaces block above.

- [ ] **Step 1: Write the failing test** `test/types.test.ts` — a compile-plus-shape test proving the model is usable and TTL constants exist:
```ts
import { describe, it, expect } from "vitest";
import { ttlForCategory, type Proposal } from "../src/index.js";
describe("proposal model", () => {
  it("derives a category TTL in ms", () => {
    expect(ttlForCategory("discount")).toBe(24 * 3600_000);
    expect(ttlForCategory("campaign")).toBe(72 * 3600_000);
    expect(ttlForCategory("autonomy_scope")).toBe(7 * 24 * 3600_000);
  });
  it("a Proposal literal type-checks with all required fields", () => {
    const p: Proposal = { id:"p1", tenantId:"t1", agentId:"a1", agentType:"win_back",
      action:{type:"send_campaign",params:{}}, category:"campaign", rationale:"r",
      boundaryReasons:[{rule:"marketing_spend",detail:"outbound send"}],
      reversalPlan:{reversible:false,plan:"one-time send; suppress follow-up"},
      preconditions:{}, status:"pending", version:0, createdAt:"2026-08-23T00:00:00Z",
      expiresAt:"2026-08-26T00:00:00Z" };
    expect(p.status).toBe("pending");
  });
});
```

- [ ] **Step 2:** Run `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm exec vitest run packages/agent-runtime/test/types.test.ts` — expect FAIL (package/exports missing).

- [ ] **Step 3: Implement** `package.json` (name `@palup/agent-runtime`, type module, deps `@palup/platform-ports`, `@palup/state-postgres`; devDep vitest — mirror `packages/widget-brain/package.json`), `tsconfig.json` (mirror a sibling), `src/types.ts` (all types above + `export function ttlForCategory(c: ProposalCategory): number`), `src/index.ts` (re-export types + `ttlForCategory`).

- [ ] **Step 4:** Run the test — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): scaffold package + proposal domain model"`

---

### Task 2: `ProposalStore` + `InMemoryProposalStore` (registry over RuntimeStatePort)

**Files:** Create `packages/agent-runtime/src/proposal-store.ts`, `packages/agent-runtime/test/proposal-store.test.ts`.

**Interfaces:** Consumes `RuntimeStatePort` + `RuntimeStateCtx` from `@palup/platform-ports` (use `InMemoryRuntimeStore` in tests). Produces `ProposalStore`, `InMemoryProposalStore`, `VersionConflictError`.

- [ ] **Step 1: Write the failing test** — create/get/list-by-filter/optimistic-version:
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryProposalStore, VersionConflictError } from "../src/proposal-store.js";
const ctx = { tenantId: "t1" };
const base = (id:string,over={}) => ({ id, tenantId:"t1", agentId:"a", agentType:"win_back",
  action:{type:"x",params:{}}, category:"campaign" as const, rationale:"r",
  boundaryReasons:[], reversalPlan:{reversible:true,plan:"undo"}, preconditions:{},
  status:"pending" as const, version:0, createdAt:"2026-08-23T00:00:00Z", expiresAt:"2026-08-26T00:00:00Z", ...over });
describe("InMemoryProposalStore", () => {
  it("creates, gets, and lists by status", async () => {
    const s = new InMemoryProposalStore(new InMemoryRuntimeStore());
    await s.create(base("p1"));
    await s.create(base("p2", { status:"rejected" }));
    expect((await s.get(ctx,"p1"))?.id).toBe("p1");
    const pend = await s.list(ctx, { status:"pending" });
    expect(pend.items.map(p=>p.id)).toEqual(["p1"]);
  });
  it("enforces optimistic version on transition", async () => {
    const s = new InMemoryProposalStore(new InMemoryRuntimeStore());
    await s.create(base("p1"));
    await s.transition(ctx, "p1", 0, { status:"approved", decidedBy:"owner" });
    await expect(s.transition(ctx, "p1", 0, { status:"rejected" })).rejects.toBeInstanceOf(VersionConflictError);
  });
  it("isolates tenants", async () => {
    const s = new InMemoryProposalStore(new InMemoryRuntimeStore());
    await s.create(base("p1"));
    expect(await s.get({tenantId:"other"}, "p1")).toBeNull();
  });
});
```

- [ ] **Step 2:** Run it — expect FAIL.

- [ ] **Step 3: Implement** `proposal-store.ts` — the `ProposalStore` interface + `InMemoryProposalStore` persisting proposals in the `RuntimeStatePort`'s tenant-scoped KV (follow the `outcome-ledger` / `cost-cap-registry` registry-over-RuntimeStatePort pattern). `transition` reads current, checks `version === expectedVersion` (else throw `VersionConflictError`), writes `{...patch, version: version+1}`. `get`/`list` tenant-scoped by ctx.

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): proposal store (in-memory registry over RuntimeStatePort)"`

---

### Task 3: `classifyAction` — the HITL classifier + floors

**Files:** Create `packages/agent-runtime/src/classify.ts`, `packages/agent-runtime/test/classify.test.ts`.

**Interfaces:** Produces `classifyAction`, `RulesProvider`, `Classification`, `categoryForAction`.

- [ ] **Step 1: Write the failing test** — auto within envelope; over-cap → approval; uncertain → approval; mass-send floor is inviolable:
```ts
import { describe, it, expect } from "vitest";
import { classifyAction, type RulesProvider } from "../src/classify.js";
const ctx = { tenantId:"t1" };
const rules = (over:Partial<ReturnType<any>> = {}): RulesProvider => ({
  async autoActLimit(){ return { maxPct: 15, allowedAuto: true, ...over }; },
  palupFloor(){ return { maxAutoPct: 30, massSendRecipientFloor: 500 }; },
});
describe("classifyAction", () => {
  it("auto-allows a discount within the merchant's auto limit", async () => {
    const c = await classifyAction({type:"issue_discount",params:{pct:10}}, ctx, rules());
    expect(c.decision).toBe("auto"); expect(c.category).toBe("discount");
  });
  it("requires approval above the merchant auto limit", async () => {
    const c = await classifyAction({type:"issue_discount",params:{pct:25}}, ctx, rules());
    expect(c.decision).toBe("requires_approval");
    expect(c.boundaryReasons[0].rule).toContain("discount");
  });
  it("defaults to requires_approval on an unknown/unclassifiable action", async () => {
    const c = await classifyAction({type:"mystery",params:{}}, ctx, rules());
    expect(c.decision).toBe("requires_approval");
  });
  it("forces approval on a mass send regardless of rules (permanent floor)", async () => {
    const c = await classifyAction({type:"send_campaign",params:{},blastRadius:2000}, ctx, rules({allowedAuto:true}));
    expect(c.decision).toBe("requires_approval");
    expect(c.boundaryReasons.some(b=>b.rule==="mass_send_floor")).toBe(true);
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.

- [ ] **Step 3: Implement** `classify.ts`: `categoryForAction(action)` maps `type`→category (unknown → `autonomy_scope` + a boundary reason, forcing approval). `classifyAction`: (1) if `action.blastRadius >= palupFloor.massSendRecipientFloor` → `requires_approval` + `{rule:"mass_send_floor"}`; (2) compare action params to `autoActLimit` (pct/usd) and `palupFloor` — within both and `allowedAuto` → `auto`; (3) unknown category or over either bound → `requires_approval` with a traceable `BoundaryReason`; (4) any uncertainty → `requires_approval`.

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): HITL classifyAction with inviolable floors"`

---

### Task 4: `proposeOrExecute` — the loop (auto path + proposal creation)

**Files:** Create `packages/agent-runtime/src/loop.ts`, `packages/agent-runtime/test/loop.test.ts`.

**Interfaces:** Produces `proposeOrExecute`, `EngineDeps`, `Executor`, `PreconditionValidator`, `ProposeInput`. Consumes Task 2 + 3 + `RuntimeStatePort.audit`.

- [ ] **Step 1: Write the failing test** — auto executes+audits; approval creates a pending proposal; missing reversalPlan invalid; TTL from category:
```ts
import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { proposeOrExecute } from "../src/loop.js";
const ctx = { tenantId:"t1" };
const mkDeps = (over={}) => { const state = new InMemoryRuntimeStore();
  return { store:new InMemoryProposalStore(state), state,
    rules:{ async autoActLimit(){return {maxPct:15,allowedAuto:true};}, palupFloor(){return {massSendRecipientFloor:500};} },
    executor: vi.fn(async ()=>({ok:true,detail:"done"})),
    validate: vi.fn(async ()=>({valid:true})), ...over }; };
const input = (over={}) => ({ ctx, agentId:"a", agentType:"win_back", category:"discount" as const,
  rationale:"r", reversalPlan:{reversible:true,plan:"undo"}, now:"2026-08-23T00:00:00Z",
  action:{type:"issue_discount",params:{pct:10}}, ...over });
describe("proposeOrExecute", () => {
  it("auto-executes an in-policy action and writes audit", async () => {
    const deps = mkDeps();
    const r = await proposeOrExecute(input(), deps);
    expect(r.kind).toBe("executed");
    expect(deps.executor).toHaveBeenCalledOnce();
    expect((await deps.state.audit.list(ctx)).length).toBeGreaterThan(0);
  });
  it("creates a pending proposal when approval is required", async () => {
    const deps = mkDeps();
    const r = await proposeOrExecute(input({action:{type:"issue_discount",params:{pct:25}}}), deps);
    expect(r.kind).toBe("proposed");
    expect(r.proposal?.status).toBe("pending");
    expect(r.proposal?.expiresAt).toBe("2026-08-24T00:00:00Z"); // +24h discount TTL
  });
  it("rejects a proposal with no reversal plan", async () => {
    await expect(proposeOrExecute(input({action:{type:"issue_discount",params:{pct:25}}, reversalPlan: undefined as any}), mkDeps()))
      .rejects.toThrow(/reversalPlan/);
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.

- [ ] **Step 3: Implement** `loop.ts` `proposeOrExecute`: validate `reversalPlan` present (else throw); `classifyAction`; if `auto` → call `executor`, write an audit entry (`action:"agent.action.auto"`, actor=agentId, detail incl. action type + result) via `state.audit`, return `{kind:"executed"}`; if `requires_approval` → build a `Proposal` (status pending, version 0, `expiresAt = now + ttlForCategory(category)`, boundaryReasons from classification), `store.create`, audit `action:"proposal.created"`, return `{kind:"proposed", proposal}`.

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): proposeOrExecute loop (auto-execute vs propose)"`

---

### Task 5: Kill-Switch enforcement (merchant scope over the shared registry)

**Files:** Create `packages/agent-runtime/src/kill.ts`, `packages/agent-runtime/test/kill.test.ts`; modify `src/loop.ts` (guard before execute).

**Interfaces:** Wraps `@palup/state-postgres` `armKill`/`disarmKill`/`matchedKill`/`killStatus`, `KillScope`. Produces `assertNotKilled`, `killMerchant`, `unkillMerchant`, `merchantKillStatus`. Modifies `proposeOrExecute` (and prepares `executeApproved`) to `assertNotKilled` before any execution.

- [ ] **Step 1: Write the failing test** — a killed merchant blocks the auto-execute path; unkilled allows:
```ts
import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { proposeOrExecute } from "../src/loop.js";
import { killMerchant, unkillMerchant, KillSwitchError } from "../src/kill.js";
const ctx = { tenantId:"t1" };
const mkDeps = () => { const state = new InMemoryRuntimeStore();
  return { store:new InMemoryProposalStore(state), state,
    rules:{ async autoActLimit(){return {maxPct:15,allowedAuto:true};}, palupFloor(){return {massSendRecipientFloor:500};} },
    executor: vi.fn(async ()=>({ok:true,detail:"done"})), validate: vi.fn(async ()=>({valid:true})) }; };
const input = { ctx, agentId:"a", agentType:"win_back", category:"discount" as const, rationale:"r",
  reversalPlan:{reversible:true,plan:"u"}, now:"2026-08-23T00:00:00Z", action:{type:"issue_discount",params:{pct:10}} };
describe("kill switch", () => {
  it("blocks auto-execution while the merchant is killed", async () => {
    const deps = mkDeps();
    await killMerchant(deps.state, ctx, "operator halt");
    await expect(proposeOrExecute(input, deps)).rejects.toBeInstanceOf(KillSwitchError);
    expect(deps.executor).not.toHaveBeenCalled();
  });
  it("resumes after unkill", async () => {
    const deps = mkDeps();
    await killMerchant(deps.state, ctx, "halt"); await unkillMerchant(deps.state, ctx);
    const r = await proposeOrExecute(input, deps);
    expect(r.kind).toBe("executed");
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.

- [ ] **Step 3: Implement** `kill.ts` — thin wrappers: `killMerchant(state,ctx,reason)` → `armKill` with a merchant-scoped `KillScope` (tenantId); `assertNotKilled(state,ctx,agentType)` → `matchedKill` for {merchant, agent-type, global}; throw `KillSwitchError` if matched; audit the arm/disarm. In `loop.ts`, call `assertNotKilled` at the top of the execute branch (and export a guard for `executeApproved` to reuse). Verify the state-postgres kill API shape first (`grep -n "export" packages/state-postgres/src/*kill*`); adapt the wrapper to the real signatures.

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): merchant-scope kill-switch enforcement over the shared registry"`

---

### Task 6: `executeApproved` — re-validate + idempotent execute + audit (the W1 approve path)

**Files:** Modify `packages/agent-runtime/src/loop.ts`; create `packages/agent-runtime/test/execute-approved.test.ts`.

**Interfaces:** Produces `executeApproved(id, decidedBy, now, deps)`. Called by W1's `POST /approvals/:id/approve`.

- [ ] **Step 1: Write the failing test** — stale precondition blocks; success is idempotent; killed blocks; audit chain intact:
```ts
import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { verifyAuditChain } from "@palup/evolution";
import { InMemoryProposalStore } from "../src/proposal-store.js";
import { proposeOrExecute, executeApproved } from "../src/loop.js";
const ctx = { tenantId:"t1" };
const seedPending = async (deps:any) => (await proposeOrExecute({ ctx, agentId:"a", agentType:"win_back",
  category:"discount", rationale:"r", reversalPlan:{reversible:true,plan:"u"}, now:"2026-08-23T00:00:00Z",
  action:{type:"issue_discount",params:{pct:25}} }, deps)).proposal!;
const mkDeps = (over={}) => { const state = new InMemoryRuntimeStore();
  return { store:new InMemoryProposalStore(state), state,
    rules:{ async autoActLimit(){return {maxPct:15,allowedAuto:true};}, palupFloor(){return {massSendRecipientFloor:500};} },
    executor: vi.fn(async ()=>({ok:true,detail:"done"})), validate: vi.fn(async ()=>({valid:true})), ...over }; };
describe("executeApproved", () => {
  it("blocks execution when a precondition no longer holds", async () => {
    const deps = mkDeps({ validate: vi.fn(async ()=>({valid:false, reason:"out of stock"})) });
    const p = await seedPending(deps);
    await expect(executeApproved(p.id,"owner","2026-08-23T01:00:00Z",deps)).rejects.toThrow(/out of stock/);
    expect(deps.executor).not.toHaveBeenCalled();
    expect((await deps.store.get(ctx,p.id))?.status).toBe("pending");
  });
  it("executes idempotently and keeps the audit chain intact", async () => {
    const deps = mkDeps(); const p = await seedPending(deps);
    const done = await executeApproved(p.id,"owner","2026-08-23T01:00:00Z",deps);
    expect(done.status).toBe("executed");
    await executeApproved(p.id,"owner","2026-08-23T01:00:00Z",deps); // idempotent re-call
    expect(deps.executor).toHaveBeenCalledOnce();
    expect(verifyAuditChain(await deps.state.audit.list(ctx)).ok).toBe(true);
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.

- [ ] **Step 3: Implement** `executeApproved`: load proposal (404 if missing); `assertNotKilled`; if already `executed` return it (idempotent); `validate(p,ctx)` → if invalid, audit `proposal.revalidation_failed`, throw with reason, leave `pending`; else `transition → approved(decidedBy) → executing`, mint `executionId` (deterministic from id+decidedBy), call `executor`, `transition → executed|execution_failed` with result, audit each transition via `state.audit`. Guard double-execute by the `executed` short-circuit + executionId.

- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): executeApproved — revalidate, idempotent execute, audited"`

---

### Task 7: Reject / expire / withdraw transitions

**Files:** Modify `packages/agent-runtime/src/loop.ts`; create `packages/agent-runtime/test/transitions.test.ts`.

**Interfaces:** Produces `rejectProposal(id,decidedBy,reason,now,deps)`, `expireStale(ctx,now,deps)`, `withdrawProposal(id,reason,now,deps)`.

- [ ] **Step 1: Write the failing test** — reject audits + blocks later approve; expireStale flips pending past-TTL to expired; withdraw by agent:
```ts
// reject → status "rejected", decisionNote set, later executeApproved throws;
// a pending proposal whose expiresAt < now becomes "expired" via expireStale and is no longer listable as pending;
// withdrawProposal sets "withdrawn". Assert audit entries exist for each and verifyAuditChain stays ok.
```
(Write the full assertions mirroring Tasks 2/6 style.)

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the three transitions with optimistic version + audit writes; `expireStale` lists pending and transitions those with `expiresAt <= now`.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): reject/expire/withdraw transitions, all audited"`

---

### Task 8: `PostgresProposalStore` (staging-real adapter)

**Files:** Create `packages/state-postgres/src/proposal-store.ts`, migration SQL, export from the package index; create `packages/state-postgres/test/proposal-store.test.ts`.

**Interfaces:** `PostgresProposalStore implements ProposalStore` (imported from `@palup/agent-runtime`), same contract as the in-memory one.

- [ ] **Step 1: Write the failing test** — run the SAME contract suite as Task 2 against the Postgres adapter (reuse via a shared `proposalStoreContract(makeStore)` helper — extract it in this task), behind the testcontainer guard used by the other state-postgres tests (`grep -n PGVECTOR_TESTCONTAINER packages/state-postgres/test/*` for the pattern; skip when off).
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the table + adapter, mirroring an existing state-postgres registry store (`grep -l "implements" packages/state-postgres/src/*.ts`); tenant-scoped rows, `version` column for optimistic locking (`UPDATE … WHERE id=$ AND version=$expected`), JSONB for action/params/preconditions.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(state-postgres): PostgresProposalStore adapter + migration"`

---

## Final: gate + PR
- [ ] Full gate green (`.claude/scripts/merge-gate.sh`); security-reviewer pass (agent autonomy + audit surface); open PR (governance-touching — engine autonomy); auto-merge on green per the ownership rule. Flag: this is inert until an agent (Win-back) and W1 call it — nothing reaches a shopper on merge.

## Self-Review
- **Spec coverage:** proposal model + lifecycle (§6.2) ✓; classify→propose→execute loop ✓; re-validate at approve-time ✓; idempotent execute ✓; reversalPlan-required ✓; inviolable mass-send floor ✓; three-scope Kill-Switch reuse (§6.3) ✓; hash-chained audit reuse (§6.3) ✓; TTL 72h default category-tuned (W1) ✓; optimistic concurrency (W1) ✓. Trust-ratchet envelope-expansion proposals are a `category:"autonomy_scope"` proposal — supported by the model, produced by a later agent plan.
- **Reuse check:** Kill-Switch = existing `@palup/state-postgres` registry (not reinvented); audit = existing `RuntimeStatePort.audit` + `verifyAuditChain` (not reinvented); store = registry-over-RuntimeStatePort (matches outcome-ledger/cost-cap).
- **Type consistency:** `Proposal`/`AgentAction`/`RulesProvider`/`EngineDeps`/`Executor`/`PreconditionValidator` are the contract W1 (approve route calls `executeApproved`/`rejectProposal`), Minimal W4 (implements `RulesProvider`), and Win-back (calls `proposeOrExecute` with an `Executor`) import — pinned in the Interfaces block, unchanged across tasks.
- **Placeholder scan:** every task carries real test + impl direction; Task 7's assertions are described to be written in the same style as Tasks 2/6 (the one spot to expand at authoring time); Tasks 5/8 instruct verifying the real state-postgres kill/registry signatures before wiring.
- **Determinism:** no `Date.now()` in pure code — `now`/`createdAt` are injected ISO strings (matches the repo's no-`Date.now` rule).
