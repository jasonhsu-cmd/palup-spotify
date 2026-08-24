# Revenue Home (W2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build W2 · Revenue Home — the retention scoreboard: a per-tenant **primary-goal object** (port + InMemory + Postgres store), a **`GET /home/summary`** read model (attributed incremental revenue from the dark-shipped outcome ledger, model cost via `deriveCostUsd`, **NET = attributed − cost** with honest underpowered/empty/unpriced/net-negative states), **`GET /activity?cursor=`** (an agent-activity read model over the existing audit log), **`PUT /home/goal`**, and the console **`RevenueHome`** screen (StatTiles + net card + activity list + onboarding-handoff card) replacing the `/dashboard` stub.

**Architecture:** Everything money-shaped is a **read model over the already-built spine** — `readOutcomeLedger`/`listArmTallies` + `computeIncrementalLift` (ADR-0007, one canonical source), `rollupEvents` + `deriveCostUsd` (ADR-0013) — never a second calculation. The one NEW durable object is `PrimaryGoalStore`, following the exact `MerchantRulesStore` split (interface + InMemory in `@palup/platform-ports`, Postgres adapter in `@palup/state-postgres`, contract test shared by both, wired in `merchant-backend`'s composition-root durable-vs-inmemory branch). Routes live inside the encapsulated `merchantPlane` context (F3), tenant always from `req.principal.merchantId`. The console screen renders only real API data with governance-honest empty states.

**Tech Stack:** TypeScript, Fastify (`merchant-backend`), vitest; React + Vite + Tailwind + `@palup/design-system` (`merchant-console`); `@palup/platform-ports` (outcome-ledger types, telemetry rollup/cost, RuntimeStatePort), `@palup/state-postgres` (outcome-ledger store fns, `Sql`), `@palup/identity-shopify` (`requirePermission`). ATDD throughout.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` — §9 W2 (this workstream), §10 "Attribution / Revenue" decisions, §11 build-order block 3, §12 non-negotiables. Depends on F1/F2/F3 + E1/W1/WB (blocks 1–2, merged) and the Wave-2 attribution spine (built dark).

## Global Constraints

Copied from the spec's §12 / CLAUDE.md §3 — every task's requirements implicitly include these:

- **Money/model/business-model never auto-applies** — W2 is a **read-only action surface**; nothing here executes, spends, or changes agent behavior. The one mutation (`PUT /home/goal`) is per-tenant orientation config, audited, RBAC-gated, and read (later) by agents whose *actions* still route through W1.
- **High integrity surface:** attributed revenue is the future billing base and comes **only from the one canonical metering path** (ADR-0007: `readOutcomeLedger` / `ArmTally` + `computeIncrementalLift`) — no second calculation in the console or the routes. Bill/report on **honest incremental lift, never last-touch**.
- **Never render fake state.** Honest "still measuring" (underpowered), honest "not yet metered"/"unpriced" cost, **net-negative shown honestly** with a fix-it path — never a fabricated number, never a mockup demo value, never `$0` presented as a measured cost when the models are unpriced.
- **Every autonomous action audited** (append-only hash-chained); goal changes audit `goal.changed`. Merchant-facing reads of the audit log use the **fixed safe-DTO allowlist** (`routes/audit.ts` precedent) — never the raw `input`/`decision` blobs.
- **Kill Switch keeps working** — W2 adds no code path an operator can't stop (reads only + one audited config write).
- **Portability (ADR-0001):** all state via `RuntimeStatePort`/store ports; no provider SDK, no SQL in feature code (SQL only in the `state-postgres` adapter).
- **Tenant scoping is mandatory:** `ctx.tenantId = req.principal!.merchantId` always; never from query/body/header.
- **Build dark / staging-shaped:** mechanisms real; the holdout stays OFF (flipping `holdout:set` for a real tenant is an owner/legal go-live step), real model prices stay operator-provided (`PALUP_MODEL_PRICES`), live billing stays W6-mocked. **This plan flips no enablement flag.**
- **RBAC in middleware on every route:** new data routes registered inside `merchantPlane`, per-route `requirePermission(...)`, and added to `KNOWN_DATA_ROUTES` in `route-protection.test.ts` — never to `AUTH_EXEMPT_PATHS`.
- Routine gate-green PRs self-merge (spec §12 ownership note); nothing in this plan is a governance-touching *edit*.

## Design decisions (argued once, referenced by tasks)

- **D1 — Cost side (decided):** no per-period `TelemetryRollup` reader exists (`TelemetryPort.query` rolls up the whole retained window). We **build a minimal period-filtered reader inside the read model**: `readStream<TelemetryEvent>(ctx, "telemetry", { limit: 10_000 })` (the control-plane precedent, `control-plane/src/server.ts:196`), filter `event.at` by `"${period}-"` prefix, `rollupEvents` + `deriveCostUsd(rollup, prices)`. Honesty contract: `metered:false` when the period has zero events; `fullyPriced:false` + `unpricedModels` surfaced when any model lacks a price (`deriveCostUsd` already excludes them — `totalUsd` is then a **lower bound**, and the console labels it `≥ $X`, never a plain figure). The reader inherits `trimStream` retention (bounded window) — documented on the DTO, acceptable for a monthly staging period.
- **D2 — Attributed (decided):** the canonical number for the period is the **sum of `OutcomeLedgerEntry.attributedIncrementalRevenue` for `entry.period === period`** (the reconciled ledger, ADR-0007's billing base). The **live per-play measurement** (from `listArmTallies` filtered to the period, grouped by play, fed to `computeIncrementalLift`) is returned **separately as informational `plays[]`** and is *never* added into `attributed.totalUsd` — no double counting, no billing off an unreconciled tally. `underpowered` (the "still measuring" state) = no ledger entries for the period AND every live play underpowered (vacuously true when nothing has run — the honest Day-0 state, since the holdout is OFF).
- **D3 — NET (decided):** `net.value = attributed.totalUsd − cost.totalUsd`, non-null **only when** the period has ≥1 ledger entry AND `cost.metered` AND `cost.fullyPriced`; otherwise `value:null` with a machine-readable `reason` (`"attribution_underpowered" | "cost_not_metered" | "cost_not_fully_priced"`, checked in that precedence order). A real negative value renders honestly (spec §10: "net-negative shown honestly + fix-it"). No fee line here — the performance fee is W6's (the ultimate §3 boundary); NET in W2 is revenue − model COGS, and the net card says exactly that.
- **D4 — `PUT /home/goal` permission (decided):** `"settings.edit"` (admin + owner per `DEFAULT_ROLE_PERMISSIONS`) — the conservative least-privilege choice for agent-orienting config; onboarding's guided setup runs as the installing owner. `GET` of the goal is folded into `/home/summary` (`console.view`). Revisable by the owner without a schema change.
- **D5 — Period format:** `"YYYY-MM"` UTC — byte-identical to `holdoutPeriod()` (`widget-backend/src/holdout.ts:159-161`, verified) so ledger entries and tallies written by the widget plane join cleanly. `merchant-backend` defines its own `currentPeriod()` rather than importing `widget-backend` (no service→service dependency).
- **D6 — Honest deviations from the mockup (`palup-merchant-app.html` `#dashboard`):** layout/labels matched, but (a) **no revenue time-series chart** — no time-series read model exists; a per-play measurement card takes that slot; (b) **no per-channel tiles** (carts/closed/upsell) — plays are free-text and only `"win_back"`/`"agent"` exist; per-channel splits arrive with W5's touchpoints; (c) the net card's "after PalUp's fee" copy becomes "incremental revenue − model cost" until W6 exists. All three are the "no fake numbers" governance rule applied, not style choices.
- **D7 — Onboarding-handoff card:** W2 defines the type + KV location (`collection "onboarding_handoff"`, key `"card"`) and **reads** it on the summary; the **writer is the Onboarding block** (cross-plane, security-reviewer-gated there). Absent ⇒ `handoff:null` ⇒ the console hides the card (honest — nothing fabricated for demo effect). Dismiss is client-local state; durable dismissal ships with the writer.
- **D8 — Activity read model:** an **allowlist filter over `readAudit`** (the only agent-activity source that exists — E1's `loop.ts` writes `proposal.*` and `agent.action.*` records). `readAudit` has no cursor ⇒ over-fetch the most-recent 500 and filter in-process; `?cursor=` is accepted as a forward-compat no-op (the exact `routes/audit.ts` convention). The DTO is a fixed safe allowlist `{seq, at, actor, action}` — never `input`/`decision`/`prevHash` (PII discipline), and metric-plumbing actions (`arm_tally.accumulate`, `outcome_ledger.append`, `rules.changed`, …) are excluded by the allowlist.

## File Structure

- `packages/platform-ports/src/primary-goal-store.ts` — `PrimaryGoalKind`/`PrimaryGoal`/`PrimaryGoalStore` + `InMemoryPrimaryGoalStore` (Task 1)
- `packages/platform-ports/src/contract/primary-goal.contract.ts` — shared adapter contract (Task 1)
- `packages/state-postgres/src/primary-goal-store.ts` — `PostgresPrimaryGoalStore` + `migrate()` (Task 2)
- `packages/merchant-backend/src/home/read-model.ts` — `HomeSummary` DTO + `readHomeSummary` + `currentPeriod` + `OnboardingHandoff` (Task 3)
- `packages/merchant-backend/src/routes/home.ts` — `GET /home/summary`, `PUT /home/goal` (Task 4)
- `packages/merchant-backend/src/routes/activity.ts` — `GET /activity` (Task 5)
- `packages/merchant-console/src/app/api.ts` — `getHomeSummary`/`getActivity`/`setPrimaryGoal` + mirrored DTO types (Task 6)
- `packages/merchant-console/src/screens/home/{format.ts,HandoffCard.tsx,NetPositionCard.tsx,ActivityToday.tsx}` (Task 7)
- `packages/merchant-console/src/screens/home/RevenueHome.tsx` + `App.tsx` wiring (Task 8)

All test paths sit beside their subjects (backend: `packages/<pkg>/test/*.test.ts`; console: colocated `*.test.tsx`). Run every command from the repo root.

---

### Task 1: `PrimaryGoalStore` port — types, InMemory adapter, shared contract

**Files:**
- Create: `packages/platform-ports/src/primary-goal-store.ts`
- Create: `packages/platform-ports/src/contract/primary-goal.contract.ts`
- Modify: `packages/platform-ports/src/index.ts` (barrel exports, append after the `merchant-rules-store.js` block)
- Modify: `packages/platform-ports/package.json` (add `"./contract/primary-goal"` to `exports`)
- Test: `packages/platform-ports/test/primary-goal-store.test.ts`

**Interfaces:**
- Consumes: `RuntimeStateCtx`, `RuntimeStatePort` (`./runtime-state-port.js` — `get`/`tx`/`RuntimeStateTx.audit`, verbatim signatures confirmed at `runtime-state-port.ts:64-125`).
- Produces (pinned for Tasks 2/3/4/6):
  ```ts
  export type PrimaryGoalKind = "recover_carts" | "close_more_chat_sales" | "grow_repeat_purchases" | "increase_aov" | "win_back_lapsed";
  export const PRIMARY_GOAL_KINDS: readonly PrimaryGoalKind[];
  export interface PrimaryGoal { kind: PrimaryGoalKind; note?: string; setBy: string; setAt: string }
  export interface PrimaryGoalSetInput { kind: PrimaryGoalKind; note?: string }
  export interface PrimaryGoalStore {
    get(ctx: RuntimeStateCtx): Promise<PrimaryGoal | null>;
    set(ctx: RuntimeStateCtx, input: PrimaryGoalSetInput, by: string): Promise<PrimaryGoal>;
  }
  export class InMemoryPrimaryGoalStore implements PrimaryGoalStore { constructor(store: RuntimeStatePort, now?: () => string) }
  export function primaryGoalContract(makeStore: () => PrimaryGoalStore | Promise<PrimaryGoalStore>): void;
  ```

- [ ] **Step 1: Write the failing test**

`packages/platform-ports/test/primary-goal-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "../src/in-memory-runtime-store.js";
import { InMemoryPrimaryGoalStore } from "../src/primary-goal-store.js";
import { primaryGoalContract } from "../src/contract/primary-goal.contract.js";

// W2 Task 1: the per-tenant primary-goal object (spec §9 W2 / §10: "one primary goal object every
// agent reads and orients to"). The in-memory adapter is the behavioral ORACLE for
// `PostgresPrimaryGoalStore` (Task 2) — both run `primaryGoalContract`.

const ctx = { tenantId: "t1" };

describe("InMemoryPrimaryGoalStore", () => {
  primaryGoalContract(() => new InMemoryPrimaryGoalStore(new InMemoryRuntimeStore()));

  it("audits goal.changed with before/after inside the same tx (NN#5)", async () => {
    const state = new InMemoryRuntimeStore();
    const s = new InMemoryPrimaryGoalStore(state, () => "2026-08-24T00:00:00.000Z");
    await s.set(ctx, { kind: "recover_carts" }, "u1");
    await s.set(ctx, { kind: "increase_aov", note: "Q3 push" }, "u2");
    const audit = await state.readAudit(ctx);
    const changed = audit.filter((r) => r.action === "goal.changed");
    expect(changed).toHaveLength(2);
    expect(changed[0]!.actor).toBe("u1");
    expect((changed[1]!.decision as { before: { kind: string } }).before.kind).toBe("recover_carts");
    expect((changed[1]!.decision as { after: { kind: string } }).after.kind).toBe("increase_aov");
    expect(changed[1]!.reversalPath).toContain("recover_carts");
  });

  it("stamps setBy/setAt from the injected clock", async () => {
    const s = new InMemoryPrimaryGoalStore(new InMemoryRuntimeStore(), () => "2026-08-24T00:00:00.000Z");
    const goal = await s.set(ctx, { kind: "win_back_lapsed" }, "owner-1");
    expect(goal).toEqual({ kind: "win_back_lapsed", setBy: "owner-1", setAt: "2026-08-24T00:00:00.000Z" });
  });
});
```

`packages/platform-ports/src/contract/primary-goal.contract.ts` (the contract IS test code — written now, exercised by both adapters):

```ts
import { describe, it, expect } from "vitest";
import type { RuntimeStateCtx } from "../runtime-state-port.js";
import type { PrimaryGoalStore } from "../primary-goal-store.js";

// PrimaryGoalStore contract (W2 Task 1; the `merchantRulesContract` convention): EVERY adapter (the
// in-memory one that ships with the port, `PostgresPrimaryGoalStore` in `@palup/state-postgres`) MUST
// pass this so the `/home` routes stay swappable and never learn which adapter they got. `makeStore`
// must return a FRESH, EMPTY store each call (Postgres: truncate its table first).

const ctx: RuntimeStateCtx = { tenantId: "t1" };

export function primaryGoalContract(makeStore: () => PrimaryGoalStore | Promise<PrimaryGoalStore>): void {
  describe("PrimaryGoalStore contract", () => {
    it("returns null when unset — honest empty, never a fabricated default goal", async () => {
      const s = await makeStore();
      expect(await s.get(ctx)).toBeNull();
    });

    it("persists and returns the set goal with setBy/setAt", async () => {
      const s = await makeStore();
      const set = await s.set(ctx, { kind: "recover_carts", note: "from onboarding" }, "u1");
      expect(set.kind).toBe("recover_carts");
      expect(set.note).toBe("from onboarding");
      expect(set.setBy).toBe("u1");
      expect(typeof set.setAt).toBe("string");
      expect(await s.get(ctx)).toEqual(set);
    });

    it("overwrites on a second set — ONE primary goal, not a list", async () => {
      const s = await makeStore();
      await s.set(ctx, { kind: "recover_carts" }, "u1");
      await s.set(ctx, { kind: "increase_aov" }, "u2");
      const got = await s.get(ctx);
      expect(got?.kind).toBe("increase_aov");
      expect(got?.setBy).toBe("u2");
      expect(got?.note).toBeUndefined(); // a set WITHOUT a note clears any prior note (full overwrite)
    });

    it("isolates tenants", async () => {
      const s = await makeStore();
      await s.set(ctx, { kind: "recover_carts" }, "u1");
      expect(await s.get({ tenantId: "other" })).toBeNull();
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/platform-ports/test/primary-goal-store.test.ts`
Expected: FAIL — `Cannot find module '../src/primary-goal-store.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/platform-ports/src/primary-goal-store.ts`:

```ts
import type { RuntimeStateCtx, RuntimeStatePort } from "./runtime-state-port.js";

// W2 Task 1 — the per-tenant PRIMARY GOAL (spec §9 W2 / §10 "Attribution / Revenue": "one primary
// goal object every agent reads and orients to"). Lives here (not merchant-backend) for the same
// reason `MerchantRulesStore` does: the Postgres adapter (`PostgresPrimaryGoalStore`,
// `@palup/state-postgres`) must import the port without a package cycle. Registry pattern over
// `RuntimeStatePort` (mirrors `merchant-rules-store.ts`): one KV row per tenant; tenant isolation
// rides on the port's own guarantee.
//
// The goal ORIENTS agents; it never authorizes anything. What an agent may DO is still governed by
// W4 rules + the W1 proposal→approval loop — a goal change can therefore be merchant-sovereign
// config (audited, RBAC-gated) rather than a HITL boundary crossing.

/** The closed goal vocabulary. Engineering-owned and cheap to extend; kept closed (not free text) so
 * every agent reading the goal can switch on it exhaustively and the Postgres CHECK can restate it. */
export type PrimaryGoalKind =
  | "recover_carts"
  | "close_more_chat_sales"
  | "grow_repeat_purchases"
  | "increase_aov"
  | "win_back_lapsed";

export const PRIMARY_GOAL_KINDS: readonly PrimaryGoalKind[] = [
  "recover_carts",
  "close_more_chat_sales",
  "grow_repeat_purchases",
  "increase_aov",
  "win_back_lapsed",
];

export interface PrimaryGoal {
  kind: PrimaryGoalKind;
  /** Optional merchant-worded nuance ("focus on the EU launch"), carried verbatim to agents. */
  note?: string;
  /** Who set it (console userId, or the onboarding flow's actor). */
  setBy: string;
  /** ISO-8601. */
  setAt: string;
}

export interface PrimaryGoalSetInput {
  kind: PrimaryGoalKind;
  note?: string;
}

/** Tenant-scoped store for the ONE primary goal. `get` returns null when unset (honest empty —
 * callers must not invent a default). `set` is a FULL overwrite (one goal, not a list; an omitted
 * `note` clears any prior note) and is audited internally by every adapter (`goal.changed`, NN#5 —
 * same adapter-owned audit obligation as `MerchantRulesStore.set`, and for the same reason: no
 * single engine-loop call site owns it). */
export interface PrimaryGoalStore {
  get(ctx: RuntimeStateCtx): Promise<PrimaryGoal | null>;
  set(ctx: RuntimeStateCtx, input: PrimaryGoalSetInput, by: string): Promise<PrimaryGoal>;
}

const GOAL_COLLECTION = "primary_goal";
const GOAL_KEY = "goal"; // one row per tenant

function buildGoal(input: PrimaryGoalSetInput, by: string, setAt: string): PrimaryGoal {
  const goal: PrimaryGoal = { kind: input.kind, setBy: by, setAt };
  if (input.note !== undefined) goal.note = input.note;
  return goal;
}

function reversalPathFor(before: PrimaryGoal | null): string {
  return before
    ? `PrimaryGoalStore.set(ctx, { kind: "${before.kind}" }, "<operator>") restores the prior goal`
    : "first-ever set — a corrected goal can be written via PrimaryGoalStore.set; the audit trail preserves history";
}

export class InMemoryPrimaryGoalStore implements PrimaryGoalStore {
  constructor(
    private readonly store: RuntimeStatePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async get(ctx: RuntimeStateCtx): Promise<PrimaryGoal | null> {
    return this.store.get<PrimaryGoal>(ctx, GOAL_COLLECTION, GOAL_KEY);
  }

  async set(ctx: RuntimeStateCtx, input: PrimaryGoalSetInput, by: string): Promise<PrimaryGoal> {
    const setAt = this.now();
    const next = buildGoal(input, by, setAt);
    // Read-modify-write + audit in ONE tx (NN#5) — the stored goal and its audit record commit
    // together or not at all, same as `InMemoryMerchantRulesStore.set`.
    return this.store.tx(ctx, async (t) => {
      const before = await t.get<PrimaryGoal>(GOAL_COLLECTION, GOAL_KEY);
      await t.put(GOAL_COLLECTION, GOAL_KEY, next);
      await t.audit(
        {
          actor: by,
          action: "goal.changed",
          input: { kind: input.kind }, // note deliberately NOT audited raw (merchant free text)
          decision: { before, after: next },
          reversalPath: reversalPathFor(before),
        },
        setAt,
      );
      return next;
    });
  }
}
```

Append to `packages/platform-ports/src/index.ts` (after the existing `merchant-rules-store.js` export block):

```ts
export type {
  PrimaryGoalKind,
  PrimaryGoal,
  PrimaryGoalSetInput,
  PrimaryGoalStore,
} from "./primary-goal-store.js";
export { PRIMARY_GOAL_KINDS, InMemoryPrimaryGoalStore } from "./primary-goal-store.js";
```

Add to `packages/platform-ports/package.json` `exports` (after `"./contract/merchant-rules"`):

```json
"./contract/primary-goal": "./src/contract/primary-goal.contract.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/platform-ports/test/primary-goal-store.test.ts`
Expected: PASS (contract + 2 adapter-specific tests).

- [ ] **Step 5: Commit**

```bash
git add packages/platform-ports/src/primary-goal-store.ts packages/platform-ports/src/contract/primary-goal.contract.ts packages/platform-ports/src/index.ts packages/platform-ports/package.json packages/platform-ports/test/primary-goal-store.test.ts
git commit -m "feat(platform-ports): PrimaryGoalStore port + InMemory adapter + contract (W2 T1)"
```

---

### Task 2: `PostgresPrimaryGoalStore` (durable adapter)

**Files:**
- Create: `packages/state-postgres/src/primary-goal-store.ts`
- Modify: `packages/state-postgres/src/index.ts` (export)
- Test: `packages/state-postgres/test/primary-goal-store.test.ts`

**Interfaces:**
- Consumes: `PrimaryGoal`/`PrimaryGoalKind`/`PrimaryGoalSetInput`/`PrimaryGoalStore` + `primaryGoalContract` (Task 1); `Sql` (`./sql.js` — `query<R>(text, params?): Promise<{rows: R[]}>`, `tx<T>(fn)` SERIALIZABLE, confirmed `sql.ts:9-12`); `RuntimeStatePort` (for `.audit()` into the shared `rs_audit` chain — the `PostgresMerchantRulesStore` precedent, `state-postgres/src/merchant-rules-store.ts:97-106`).
- Produces (pinned for Task 4's composition root): `class PostgresPrimaryGoalStore implements PrimaryGoalStore { constructor(sql: Sql, state: RuntimeStatePort, opts?: { now?: () => string }); migrate(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

`packages/state-postgres/test/primary-goal-store.test.ts` (the `merchant-rules-store.test.ts` testcontainer pattern — real engine, clean skip without Docker):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { primaryGoalContract } from "@palup/platform-ports/contract/primary-goal";
import { PGVECTOR_AVAILABLE, startPgvectorContainer } from "./helpers/pgvector-container.js";
import type { Sql } from "../src/sql.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import { PostgresPrimaryGoalStore } from "../src/primary-goal-store.js";

// W2 Task 2: the durable twin of `InMemoryPrimaryGoalStore` (the behavioral oracle — both run
// `primaryGoalContract`). Verified against a REAL Postgres engine via the shared testcontainer;
// skips cleanly (exit 0) when Docker is unreachable, same as merchant-rules-store.test.ts.

const ctx = { tenantId: "t1" };

describe.skipIf(!PGVECTOR_AVAILABLE)("PostgresPrimaryGoalStore", () => {
  let sql: Sql;
  let stop: () => Promise<void>;
  let runtimeStore: PostgresRuntimeStore;

  beforeAll(async () => {
    ({ sql, stop } = await startPgvectorContainer());
    runtimeStore = new PostgresRuntimeStore(sql);
    await runtimeStore.migrate();
    const bootstrap = new PostgresPrimaryGoalStore(sql, runtimeStore);
    await bootstrap.migrate();
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  }, 120_000);

  primaryGoalContract(async () => {
    await sql.query("TRUNCATE pl_primary_goal");
    await sql.query("TRUNCATE rs_audit");
    return new PostgresPrimaryGoalStore(sql, runtimeStore);
  });

  it("migrate() is idempotent", async () => {
    const s = new PostgresPrimaryGoalStore(sql, runtimeStore);
    await s.migrate();
    await s.migrate();
  });

  it("the CHECK constraint rejects an un-vetted kind written outside the adapter", async () => {
    await expect(
      sql.query("INSERT INTO pl_primary_goal (tenant_id, kind, note, set_by, set_at) VALUES ('tX','engagement_maxxing',NULL,'u','2026-08-24T00:00:00.000Z')"),
    ).rejects.toThrow();
  });

  it("audits goal.changed into the SHARED rs_audit chain after a successful set", async () => {
    await sql.query("TRUNCATE pl_primary_goal");
    await sql.query("TRUNCATE rs_audit");
    const s = new PostgresPrimaryGoalStore(sql, runtimeStore, { now: () => "2026-08-24T00:00:00.000Z" });
    await s.set(ctx, { kind: "recover_carts" }, "u1");
    const audit = await runtimeStore.readAudit(ctx);
    expect(audit.some((r) => r.action === "goal.changed" && r.actor === "u1")).toBe(true);
  });

  it("rejects a blank tenantId (tenant isolation, fail-closed)", async () => {
    const s = new PostgresPrimaryGoalStore(sql, runtimeStore);
    await expect(s.get({ tenantId: " " })).rejects.toThrow(/tenantId/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/state-postgres/test/primary-goal-store.test.ts`
Expected: FAIL — `Cannot find module '../src/primary-goal-store.js'` (with Docker), or the same import error before the skip evaluates (without Docker the file still fails to LOAD — the import error fires regardless).

- [ ] **Step 3: Write minimal implementation**

`packages/state-postgres/src/primary-goal-store.ts`:

```ts
import type {
  PrimaryGoal,
  PrimaryGoalKind,
  PrimaryGoalSetInput,
  PrimaryGoalStore,
  RuntimeStateCtx,
  RuntimeStatePort,
} from "@palup/platform-ports";
import type { Sql } from "./sql.js";

// W2 Task 2 — Postgres adapter for `PrimaryGoalStore` (port + oracle in `@palup/platform-ports/
// primary-goal-store.ts`). Mirrors `PostgresMerchantRulesStore` exactly: own narrow table
// (`pl_primary_goal`, one row per tenant), MUTATE-THEN-AUDIT into the SHARED `rs_audit` chain via
// the second `state: RuntimeStatePort` constructor arg (see merchant-rules-store.ts's file header
// for the full atomicity argument — two commits, honestly-stated crash gap, failed mutations still
// audited via `goal.change_failed`), and a literal CHECK restating the `PrimaryGoalKind` union so a
// hand-edited row can't smuggle an un-vetted kind. SQL injection: every value is a bound `$n`
// parameter; the only template-substituted text is the fixed `COLUMNS` constant.

interface PrimaryGoalRow {
  tenant_id: string;
  kind: string;
  note: string | null;
  set_by: string;
  set_at: string;
}

const COLUMNS = "tenant_id, kind, note, set_by, set_at";

function requireTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim())
    throw new Error("PrimaryGoalStore: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

function rowToGoal(row: PrimaryGoalRow): PrimaryGoal {
  const goal: PrimaryGoal = { kind: row.kind as PrimaryGoalKind, setBy: row.set_by, setAt: row.set_at };
  if (row.note !== null) goal.note = row.note;
  return goal;
}

export interface PostgresPrimaryGoalStoreOpts {
  /** Injectable clock (ISO-8601) — same determinism knob as PostgresMerchantRulesStore. */
  now?: () => string;
}

export class PostgresPrimaryGoalStore implements PrimaryGoalStore {
  private readonly now: () => string;

  constructor(
    private readonly sql: Sql,
    private readonly state: RuntimeStatePort,
    opts: PostgresPrimaryGoalStoreOpts = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Idempotent; run at startup like every other state-postgres adapter's migrate(). The kind CHECK
   *  restates the `PrimaryGoalKind` union LITERALLY (never interpolated) — same discipline as
   *  pl_merchant_rules's provenance CHECK. */
  async migrate(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS pl_primary_goal (
         tenant_id text PRIMARY KEY CHECK (btrim(tenant_id) <> ''),
         kind text NOT NULL CHECK (kind IN ('recover_carts','close_more_chat_sales','grow_repeat_purchases','increase_aov','win_back_lapsed')),
         note text,
         set_by text NOT NULL,
         set_at text NOT NULL)`,
    );
  }

  async get(ctx: RuntimeStateCtx): Promise<PrimaryGoal | null> {
    const tenantId = requireTenant(ctx.tenantId);
    const { rows } = await this.sql.query<PrimaryGoalRow>(
      `SELECT ${COLUMNS} FROM pl_primary_goal WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = rows[0];
    return row ? rowToGoal(row) : null;
  }

  async set(ctx: RuntimeStateCtx, input: PrimaryGoalSetInput, by: string): Promise<PrimaryGoal> {
    const tenantId = requireTenant(ctx.tenantId);
    const setAt = this.now();
    const next: PrimaryGoal = { kind: input.kind, setBy: by, setAt };
    if (input.note !== undefined) next.note = input.note;

    // MUTATE FIRST inside one SERIALIZABLE tx; the `before` captured is what the tx actually read.
    let before: PrimaryGoal | null;
    try {
      before = await this.sql.tx(async (tx) => {
        const { rows } = await tx.query<PrimaryGoalRow>(
          `SELECT ${COLUMNS} FROM pl_primary_goal WHERE tenant_id = $1`,
          [tenantId],
        );
        await tx.query(
          `INSERT INTO pl_primary_goal (${COLUMNS}) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id) DO UPDATE
             SET kind = EXCLUDED.kind, note = EXCLUDED.note,
                 set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
          [tenantId, next.kind, next.note ?? null, by, setAt],
        );
        const prev = rows[0];
        return prev ? rowToGoal(prev) : null;
      });
    } catch (e) {
      // No silent failure (NN#5) — mirror `rules.change_failed`.
      await this.state.audit(
        { tenantId },
        {
          actor: by,
          action: "goal.change_failed",
          input: { kind: input.kind },
          decision: { error: e instanceof Error ? e.message : String(e) },
          reversalPath: "no state changed — the mutation was rolled back; retry set() with the same input",
        },
        setAt,
      );
      throw e;
    }

    await this.state.audit(
      { tenantId },
      {
        actor: by,
        action: "goal.changed",
        input: { kind: input.kind },
        decision: { before, after: next },
        reversalPath: before
          ? `PrimaryGoalStore.set(ctx, { kind: "${before.kind}" }, "<operator>") restores the prior goal`
          : "first-ever set — a corrected goal can be written via PrimaryGoalStore.set; the audit trail preserves history",
      },
      setAt,
    );

    return next;
  }
}
```

Append to `packages/state-postgres/src/index.ts`:

```ts
export { PostgresPrimaryGoalStore, type PostgresPrimaryGoalStoreOpts } from "./primary-goal-store.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/state-postgres/test/primary-goal-store.test.ts`
Expected: PASS with Docker running (contract + 4 engine tests); SKIP (exit 0) without Docker — run at least once with Docker before commit.

- [ ] **Step 5: Commit**

```bash
git add packages/state-postgres/src/primary-goal-store.ts packages/state-postgres/src/index.ts packages/state-postgres/test/primary-goal-store.test.ts
git commit -m "feat(state-postgres): PostgresPrimaryGoalStore (durable primary goal, W2 T2)"
```

---

### Task 3: Revenue Home read model (`readHomeSummary`)

**Files:**
- Create: `packages/merchant-backend/src/home/read-model.ts`
- Test: `packages/merchant-backend/test/home-read-model.test.ts`

**Interfaces:**
- Consumes (all verified in-repo): `readOutcomeLedger(store, tenantId, opts?): Promise<OutcomeLedgerEntry[]>` + `listArmTallies(store, tenantId): Promise<ArmTally[]>` (`@palup/state-postgres`, `outcome-ledger-store.ts:190-241`); `computeIncrementalLift({treated, control}): IncrementalLiftResult` + `EMPTY_ARM_AGG` (`@palup/platform-ports`, `outcome-ledger.ts:201`); `rollupEvents(tenantId, events): TelemetryRollup` (`telemetry-port.ts:120`); `deriveCostUsd(rollup, prices): CostBreakdown` + `loadModelPrices()` (`telemetry-cost.ts:54,25`); `RuntimeStatePort.readStream` / `.get`; `PrimaryGoalStore` (Task 1).
- Produces (pinned for Tasks 4/6):
  ```ts
  export function currentPeriod(now?: Date): string; // "YYYY-MM" UTC (D5)
  export interface PlayMeasurement { play: string; incrementalLiftUsd: number; relativeLift: number; confidence: number; underpowered: boolean; method: string }
  export interface OnboardingHandoff { headline: string; items: Array<{ label: string; detail: string }>; sourceNote: string }
  export const HANDOFF_COLLECTION = "onboarding_handoff"; export const HANDOFF_KEY = "card";
  export interface HomeSummary {
    period: string;
    goal: PrimaryGoal | null;
    attributed: { totalUsd: number; entryCount: number; plays: PlayMeasurement[]; underpowered: boolean };
    cost: { metered: boolean; totalUsd: number; fullyPriced: boolean; unpricedModels: string[]; events: number };
    net: { value: number | null; reason: "ok" | "attribution_underpowered" | "cost_not_metered" | "cost_not_fully_priced" };
    handoff: OnboardingHandoff | null;
  }
  export interface HomeSummaryOpts { period?: string; prices?: ModelPriceTable }
  export function readHomeSummary(store: RuntimeStatePort, goalStore: PrimaryGoalStore, tenantId: string, opts?: HomeSummaryOpts): Promise<HomeSummary>;
  ```

- [ ] **Step 1: Write the failing test**

`packages/merchant-backend/test/home-read-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  InMemoryPrimaryGoalStore,
  PLACEHOLDER_MODEL_PRICES,
  type TelemetryEvent,
} from "@palup/platform-ports";
import { accumulateArmTally, appendOutcomeLedgerEntry } from "@palup/state-postgres";
import {
  currentPeriod,
  readHomeSummary,
  HANDOFF_COLLECTION,
  HANDOFF_KEY,
  type OnboardingHandoff,
} from "../src/home/read-model.js";

// W2 Task 3: the Revenue Home read model. Every number is derived from the canonical spine
// (outcome ledger / arm tallies / telemetry rollup) — this suite proves each HONEST state the
// spec demands: still-measuring, not-yet-metered, unpriced-lower-bound, and net-negative.

const T = "t1";
const PERIOD = "2026-08";
const ctx = { tenantId: T };

function tele(at: string, model: string, inputTokens: number, outputTokens: number): TelemetryEvent {
  return { kind: "model_call", model, inputTokens, outputTokens, at };
}

async function seedPoweredPlay(store: InMemoryRuntimeStore): Promise<void> {
  // 300 exposures per arm clears MIN_EXPOSURES_PER_ARM=200 (the measured-outcome-signal.test.ts fixture).
  await accumulateArmTally(store, { tenantId: T, play: "win_back", period: PERIOD, arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
  await accumulateArmTally(store, { tenantId: T, play: "win_back", period: PERIOD, arm: "control", exposures: 300, orders: 15, revenue: 750 });
}

describe("currentPeriod", () => {
  it("formats YYYY-MM in UTC (matches widget-backend's holdoutPeriod format)", () => {
    expect(currentPeriod(new Date("2026-08-24T23:59:59.000Z"))).toBe("2026-08");
    expect(currentPeriod(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01");
  });
});

describe("readHomeSummary", () => {
  it("Day-0 honest empty: no goal, underpowered attribution, unmetered cost, null net, no handoff", async () => {
    const store = new InMemoryRuntimeStore();
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s).toEqual({
      period: PERIOD,
      goal: null,
      attributed: { totalUsd: 0, entryCount: 0, plays: [], underpowered: true },
      cost: { metered: false, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 0 },
      net: { value: null, reason: "attribution_underpowered" },
      handoff: null,
    });
  });

  it("sums ONLY the requested period's ledger entries (canonical attributed, D2)", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "win_back", attributedIncrementalRevenue: 100.5, controlRef: "holdout-2026-08", method: "m", confidence: 0.9 });
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "agent", attributedIncrementalRevenue: 49.5, controlRef: "holdout-2026-08", method: "m", confidence: 0.9 });
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: "2026-07", play: "win_back", attributedIncrementalRevenue: 999, controlRef: "holdout-2026-07", method: "m", confidence: 0.9 });
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.totalUsd).toBe(150);
    expect(s.attributed.entryCount).toBe(2);
    expect(s.attributed.underpowered).toBe(false);
  });

  it("reports live per-play measurement separately and NEVER adds it into attributed.totalUsd", async () => {
    const store = new InMemoryRuntimeStore();
    await seedPoweredPlay(store);
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.totalUsd).toBe(0); // no ledger entry yet — tallies alone are not billed
    expect(s.attributed.entryCount).toBe(0);
    expect(s.attributed.plays).toHaveLength(1);
    const play = s.attributed.plays[0]!;
    expect(play.play).toBe("win_back");
    expect(play.underpowered).toBe(false);
    // (10 - 2.5) revenue-per-exposure gap × 300 treated exposures = 2250 (computeIncrementalLift's math)
    expect(play.incrementalLiftUsd).toBeCloseTo(2250);
    expect(s.attributed.underpowered).toBe(false); // a powered live play ends "still measuring"
  });

  it("an underpowered play (below the exposure floor) keeps the honest still-measuring state", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: T, play: "win_back", period: PERIOD, arm: "treated", exposures: 10, orders: 5, revenue: 500 });
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.plays[0]!.underpowered).toBe(true);
    expect(s.attributed.plays[0]!.incrementalLiftUsd).toBe(0); // clamped, never a number the data can't support
    expect(s.attributed.underpowered).toBe(true);
    expect(s.net).toEqual({ value: null, reason: "attribution_underpowered" });
  });

  it("ignores tallies from other periods", async () => {
    const store = new InMemoryRuntimeStore();
    await accumulateArmTally(store, { tenantId: T, play: "win_back", period: "2026-07", arm: "treated", exposures: 300, orders: 60, revenue: 3000 });
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.plays).toEqual([]);
  });

  it("cost: period-filtered rollup over the telemetry stream (D1) — fully priced mock model", async () => {
    const store = new InMemoryRuntimeStore();
    await store.append(ctx, "telemetry", tele("2026-08-10T00:00:00.000Z", "mock", 1000, 500));
    await store.append(ctx, "telemetry", tele("2026-07-10T00:00:00.000Z", "mock", 9999, 9999)); // other period — excluded
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.cost).toEqual({ metered: true, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 1 });
  });

  it("cost: an unpriced model is FLAGGED, its cost never fabricated, and net is withheld", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "win_back", attributedIncrementalRevenue: 100, controlRef: "c", method: "m", confidence: 0.9 });
    await store.append(ctx, "telemetry", tele("2026-08-10T00:00:00.000Z", "gemini-2.5-flash", 1000, 500));
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.cost.metered).toBe(true);
    expect(s.cost.fullyPriced).toBe(false);
    expect(s.cost.unpricedModels).toEqual(["gemini-2.5-flash"]);
    expect(s.net).toEqual({ value: null, reason: "cost_not_fully_priced" });
  });

  it("net: attributed − cost when both sides are honest; a NEGATIVE net is returned, not hidden (D3)", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "win_back", attributedIncrementalRevenue: 1, controlRef: "c", method: "m", confidence: 0.9 });
    await store.append(ctx, "telemetry", tele("2026-08-10T00:00:00.000Z", "mock", 1000, 500));
    // Priced table injected for determinism: $1000/1M in + $1000/1M out → 1000 in = $1, 500 out = $0.50.
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, {
      period: PERIOD,
      prices: { mock: { inputPer1M: 1000, outputPer1M: 1000 } },
    });
    expect(s.cost.totalUsd).toBeCloseTo(1.5);
    expect(s.net.reason).toBe("ok");
    expect(s.net.value).toBeCloseTo(-0.5); // net-negative shown honestly
  });

  it("net: withheld with reason cost_not_metered when attribution exists but no telemetry does", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: T, period: PERIOD, play: "win_back", attributedIncrementalRevenue: 100, controlRef: "c", method: "m", confidence: 0.9 });
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.net).toEqual({ value: null, reason: "cost_not_metered" });
  });

  it("returns the goal and the onboarding-handoff card when present (D7)", async () => {
    const store = new InMemoryRuntimeStore();
    const goalStore = new InMemoryPrimaryGoalStore(store, () => "2026-08-24T00:00:00.000Z");
    await goalStore.set(ctx, { kind: "recover_carts" }, "u1");
    const handoff: OnboardingHandoff = {
      headline: "Welcome to PalUp — I picked up where we left off",
      items: [{ label: "Your goal — recover more carts — is first in line.", detail: "It's the first play I'm running for you this week." }],
      sourceNote: "This is from your signup conversation with PalUp — kept separate from your customers' data.",
    };
    await store.put(ctx, HANDOFF_COLLECTION, HANDOFF_KEY, handoff);
    const s = await readHomeSummary(store, goalStore, T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.goal).toEqual({ kind: "recover_carts", setBy: "u1", setAt: "2026-08-24T00:00:00.000Z" });
    expect(s.handoff).toEqual(handoff);
  });

  it("tenant isolation: another tenant's ledger/tallies/telemetry never leak in", async () => {
    const store = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(store, { merchantId: "other", period: PERIOD, play: "win_back", attributedIncrementalRevenue: 999, controlRef: "c", method: "m", confidence: 0.9 });
    await store.append({ tenantId: "other" }, "telemetry", tele("2026-08-10T00:00:00.000Z", "mock", 1000, 500));
    const s = await readHomeSummary(store, new InMemoryPrimaryGoalStore(store), T, { period: PERIOD, prices: PLACEHOLDER_MODEL_PRICES });
    expect(s.attributed.totalUsd).toBe(0);
    expect(s.cost.metered).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/merchant-backend/test/home-read-model.test.ts`
Expected: FAIL — `Cannot find module '../src/home/read-model.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/merchant-backend/src/home/read-model.ts`:

```ts
import {
  computeIncrementalLift,
  deriveCostUsd,
  loadModelPrices,
  rollupEvents,
  EMPTY_ARM_AGG,
  type ArmAgg,
  type ModelPriceTable,
  type PrimaryGoal,
  type PrimaryGoalStore,
  type RuntimeStatePort,
  type TelemetryEvent,
} from "@palup/platform-ports";
import { listArmTallies, readOutcomeLedger } from "@palup/state-postgres";

// W2 Task 3 — the Revenue Home READ MODEL (spec §9 W2). Pure derivation over the canonical spine:
//   attributed  ← the outcome ledger (ADR-0007's billing base) — D2: ledger sum is the ONE number;
//                 live per-play lift (arm tallies → computeIncrementalLift) is informational only.
//   cost        ← D1: a minimal period-filtered rollup over the "telemetry" stream (no per-period
//                 TelemetryPort reader exists; the whole-window `query` would mis-bill history).
//                 Inherits trimStream retention — a bounded most-recent window, honest at staging
//                 scale, and unpriced models are FLAGGED (deriveCostUsd), never a fabricated $0.
//   net         ← D3: attributed − cost, withheld (null + reason) unless BOTH sides are honest.
// NO fee computation here — the performance fee is W6's separately-gated boundary (ADR-0007
// proposer≠fee-computer discipline carries over: this module never imports evolution/billing code).

/** "YYYY-MM" in UTC — byte-identical to widget-backend's holdoutPeriod() (holdout.ts:159) so the
 * summary joins the periods the widget plane writes, WITHOUT a service→service import (D5). */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface PlayMeasurement {
  play: string;
  /** computeIncrementalLift().incrementalLift — 0 (clamped) whenever underpowered. */
  incrementalLiftUsd: number;
  relativeLift: number;
  confidence: number;
  underpowered: boolean;
  method: string;
}

/** The signup→console handoff card (spec: Install & Onboarding). W2 defines the shape and READS it;
 * the WRITER is the onboarding block (D7) — absent ⇒ null ⇒ the console renders no card. Content is
 * merchant-plane copy about the merchant's own signup conversation, never customer data. */
export interface OnboardingHandoff {
  headline: string;
  items: Array<{ label: string; detail: string }>;
  sourceNote: string;
}

export const HANDOFF_COLLECTION = "onboarding_handoff";
export const HANDOFF_KEY = "card";

export interface HomeSummary {
  period: string;
  goal: PrimaryGoal | null;
  attributed: {
    /** Sum of the period's OutcomeLedgerEntry.attributedIncrementalRevenue — the CANONICAL number. */
    totalUsd: number;
    entryCount: number;
    /** Live, per-play measurement state — shown as "measuring", never summed into totalUsd (D2). */
    plays: PlayMeasurement[];
    /** True when there is NO trustworthy signal: zero ledger entries AND every live play (possibly
     * none) underpowered. The console's "still measuring" state. */
    underpowered: boolean;
  };
  cost: {
    /** False when the period has zero telemetry events — cost is then UNKNOWN, not $0. */
    metered: boolean;
    /** A LOWER BOUND whenever fullyPriced is false (unpriced models excluded, never guessed). */
    totalUsd: number;
    fullyPriced: boolean;
    unpricedModels: string[];
    events: number;
  };
  net: {
    /** attributed.totalUsd − cost.totalUsd, or null when either side can't honestly support it. A
     * negative value is returned as-is (net-negative shown honestly, spec §10). */
    value: number | null;
    reason: "ok" | "attribution_underpowered" | "cost_not_metered" | "cost_not_fully_priced";
  };
  handoff: OnboardingHandoff | null;
}

export interface HomeSummaryOpts {
  period?: string;
  /** Injectable for deterministic tests; defaults to the operator-provided table (PALUP_MODEL_PRICES
   * over PLACEHOLDER_MODEL_PRICES — telemetry-cost.ts). */
  prices?: ModelPriceTable;
}

const TELEMETRY_STREAM = "telemetry"; // the stream createStoreTelemetry writes (telemetry-port.ts:109)
const TELEMETRY_READ_LIMIT = 10_000; // control-plane's read-bound precedent (control-plane/src/server.ts:196)
const LEDGER_READ_LIMIT = 10_000;

export async function readHomeSummary(
  store: RuntimeStatePort,
  goalStore: PrimaryGoalStore,
  tenantId: string,
  opts: HomeSummaryOpts = {},
): Promise<HomeSummary> {
  const period = opts.period ?? currentPeriod();
  const prices = opts.prices ?? loadModelPrices();
  const ctx = { tenantId };

  const goal = await goalStore.get(ctx);

  // --- attributed: the canonical ledger sum (D2) ---
  const ledger = await readOutcomeLedger(store, tenantId, { limit: LEDGER_READ_LIMIT });
  const periodEntries = ledger.filter((e) => e.period === period);
  const totalUsd = periodEntries.reduce((sum, e) => sum + e.attributedIncrementalRevenue, 0);

  // --- live per-play measurement (informational; underpowered plays clamp to 0 fail-closed) ---
  const tallies = (await listArmTallies(store, tenantId)).filter((t) => t.period === period);
  const byPlay = new Map<string, { treated: ArmAgg; control: ArmAgg }>();
  for (const t of tallies) {
    const pair = byPlay.get(t.play) ?? { treated: EMPTY_ARM_AGG, control: EMPTY_ARM_AGG };
    pair[t.arm] = { exposures: t.exposures, orders: t.orders, revenue: t.revenue };
    byPlay.set(t.play, pair);
  }
  const plays: PlayMeasurement[] = Array.from(byPlay.entries()).map(([play, pair]) => {
    const lift = computeIncrementalLift(pair);
    return {
      play,
      incrementalLiftUsd: lift.incrementalLift,
      relativeLift: lift.relativeLift,
      confidence: lift.confidence,
      underpowered: lift.underpowered,
      method: lift.method,
    };
  });
  const underpowered = periodEntries.length === 0 && plays.every((p) => p.underpowered);

  // --- cost: period-filtered rollup (D1) ---
  const events = await store.readStream<TelemetryEvent>(ctx, TELEMETRY_STREAM, { limit: TELEMETRY_READ_LIMIT });
  const periodPrefix = `${period}-`;
  const periodEvents = events.filter((e) => typeof e.at === "string" && e.at.startsWith(periodPrefix));
  const breakdown = deriveCostUsd(rollupEvents(tenantId, periodEvents), prices);
  const cost: HomeSummary["cost"] = {
    metered: periodEvents.length > 0,
    totalUsd: breakdown.totalUsd,
    fullyPriced: breakdown.fullyPriced,
    unpricedModels: breakdown.unpricedModels,
    events: periodEvents.length,
  };

  // --- net (D3): withheld unless both sides are honest; precedence attribution → metered → priced ---
  let net: HomeSummary["net"];
  if (periodEntries.length === 0) net = { value: null, reason: "attribution_underpowered" };
  else if (!cost.metered) net = { value: null, reason: "cost_not_metered" };
  else if (!cost.fullyPriced) net = { value: null, reason: "cost_not_fully_priced" };
  else net = { value: totalUsd - cost.totalUsd, reason: "ok" };

  const handoff = await store.get<OnboardingHandoff>(ctx, HANDOFF_COLLECTION, HANDOFF_KEY);

  return {
    period,
    goal,
    attributed: { totalUsd, entryCount: periodEntries.length, plays, underpowered },
    cost,
    net,
    handoff,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/merchant-backend/test/home-read-model.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/home/read-model.ts packages/merchant-backend/test/home-read-model.test.ts
git commit -m "feat(merchant-backend): Revenue Home read model — canonical attributed/cost/net with honest states (W2 T3)"
```

---

### Task 4: `GET /home/summary` + `PUT /home/goal` routes, composition-root wiring

**Files:**
- Create: `packages/merchant-backend/src/routes/home.ts`
- Modify: `packages/merchant-backend/src/server.ts` (import, `goalStore` opt + durable-vs-inmemory branch, register inside `merchantPlane`)
- Modify: `packages/merchant-backend/test/route-protection.test.ts` (`KNOWN_DATA_ROUTES` additions)
- Test: `packages/merchant-backend/test/home-routes.test.ts`

**Interfaces:**
- Consumes: `readHomeSummary` (Task 3); `PrimaryGoalStore`/`PRIMARY_GOAL_KINDS`/`PrimaryGoalKind`/`InMemoryPrimaryGoalStore` (Task 1); `PostgresPrimaryGoalStore` (Task 2); `requirePermission` (`@palup/identity-shopify`); `req.principal` (F2/F3).
- Produces (pinned for Task 6): `GET /home/summary` → `HomeSummary` JSON (`console.view`); `PUT /home/goal` body `{ kind: PrimaryGoalKind; note?: string }` → `{ goal: PrimaryGoal }` (`settings.edit`, D4); 400 on malformed body, never touching the store.

- [ ] **Step 1: Write the failing test**

`packages/merchant-backend/test/home-routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  InMemoryPrimaryGoalStore,
  InMemoryRuntimeStore,
  type MerchantIdentityPort,
  type MerchantPrincipal,
} from "@palup/platform-ports";
import { appendOutcomeLedgerEntry } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// W2 Task 4: GET /home/summary (console.view) + PUT /home/goal (settings.edit — D4).

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };
const operator: MerchantPrincipal = { ...owner, role: "operator" };
const manager: MerchantPrincipal = { ...owner, role: "manager" };
const admin: MerchantPrincipal = { ...owner, role: "admin" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

describe("GET /home/summary", () => {
  it("a viewer (console.view floor) gets the honest Day-0 summary", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/home/summary", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.goal).toBeNull();
    expect(body.attributed).toMatchObject({ totalUsd: 0, entryCount: 0, plays: [], underpowered: true });
    expect(body.cost.metered).toBe(false);
    expect(body.net).toEqual({ value: null, reason: "attribution_underpowered" });
    expect(body.handoff).toBeNull();
    expect(typeof body.period).toBe("string");
    await app.close();
  });

  it("tenant comes from the PRINCIPAL, never a query param — another tenant's ledger never leaks", async () => {
    const state = new InMemoryRuntimeStore();
    await appendOutcomeLedgerEntry(state, { merchantId: "t2", period: "2026-08", play: "win_back", attributedIncrementalRevenue: 999, controlRef: "c", method: "m", confidence: 0.9 });
    const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/home/summary?tenantId=t2", headers: { authorization: "Bearer good" } });
    expect(res.json().attributed.totalUsd).toBe(0);
    await app.close();
  });

  it("an anonymous caller is 401'd", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({
      store: state,
      goalStore: new InMemoryPrimaryGoalStore(state),
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    const res = await app.inject({ method: "GET", url: "/home/summary" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("PUT /home/goal", () => {
  it.each([["viewer", viewer], ["operator", operator], ["manager", manager]] as const)(
    "%s is forbidden (403) — the goal is settings.edit (admin+, D4)",
    async (_label, principal) => {
      const state = new InMemoryRuntimeStore();
      const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(principal) });
      const res = await app.inject({
        method: "PUT",
        url: "/home/goal",
        headers: { authorization: "Bearer good" },
        payload: { kind: "recover_carts" },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    },
  );

  it.each([["admin", admin], ["owner", owner]] as const)(
    "%s can PUT; the summary reflects the goal; goal.changed is audited (NN#5)",
    async (_label, principal) => {
      const state = new InMemoryRuntimeStore();
      const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(principal) });

      const put = await app.inject({
        method: "PUT",
        url: "/home/goal",
        headers: { authorization: "Bearer good" },
        payload: { kind: "recover_carts", note: "cart recovery first" },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().goal).toMatchObject({ kind: "recover_carts", note: "cart recovery first", setBy: "u1" });

      const summary = await app.inject({ method: "GET", url: "/home/summary", headers: { authorization: "Bearer good" } });
      expect(summary.json().goal.kind).toBe("recover_carts");

      const audit = await state.readAudit({ tenantId: "t1" });
      expect(audit.some((r) => r.action === "goal.changed" && r.actor === "u1")).toBe(true);
      await app.close();
    },
  );

  it("rejects an unknown kind with 400 and never touches the store", async () => {
    const state = new InMemoryRuntimeStore();
    const goalStore = new InMemoryPrimaryGoalStore(state);
    const app = await buildServer({ store: state, goalStore, identity: identityFor(owner) });
    const res = await app.inject({
      method: "PUT",
      url: "/home/goal",
      headers: { authorization: "Bearer good" },
      payload: { kind: "engagement_maxxing" },
    });
    expect(res.statusCode).toBe(400);
    expect(await goalStore.get({ tenantId: "t1" })).toBeNull();
    await app.close();
  });

  it("rejects a non-object body and a non-string note with 400", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, goalStore: new InMemoryPrimaryGoalStore(state), identity: identityFor(owner) });
    const arr = await app.inject({ method: "PUT", url: "/home/goal", headers: { authorization: "Bearer good" }, payload: [1, 2] });
    expect(arr.statusCode).toBe(400);
    const badNote = await app.inject({ method: "PUT", url: "/home/goal", headers: { authorization: "Bearer good" }, payload: { kind: "recover_carts", note: 42 } });
    expect(badNote.statusCode).toBe(400);
    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({
      store: state,
      goalStore: new InMemoryPrimaryGoalStore(state),
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });
    const res = await app.inject({ method: "PUT", url: "/home/goal", payload: { kind: "recover_carts" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/merchant-backend/test/home-routes.test.ts`
Expected: FAIL — `buildServer` has no `goalStore` opt (TS error) / 404s on `/home/summary`.

- [ ] **Step 3: Write minimal implementation**

`packages/merchant-backend/src/routes/home.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import {
  PRIMARY_GOAL_KINDS,
  type PrimaryGoalKind,
  type PrimaryGoalSetInput,
  type PrimaryGoalStore,
  type RuntimeStatePort,
} from "@palup/platform-ports";
import { readHomeSummary } from "../home/read-model.js";

// W2 Task 4: the Revenue Home routes. `GET /home/summary` is `console.view` (every role — the
// scoreboard is the whole point of the console); `PUT /home/goal` is `settings.edit` (admin+owner,
// decision D4 — conservative least-privilege for agent-orienting config; the goal never authorizes
// an action, W4 rules + the W1 loop do). `ctx` is derived from `req.principal.merchantId` ONLY —
// same tenant-isolation guarantee as every other route in this package. `PUT` validates shape BEFORE
// the store is touched (the rules.ts precedent), and auditing is the STORE's own obligation
// (`PrimaryGoalStore.set` audits `goal.changed` internally) — this route just calls it.

export interface HomeRoutesDeps {
  state: RuntimeStatePort;
  goalStore: PrimaryGoalStore;
}

function validateGoalBody(body: unknown): { ok: true; value: PrimaryGoalSetInput } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body must be an object" };
  }
  const { kind, note } = body as Record<string, unknown>;
  if (typeof kind !== "string" || !(PRIMARY_GOAL_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `kind must be one of: ${PRIMARY_GOAL_KINDS.join(", ")}` };
  }
  if (note !== undefined && typeof note !== "string") {
    return { ok: false, reason: "note must be a string" };
  }
  const value: PrimaryGoalSetInput = { kind: kind as PrimaryGoalKind };
  if (note !== undefined) value.note = note as string;
  return { ok: true, value };
}

export function registerHomeRoutes(app: FastifyInstance, deps: HomeRoutesDeps): void {
  app.get("/home/summary", { preHandler: requirePermission("console.view") }, async (req) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    return readHomeSummary(deps.state, deps.goalStore, principal.merchantId);
  });

  app.put<{ Body: unknown }>("/home/goal", { preHandler: requirePermission("settings.edit") }, async (req, reply) => {
    const principal = req.principal!;
    const validated = validateGoalBody(req.body);
    if (!validated.ok) {
      return reply.code(400).send({ error: "invalid goal", reason: validated.reason });
    }
    const goal = await deps.goalStore.set({ tenantId: principal.merchantId }, validated.value, principal.userId);
    return { goal };
  });
}
```

`packages/merchant-backend/src/server.ts` edits (four spots, exact):

1. Extend the `@palup/platform-ports` import block (add two names):

```ts
  type PrimaryGoalStore,
  InMemoryPrimaryGoalStore,
```

2. Extend the `@palup/state-postgres` import:

```ts
import { createRuntimeStore, PostgresMerchantRegistry, PostgresMerchantRulesStore, PostgresPrimaryGoalStore } from "@palup/state-postgres";
```

and add the route import after `registerRulesRoutes`:

```ts
import { registerHomeRoutes } from "./routes/home.js";
```

3. Add to the `buildServer` opts type (after `rulesStore?: MerchantRulesStore;`):

```ts
  // W2 (Revenue Home): injectable for tests, same convention as rulesStore. Absent → the durable
  // Postgres adapter when DATABASE_URL gave us a pool, else in-memory.
  goalStore?: PrimaryGoalStore;
```

and the composition branch (directly after the `rulesStore` branch, before `const bus`), mirroring the migrate-before-serve rule the rules store documents:

```ts
  // W2: same durable-vs-inmemory split + migrate-before-serve rule as `rulesStore` above —
  // `createRuntimeStore()` migrates only its OWN tables, so the concrete Postgres adapter is
  // constructed here, `await`ed through `migrate()`, and only then handed off port-typed.
  let goalStore: PrimaryGoalStore;
  if (opts?.goalStore) {
    goalStore = opts.goalStore;
  } else if (runtimeResult?.sql) {
    const postgresGoalStore = new PostgresPrimaryGoalStore(runtimeResult.sql, store);
    await postgresGoalStore.migrate();
    goalStore = postgresGoalStore;
  } else {
    goalStore = new InMemoryPrimaryGoalStore(store);
  }
```

4. Register inside the `merchantPlane` callback (after `registerRulesRoutes(merchantPlane, { rulesStore });`):

```ts
    registerHomeRoutes(merchantPlane, { state: store, goalStore });
```

`packages/merchant-backend/test/route-protection.test.ts` — add to `KNOWN_DATA_ROUTES` (never to `AUTH_EXEMPT_PATHS`/`PUBLIC_WILDCARD_ROUTES`):

```ts
  { method: "GET", url: "/home/summary" },
  { method: "PUT", url: "/home/goal" },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/merchant-backend/test/home-routes.test.ts packages/merchant-backend/test/route-protection.test.ts`
Expected: PASS (the structural guard now proves both new routes 401 without a token). Then the whole package: `pnpm exec vitest run packages/merchant-backend` — PASS (no existing suite injects `goalStore`, and the absent-opt default is in-memory, so nothing else changes behavior).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/routes/home.ts packages/merchant-backend/src/server.ts packages/merchant-backend/test/home-routes.test.ts packages/merchant-backend/test/route-protection.test.ts
git commit -m "feat(merchant-backend): GET /home/summary + PUT /home/goal (RBAC-gated, tenant-scoped, W2 T4)"
```

---

### Task 5: `GET /activity` — the agent-activity read model

**Files:**
- Create: `packages/merchant-backend/src/routes/activity.ts`
- Modify: `packages/merchant-backend/src/server.ts` (import + register inside `merchantPlane`)
- Modify: `packages/merchant-backend/test/route-protection.test.ts` (`KNOWN_DATA_ROUTES`)
- Test: `packages/merchant-backend/test/activity-route.test.ts`

**Interfaces:**
- Consumes: `RuntimeStatePort.readAudit(ctx, {limit?})` (most-recent-N, oldest-first, NO cursor — `runtime-state-port.ts:108`); the audit action slugs E1's `loop.ts` writes (verified: `proposal.created/approved/rejected/executing/executed/execution_failed/expired/withdrawn/revalidation_failed`, `agent.action.auto.intent/auto/failed`); `requirePermission`.
- Produces (pinned for Task 6): `GET /activity?cursor=` → `{ items: ActivityEntry[] }`, newest-first, where `interface ActivityEntry { seq: number; at: string; actor: string; action: string }` — the safe-DTO allowlist (D8), no `input`/`decision`/`prevHash`/`hash`. `cursor` accepted, presently a no-op (port has no cursor — the `routes/audit.ts` convention). W5 will consume this same read model for order touchpoint overlays.

- [ ] **Step 1: Write the failing test**

`packages/merchant-backend/test/activity-route.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore, type MerchantIdentityPort, type MerchantPrincipal } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// W2 Task 5: GET /activity — the merchant-facing agent-activity feed, an ALLOWLIST read model over
// the audit log (D8). Proves: allowlist filtering (metric/config plumbing excluded), newest-first
// order, the fixed safe DTO (no input/decision blobs), tenant scoping, and RBAC.

const viewer: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "viewer", authLevel: "session", sessionId: "s1" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

const ctx = { tenantId: "t1" };

describe("GET /activity", () => {
  it("returns ONLY agent-activity actions, newest first, as the fixed safe DTO", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit(ctx, { actor: "win_back_agent", action: "proposal.created", input: { SECRET: "never-shown" }, decision: { alsoSecret: true } }, "2026-08-24T01:00:00.000Z");
    await state.audit(ctx, { actor: "outcome-ledger", action: "arm_tally.accumulate" }, "2026-08-24T02:00:00.000Z"); // plumbing — excluded
    await state.audit(ctx, { actor: "u1", action: "rules.changed" }, "2026-08-24T03:00:00.000Z"); // config — excluded (it has its own screen)
    await state.audit(ctx, { actor: "u1", action: "proposal.approved" }, "2026-08-24T04:00:00.000Z");

    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/activity", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toEqual([
      { seq: 4, at: "2026-08-24T04:00:00.000Z", actor: "u1", action: "proposal.approved" },
      { seq: 1, at: "2026-08-24T01:00:00.000Z", actor: "win_back_agent", action: "proposal.created" },
    ]);
    // The safe-DTO allowlist holds structurally: no entry carries the raw blobs.
    expect(JSON.stringify(items)).not.toContain("SECRET");
    await app.close();
  });

  it("accepts ?cursor= as a forward-compat no-op (the audit-route convention)", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/activity?cursor=abc", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] }); // honest empty — never a fabricated feed
    await app.close();
  });

  it("tenant scoping: another tenant's activity never appears", async () => {
    const state = new InMemoryRuntimeStore();
    await state.audit({ tenantId: "t2" }, { actor: "win_back_agent", action: "proposal.created" });
    const app = await buildServer({ store: state, identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/activity", headers: { authorization: "Bearer good" } });
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it("an anonymous caller is 401'd", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity: identityFor(viewer) });
    const res = await app.inject({ method: "GET", url: "/activity" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/merchant-backend/test/activity-route.test.ts`
Expected: FAIL — 404 on `/activity` (route not registered).

- [ ] **Step 3: Write minimal implementation**

`packages/merchant-backend/src/routes/activity.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { AuditRecord, RuntimeStatePort } from "@palup/platform-ports";

// W2 Task 5: `GET /activity` — the merchant-facing "what did my agent do" feed (spec §9 W2), an
// ALLOWLIST read model over the tenant's audit log (D8). The audit log is the ONLY agent-activity
// source that exists (E1's loop.ts writes proposal.*/agent.action.* records; ADR-0006's richer
// event stream is not built) — so this feed is honest by construction: it can only show what was
// actually audited. Two disciplines carried over from routes/audit.ts:
//   • FIXED safe DTO — {seq, at, actor, action} only; never input/decision (typed `unknown`,
//     written by ~50 sites) and never prevHash/hash (chain-internal).
//   • `cursor` accepted but presently a no-op — `readAudit` has only `limit` (most-recent-N), so we
//     over-fetch and filter in-process. TODO(pagination): wire once the port grows a cursor.
// The ALLOWLIST (not a denylist) means new audit actions are EXCLUDED until deliberately added —
// a future write site can never accidentally leak an operational/config record into the feed.

export interface ActivityRoutesDeps {
  state: RuntimeStatePort;
}

/** The audit actions that ARE merchant-visible agent activity. Exactly the slugs `agent-runtime/
 * src/loop.ts` writes (verified against loop.ts) — metric plumbing (arm_tally.accumulate,
 * outcome_ledger.append), config changes (rules.changed, goal.changed — they have their own
 * surfaces), and kill/identity records are deliberately absent. */
export const ACTIVITY_ACTIONS: ReadonlySet<string> = new Set([
  "agent.action.auto.intent",
  "agent.action.auto",
  "agent.action.failed",
  "proposal.created",
  "proposal.approved",
  "proposal.rejected",
  "proposal.executing",
  "proposal.executed",
  "proposal.execution_failed",
  "proposal.expired",
  "proposal.withdrawn",
  "proposal.revalidation_failed",
]);

/** The merchant-safe activity entry. Deliberately smaller than SafeAuditEntry (no hash — this is a
 * product feed, not a verification surface; the audit screen serves that). */
export interface ActivityEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
}

interface ActivityListQuery {
  cursor?: string;
}

/** Over-fetch bound: the most-recent N audit records scanned per request. Activity actions are a
 * subset, so the feed shows at most this many — a bounded, honest window, not full history. */
const AUDIT_OVERFETCH = 500;

function toActivityEntry(record: AuditRecord): ActivityEntry {
  return { seq: record.seq, at: record.at, actor: record.actor, action: record.action };
}

export function registerActivityRoutes(app: FastifyInstance, deps: ActivityRoutesDeps): void {
  app.get<{ Querystring: ActivityListQuery }>(
    "/activity",
    { preHandler: requirePermission("console.view") },
    async (req) => {
      const principal = req.principal!; // set by the enclosing requireMerchant preHandler
      const records = await deps.state.readAudit({ tenantId: principal.merchantId }, { limit: AUDIT_OVERFETCH });
      const items = records
        .filter((r) => ACTIVITY_ACTIONS.has(r.action))
        .map(toActivityEntry)
        .reverse(); // readAudit is oldest-first; the feed wants newest-first
      return { items };
    },
  );
}
```

`packages/merchant-backend/src/server.ts` edits (two spots):

```ts
import { registerActivityRoutes } from "./routes/activity.js";
```

and inside the `merchantPlane` callback (after the Task 4 `registerHomeRoutes` line):

```ts
    registerActivityRoutes(merchantPlane, { state: store });
```

`packages/merchant-backend/test/route-protection.test.ts` — add to `KNOWN_DATA_ROUTES`:

```ts
  { method: "GET", url: "/activity" },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/merchant-backend/test/activity-route.test.ts packages/merchant-backend/test/route-protection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/routes/activity.ts packages/merchant-backend/src/server.ts packages/merchant-backend/test/activity-route.test.ts packages/merchant-backend/test/route-protection.test.ts
git commit -m "feat(merchant-backend): GET /activity — allowlist agent-activity feed over the audit log (W2 T5)"
```

---

### Task 6: Console API client — `getHomeSummary` / `getActivity` / `setPrimaryGoal`

**Files:**
- Modify: `packages/merchant-console/src/app/api.ts`
- Test: `packages/merchant-console/src/app/api.test.ts` (append a describe block)

**Interfaces:**
- Consumes: the existing `request<T>`/`toQuery` internals of `makeApiClient` (verbatim in `api.ts:138-173`); Task 4/5 wire contracts.
- Produces (pinned for Tasks 7/8) — **mirrored local types** (same rationale as `AuditEntry`: `@palup/merchant-backend` is a Fastify service, not a types barrel a frontend may depend on; every field below is a plain mirror of Task 3/5's response shapes, not invented):
  ```ts
  export type PrimaryGoalKind = "recover_carts" | "close_more_chat_sales" | "grow_repeat_purchases" | "increase_aov" | "win_back_lapsed";
  export interface PrimaryGoal { kind: PrimaryGoalKind; note?: string; setBy: string; setAt: string }
  export interface PlayMeasurement { play: string; incrementalLiftUsd: number; relativeLift: number; confidence: number; underpowered: boolean; method: string }
  export interface OnboardingHandoff { headline: string; items: Array<{ label: string; detail: string }>; sourceNote: string }
  export type NetReason = "ok" | "attribution_underpowered" | "cost_not_metered" | "cost_not_fully_priced";
  export interface HomeSummary { period: string; goal: PrimaryGoal | null; attributed: {...}; cost: {...}; net: { value: number | null; reason: NetReason }; handoff: OnboardingHandoff | null }
  export interface ActivityEntry { seq: number; at: string; actor: string; action: string }
  // ApiClient additions:
  getHomeSummary(): Promise<HomeSummary>;
  getActivity(cursor?: string): Promise<{ items: ActivityEntry[] }>;
  setPrimaryGoal(kind: PrimaryGoalKind, note?: string): Promise<{ goal: PrimaryGoal }>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `packages/merchant-console/src/app/api.test.ts` (reusing the file's existing `mockFetch`/`headersOf` helpers):

```ts
describe("Revenue Home methods (W2 T6)", () => {
  const emptySummary = {
    period: "2026-08",
    goal: null,
    attributed: { totalUsd: 0, entryCount: 0, plays: [], underpowered: true },
    cost: { metered: false, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 0 },
    net: { value: null, reason: "attribution_underpowered" },
    handoff: null,
  };

  it("getHomeSummary GETs /home/summary with the bearer", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify(emptySummary), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "sess-1", fetch: fetchSpy });
    const summary = await api.getHomeSummary();
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/home/summary");
    expect(headersOf(fetchSpy.mock.calls[0]![1]).Authorization).toBe("Bearer sess-1");
    expect(summary.net.reason).toBe("attribution_underpowered");
  });

  it("getActivity GETs /activity, forwarding an optional cursor", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await api.getActivity();
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/activity");
    await api.getActivity("c1");
    expect(fetchSpy.mock.calls[1]![0]).toBe("/api/activity?cursor=c1");
  });

  it("setPrimaryGoal PUTs /home/goal with kind (and note only when given)", async () => {
    const goal = { kind: "recover_carts", setBy: "u1", setAt: "2026-08-24T00:00:00.000Z" };
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ goal }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });

    await api.setPrimaryGoal("recover_carts");
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/home/goal");
    expect(fetchSpy.mock.calls[0]![1].method).toBe("PUT");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1].body))).toEqual({ kind: "recover_carts" });

    await api.setPrimaryGoal("increase_aov", "Q3 push");
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1].body))).toEqual({ kind: "increase_aov", note: "Q3 push" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/merchant-console/src/app/api.test.ts`
Expected: FAIL — `api.getHomeSummary is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `packages/merchant-console/src/app/api.ts`, add below the existing `ConsoleEvent` type (mirrored types — see the file's own header for why these are local, not imported from the backend):

```ts
// W2 (Revenue Home) — mirrors of merchant-backend's home/activity wire contract
// (src/home/read-model.ts's HomeSummary, src/routes/activity.ts's ActivityEntry,
// @palup/platform-ports' PrimaryGoal). Plain mirrors, not invented; same rationale as AuditEntry.

export type PrimaryGoalKind =
  | "recover_carts"
  | "close_more_chat_sales"
  | "grow_repeat_purchases"
  | "increase_aov"
  | "win_back_lapsed";

export interface PrimaryGoal {
  kind: PrimaryGoalKind;
  note?: string;
  setBy: string;
  setAt: string;
}

export interface PlayMeasurement {
  play: string;
  incrementalLiftUsd: number;
  relativeLift: number;
  confidence: number;
  underpowered: boolean;
  method: string;
}

export interface OnboardingHandoff {
  headline: string;
  items: Array<{ label: string; detail: string }>;
  sourceNote: string;
}

export type NetReason = "ok" | "attribution_underpowered" | "cost_not_metered" | "cost_not_fully_priced";

export interface HomeSummary {
  period: string;
  goal: PrimaryGoal | null;
  attributed: { totalUsd: number; entryCount: number; plays: PlayMeasurement[]; underpowered: boolean };
  cost: { metered: boolean; totalUsd: number; fullyPriced: boolean; unpricedModels: string[]; events: number };
  net: { value: number | null; reason: NetReason };
  handoff: OnboardingHandoff | null;
}

export interface ActivityEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
}
```

Add to the `ApiClient` interface (after `listAudit`):

```ts
  getHomeSummary(): Promise<HomeSummary>;
  getActivity(cursor?: string): Promise<{ items: ActivityEntry[] }>;
  setPrimaryGoal(kind: PrimaryGoalKind, note?: string): Promise<{ goal: PrimaryGoal }>;
```

Add to the returned object in `makeApiClient` (after the `listAudit` implementation):

```ts
    async getHomeSummary() {
      return request<HomeSummary>(`/home/summary`);
    },
    async getActivity(cursor) {
      return request<{ items: ActivityEntry[] }>(`/activity${toQuery({ cursor })}`);
    },
    async setPrimaryGoal(kind, note) {
      return request<{ goal: PrimaryGoal }>(`/home/goal`, {
        method: "PUT",
        body: JSON.stringify(note === undefined ? { kind } : { kind, note }),
      });
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/merchant-console/src/app/api.test.ts`
Expected: PASS (existing + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-console/src/app/api.ts packages/merchant-console/src/app/api.test.ts
git commit -m "feat(merchant-console): api client — getHomeSummary/getActivity/setPrimaryGoal (W2 T6)"
```

---

### Task 7: Revenue Home sub-components — `HandoffCard`, `NetPositionCard`, `ActivityToday`

**Files:**
- Create: `packages/merchant-console/src/screens/home/format.ts`
- Create: `packages/merchant-console/src/screens/home/HandoffCard.tsx`
- Create: `packages/merchant-console/src/screens/home/NetPositionCard.tsx`
- Create: `packages/merchant-console/src/screens/home/ActivityToday.tsx`
- Test: `packages/merchant-console/src/screens/home/HandoffCard.test.tsx`
- Test: `packages/merchant-console/src/screens/home/NetPositionCard.test.tsx`
- Test: `packages/merchant-console/src/screens/home/ActivityToday.test.tsx`

**Interfaces:**
- Consumes: `HomeSummary`/`OnboardingHandoff`/`ActivityEntry`/`PrimaryGoalKind`/`NetReason` (Task 6); `@palup/design-system` `Card`/`CardHeader`/`CardTitle`/`CardBody`/`Note`/`Badge` (signatures verified: `Note` accepts `className`+`variant "info"|"warn"|"ever"|"dang"`; `Badge` `variant`+`dot`; Card family are plain div wrappers).
- Produces (pinned for Task 8):
  ```ts
  // format.ts
  export function fmtUsd(n: number): string;
  export const GOAL_LABELS: Record<PrimaryGoalKind, string>;
  export const ACTION_LABELS: Record<string, string>;   // activity slug → merchant copy; unknown → raw slug
  export function activityLabel(action: string): string;
  // components
  export function HandoffCard(props: { handoff: OnboardingHandoff; onDismiss: () => void }): JSX.Element;
  export function NetPositionCard(props: { summary: HomeSummary }): JSX.Element;
  export function ActivityToday(props: { items: ActivityEntry[] }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/merchant-console/src/screens/home/HandoffCard.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OnboardingHandoff } from "../../app/api";
import { HandoffCard } from "./HandoffCard";

const handoff: OnboardingHandoff = {
  headline: "Welcome to PalUp — I picked up where we left off",
  items: [
    { label: "Shade and ingredient Q&A is on.", detail: "I answer these in live chat 24/7." },
    { label: "Your goal — recover more carts — is first in line.", detail: "It's the first play this week." },
  ],
  sourceNote: "This is from your signup conversation with PalUp — kept separate from your customers' data.",
};

describe("HandoffCard", () => {
  it("renders the headline, every item, and the data-separation source note", () => {
    render(<HandoffCard handoff={handoff} onDismiss={vi.fn()} />);
    expect(screen.getByText(handoff.headline)).toBeInTheDocument();
    expect(screen.getByText("Shade and ingredient Q&A is on.")).toBeInTheDocument();
    expect(screen.getByText("It's the first play this week.")).toBeInTheDocument();
    expect(screen.getByText(/kept separate from your customers/)).toBeInTheDocument();
  });

  it("fires onDismiss from the labeled dismiss control", async () => {
    const onDismiss = vi.fn();
    render(<HandoffCard handoff={handoff} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
```

`packages/merchant-console/src/screens/home/NetPositionCard.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HomeSummary } from "../../app/api";
import { NetPositionCard } from "./NetPositionCard";

function summary(over: Partial<HomeSummary> = {}): HomeSummary {
  return {
    period: "2026-08",
    goal: null,
    attributed: { totalUsd: 0, entryCount: 0, plays: [], underpowered: true },
    cost: { metered: false, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 0 },
    net: { value: null, reason: "attribution_underpowered" },
    handoff: null,
    ...over,
  };
}

describe("NetPositionCard", () => {
  it("renders a real positive net with both honest sides itemized", () => {
    render(
      <NetPositionCard
        summary={summary({
          attributed: { totalUsd: 150, entryCount: 2, plays: [], underpowered: false },
          cost: { metered: true, totalUsd: 12.5, fullyPriced: true, unpricedModels: [], events: 40 },
          net: { value: 137.5, reason: "ok" },
        })}
      />,
    );
    expect(screen.getByText("$137.50")).toBeInTheDocument();
    expect(screen.getByText("Incremental revenue created")).toBeInTheDocument();
    expect(screen.getByText("$150.00")).toBeInTheDocument();
    expect(screen.getByText("Model cost (measured)")).toBeInTheDocument();
    expect(screen.getByText("−$12.50")).toBeInTheDocument();
  });

  it("shows a NEGATIVE net honestly with the fix-it note — never hidden (spec §10)", () => {
    render(
      <NetPositionCard
        summary={summary({
          attributed: { totalUsd: 1, entryCount: 1, plays: [], underpowered: false },
          cost: { metered: true, totalUsd: 1.5, fullyPriced: true, unpricedModels: [], events: 3 },
          net: { value: -0.5, reason: "ok" },
        })}
      />,
    );
    expect(screen.getByText("−$0.50")).toBeInTheDocument();
    expect(screen.getByText(/currently costs more than the incremental revenue/i)).toBeInTheDocument();
    expect(screen.getByText(/tighten what runs automatically in Automation Rules/i)).toBeInTheDocument();
  });

  it("still-measuring state: no number is fabricated while attribution is underpowered", () => {
    render(<NetPositionCard summary={summary()} />);
    expect(screen.getByText(/still measuring/i)).toBeInTheDocument();
    expect(screen.getByText(/holdout/i)).toBeInTheDocument();
    expect(screen.queryByText(/^\$/)).toBeNull();
  });

  it("withholds net when cost is not metered, saying so", () => {
    render(
      <NetPositionCard
        summary={summary({
          attributed: { totalUsd: 100, entryCount: 1, plays: [], underpowered: false },
          net: { value: null, reason: "cost_not_metered" },
        })}
      />,
    );
    expect(screen.getByText(/model cost isn't metered for this period yet/i)).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument(); // the honest side still shows
  });

  it("withholds net when models are unpriced, labeling cost as a lower bound", () => {
    render(
      <NetPositionCard
        summary={summary({
          attributed: { totalUsd: 100, entryCount: 1, plays: [], underpowered: false },
          cost: { metered: true, totalUsd: 2, fullyPriced: false, unpricedModels: ["gemini-2.5-flash"], events: 9 },
          net: { value: null, reason: "cost_not_fully_priced" },
        })}
      />,
    );
    expect(screen.getByText(/some model costs aren't priced yet/i)).toBeInTheDocument();
    expect(screen.getByText(/≥ \$2\.00/)).toBeInTheDocument();
  });
});
```

`packages/merchant-console/src/screens/home/ActivityToday.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ActivityEntry } from "../../app/api";
import { ActivityToday } from "./ActivityToday";

const items: ActivityEntry[] = [
  { seq: 4, at: "2026-08-24T04:00:00.000Z", actor: "u1", action: "proposal.approved" },
  { seq: 1, at: "2026-08-24T01:00:00.000Z", actor: "win_back_agent", action: "proposal.created" },
  { seq: 9, at: "2026-08-24T05:00:00.000Z", actor: "win_back_agent", action: "some.future.action" },
];

describe("ActivityToday", () => {
  it("renders merchant-worded labels for known actions and the raw slug for unknown ones", () => {
    render(<ActivityToday items={items} />);
    expect(screen.getByText("Proposal approved")).toBeInTheDocument();
    expect(screen.getByText("Drafted a proposal for your approval")).toBeInTheDocument();
    expect(screen.getByText("some.future.action")).toBeInTheDocument(); // honest fallback, never dropped
  });

  it("shows the actor on each row", () => {
    render(<ActivityToday items={items} />);
    expect(screen.getAllByText("win_back_agent").length).toBeGreaterThan(0);
  });

  it("honest empty state when there is no recorded activity", () => {
    render(<ActivityToday items={[]} />);
    expect(screen.getByText(/no agent activity recorded yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/merchant-console/src/screens/home`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementations**

`packages/merchant-console/src/screens/home/format.ts`:

```ts
import type { PrimaryGoalKind } from "../../app/api";

// Shared display helpers for the Revenue Home screens (W2 T7/T8) — one place so the tiles, the net
// card, and the activity feed can never drift on wording. Copy tone matches
// palup-merchant-app.html #dashboard; every NUMBER is API-driven (governance: no fake numbers).

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$1,234.56"; negatives use the typographic minus the mockup uses ("−$0.50"). */
export function fmtUsd(n: number): string {
  return n < 0 ? `−${usd.format(Math.abs(n))}` : usd.format(n);
}

export const GOAL_LABELS: Record<PrimaryGoalKind, string> = {
  recover_carts: "Recover more carts",
  close_more_chat_sales: "Close more chat sales",
  grow_repeat_purchases: "Grow repeat purchases",
  increase_aov: "Increase average order value",
  win_back_lapsed: "Win back lapsed customers",
};

/** Activity-slug → merchant copy. Keyed by the exact audit actions routes/activity.ts allowlists
 * (agent-runtime/src/loop.ts's slugs). An unknown slug falls back to the raw slug — honest, never
 * dropped or guessed. */
export const ACTION_LABELS: Record<string, string> = {
  "agent.action.auto.intent": "Started an in-envelope action",
  "agent.action.auto": "Completed an in-envelope action",
  "agent.action.failed": "An action failed (logged for review)",
  "proposal.created": "Drafted a proposal for your approval",
  "proposal.approved": "Proposal approved",
  "proposal.rejected": "Proposal rejected",
  "proposal.executing": "Started executing an approved proposal",
  "proposal.executed": "Executed an approved proposal",
  "proposal.execution_failed": "An approved proposal failed to execute",
  "proposal.expired": "A proposal expired unanswered",
  "proposal.withdrawn": "A proposal was withdrawn",
  "proposal.revalidation_failed": "An approved proposal no longer passed its checks",
};

export function activityLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
```

`packages/merchant-console/src/screens/home/HandoffCard.tsx`:

```tsx
import { Note } from "@palup/design-system";
import type { OnboardingHandoff } from "../../app/api";

// W2 T7: the signup→console handoff card (mockup #onboard-handoff). Rendered ONLY when the API
// returned a real handoff object written by onboarding (D7) — never fabricated. The sourceNote is
// the cross-plane transparency line ("from your signup conversation… kept separate from your
// customers' data") and always renders with the card.

export interface HandoffCardProps {
  handoff: OnboardingHandoff;
  onDismiss: () => void;
}

export function HandoffCard({ handoff, onDismiss }: HandoffCardProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-ever bg-surface shadow-sm">
      <div className="flex items-center justify-between gap-3 bg-ever px-[18px] py-[13px] text-white">
        <b className="text-[14px]">{handoff.headline}</b>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="cursor-pointer text-[20px] leading-none opacity-85"
        >
          ×
        </button>
      </div>
      <div className="px-[18px] py-4">
        <div className="mb-[15px] flex flex-col gap-[10px]">
          {handoff.items.map((item) => (
            <div key={item.label} className="flex items-start gap-[10px]">
              <span
                aria-hidden="true"
                className="mt-[1px] grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full bg-ever-soft text-ever"
              >
                ✓
              </span>
              <div>
                <b className="text-[13px]">{item.label}</b>
                <div className="text-[12.5px] text-ink-3">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
        <Note variant="info" className="text-[11.5px]">
          {handoff.sourceNote}
        </Note>
      </div>
    </div>
  );
}
```

`packages/merchant-console/src/screens/home/NetPositionCard.tsx`:

```tsx
import { Badge, Card, CardBody, CardHeader, CardTitle, Note } from "@palup/design-system";
import type { HomeSummary } from "../../app/api";
import { fmtUsd } from "./format";

// W2 T7: "Your net position" (mockup #dashboard net card), with the honesty rules D3 demands:
//   • net shown ONLY when both sides are honest (≥1 ledger entry, metered, fully priced);
//   • net-NEGATIVE shown as-is with a fix-it path (spec §10 — hiding it inverts the moat);
//   • otherwise the reason is stated in words, never a fabricated $0 or a blank.
// Deviation from the mockup (D6): no fee line — the performance fee is W6's separately-gated
// boundary; until it exists this card is incremental revenue − model cost, and says so.

export interface NetPositionCardProps {
  summary: HomeSummary;
}

export function NetPositionCard({ summary }: NetPositionCardProps) {
  const { attributed, cost, net } = summary;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your net position</CardTitle>
      </CardHeader>
      <CardBody>
        {net.reason === "ok" && net.value !== null ? (
          <>
            <div className="pb-1 pt-[6px] text-center">
              <div className="text-[12.5px] text-ink-3">Incremental revenue − model cost</div>
              <div
                className={`mt-1 font-mono text-[34px] font-semibold tracking-[-.02em] ${net.value >= 0 ? "text-pos" : "text-dang"}`}
              >
                {fmtUsd(net.value)}
              </div>
              {net.value >= 0 && (
                <Badge variant="pos" className="mt-2">
                  Net positive this period
                </Badge>
              )}
            </div>
            <div className="my-3 border-t border-line-2" />
            <div className="mb-[10px] flex justify-between text-[13px]">
              <span className="text-ink-3">Incremental revenue created</span>
              <b className="font-mono">{fmtUsd(attributed.totalUsd)}</b>
            </div>
            <div className="flex justify-between text-[13px]">
              <span className="text-ink-3">Model cost (measured)</span>
              <b className="font-mono text-coral">{fmtUsd(-cost.totalUsd)}</b>
            </div>
            {net.value < 0 && (
              <Note variant="warn" className="mt-[14px] text-[12px]">
                Your agent currently costs more than the incremental revenue it has proven. This is shown
                honestly, never hidden. To fix it: tighten what runs automatically in Automation Rules, or
                reply to this in the Approval Center — we only want to earn when we create new revenue for you.
              </Note>
            )}
          </>
        ) : (
          <>
            {attributed.entryCount > 0 && (
              <div className="mb-[10px] flex justify-between text-[13px]">
                <span className="text-ink-3">Incremental revenue created</span>
                <b className="font-mono">{fmtUsd(attributed.totalUsd)}</b>
              </div>
            )}
            {net.reason === "attribution_underpowered" && (
              <Note variant="info">
                Still measuring. We only count revenue proven against a holdout — never sales you&apos;d have
                made anyway — and there isn&apos;t enough evidence yet to state a number. No number beats a
                made-up one.
              </Note>
            )}
            {net.reason === "cost_not_metered" && (
              <Note variant="info">
                Model cost isn&apos;t metered for this period yet, so we won&apos;t show a net figure we can&apos;t
                stand behind.
              </Note>
            )}
            {net.reason === "cost_not_fully_priced" && (
              <Note variant="warn">
                Some model costs aren&apos;t priced yet (measured so far: {`≥ ${fmtUsd(cost.totalUsd).replace("−", "")}`},
                a lower bound). Net is withheld rather than guessed.
              </Note>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
```

`packages/merchant-console/src/screens/home/ActivityToday.tsx`:

```tsx
import { Card, CardBody, CardHeader, CardTitle, Note } from "@palup/design-system";
import type { ActivityEntry } from "../../app/api";
import { activityLabel } from "./format";

// W2 T7: "What your agent did" (mockup #dashboard activity card) — a pure render of GET /activity's
// audit-derived feed. Every row IS an audit record (allowlisted server-side); nothing is inferred,
// aggregated, or invented, and an unknown action renders its raw slug rather than being dropped.
// The mockup's rolled-up counts ("Recovered 11 abandoned carts · $1,840") need per-order touchpoint
// data that W5 builds — until then the honest feed is the individual audited actions (D6/D8).

export interface ActivityTodayProps {
  items: ActivityEntry[];
}

const timeFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function formatAt(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : timeFormatter.format(parsed);
}

export function ActivityToday({ items }: ActivityTodayProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What your agent did</CardTitle>
      </CardHeader>
      <CardBody className="pt-[6px]">
        {items.length === 0 ? (
          <Note variant="info">No agent activity recorded yet — everything your agent does will appear here, from its audit log.</Note>
        ) : (
          items.map((entry, i) => (
            <div
              key={entry.seq}
              className={`flex items-start justify-between gap-3 py-[11px] ${i < items.length - 1 ? "border-b border-line-2" : ""}`}
            >
              <div>
                <b className="text-[13px]">{activityLabel(entry.action)}</b>
                <div className="text-[12.5px] text-ink-3">{entry.actor}</div>
              </div>
              <span className="whitespace-nowrap text-[12px] text-ink-4">{formatAt(entry.at)}</span>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/merchant-console/src/screens/home`
Expected: PASS (10 tests across 3 files).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-console/src/screens/home
git commit -m "feat(merchant-console): Revenue Home sub-components — handoff, honest net card, activity feed (W2 T7)"
```

---

### Task 8: `RevenueHome` screen + replace the `/dashboard` stub

**Files:**
- Create: `packages/merchant-console/src/screens/home/RevenueHome.tsx`
- Modify: `packages/merchant-console/src/App.tsx` (import + `<Route>`, remove `/dashboard` from `STUB_ROUTES`)
- Test: `packages/merchant-console/src/screens/home/RevenueHome.test.tsx`

**Interfaces:**
- Consumes: `ApiClient` (`getHomeSummary`/`getActivity`, Task 6); `HandoffCard`/`NetPositionCard`/`ActivityToday`/`fmtUsd`/`GOAL_LABELS` (Task 7); `StatTile`/`Card`/`CardHeader`/`CardTitle`/`CardBody`/`Badge`/`Button`/`Note`/`Table` family (`@palup/design-system`, signatures verified).
- Produces: `export function RevenueHome(props: { api: Pick<ApiClient, "getHomeSummary" | "getActivity"> }): JSX.Element` at route `/dashboard` (nav link already exists in `app/shell.tsx:45` — no shell change).

- [ ] **Step 1: Write the failing test**

`packages/merchant-console/src/screens/home/RevenueHome.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityEntry, HomeSummary } from "../../app/api";
import { RevenueHome } from "./RevenueHome";

function summary(over: Partial<HomeSummary> = {}): HomeSummary {
  return {
    period: "2026-08",
    goal: null,
    attributed: { totalUsd: 0, entryCount: 0, plays: [], underpowered: true },
    cost: { metered: false, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 0 },
    net: { value: null, reason: "attribution_underpowered" },
    handoff: null,
    ...over,
  };
}

function fakeApi(s: HomeSummary, items: ActivityEntry[] = []) {
  return {
    getHomeSummary: vi.fn(async () => s),
    getActivity: vi.fn(async () => ({ items })),
  };
}

describe("RevenueHome", () => {
  it("Day-0: every tile is an HONEST state — no fabricated numbers anywhere", async () => {
    render(<RevenueHome api={fakeApi(summary())} />);
    expect(await screen.findByText("Still measuring")).toBeInTheDocument();
    expect(screen.getByText("Not yet metered")).toBeInTheDocument();
    expect(screen.getByText("No primary goal set yet")).toBeInTheDocument();
    expect(screen.getByText(/no plays are being measured yet/i)).toBeInTheDocument();
    // The mockup's demo values must never leak in.
    expect(screen.queryByText("$76,420")).toBeNull();
  });

  it("renders real attributed/cost/net values when the API has them, plus the goal chip", async () => {
    render(
      <RevenueHome
        api={fakeApi(
          summary({
            goal: { kind: "recover_carts", setBy: "u1", setAt: "2026-08-24T00:00:00.000Z" },
            attributed: {
              totalUsd: 150,
              entryCount: 2,
              plays: [{ play: "win_back", incrementalLiftUsd: 2250, relativeLift: 3, confidence: 0.99, underpowered: false, method: "m" }],
              underpowered: false,
            },
            cost: { metered: true, totalUsd: 12.5, fullyPriced: true, unpricedModels: [], events: 40 },
            net: { value: 137.5, reason: "ok" },
          }),
          [{ seq: 1, at: "2026-08-24T01:00:00.000Z", actor: "win_back_agent", action: "proposal.created" }],
        )}
      />,
    );
    // "$150.00" appears on BOTH the attributed tile and the net card's itemized row — assert ≥1,
    // never getByText (which throws on multiple matches).
    expect((await screen.findAllByText("$150.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("$12.50")).toBeInTheDocument(); // cost tile (the net card row reads "−$12.50")
    expect(screen.getAllByText("$137.50").length).toBeGreaterThan(0); // net tile + card
    expect(screen.getByText("Recover more carts")).toBeInTheDocument(); // goal chip
    expect(screen.getByText("win_back")).toBeInTheDocument(); // measurement row
    expect(screen.getByText("Drafted a proposal for your approval")).toBeInTheDocument(); // activity
  });

  it("labels an unpriced cost as a lower bound on the tile", async () => {
    render(
      <RevenueHome
        api={fakeApi(
          summary({ cost: { metered: true, totalUsd: 2, fullyPriced: false, unpricedModels: ["gemini-2.5-flash"], events: 9 } }),
        )}
      />,
    );
    expect(await screen.findByText("≥ $2.00")).toBeInTheDocument();
    expect(screen.getByText(/some models unpriced/i)).toBeInTheDocument();
  });

  it("shows the handoff card when the API returns one and hides it on dismiss", async () => {
    render(
      <RevenueHome
        api={fakeApi(
          summary({
            handoff: {
              headline: "Welcome to PalUp — I picked up where we left off",
              items: [{ label: "Your goal is first in line.", detail: "Running this week." }],
              sourceNote: "From your signup conversation — kept separate from your customers' data.",
            },
          }),
        )}
      />,
    );
    expect(await screen.findByText(/picked up where we left off/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/picked up where we left off/)).toBeNull();
  });

  it("surfaces a load failure with a Retry that re-fetches", async () => {
    const api = {
      getHomeSummary: vi.fn(async () => {
        throw new Error("boom");
      }),
      getActivity: vi.fn(async () => ({ items: [] as ActivityEntry[] })),
    };
    render(<RevenueHome api={api} />);
    expect(await screen.findByText(/couldn't load revenue home/i)).toBeInTheDocument();
    api.getHomeSummary.mockImplementation(async () => summary());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Still measuring")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/merchant-console/src/screens/home/RevenueHome.test.tsx`
Expected: FAIL — `Cannot find module './RevenueHome'`.

- [ ] **Step 3: Write minimal implementation**

`packages/merchant-console/src/screens/home/RevenueHome.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Note,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@palup/design-system";
import type { ActivityEntry, ApiClient, HomeSummary } from "../../app/api";
import { HandoffCard } from "./HandoffCard";
import { NetPositionCard } from "./NetPositionCard";
import { ActivityToday } from "./ActivityToday";
import { fmtUsd, GOAL_LABELS } from "./format";

// W2 T8: Revenue Home — the retention scoreboard (spec §9 W2), replacing the /dashboard stub.
// Layout matches palup-merchant-app.html #dashboard (handoff card → incremental-honesty note →
// stat-tile row → measurement + net cards → activity); every NUMBER is API-driven with honest
// "still measuring"/"not yet metered" states — the mockup's demo values are deliberately absent
// (governance rule, not style). Deviations D6: no time-series chart (no read model yet — the
// per-play measurement card takes that slot), no per-channel tiles (needs W5 touchpoints), no fee
// line (W6). Read-only: the one write this surface owns (the goal) is set by onboarding's guided
// flow via api.setPrimaryGoal; here the goal renders as a chip.

export interface RevenueHomeProps {
  api: Pick<ApiClient, "getHomeSummary" | "getActivity">;
}

type LoadState = "loading" | "ready" | "error";

export function RevenueHome({ api }: RevenueHomeProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [handoffDismissed, setHandoffDismissed] = useState(false);

  const load = useCallback(() => {
    setState("loading");
    Promise.all([api.getHomeSummary(), api.getActivity()]).then(
      ([s, a]) => {
        setSummary(s);
        setActivity(a.items);
        setState("ready");
      },
      () => setState("error"),
    );
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === "loading") {
    return (
      <div role="status" className="p-6 text-[13px] text-ink-3">
        Loading Revenue Home…
      </div>
    );
  }

  if (state === "error" || summary === null) {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn&apos;t load Revenue Home.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </Note>
    );
  }

  const attributedValue = summary.attributed.underpowered ? "Still measuring" : fmtUsd(summary.attributed.totalUsd);
  const attributedFootnote = summary.attributed.underpowered
    ? "Proven against a holdout — needs more evidence before we state a number"
    : `${summary.attributed.entryCount} reconciled ledger entries · ${summary.period}`;

  const costValue = !summary.cost.metered
    ? "Not yet metered"
    : summary.cost.fullyPriced
      ? fmtUsd(summary.cost.totalUsd)
      : `≥ ${fmtUsd(summary.cost.totalUsd)}`;
  const costFootnote = !summary.cost.metered
    ? "No model calls recorded this period"
    : summary.cost.fullyPriced
      ? `${summary.cost.events} model calls · ${summary.period}`
      : `Lower bound — some models unpriced (${summary.cost.unpricedModels.join(", ")})`;

  const netValue = summary.net.value === null ? "—" : fmtUsd(summary.net.value);
  const netFootnote =
    summary.net.reason === "ok"
      ? "Incremental revenue − model cost"
      : summary.net.reason === "attribution_underpowered"
        ? "Withheld until attribution has enough evidence"
        : summary.net.reason === "cost_not_metered"
          ? "Withheld — model cost not metered this period"
          : "Withheld — some model costs are unpriced";

  return (
    <div className="flex flex-col gap-4">
      {summary.handoff && !handoffDismissed && (
        <HandoffCard handoff={summary.handoff} onDismiss={() => setHandoffDismissed(true)} />
      )}

      <Note variant="ever">
        <b>This is the value PalUp added that you would not have captured otherwise.</b> We only count{" "}
        <i>incremental</i> revenue your agent created, proven against a holdout — never sales you&apos;d have
        made anyway.
      </Note>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Revenue PalUp brought in" value={attributedValue} mono={!summary.attributed.underpowered} footnote={attributedFootnote} />
        <StatTile label="Model cost" value={costValue} mono={summary.cost.metered} footnote={costFootnote} />
        <StatTile label="Net position" value={netValue} mono={summary.net.value !== null} footnote={netFootnote} />
        <StatTile label="Agent actions (recent)" value={String(activity.length)} footnote="From the audit log — every action, no silent ones" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>What&apos;s being measured</CardTitle>
            {summary.goal ? (
              <Badge variant="ever" dot={false}>{GOAL_LABELS[summary.goal.kind]}</Badge>
            ) : (
              <Badge variant="gray" dot={false}>No primary goal set yet</Badge>
            )}
          </CardHeader>
          <CardBody>
            {summary.attributed.plays.length === 0 ? (
              <Note variant="info">
                No plays are being measured yet. Measurement begins once your agent runs its first play
                against the holdout — the proof behind every number on this page.
              </Note>
            ) : (
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Play</TableHeaderCell>
                    <TableHeaderCell>Incremental lift</TableHeaderCell>
                    <TableHeaderCell>Confidence</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {summary.attributed.plays.map((p) => (
                    <TableRow key={p.play}>
                      <TableCell>{p.play}</TableCell>
                      <TableCell>{p.underpowered ? "—" : fmtUsd(p.incrementalLiftUsd)}</TableCell>
                      <TableCell>{p.underpowered ? "—" : `${Math.round(p.confidence * 100)}%`}</TableCell>
                      <TableCell>
                        {p.underpowered ? <Badge variant="warn">Still measuring</Badge> : <Badge variant="pos">Measured</Badge>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardBody>
        </Card>

        <NetPositionCard summary={summary} />
      </div>

      <ActivityToday items={activity} />
    </div>
  );
}
```

`packages/merchant-console/src/App.tsx` edits (three exact changes):

1. Add the import after the `ApprovalCenter` import:

```tsx
import { RevenueHome } from "./screens/home/RevenueHome";
```

2. Delete the line `{ path: "/dashboard", title: "Revenue Home" },` from `STUB_ROUTES`.

3. Add the route directly after the `/approvals` route:

```tsx
        <Route path="/dashboard" element={<RevenueHome api={api} />} />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/merchant-console`
Expected: PASS (all console suites — the removed stub breaks nothing; `shell.test.tsx` doesn't assert stub rendering). Then type-check + build the SPA: `pnpm --filter @palup/merchant-console build` — succeeds (this is also what `merchant-backend`'s `ensureConsoleBuilt` tests consume).

- [ ] **Step 5: Run the full local gate and commit**

Run: `bash .claude/scripts/merge-gate.sh` (the repo's local CI gate — do not claim green without running it).

```bash
git add packages/merchant-console/src/screens/home/RevenueHome.tsx packages/merchant-console/src/screens/home/RevenueHome.test.tsx packages/merchant-console/src/App.tsx
git commit -m "feat(merchant-console): Revenue Home screen replaces the /dashboard stub (W2 T8)"
```

---

## Self-review checklist (run after writing code, before the PR)

- Spec §9 W2 coverage: `GET /home/summary` (T3/T4) ✓ · `GET /activity?cursor=` (T5) ✓ · onboarding-handoff card (T3 D7 + T7/T8) ✓ · attributed/cost/**net** (T3 D1–D3) ✓ · one primary goal (T1/T2/T4) ✓ · honest incremental/holdout positioning + net-negative-honest (T7/T8 copy + tests) ✓ · canonical-metering single-source (D2 — ledger only, no second calculation) ✓.
- No route outside `merchantPlane`; both new-route tasks update `KNOWN_DATA_ROUTES`; nothing added to `AUTH_EXEMPT_PATHS`.
- Type names consistent end-to-end: `PrimaryGoal`/`PrimaryGoalKind`/`PrimaryGoalSetInput`/`PrimaryGoalStore` (T1→T2→T4→T6), `HomeSummary`/`PlayMeasurement`/`OnboardingHandoff`/`NetReason` (T3→T6→T7→T8), `ActivityEntry` (T5→T6→T7).
- No enablement flag flipped anywhere; no import of `packages/evolution` or any billing/fee code.

## Deferred human/legal/enablement gates (program-level hand-off)

- **Holdout enablement** (`pnpm holdout:set <tenant> true [fraction]`, `writeHoldoutConfig`) stays **OFF** — flipping it for a real tenant is an **owner/legal go-live decision** (§3). Until then `attributed` is honestly empty/underpowered by construction.
- **Real model prices** (`PALUP_MODEL_PRICES`) are a **FinOps/owner-provided** world fact (source + date); until provided, cost renders as unpriced/lower-bound — never auto-populated by a build agent.
- **Performance fee / billing** — deliberately absent from NET (D3). The fee model (~6% on incremental) is **W6's** and the ultimate §3 money/business-model boundary; any fee computation requires that workstream's gates.
- **Onboarding-handoff writer** — W2 reads `onboarding_handoff/card` only; the writer is the Onboarding block, whose **cross-plane signup-data separation is named-human-owner + security-reviewer gated** (spec: Install & Onboarding §3 note). Durable handoff dismissal ships there too.
- **Shopify `read_orders` scope + Protected Customer Data approval** — required before real order attribution feeds the tallies in production (Wave-2 pre-enable list; human/partner-dashboard steps).
- **`UsageLedgerEntry` writer** — still a type with no writer (verified); W2 does not populate it. Credit metering is a later, separately-owned increment (W6).
- **Prod deployment/promotion** of `merchant-backend`/console remains human-promoted (§3 #2); this plan is staging-shaped only.

## Assumes from earlier blocks

- **F1 `design-system`**: `StatTile`/`Card*`/`Note`/`Badge`/`Button`/`Table*` with the verified signatures (`packages/design-system/src/components/*`).
- **F2 `identity-shopify`**: `requireMerchant`/`requirePermission`, `req.principal` decoration, the 5-role `DEFAULT_ROLE_PERMISSIONS` (`console.view` floor; `settings.edit` = admin+owner).
- **F3 `merchant-backend`**: `buildServer` composition root (injectable `store`/`identity`/…), the `merchantPlane` encapsulation, the redacting error handler, `route-protection.test.ts`'s structural guard, `ensureConsoleBuilt` for SPA-touching tests.
- **E1/W1/WB**: `agent-runtime/src/loop.ts`'s audit slugs (the activity feed's entire vocabulary) and the Approval Center the activity copy points at.
- **Wave-2 attribution spine (built dark)**: `outcome-ledger.ts` types + `computeIncrementalLift`, `state-postgres/outcome-ledger-store.ts` accessors, `holdout.ts` period/play conventions, `telemetry-port.ts`/`telemetry-cost.ts`.
- **Provides forward**: W5 consumes the `/activity` read model (and extends it with per-order touchpoints); **W6 consumes W2's attributed totals** (`readOutcomeLedger` per period) as the fee base and this plan's `cost` honesty states for margin display; **Onboarding consumes the goal object** (`setPrimaryGoal`) + the `OnboardingHandoff` contract (+ W4 presets + W7 residency, per its own plan).
