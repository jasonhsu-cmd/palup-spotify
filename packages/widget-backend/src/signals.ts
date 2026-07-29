import type { Signals } from "@palup/widget-brain";

// T7 — derive the trusted `signals` the brain runs on from UNTRUSTED client input. The default is that
// a client-supplied field is IGNORED; only explicitly non-trust-bearing context (mood/cart, and only
// when a valid enum) is passed through. Everything that grants treatment, governs behavior, or is
// legally load-bearing is supplied by the caller from server/merchant/operator/session sources. See the
// TRUST BOUNDARY note in server.ts for the per-field rationale.

const MOODS = new Set<string>(["frustrated", "upset", "anxious", "confused", "skeptical", "neutral", "satisfied"]);
const CARTS = new Set<string>(["empty", "has_items", "high_value"]);

export interface ServingSignalContext {
  /** Operator kill state for this scope (from the registry, server-side). */
  kill: boolean;
  /** Merchant/geo jurisdiction (server config). */
  region: NonNullable<Signals["region"]>;
  /** Merchant "discuss competitors" mode (merchant policy). */
  groundingMode: NonNullable<Signals["groundingMode"]>;
}

export function deriveServingSignals(raw: Signals | undefined, ctx: ServingSignalContext): Signals {
  const r = (raw ?? {}) as Signals;
  return {
    // Accepted shopper/UI context — only when a valid enum value.
    mood: typeof r.mood === "string" && MOODS.has(r.mood) ? r.mood : undefined,
    cart: typeof r.cart === "string" && CARTS.has(r.cart) ? r.cart : undefined,
    // Server-derived trust-bearing signals — never taken from the client.
    relationship: "anonymous", // no identified customer yet (M2); never client-claimed VIP/subscriber
    consent: { email: "unknown", sms: "unknown" }, // conservative; real consent store is a later subsystem
    groundingMode: ctx.groundingMode,
    region: ctx.region,
    // proactivityLevel omitted ⇒ brain falls back to the merchant policy default (not the shopper)
    // openIssues / safetyLatched omitted ⇒ sourced only from persisted session state
    kill: ctx.kill ? true : undefined,
  };
}
