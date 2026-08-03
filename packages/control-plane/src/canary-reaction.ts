import type { RuntimeStatePort } from "@palup/platform-ports";
import { freezeAutoPromote, AUTO_PROMOTE_WINDOW_MS } from "@palup/state-postgres";
import { stopCanary } from "./canary-controller.js";

/**
 * React to a canary shadow-eval verdict. On "rollback": stop the canary AND FREEZE this merchant's
 * auto-promote fast-lane (ADR-0014 #9) — a canary regression must not be immediately re-promoted. Split
 * out from the credential-gated /api/canary/shadow endpoint (the live shadowEvaluate call stays behind
 * the gate) so this reaction — the wiring seam — is offline-testable. Keyed on the SAME tenant the
 * auto-loop's rate-limit check reads, so the freeze lands where it's enforced.
 */
export async function applyCanaryVerdict(
  store: RuntimeStatePort,
  tenantId: string,
  verdict: string,
  at = new Date().toISOString(),
): Promise<{ rolledBack: boolean }> {
  if (verdict !== "rollback") return { rolledBack: false };
  await stopCanary(store, tenantId);
  const until = new Date(Date.parse(at) + AUTO_PROMOTE_WINDOW_MS).toISOString();
  await freezeAutoPromote(store, tenantId, until, "canary-shadow-rollback", at);
  return { rolledBack: true };
}
