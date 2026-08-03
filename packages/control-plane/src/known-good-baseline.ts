import type { RuntimeStatePort } from "@palup/platform-ports";
import type { Policy } from "@palup/widget-brain";

// ADR-0014 prereq #10 — a DURABLE, per-tenant "known-good" champion baseline that survives BEYOND the
// evolution engine's depth-1 prevChampion. Lagging return/complaint harm can surface days-to-weeks after
// a promotion, by which time several champions may have shipped; the engine can only revert one step, so
// it cannot restore the last CONFIRMED-good champion. This baseline records that champion durably (on the
// shared RuntimeStatePort, keyed per serving tenant) so the delayed rollback (champion-promoter.ts) has a
// safe target no matter how many promotions happened since. Recorded when a champion survives its
// observation window (the confirmation that makes it "known-good").
//
// Kept in its OWN collection (never the serving CHAMPION/active key) so a baseline write can never be
// mistaken for the active serving champion.
const BASELINE = "champion-baseline";
const KNOWN_GOOD_KEY = "known-good";

export interface KnownGoodBaseline {
  policy: Policy;
  /** When this champion was confirmed good (survived its observation window). */
  confirmedAt: string;
  note?: string;
}

/** The durable known-good baseline for this tenant, or null if none has been confirmed yet. */
export async function readKnownGood(store: RuntimeStatePort, tenantId: string): Promise<KnownGoodBaseline | null> {
  return (await store.get<KnownGoodBaseline>({ tenantId }, BASELINE, KNOWN_GOOD_KEY)) ?? null;
}

/** Record `policy` as the tenant's durable known-good baseline (write + audit, atomic). Call when a
 * champion has survived its observation window — it becomes the safe revert target for a later delayed
 * rollback, independent of how many champions ship afterward. */
export async function recordKnownGood(store: RuntimeStatePort, tenantId: string, policy: Policy, at = new Date().toISOString(), note?: string): Promise<void> {
  const baseline: KnownGoodBaseline = { policy, confirmedAt: at, note };
  await store.tx({ tenantId }, async (t) => {
    await t.put(BASELINE, KNOWN_GOOD_KEY, baseline);
    await t.audit(
      {
        actor: "monitor",
        action: "champion.known_good",
        input: { tenantId, policyId: policy.id },
        decision: `recorded known-good baseline ${policy.id}`,
        reversalPath: "n/a — a confirmed-good marker",
      },
      at,
    );
  });
}
