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
