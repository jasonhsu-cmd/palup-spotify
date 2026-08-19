import type { RuntimeStatePort, RuntimeStateCtx } from "@palup/platform-ports";
import { verifyStepUp, STEPUP_MAX_AGE_MS, STEPUP_CLOCK_SKEW_MS } from "@palup/platform-ports";
import { RUNTIME_AGENT_TYPE } from "./runtime-kill-registry.js";

// ADR-0014 cond #1/#2 + prereq #6 — the two switches that gate the auto-optimize fast-lane, BOTH default
// OFF so a fresh deployment is dormant:
//   • per-merchant  `autoPromoteOptIn`            (tenant KV)      — the merchant opts their store in;
//   • platform      `autopromote_globally_enabled` (system KV)     — the PalUp force-human master switch.
// Auto-promote is permitted only when BOTH are on; the platform override WINS (force-human whenever it
// is off, regardless of the tenant flag). Setting either is a high-sensitivity action: it requires a
// real STEP-UP assertion (step-up.ts) bound to the exact action+tenant, is written + AUDITED atomically,
// and can NEVER be performed by an agent (inv #7: an agent can't flip its own opt-in). The opt-in value
// is server-sourced — read only from this store, never from a client/agent-supplied field.

const COLLECTION = "autopromote";
const OPTIN_KEY = "optin";
const PLATFORM_KEY = "platform";
/** Reserved platform partition for the global override (not a real merchant). */
export const PLATFORM_TENANT = "__system__";
const NONCE_COLLECTION = "autopromote-stepup-nonce";
/** Step-up actions the SET paths bind to (an assertion for one can't set the other). */
export const STEPUP_ACTION = "autopromote.optin.set";
export const PLATFORM_STEPUP_ACTION = "autopromote.platform.set";

export interface AutoPromoteGateInput {
  tenantOptIn: boolean;
  globallyEnabled: boolean;
}
export interface AutoPromoteGateResult {
  enabled: boolean;
  reason?: string;
}

/** Pure predicate: BOTH switches must be on; the platform override wins. */
export function autoPromoteGate({ tenantOptIn, globallyEnabled }: AutoPromoteGateInput): AutoPromoteGateResult {
  if (!globallyEnabled) return { enabled: false, reason: "platform autopromote force-human (globally disabled)" };
  if (!tenantOptIn) return { enabled: false, reason: "tenant has not opted in" };
  return { enabled: true };
}

export async function readTenantOptIn(store: RuntimeStatePort, tenantId: string): Promise<boolean> {
  return (await store.get<{ enabled: boolean }>({ tenantId }, COLLECTION, OPTIN_KEY))?.enabled === true;
}
export async function readPlatformEnabled(store: RuntimeStatePort): Promise<boolean> {
  return (await store.get<{ enabled: boolean }>({ tenantId: PLATFORM_TENANT }, COLLECTION, PLATFORM_KEY))?.enabled === true;
}

/** The pipeline's single read: is auto-promote enabled for this tenant right now? Default OFF — an unset
 * tenant flag AND an unset platform override both read false, so the fast-lane is dormant. */
export async function readAutoPromoteEnabled(store: RuntimeStatePort, tenantId: string): Promise<AutoPromoteGateResult> {
  const [tenantOptIn, globallyEnabled] = await Promise.all([readTenantOptIn(store, tenantId), readPlatformEnabled(store)]);
  return autoPromoteGate({ tenantOptIn, globallyEnabled });
}

export interface SetOptInOpts {
  /** The recorded HUMAN operator (audit actor). NEVER an agent — asserted below. */
  actor: string;
  /** The step-up assertion (from a re-auth). */
  stepUpToken?: string;
  /** The elevated step-up secret, injected from the secrets port/env at the edge (never hard-coded). */
  stepUpSecret?: string;
  now?: number;
}

// An agent (the auto-loop, or the run-time agent type) can NEVER be the actor of an opt-in change —
// defense in depth on top of the step-up secret, so even a mis-wired caller can't record an agent as
// the setter (inv #7). Requires a non-empty, non-agent actor.
function assertHumanActor(actor: string): void {
  if (!actor || actor === "auto-loop" || actor === RUNTIME_AGENT_TYPE) {
    throw new Error(`autopromote SET requires a human operator actor — refused for "${actor || "none"}" (an agent can never flip its own opt-in)`);
  }
}

async function setFlag(
  store: RuntimeStatePort,
  ctx: RuntimeStateCtx,
  key: string,
  action: string,
  boundTenant: string,
  enabled: boolean,
  reversalPath: string,
  opts: SetOptInOpts,
): Promise<void> {
  assertHumanActor(opts.actor);
  const now = opts.now ?? Date.now();
  const v = verifyStepUp(opts.stepUpSecret, opts.stepUpToken, { action, tenantId: boundTenant, now });
  if (!v.ok) throw new Error(`autopromote SET blocked — step-up failed: ${v.reason}`);
  const at = new Date(now).toISOString();
  await store.tx(ctx, async (t) => {
    // Single-use: refuse a replayed step-up (same nonce) inside the freshness window.
    if (await t.get(NONCE_COLLECTION, v.nonce)) throw new Error("step-up assertion already used (replay blocked)");
    // Keep the nonce for the FULL window the assertion could still verify (maxAge + skew from usedAt),
    // so the replay backstop never expires before the assertion does (security review, LOW).
    await t.put(NONCE_COLLECTION, v.nonce, { usedAt: at }, { ttlSeconds: Math.ceil((STEPUP_MAX_AGE_MS + STEPUP_CLOCK_SKEW_MS) / 1000) });
    await t.put(COLLECTION, key, { enabled });
    await t.audit(
      {
        actor: opts.actor,
        action: enabled ? `${action}.enable` : `${action}.disable`,
        input: { tenantId: boundTenant, enabled },
        decision: `autopromote flag set to ${enabled}`,
        reversalPath,
      },
      at,
    );
  });
}

/** SET a merchant's opt-in flag (step-up + audited; human-only). */
export async function setAutoPromoteOptIn(store: RuntimeStatePort, tenantId: string, enabled: boolean, opts: SetOptInOpts): Promise<void> {
  if (!tenantId || tenantId === PLATFORM_TENANT) throw new Error("setAutoPromoteOptIn requires a real merchant tenantId");
  await setFlag(store, { tenantId }, OPTIN_KEY, STEPUP_ACTION, tenantId, enabled, `setAutoPromoteOptIn(${JSON.stringify(tenantId)}, false, ...) with a fresh step-up`, opts);
}

/** SET the platform force-human override (step-up + audited; human-only). */
export async function setPlatformAutoPromote(store: RuntimeStatePort, enabled: boolean, opts: SetOptInOpts): Promise<void> {
  // Reversal names THIS function (setAutoPromoteOptIn throws on PLATFORM_TENANT, so it could never
  // execute the recorded reversal) — security review LOW, NN#5 accurate-reversal-path.
  await setFlag(store, { tenantId: PLATFORM_TENANT }, PLATFORM_KEY, PLATFORM_STEPUP_ACTION, PLATFORM_TENANT, enabled, "setPlatformAutoPromote(false, ...) with a fresh step-up", opts);
}
