# Minimal Automation Rules (W4-min) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine's classifier the **live standing rules** it needs to decide auto-act vs. propose — the minimal slice of Automation Rules for the first end-to-end vertical: the three-layer envelope (`PalUp floors < merchant envelope < auto-act limit`), conservative-but-useful defaults for new tenants, an implementation of E1's `RulesProvider`, and a minimal RBAC-gated `GET/PUT /rules` API with audited changes. The full W4 (vertical presets, agent-proposed envelope expansions via W1, comms/quiet-hours/subscription policy, big-jump confirmation UX) is a later **broaden-W4** plan.

**Architecture:** The rules domain lives in `packages/agent-runtime` (co-located with `classifyAction`, which consumes it) as a registry over `RuntimeStatePort` — same pattern as the proposal store (E1) and the existing `cost-cap-registry`. `merchant-backend` imports it to expose the edit API. PalUp floors are inviolable constants; the merchant envelope is per-tenant state; conservative defaults apply when a tenant has set nothing.

**Tech Stack:** TypeScript, vitest, Fastify (routes). Depends on `@palup/agent-runtime` (`RulesProvider`, `ProposalCategory`), `@palup/platform-ports` (`RuntimeStatePort`), F2 (`Permission "rules.edit"`), F3 (route mount + `request.principal`). ATDD. `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm exec vitest run`.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` — §9 W4. Depends on plans **E1** (the `RulesProvider` seam + classifier) and **F3** (the service to mount routes). Consumed by the **Win-back** and **W1** plans.

## Global Constraints

- **The three layers.** `PALUP_FLOORS` (inviolable, code constants) bound what any merchant/agent can auto-act on; the merchant envelope sits inside them; the agent's auto-act limit is the merchant envelope (widened later by the trust ratchet via W1). The classifier already enforces the floor precedence (E1 Task 3) — this plan supplies the values.
- **Conservative-but-useful defaults** (ratified): a new tenant's envelope allows the agent to *answer + tiny in-policy nudges* automatically, but **all spend/discount/refund require approval** until earned. Concretely: `discount.allowedAuto = false`, `ad_spend.allowedAuto = false`, `refund.allowedAuto = false` by default (only trivial goodwill within the floor is auto, per W5 — but default OFF here).
- **Every rule change is audited with provenance** (`merchant_set` vs `agent_proposed`) via `RuntimeStatePort.audit`. A rule change never silently mutates behavior without an audit row.
- **RBAC:** editing rules requires the `rules.edit` permission (F2). Reading is `console.view`.
- **Merchant sovereign, instant** (ratified) — a `PUT /rules` takes effect immediately (the classifier reads live); a big jump is flagged in the response (`bigJump: true`) for the UI to confirm, but is not blocked or cooldown-delayed.
- **Portability / tenant isolation** — via `RuntimeStatePort` + `RuntimeStateCtx`; no client-supplied tenant.
- Build-time dev against an APPROVED, owned spec; **security-reviewer required** (this is money-boundary config — §3 dense); self-merge on gate-green.

## File Structure

- Create `packages/agent-runtime/src/rules.ts` — `PALUP_FLOORS`, `CONSERVATIVE_DEFAULTS`, `MerchantEnvelope`, `MerchantRulesStore` (interface + `InMemoryMerchantRulesStore`), `createRulesProvider(store)`.
- Create `packages/state-postgres/src/merchant-rules-store.ts` — `PostgresMerchantRulesStore` + migration.
- Create `packages/merchant-backend/src/routes/rules.ts` — `GET /rules`, `PUT /rules` (RBAC + audit).
- Export additions to the respective `index.ts`.
- Tests alongside.

## Interfaces (pin these)

```ts
// packages/agent-runtime/src/rules.ts
import type { ProposalCategory } from "./types.js";
import type { RulesProvider } from "./classify.js";

export interface CategoryEnvelope { allowedAuto: boolean; maxUsd?: number; maxPct?: number; }
export type MerchantEnvelope = Partial<Record<ProposalCategory, CategoryEnvelope>>;

export interface PalupFloor { maxAutoUsd?: number; maxAutoPct?: number; massSendRecipientFloor: number; }
export const PALUP_FLOORS: Readonly<Record<ProposalCategory, PalupFloor>>; // inviolable
export const CONSERVATIVE_DEFAULTS: Readonly<MerchantEnvelope>;            // new-tenant envelope

export type RuleProvenance = "merchant_set" | "agent_proposed";
export interface MerchantRulesStore {
  get(ctx: RuntimeStateCtx): Promise<MerchantEnvelope>;                    // merges stored over CONSERVATIVE_DEFAULTS
  set(ctx: RuntimeStateCtx, envelope: MerchantEnvelope, by: string, provenance: RuleProvenance): Promise<{ envelope: MerchantEnvelope; bigJump: boolean }>;
}
export function createRulesProvider(store: MerchantRulesStore): RulesProvider; // clamps every envelope to PALUP_FLOORS
```

`createRulesProvider` guarantees the floor precedence: `autoActLimit` returns `min(merchant envelope, PALUP_FLOORS)` and `allowedAuto = envelope.allowedAuto && withinFloor`; `palupFloor` returns `PALUP_FLOORS[category]`. So even a mis-set envelope can never exceed a floor.

---

### Task 1: `PALUP_FLOORS` + `CONSERVATIVE_DEFAULTS` (inviolable + safe defaults)

**Files:** Create `packages/agent-runtime/src/rules.ts` (constants + types only for now), `packages/agent-runtime/test/rules-constants.test.ts`.

- [ ] **Step 1: Write the failing test** — floors exist for every category; defaults are conservative (spend/discount/refund not auto):
```ts
import { describe, it, expect } from "vitest";
import { PALUP_FLOORS, CONSERVATIVE_DEFAULTS } from "../src/rules.js";
describe("rule constants", () => {
  it("defines a mass-send floor and per-category caps", () => {
    expect(PALUP_FLOORS.campaign.massSendRecipientFloor).toBeGreaterThan(0);
    expect(PALUP_FLOORS.discount.maxAutoPct).toBeGreaterThan(0);   // a hard ceiling even the merchant can't exceed
  });
  it("defaults deny auto spend/discount/refund for a new tenant", () => {
    expect(CONSERVATIVE_DEFAULTS.discount?.allowedAuto ?? false).toBe(false);
    expect(CONSERVATIVE_DEFAULTS.ad_spend?.allowedAuto ?? false).toBe(false);
    expect(CONSERVATIVE_DEFAULTS.refund?.allowedAuto ?? false).toBe(false);
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the types + `PALUP_FLOORS` (e.g. `campaign.massSendRecipientFloor = 500`, `discount.maxAutoPct = 30`, `ad_spend.maxAutoUsd` sanity cap, `refund.maxAutoUsd` abuse cap) and `CONSERVATIVE_DEFAULTS` (spend/discount/refund `allowedAuto:false`). Document each value's rationale in a comment.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): PalUp rule floors + conservative tenant defaults"`

---

### Task 2: `MerchantRulesStore` + in-memory adapter (defaults-merged)

**Files:** Modify `packages/agent-runtime/src/rules.ts`; create `packages/agent-runtime/test/rules-store.test.ts`.

- [ ] **Step 1: Write the failing test** — unset tenant returns defaults; set-then-get round-trips merged; big-jump flagged:
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryMerchantRulesStore, CONSERVATIVE_DEFAULTS } from "../src/rules.js";
const ctx = { tenantId: "t1" };
describe("MerchantRulesStore", () => {
  it("returns conservative defaults when unset", async () => {
    const s = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    expect((await s.get(ctx)).discount?.allowedAuto ?? false).toBe(CONSERVATIVE_DEFAULTS.discount?.allowedAuto ?? false);
  });
  it("persists a set envelope and flags a big jump", async () => {
    const s = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    const r = await s.set(ctx, { discount: { allowedAuto: true, maxPct: 25 } }, "owner", "merchant_set");
    expect(r.bigJump).toBe(true);                       // 0 → 25% auto is a big jump
    expect((await s.get(ctx)).discount?.maxPct).toBe(25);
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `InMemoryMerchantRulesStore` over `RuntimeStatePort` (registry pattern): `get` merges stored envelope over `CONSERVATIVE_DEFAULTS`; `set` writes, computes `bigJump` (e.g. a category flips to `allowedAuto` or maxPct/maxUsd rises past a delta threshold vs current), and writes an audit row (`action:"rules.changed"`, actor=by, detail incl. provenance + before/after).
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): merchant rules store with defaults + big-jump + audit"`

---

### Task 3: `createRulesProvider` — the E1 `RulesProvider`, floor-clamped

**Files:** Modify `packages/agent-runtime/src/rules.ts`; create `packages/agent-runtime/test/rules-provider.test.ts`.

**Interfaces:** Produces `createRulesProvider(store): RulesProvider` — the object `classifyAction`/`proposeOrExecute` consume.

- [ ] **Step 1: Write the failing test** — provider clamps to the floor; a within-envelope discount is auto, an over-floor one is not; wire it through the real classifier:
```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { InMemoryMerchantRulesStore, createRulesProvider } from "../src/rules.js";
import { classifyAction } from "../src/classify.js";
const ctx = { tenantId: "t1" };
describe("createRulesProvider", () => {
  it("auto-allows within the merchant envelope but clamps to the PalUp floor", async () => {
    const store = new InMemoryMerchantRulesStore(new InMemoryRuntimeStore());
    await store.set(ctx, { discount: { allowedAuto: true, maxPct: 100 } }, "owner", "merchant_set"); // absurd — floor must clamp
    const rules = createRulesProvider(store);
    expect((await classifyAction({ type:"issue_discount", params:{ pct: 20 } }, ctx, rules)).decision).toBe("auto");   // within floor (30)
    expect((await classifyAction({ type:"issue_discount", params:{ pct: 40 } }, ctx, rules)).decision).toBe("requires_approval"); // above floor 30
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `createRulesProvider(store)`: `autoActLimit(ctx, category)` = read `store.get(ctx)[category]`, clamp `maxPct/maxUsd` to `PALUP_FLOORS[category]`, `allowedAuto = envelope.allowedAuto && withinFloor`; `palupFloor(category)` = `PALUP_FLOORS[category]`.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(agent-runtime): floor-clamped RulesProvider feeding the classifier"`

---

### Task 4: `GET /rules` + `PUT /rules` on merchant-backend (RBAC + audit)

**Files:** Create `packages/merchant-backend/src/routes/rules.ts`; register in `server.ts`; create `packages/merchant-backend/test/rules-routes.test.ts`.

**Interfaces:** Consumes F2 `requirePermission("rules.edit")` / `"console.view"`, the `MerchantRulesStore`.

- [ ] **Step 1: Write the failing test** — viewer can GET, cannot PUT (403); manager/owner can PUT and it takes effect; response carries `bigJump`:
```ts
// buildServer with an injected InMemoryMerchantRulesStore + fake identity yielding a given role;
// GET /rules → 200 defaults for viewer; PUT /rules as viewer → 403; PUT as owner → 200 { bigJump:true };
// subsequent GET reflects the change. Assert an audit row was written.
```
(Write full assertions in the F3 route-test style.)

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the routes: `GET /rules` (`preHandler: requirePermission("console.view")`) → `store.get(ctx)`; `PUT /rules` (`preHandler: requirePermission("rules.edit")`) → validate body shape, `store.set(ctx, body, req.principal.userId, "merchant_set")`, return `{ envelope, bigJump }`. `ctx` derives from `req.principal.merchantId` (never body). Wire the store into `buildServer`'s composition (injectable).
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-backend): GET/PUT /rules (RBAC-gated, audited)"`

---

### Task 5: `PostgresMerchantRulesStore` (staging-real)

**Files:** Create `packages/state-postgres/src/merchant-rules-store.ts` + migration; export; create test.

- [ ] **Step 1: Write the failing test** — run the SAME contract as Task 2 against the Postgres adapter (extract a `merchantRulesContract(makeStore)` helper), behind the testcontainer guard.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the table (tenant-scoped, JSONB envelope, provenance + updated_by columns) + adapter mirroring an existing state-postgres registry store; audit via `RuntimeStatePort.audit`.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(state-postgres): PostgresMerchantRulesStore + migration"`

---

## Final: gate + PR
- [ ] Full gate green; **security-reviewer pass** (money-boundary config, §3); open PR (governance-touching); auto-merge on green. Inert until the classifier + an agent consume it (Win-back plan) and the console edits it (broaden-W4 / W1).

## Self-Review
- **Spec coverage (minimal slice):** three-layer envelope (§9 W4) ✓; conservative-but-useful defaults ✓; PalUp inviolable floors ✓; merchant sovereign + big-jump flag ✓; rules enforced live in the classifier via `createRulesProvider` (the E1 seam) ✓; audited with provenance ✓; RBAC `rules.edit` ✓. **Deferred to broaden-W4:** vertical presets (needs W3 aggregate), agent-proposed envelope expansions (needs W1), comms frequency/quiet-hours/subscription policy, big-jump confirmation UX.
- **Contract fit:** `createRulesProvider` returns exactly E1's `RulesProvider`; `autoActLimit`/`palupFloor` signatures match E1's Interfaces block. The floor-clamp guarantees E1's "inviolable floors" invariant even if the merchant envelope is mis-set.
- **Type consistency:** `ProposalCategory` imported from `@palup/agent-runtime` (single source); `MerchantEnvelope`/`PALUP_FLOORS` are the store's and provider's shared vocabulary.
- **Placeholder scan:** Tasks 4/5 tests are described in the established route/contract style (the two spots to finalize at authoring); Tasks 1–3 carry full red/green code.
- **Determinism:** no `Date.now()` — audit timestamps come from the `RuntimeStatePort.audit` sink's own convention (verify it accepts an injected time or supplies one, matching E1).
