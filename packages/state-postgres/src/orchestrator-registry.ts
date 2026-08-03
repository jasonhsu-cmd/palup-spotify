import type { RuntimeStatePort } from "@palup/platform-ports";

// ADR-0014 #9 — the SHARED, per-tenant auto-promote orchestrator state (frequency cap + freeze), on the
// same RuntimeStatePort the serving / rollback paths use. Both the auto-loop (records promotions, reads
// the cap) and the rollback paths (freeze on a monitored regression) touch this ONE tenant-keyed row —
// so a rollback in one lifecycle (the monitor/canary) freezes the auto-promote fast-lane in another (the
// next auto-loop run). Keyed per SERVING TENANT, so the cap/freeze are per-merchant (never global).
const ORCH = "orchestrator";
const STATE_KEY = "auto-promote";

/** Default frequency-cap + freeze window (1 week) — bounds silent drift to ≤1 auto-promotion/week. */
export const AUTO_PROMOTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrchestratorState {
  /** ISO time of the last AUTO-promotion — the frequency cap measures from here. */
  lastPromotedAt?: string;
  /** ISO time the auto-promote fast-lane is FROZEN until (set on a rollback). */
  frozenUntil?: string;
}

export async function readOrchestratorState(store: RuntimeStatePort, tenantId: string): Promise<OrchestratorState> {
  return (await store.get<OrchestratorState>({ tenantId }, ORCH, STATE_KEY)) ?? {};
}

/** Stamp the frequency-cap clock on an auto-promotion (audited, NN #5). Atomic put + audit. */
export async function recordAutoPromotion(store: RuntimeStatePort, tenantId: string, at = new Date().toISOString()): Promise<void> {
  await store.tx({ tenantId }, async (t) => {
    const st = (await t.get<OrchestratorState>(ORCH, STATE_KEY)) ?? {};
    await t.put(ORCH, STATE_KEY, { ...st, lastPromotedAt: at });
    await t.audit({ actor: "auto-loop", action: "orchestrator.promoted", input: { tenantId }, decision: "stamped the frequency-cap clock", reversalPath: "n/a" }, at);
  });
}

/**
 * FREEZE the auto-promote fast-lane until `until` after a rollback (audited). Called by the rollback
 * path (rollbackServing / canary rollback) — a monitored regression halts the fast-lane so the same or a
 * similar change can't be immediately re-promoted (ADR-0014 #9 "freeze on rollback").
 */
export async function freezeAutoPromote(store: RuntimeStatePort, tenantId: string, until: string, reason: string, at = new Date().toISOString()): Promise<void> {
  await store.tx({ tenantId }, async (t) => {
    const st = (await t.get<OrchestratorState>(ORCH, STATE_KEY)) ?? {};
    await t.put(ORCH, STATE_KEY, { ...st, frozenUntil: until });
    await t.audit({ actor: "monitor", action: "orchestrator.freeze", input: { tenantId, until, reason }, decision: `froze auto-promotion until ${until}`, reversalPath: "n/a" }, at);
  });
}

/**
 * The halt reason if auto-promotion is currently FROZEN or inside the frequency cap, else null.
 * FAIL-CLOSED on an unreadable/absent clock — a drift-bounding control must never silently self-disable,
 * so anything it can't verify halts (returns a reason) rather than allowing a promotion.
 */
export function rateLimitReason(st: OrchestratorState, nowIso: string, cooldownMs = AUTO_PROMOTE_WINDOW_MS): string | null {
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) return "clock-unreadable — cannot verify the rate-limit"; // fail closed
  if (st.frozenUntil) {
    const f = Date.parse(st.frozenUntil);
    if (Number.isNaN(f)) return "freeze timestamp unreadable"; // fail closed
    if (nowMs < f) return `frozen until ${st.frozenUntil} (post-rollback)`;
  }
  if (st.lastPromotedAt) {
    const l = Date.parse(st.lastPromotedAt);
    if (Number.isNaN(l)) return "last-promotion timestamp unreadable"; // fail closed
    if (nowMs - l < cooldownMs) return `frequency cap — ≤1 auto-promotion per ${Math.round(cooldownMs / 86_400_000)}d (last ${st.lastPromotedAt})`;
  }
  return null;
}
