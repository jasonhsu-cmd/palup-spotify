import type { RuntimeStatePort, RuntimeStateTx } from "@palup/platform-ports";

// ADR-0014 T4c — a DURABLE, per-tenant+candidate record of the auto-optimize stages that have completed,
// on the shared RuntimeStatePort. It records STAGE COMPLETION + ORDER (both shadow AND canary), verified
// by the terminal serveAutoChampion write inside its tx as a DURABLE cross-process check — one of TWO
// conjuncted guards: serveAutoChampion also requires the calling process's engine.autoPromotable() markers
// (guard 1), so a SEPARATE process that never drove the in-memory engine is refused by guard 1 regardless,
// and the ledger (guard 3) is the durable backstop.
//
// HONEST SCOPE: `pass` here is the engine's ALREADY-DERIVED marker (the orchestrator records what
// engine.recordShadow/recordCanary returned); the ledger does NOT itself re-derive pass from raw numbers
// (it lacks the thresholds), and both the engine markers and this ledger trust the MEASUREMENT VALUES fed
// in by the injected real graders (traffic + cross-family judge). The guarantee is stage order/completion,
// NOT unforgeable measurements; an insider process fabricating measurement values is out of scope
// (bounded by the operator-run entrypoint + the opt-in/kill/change-class gates at the write). The ledger
// is NOT full engine-state rehydration — a fresh process still has no candidate and fails safe to human.
// Keyed per SERVING TENANT + candidateId, so a ledger entry for one merchant/candidate is invisible to
// another (blast-radius isolation, inv #9).

const LEDGER = "auto-stage"; // KV collection, per tenant, keyed by candidateId

export interface AutoStageMark {
  n: number;
  delta: number;
  elapsedMs?: number;
  at: string;
  /** ENGINE-derived (recorded from the engine's returned marker), never a fabricated caller boolean. */
  pass: boolean;
}
export interface AutoStageLedger {
  candidateId: string;
  shadow?: AutoStageMark;
  canary?: AutoStageMark;
}

export async function readAutoStage(store: RuntimeStatePort, tenantId: string, candidateId: string): Promise<AutoStageLedger | null> {
  return (await store.get<AutoStageLedger>({ tenantId }, LEDGER, candidateId)) ?? null;
}

/** Read the ledger WITHIN an existing tx (for the terminal write's in-tx verification). */
export async function readAutoStageTx(t: RuntimeStateTx, candidateId: string): Promise<AutoStageLedger | null> {
  return (await t.get<AutoStageLedger>(LEDGER, candidateId)) ?? null;
}

/** Both shadow AND canary recorded as PASSING — the cross-process "stages complete" signal. */
export function autoStageComplete(ledger: AutoStageLedger | null): boolean {
  return !!ledger && ledger.shadow?.pass === true && ledger.canary?.pass === true;
}

/** Record a completed stage (the engine's derived marker) durably + audited. Merges into the existing
 * per-candidate ledger so shadow then canary accumulate. */
export async function recordAutoStage(
  store: RuntimeStatePort,
  tenantId: string,
  candidateId: string,
  stage: "shadow" | "canary",
  mark: AutoStageMark,
  at = new Date().toISOString(),
): Promise<void> {
  await store.tx({ tenantId }, async (t) => {
    const cur = (await t.get<AutoStageLedger>(LEDGER, candidateId)) ?? { candidateId };
    await t.put(LEDGER, candidateId, { ...cur, [stage]: mark });
    await t.audit(
      {
        actor: "auto-loop",
        action: `auto_stage.${stage}`,
        input: { tenantId, candidateId, n: mark.n, delta: mark.delta, pass: mark.pass },
        decision: `recorded ${stage} stage (pass=${mark.pass})`,
        reversalPath: "n/a — a stage-completion marker",
      },
      at,
    );
  });
}
