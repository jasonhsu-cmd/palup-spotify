import { createHash } from "node:crypto";
import type { Arm, RuntimeStatePort } from "@palup/platform-ports";
import { DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { bucket } from "./canary.js";

// Wave 2 / W2-B — the business HOLDOUT: a durable, period-stable treated/control arm assignment on the
// /chat serving path, writing per-arm EXPOSURES to the W2-A outcome ledger
// (`accumulateArmTally`, `packages/state-postgres/src/outcome-ledger-store.ts`) so the revenue flywheel
// can measure the champion's INCREMENTAL value against an un-treated control — realizes
// `docs/adr/0007-attribution-and-metering.md` decision 1 and `docs/design/attribution-and-billing.md` §1
// ("Method: incrementality against a holdout/control"). SHIPS DARK: the per-tenant default is
// `{ enabled: false, fraction: 0 }`, under which `readHoldoutConfig` returns that default, the /chat
// server never calls `assignHoldoutArm`, and `accumulateArmTally` is never called — zero behavior
// change and zero ledger writes (pinned by `chat-wire-flag-off.test.ts`, which never enables a holdout
// for its probe tenant, and by this file's own tests).
//
// TEMPLATE: mirrors `canary.ts` deliberately — same per-tenant `RuntimeStatePort` collection pattern,
// same sticky `bucket()` hash, same "read once per turn" shape as `matchedKill`. The one structural
// difference `canary.ts` does NOT have: a canary's bucket is recomputed fresh every turn from the
// session id alone (no persistence), which is fine for a canary because nothing downstream depends on
// an identity's assignment being STABLE ACROSS SESSIONS. A holdout's arm must be — ADR-0007 requires the
// method to be "recorded per billing period" and the whole point of a control group is that the SAME
// shopper is measured consistently within a period — so this file additionally PERSISTS the first
// assignment per (tenant, identity, period) and every later turn in that period reads it back, rather
// than recomputing (recomputing would already be deterministic per identity+period, but persisting also
// survives a config `fraction` change or a future hash-function change without silently reassigning
// shoppers mid-period).
//
// ENABLING THE HOLDOUT (flipping a real tenant's config to `enabled: true`) IS AN OWNER/LEGAL STEP, NOT
// A BUILD AGENT'S. An un-treated control arm means some real shoppers deliberately get less-capable
// service than they otherwise would, purely for measurement — a business-model / experiment-design
// decision (`docs/adr/0007-attribution-and-metering.md`: "a small holdout is un-monetized by design"
// and "the honesty cost") that plausibly also needs shopper-facing consent/disclosure review, mirroring
// `docs/MEMORY-GO-LIVE-CHECKLIST.md`'s human-only go-live gate for `widget-memory`. Nothing in this file
// flips that switch; it only makes the OFF state (which is the only state ever exercised in CI/staging
// today) fully wired and tested.

const HOLDOUT = "holdout"; // KV collection (rollout config), keyed per SERVING tenant — mirrors canary.ts
const CONFIG_KEY = "config";
const ASSIGNMENT = "holdout_assignment"; // KV collection: one row per (tenant, identity, period)

/**
 * v1 "play" every /chat turn's exposure is tallied under. `Play` (platform-ports/outcome-ledger.ts) is
 * deliberately free-text and its real per-play vocabulary (cart_recovery/upsell/win-back/nurture/...) is
 * explicitly left to "whichever increment first assigns plays to real merchant flows" — not this one.
 * Until that exists, every turn this holdout covers is the single generic "agent" play.
 */
export const HOLDOUT_PLAY = "agent";

export interface HoldoutConfig {
  enabled: boolean;
  /** 0..1 — the probability a newly-seen identity lands in the CONTROL arm this period. The rest (1 -
   * fraction) is treated. Clamped to [0,1] defensively in `assignHoldoutArm` (never trusts a stored
   * value blindly, mirroring `champion.ts`'s fail-closed read). */
  fraction: number;
  /**
   * Documents which policy definition the control arm is meant to serve. INFORMATIONAL ONLY in this
   * increment: there is no general named-policy store to resolve an arbitrary id against (only the
   * `champion`/`canary` KV rows carry a full `Policy` object, keyed by tenant, not by an arbitrary named
   * id), so `resolveControlPolicy` below always returns `DEFAULT_POLICY` regardless of this field's
   * value today. Recorded so a later, owner-approved increment can wire it to a real lookup without a
   * config-shape migration. See `resolveControlPolicy`'s own comment for why `DEFAULT_POLICY` is v1's
   * control and why that choice is explicitly an owner/experiment-design decision, not a build-agent one.
   */
  controlPolicyId?: string;
}

const DEFAULT_HOLDOUT_CONFIG: Readonly<HoldoutConfig> = { enabled: false, fraction: 0 };

/** This tenant's holdout config, or the honest DEFAULT (`enabled:false, fraction:0`) when nothing has
 * been written — never null, so every call site can read `.enabled` without an extra null-check (unlike
 * `readCanaryConfig`, which has a genuine "no canary at all" state; a holdout's absence IS its off state,
 * they are the same thing, so collapsing them is not a change in meaning). */
export async function readHoldoutConfig(store: RuntimeStatePort, tenantId: string): Promise<HoldoutConfig> {
  const cfg = await store.get<HoldoutConfig>({ tenantId }, HOLDOUT, CONFIG_KEY);
  return cfg ?? DEFAULT_HOLDOUT_CONFIG;
}

/**
 * The policy the CONTROL arm is served. `docs/adr/0007-attribution-and-metering.md` treats the exact
 * definition of "un-treated" as an experiment-design decision for whoever owns the holdout, not
 * something to guess here — so this is a NAMED, DOCUMENTED seam (a plain function, not an inlined
 * constant) precisely so that decision can change later without touching the serving call site. v1's
 * answer: widget-brain's own `DEFAULT_POLICY` — the un-evolved baseline nothing has ever been promoted
 * over — because it is the one policy that is, by construction, not a product of the self-improvement
 * pipeline this holdout exists to measure against.
 */
export function resolveControlPolicy(_config: HoldoutConfig): Policy {
  return DEFAULT_POLICY;
}

/** `YYYY-MM` in UTC. The ArmTally bucketing granularity for v1 — matches the outcome-ledger store's own
 * `"2026-08"`-shaped period strings (`packages/state-postgres/test/outcome-ledger-store.test.ts`). Named
 * and exported (rather than inlined at each call site) so a later increment that wants a different
 * granularity (a week, a merchant's own billing cycle) has exactly one place to change it. */
export function holdoutPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The stable identity a holdout assignment is keyed on for one turn: the server-VERIFIED shopperId when
 * this turn resolved one (a signed-in, re-identified customer — the strongest stable key we have), else
 * a HASHED sessionId. The session id is hashed — never stored raw — mirroring `logTraffic`'s own
 * sessionId hashing in `canary.ts`: a client-supplied session id can carry incidental structure, and this
 * value is about to be persisted (unlike a canary bucket, which is recomputed and never stored), so it
 * gets the same at-rest minimization traffic already gets.
 */
export function holdoutIdentity(input: { verifiedShopperId?: string; sessionId: string }): string {
  if (input.verifiedShopperId) return `shopper:${input.verifiedShopperId}`;
  const hashed = createHash("sha256").update(input.sessionId).digest("hex").slice(0, 16);
  return `sess:${hashed}`;
}

function assignmentKey(identity: string, period: string): string {
  return `${identity}::${period}`;
}

interface HoldoutAssignment {
  arm: Arm;
  at: string;
}

/**
 * Deterministic + PERSISTED per (tenant, identity, period). The FIRST turn a given identity is seen in a
 * period computes the split with the SAME sticky hash `canary.ts`'s `bucket()` uses (seeded with the
 * period too, so a fresh coin flip happens each new period rather than the same shoppers being stuck in
 * one arm forever) and durably records it; every later turn for that identity in that period reads the
 * persisted row back UNCHANGED — so neither a control-plane `fraction` edit mid-period nor any other
 * runtime change can flip an already-assigned shopper's arm before the period rolls over. Read + write +
 * audit commit atomically (NN #5): an assignment and its audit trail can never drift apart on a
 * mid-write failure.
 */
export async function assignHoldoutArm(
  store: RuntimeStatePort,
  tenantId: string,
  config: HoldoutConfig,
  identity: string,
  period: string,
): Promise<Arm> {
  const key = assignmentKey(identity, period);
  const existing = await store.get<HoldoutAssignment>({ tenantId }, ASSIGNMENT, key);
  if (existing) return existing.arm;

  // Fail-closed clamp: an operator-authored config is still untrusted input to THIS function — a stored
  // fraction outside [0,1] must never be read as "always control" / "always treated" by surprise.
  const fraction = Math.max(0, Math.min(1, config.fraction));
  const controlCutoff = Math.round(fraction * 100);
  const arm: Arm = bucket(`${identity}::${period}`) < controlCutoff ? "control" : "treated";

  return store.tx({ tenantId }, async (t) => {
    // A concurrent turn for the SAME identity/period may have written between the read above and this
    // tx acquiring its lock (two browser tabs, a retried request). Re-check inside the tx and defer to
    // whichever assignment landed first, so two concurrent turns for one shopper can never disagree.
    const raced = await t.get<HoldoutAssignment>(ASSIGNMENT, key);
    if (raced) return raced.arm;
    const at = new Date().toISOString();
    await t.put(ASSIGNMENT, key, { arm, at });
    await t.audit(
      {
        actor: "holdout",
        action: "holdout_arm.assign",
        input: { period, fraction: config.fraction },
        decision: arm,
        reversalPath:
          "an operator can delete this tenant's `holdout_assignment` row for this (identity, period) to " +
          "force a fresh assignment on the identity's next turn this period; disabling the holdout " +
          "(`enabled:false`) stops all NEW assignments immediately. This is a measurement artifact, not " +
          "an action taken on the shopper's behalf, so there is nothing shopper-facing to reverse.",
      },
      at,
    );
    return arm;
  });
}
