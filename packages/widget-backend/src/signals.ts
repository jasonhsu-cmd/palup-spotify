import type { Signals } from "@palup/widget-brain";

// T7 — derive the trusted `signals` the brain runs on from UNTRUSTED client input. The default is that
// a client-supplied field is IGNORED; only explicitly non-trust-bearing context (mood/cart, and only
// when a valid enum) is passed through. Everything that grants treatment, governs behavior, or is
// legally load-bearing is supplied by the caller from server/merchant/operator/session sources. See the
// TRUST BOUNDARY note in server.ts for the per-field rationale.

const MOODS = new Set<string>(["frustrated", "upset", "anxious", "confused", "skeptical", "neutral", "satisfied"]);
const CARTS = new Set<string>(["empty", "has_items", "high_value"]);

export interface ServingSignalContext {
  /** The verified tenant/merchant this request serves (from the widget token, server-side). */
  tenantId: string;
  /** Operator kill state for this scope (from the registry, server-side). */
  kill: boolean;
  /** Merchant/geo jurisdiction (server config). */
  region: NonNullable<Signals["region"]>;
  /** Merchant "discuss competitors" mode (merchant policy). */
  groundingMode: NonNullable<Signals["groundingMode"]>;
  /**
   * Shopper's LOCAL hour of day (0–23), computed server-side from the request locale/timezone.
   * Optional: when omitted, quiet-hours OUTBOUND suppression is simply not applied. NEVER taken from
   * the client (like tenantId/kill/region, this is the trusted, server-derived origin of the signal).
   */
  localHour?: number;
}

export function deriveServingSignals(raw: Signals | undefined, ctx: ServingSignalContext): Signals {
  const r = (raw ?? {}) as Signals;
  return {
    // Accepted shopper/UI context — only when a valid enum value.
    mood: typeof r.mood === "string" && MOODS.has(r.mood) ? r.mood : undefined,
    cart: typeof r.cart === "string" && CARTS.has(r.cart) ? r.cart : undefined,
    // Server-derived trust-bearing signals — never taken from the client.
    tenantId: ctx.tenantId, // the verified merchant; drives per-merchant grounding — never client-set
    relationship: "anonymous", // no identified customer yet (M2); never client-claimed VIP/subscriber
    consent: { email: "unknown", sms: "unknown" }, // conservative; real consent store is a later subsystem
    groundingMode: ctx.groundingMode,
    region: ctx.region,
    // proactivityLevel omitted ⇒ the session applies its own server-side default ("balanced"), never
    // the shopper. (A canary policy's proactivityDefault is not threaded onto /chat today — tracked;
    // server-controlled either way, no client influence.)
    // openIssues / safetyLatched omitted ⇒ sourced only from persisted session state
    kill: ctx.kill ? true : undefined,
    // Quiet-hours clock is SERVER-derived (ctx), never the client's r.localHour. Only a valid 0–23
    // integer is honored; anything else ⇒ omitted ⇒ quiet-hours suppression simply does not apply.
    localHour:
      typeof ctx.localHour === "number" && Number.isInteger(ctx.localHour) && ctx.localHour >= 0 && ctx.localHour <= 23
        ? ctx.localHour
        : undefined,
  };
}
