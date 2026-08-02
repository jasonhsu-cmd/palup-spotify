import type { RuntimeStatePort } from "@palup/platform-ports";
import type { Policy } from "@palup/widget-brain";

// The ACTIVE serving champion policy, on the SHARED RuntimeStatePort so a human-approved promotion the
// control plane persists (control-plane/champion-promoter.ts) takes effect on EVERY serving instance —
// closing the promote→serving gap (engine.promote used to update only in-memory state while serving kept
// serving DEFAULT_POLICY). Keyed PER SERVING TENANT, exactly like the canary config (canary.ts), so one
// merchant's promoted champion never serves another merchant's shoppers (ADR-0014 blast-radius).
// Keep the collection/key names in sync with control-plane/champion-promoter.ts.
const CHAMPION = "champion"; // KV collection (active serving champion), keyed per SERVING tenant
const ACTIVE_KEY = "active";

/** What the control plane persists on a gated promotion (mirror of champion-promoter.ts's ServingChampion). */
interface ServingChampion {
  policy: Policy;
  /** Prior champion policy id this replaced (audit trail); undefined for the first promotion. */
  promotedFrom?: string;
  promotedAt?: string;
}

const MAX_STYLE_DIRECTIVE = 2000; // a voice line, not an essay — bounds a poisoned/oversized directive

/**
 * Runtime narrow to a bare Policy at the store→serving trust boundary. `store.get` is a compile-time
 * cast over untyped JSON, so a malformed or oversized row would otherwise flow into the TRUSTED region of
 * the system prompt (styleDirective is not fenced like merchant data). Enforce the containment invariant
 * HERE — a value that isn't a well-formed, bounded Policy is rejected so serving falls back to
 * DEFAULT_POLICY (fail-closed), not served.
 */
function isServingPolicy(p: unknown): p is Policy {
  if (!p || typeof p !== "object") return false;
  const q = p as Record<string, unknown>;
  return (
    typeof q.id === "string" && q.id.length > 0 && q.id.length <= 128 &&
    typeof q.label === "string" && q.label.length <= 200 &&
    typeof q.styleDirective === "string" && q.styleDirective.length <= MAX_STYLE_DIRECTIVE &&
    (q.proactivityDefault === "cautious" || q.proactivityDefault === "balanced" || q.proactivityDefault === "confident")
  );
}

/**
 * The tenant's active promoted champion, or null if none has been promoted yet (⇒ serving falls back to
 * DEFAULT_POLICY). A pure READ — serving never writes the champion; only a human-gated promotion does
 * (control-plane/champion-promoter.ts, after engine.promote, which throws unless the candidate is
 * human-approved and the kill switch is off). What comes back is a Policy — styleDirective +
 * proactivityDefault only — so a promoted champion can only change voice/proactivity, never a
 * deterministic guardrail (those live in code; widget-brain types.ts). That is what makes serving a
 * self-improved champion safe.
 */
export async function readActiveChampion(store: RuntimeStatePort, tenantId: string): Promise<Policy | null> {
  const cfg = await store.get<ServingChampion>({ tenantId }, CHAMPION, ACTIVE_KEY);
  // Fail CLOSED: null OR a malformed/oversized champion ⇒ null, so the caller falls back to DEFAULT_POLICY.
  return cfg && isServingPolicy(cfg.policy) ? cfg.policy : null;
}
