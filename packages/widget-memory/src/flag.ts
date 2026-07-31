// The DOUBLE gate that keeps the whole cross-visit memory subsystem inert (ADR-0015: "Proposed — NOT
// enacted. It enables nothing on its own"). CLAUDE.md §3 NN#1: nothing that changes an agent's
// behavior/business model auto-applies — that includes turning on a durable, consent-gated store of
// customer data. `MEMORY_ADR_ACCEPTED` is a hardcoded, build-time const: flipping it requires a
// reviewed code change (named owner + security-reviewer + legal sign-off per the ADR), NOT an operator
// env var. `MEMORY_ENABLED` alone (an operator/deploy-time flag) can therefore NEVER turn memory on by
// itself — both gates must be true. This makes "ship the code, still inert" provable rather than
// aspirational: no caller can flip this package on by config alone.

/** Flips to true only via a reviewed code change once ADR-0015 is Accepted (owner + security-reviewer +
 * legal sign-off recorded). Stays false for this PR by construction. */
export const MEMORY_ADR_ACCEPTED: boolean = false;

/** True only when BOTH the operator flag is the exact string "true" AND the ADR has been accepted in
 * code. Any other value (unset, "1", "yes", "" , wrong case, …) is treated as off — fail closed. */
export function isMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMORY_ENABLED === "true" && MEMORY_ADR_ACCEPTED;
}
