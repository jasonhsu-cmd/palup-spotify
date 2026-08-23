# Approval Center API (W1-API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the merchant-plane **Approval Center API** on `merchant-backend` — list/detail/approve/reject proposals, the merchant Kill Switch, the audit read, and an SSE event stream — all backed by E1 (the proposal store + `executeApproved`/`rejectProposal` + kill), RBAC-gated per F2, tenant-scoped per F3. This is the API half of W1; the console UI is a separate plan.

**Architecture:** Thin routes over E1. The one real design piece is an **executor/validator registry** so the approve route resolves the right `Executor` per proposal `action.type` (campaign → the win-back `campaignExecutor`; more agents register more executors later). Mutations publish to an **`EventBus`** seam (in-memory adapter now, pub/sub later) that the SSE route streams. Everything derives `ctx` from `request.principal.merchantId` (never the client).

**Tech Stack:** TypeScript, Fastify (incl. SSE via `reply.raw`), vitest. Depends on `@palup/agent-runtime` (`ProposalStore`, `executeApproved`, `rejectProposal`, `expireStale`, kill fns, `EngineDeps`, `Executor`, `PreconditionValidator`), `@palup/agent-runtime` win-back (`campaignExecutor`), F2 (`requirePermission`), F3 (`buildServer`, `request.principal`), `RuntimeStatePort.audit`. ATDD.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` — §9 W1 (the API contract), §6.2/§6.3. Depends on **E1**, **F3**, **WB** (the campaign executor). Paired with **W1-UI**.

## Global Constraints

- **The API is a thin, governed façade over E1** — no approval logic re-implemented here; approve = `executeApproved`, reject = `rejectProposal`. A proposal is never mutated except through E1's transitions (audit + optimistic version preserved).
- **RBAC (F2):** list/detail/audit = `console.view`; approve/reject = `approve_money`; **kill = `agent.operate`** (anyone operating can hit the brakes); **unkill = `manager`+ via a dedicated `resumeAutonomy` check** (resuming autonomy is a bigger call than stopping).
- **Optimistic concurrency surfaces as HTTP 409** — a `VersionConflictError` from E1 → `409 { error, current }` (the UI re-fetches), never a double-execute.
- **Tenant from `request.principal.merchantId` only.** No route reads a client tenant id.
- **Kill freezes decisions** — while the merchant is killed, `approve` returns `409/423` (E1's `executeApproved` throws `KillSwitchError`); surface it cleanly.
- **SSE is best-effort, not the source of truth** — the store is. A dropped stream never loses a proposal (the UI reconciles via `GET /approvals`). Single-instance in-memory bus now; a note marks the pub/sub upgrade for multi-instance.
- Build-time dev against an APPROVED, owned spec; **security-reviewer required** (money-action approval surface, §3 keystone); self-merge on gate-green.

## File Structure

- Create `packages/merchant-backend/src/engine-wiring.ts` — `resolveExecutor(actionType)`, `resolveValidator(category)`, `buildEngineDeps(ctx, req-scoped)`; the executor registry (campaign → `campaignExecutor`).
- Create `packages/merchant-backend/src/events.ts` — `EventBus` interface + `InMemoryEventBus`; event types.
- Create `packages/merchant-backend/src/routes/approvals.ts` — list/detail/approve/reject.
- Create `packages/merchant-backend/src/routes/kill.ts` — GET/POST /kill, POST /unkill.
- Create `packages/merchant-backend/src/routes/audit.ts` — GET /audit.
- Create `packages/merchant-backend/src/routes/events.ts` — GET /events (SSE).
- Register all in `server.ts`; tests alongside.

## Interfaces (pin these)

```ts
// engine-wiring.ts
import type { Executor, PreconditionValidator, EngineDeps, ProposalCategory } from "@palup/agent-runtime";
export function resolveExecutor(actionType: string, deps: WiringDeps): Executor;        // campaign → campaignExecutor(comms)
export function resolveValidator(category: ProposalCategory, deps: WiringDeps): PreconditionValidator;
export function buildEngineDeps(actionType: string, category: ProposalCategory, deps: WiringDeps): EngineDeps;

// events.ts
export type ConsoleEvent =
  | { type: "proposal.created"; id: string } | { type: "proposal.decided"; id: string; status: string }
  | { type: "kill.changed"; killed: boolean };
export interface EventBus { publish(tenantId: string, e: ConsoleEvent): void; subscribe(tenantId: string, fn: (e: ConsoleEvent)=>void): () => void; }
export class InMemoryEventBus implements EventBus {}
```

Routes (all under the F3 auth hook; `ctx = { tenantId: request.principal.merchantId }`):
`GET /approvals?status=&category=&cursor=` · `GET /approvals/:id` · `POST /approvals/:id/approve {version, note?}` · `POST /approvals/:id/reject {reason}` · `GET /kill` · `POST /kill {reason}` · `POST /unkill` · `GET /audit?cursor=` · `GET /events` (SSE).

---

### Task 1: Executor/validator registry (`engine-wiring.ts`)

**Files:** Create `packages/merchant-backend/src/engine-wiring.ts`, `test/engine-wiring.test.ts`.

- [ ] **Step 1: Write the failing test** — a campaign action resolves to a sender that drives the comms sandbox; an unknown type throws (never silently no-ops):
```ts
import { describe, it, expect } from "vitest";
import { SandboxCommsAdapter } from "@palup/platform-ports";
import { resolveExecutor } from "../src/engine-wiring.js";
describe("resolveExecutor", () => {
  it("routes send_campaign to the campaign executor", async () => {
    const comms = new SandboxCommsAdapter();
    const exec = resolveExecutor("send_campaign", { comms } as any);
    await exec({ type:"send_campaign", params:{ recipients:["a@x.com"], channel:"email", subject:"s", body:"b" } }, { tenantId:"t1" });
    expect(comms.recorded).toHaveLength(1);
  });
  it("throws on an unregistered action type", () => {
    expect(() => resolveExecutor("mystery", {} as any)).toThrow(/no executor/i);
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the registry: `send_campaign → campaignExecutor(deps.comms)`; unknown → throw. `resolveValidator` returns a minimal validator per category (v1: `campaign → always-valid`; leave a TODO to add real revalidation — e.g. discount → re-check rule caps — as agents land). `buildEngineDeps` composes `{ store, state, rules, executor: resolveExecutor(...), validate: resolveValidator(...) }`.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): executor/validator registry for the approve path"`

---

### Task 2: `GET /approvals` + `GET /approvals/:id`

**Files:** Create `packages/merchant-backend/src/routes/approvals.ts` (list/detail); register; create `test/approvals-read.test.ts`.

- [ ] **Step 1: Write the failing test** — list filters by status/category, is tenant-scoped, RBAC console.view; detail 404s cross-tenant:
```ts
// seed the injected ProposalStore with 2 pending + 1 rejected for t1 and 1 for t2;
// GET /approvals?status=pending as a t1 viewer → the 2 t1 pendings only;
// GET /approvals/:id for a t2 proposal as t1 → 404; a no-perm principal (none has console.view? all do) → still gated test via a stub.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `GET /approvals` (`requirePermission("console.view")`) → `store.list(ctx, {status, category, cursor})`; `GET /approvals/:id` → `store.get(ctx, id)` or 404. `ctx` from principal.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): approvals list + detail (tenant-scoped, RBAC)"`

---

### Task 3: `POST /approvals/:id/approve` (executeApproved, 409 on version conflict, kill-aware)

**Files:** Modify `routes/approvals.ts`; create `test/approve.test.ts`.

- [ ] **Step 1: Write the failing test** — approve executes + sends (campaign), returns executed proposal; stale version → 409; a viewer → 403; a killed merchant → 423/409 with a clear error:
```ts
// seed a pending campaign proposal (via proposeWinBack against the injected deps);
// POST approve {version:0} as owner → 200 { status:"executed" }, comms.recorded length 1;
// POST approve {version:0} again (stale) → 409;
// as viewer → 403;
// after POST /kill, approve → 423 (or 409) with error mentioning kill.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `POST /approvals/:id/approve` (`requirePermission("approve_money")`): load proposal → `buildEngineDeps(action.type, category, wiring)` → `executeApproved(id, principal.userId, now, deps)`; map `VersionConflictError`→409, `KillSwitchError`→423, missing→404; publish `proposal.decided` to the `EventBus`; return the updated proposal. (Guard the body `version` against the loaded proposal's version before calling, to give a clean 409.)
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): approve route via executeApproved (409/423/403 handled)"`

---

### Task 4: `POST /approvals/:id/reject`

**Files:** Modify `routes/approvals.ts`; create `test/reject.test.ts`.

- [ ] **Step 1: Write the failing test** — reject requires a reason, sets rejected + note, audits, blocks a later approve, RBAC approve_money:
```ts
// POST reject {} → 400 (reason required); POST reject {reason:"off-brand"} as owner → 200 status "rejected";
// then POST approve → 4xx (not pending); as viewer → 403; assert an audit row exists.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `POST /approvals/:id/reject` (`approve_money`): require `reason`, call `rejectProposal(id, principal.userId, reason, now, deps)`, publish `proposal.decided`, return the proposal.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): reject route (reason required, audited)"`

---

### Task 5: Kill Switch routes

**Files:** Create `packages/merchant-backend/src/routes/kill.ts`; register; create `test/kill-routes.test.ts`.

- [ ] **Step 1: Write the failing test** — operator can kill (halts approves), status reflects it, manager+ can unkill; a viewer cannot kill:
```ts
// POST /kill {reason} as operator → 200; GET /kill → { killed:true }; approve now → 423;
// POST /unkill as operator → 403 (needs manager+); as manager → 200; GET /kill → { killed:false };
// POST /kill as viewer → 403. Assert kill/unkill publish "kill.changed" and write audit.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `GET /kill` (`console.view`) → `merchantKillStatus`; `POST /kill` (`agent.operate`) → `killMerchant(state, ctx, reason)` + publish; `POST /unkill` (a `resumeAutonomy` check = role manager/admin/owner — add a small `requireRole(minRole)` preHandler or reuse a permission) → `unkillMerchant` + publish.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): merchant Kill Switch routes (kill=operate, unkill=manager+)"`

---

### Task 6: `GET /audit`

**Files:** Create `packages/merchant-backend/src/routes/audit.ts`; register; create `test/audit-route.test.ts`.

- [ ] **Step 1: Write the failing test** — returns the tenant's audit entries (append-only), paginated, RBAC console.view, tenant-scoped. (First `grep -n "audit" packages/platform-ports/src/runtime-state-port.ts` to confirm the exact `RuntimeStatePort.audit` list/read method + entry shape, and assert against it.)

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `GET /audit` (`console.view`) → read `state.audit` for `ctx`, paginate by cursor, return entries (seq/actor/action/target/detail/ts — never raw PII).
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): tenant audit read route"`

---

### Task 7: `GET /events` (SSE) + `EventBus`

**Files:** Create `packages/merchant-backend/src/events.ts`, `packages/merchant-backend/src/routes/events.ts`; wire the bus into the mutating routes; create `test/events.test.ts`.

- [ ] **Step 1: Write the failing test** — subscribing receives a `proposal.decided` when an approve happens; tenant-isolated:
```ts
// InMemoryEventBus: subscribe(t1) receives events published to t1, not t2.
// Integration: an approve on t1 publishes proposal.decided to t1's subscribers.
// (SSE wire test: inject the app, open GET /events, trigger an approve, assert a data: line arrives — or unit-test the bus + assert the route registers a subscriber and writes text/event-stream headers.)
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `InMemoryEventBus` (per-tenant subscriber sets); `GET /events` (`console.view`) sets `text/event-stream` headers on `reply.raw`, subscribes for `ctx.tenantId`, writes `data: <json>\n\n` per event, unsubscribes on close. Publish from approve/reject/kill routes and (optionally) on proposal creation via the internal trigger. Add a `// TODO: replace InMemoryEventBus with a pub/sub adapter for multi-instance Cloud Run` note.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): SSE events + in-memory event bus"`

---

## Final: gate + PR
- [ ] Full gate green; **security-reviewer pass** (the §3 approval keystone — money-action approval, kill, audit); open PR (governance-touching); auto-merge on green. Inert until W1-UI + a deployed merchant-backend + a proposal producer (WB) run on staging.

## Self-Review
- **Spec coverage:** the full W1 API contract (§9 W1) — list/detail/approve/reject/kill/unkill/audit/events ✓; approve = E1 `executeApproved` (re-validate + idempotent) ✓; optimistic concurrency → 409 ✓; kill freezes approve → 423 ✓; RBAC per-route (approve=approve_money, kill=operate, unkill=manager+) ✓; tenant from principal only ✓; audit read ✓; SSE best-effort with store as source of truth ✓.
- **Contract fit:** approve/reject call E1 unchanged; the executor registry resolves WB's `campaignExecutor`; no approval logic duplicated in the API.
- **Type consistency:** `Proposal`/`EngineDeps`/`Executor`/kill fns from `@palup/agent-runtime`; `MerchantPrincipal`/`Permission` from F2; `request.principal` from F3.
- **Placeholder scan:** Tasks 2/6/7 tests are described in the established style with the one grounding step called out (confirm the real `RuntimeStatePort.audit` method); Tasks 1/3/4/5 carry full red/green code.
- **Multi-instance caveat surfaced:** the in-memory `EventBus` is single-instance; the pub/sub upgrade is a `TODO`, not silently assumed — the store remains the source of truth so correctness doesn't depend on SSE.
- **Determinism:** `now` injected into E1 calls; no `Date.now()` in route logic beyond a request-time clock passed explicitly.
