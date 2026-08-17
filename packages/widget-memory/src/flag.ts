// The build-time half of memory's double gate. CLAUDE.md §3 NN#1: nothing that changes an agent's
// behavior/business model auto-applies — turning on a durable, consent-gated store of customer data is a
// reviewed code change (named owner + security-reviewer sign-off per the ADR), NOT an operator env var.
//
// FLIPPED TRUE 2026-08-17 — ADR-0015 Accepted for INTERNAL STAGING (internal users only), legal DEFERRED
// as a named-owner-accepted risk (owner: jason.hsu@framy.co); security-reviewer PASS-WITH-CONDITIONS
// recorded at ADR-0015 / MEMORY-GO-LIVE-CHECKLIST A4. This was merged by the named human owner (the
// merge-gate refuses this flip by construction, so it is a deliberate manual merge). Consequence, called
// out at review time: the second gate is now SPENT — `MEMORY_ENABLED` alone is load-bearing on every
// build. Memory is still OFF wherever `MEMORY_ENABLED` is unset (production is deployed nowhere and its
// `MEMORY_ENABLED` is unset), and it is ON only on the staging service where `MEMORY_ENABLED="true"`.
// This is NOT a production/external go-live: the legal items (ADR-0015 §A A1/A2/A3/A5/A6, ADR-0019 Q19)
// stay OPEN and must be closed before any external-shopper enablement.

/** Accepted for internal staging (2026-08-17). Kept as a named const — not folded into `isMemoryEnabled`
 * — so the flip stays a single, reviewed, greppable code change and the merge-gate's human-only guard
 * (merge-gate.sh) still fires on any PR that sets it. */
export const MEMORY_ADR_ACCEPTED: boolean = true;

/** True only when BOTH the operator flag is the exact string "true" AND the ADR has been accepted in
 * code. Any other value (unset, "1", "yes", "" , wrong case, …) is treated as off — fail closed. */
export function isMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMORY_ENABLED === "true" && MEMORY_ADR_ACCEPTED;
}
