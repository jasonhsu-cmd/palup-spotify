import type { Signals } from "./types.js";

/** Shopper jurisdiction, reusing the exact union `Signals.region` already carries. */
export type ConsentRegion = Signals["region"];

/** A recorded consent tri-state. `undefined` means "no record / never asked" and is treated exactly
 * like `"unknown"` everywhere — never as a grant. */
export type ConsentTriState = "in" | "out" | "unknown" | undefined;

/** Which consent tier a fact falls under. Anything that is not special-category is ordinary. */
export type ConsentTier = "ordinary" | "special";

/**
 * THE single consent rule for this system — the one place the region regime is expressed. Both the WRITE
 * gate (`decideMemoryWrite`, @palup/widget-memory) and the READ gate (`consentedAtReadTime`, brain.ts)
 * call this, so the two cannot drift apart.
 *
 * It lives HERE, in the lower package, purely to satisfy the no-dep-cycle contract this package
 * documents elsewhere (types.ts): @palup/widget-memory depends on @palup/widget-brain and never the
 * reverse, so a rule both need has to sit on this side of the edge. It is a pure function — no storage,
 * no ports, no model.
 *
 * THE RULE
 * - **Ordinary** (Art. 6, cross-visit preferences): `region === "us"` is an OPT-OUT regime — permitted
 *   unless the shopper explicitly said `"out"`. EVERY other region — "eu", "uk", "other", or an
 *   absent/unknown region — is fail-closed and needs an explicit `"in"`. An unknown region deliberately
 *   gets the STRICTER treatment (ADR-0015 Inv 3).
 * - **Special-category** (Art. 9, health): ALWAYS requires an explicit `"in"`, in EVERY region including
 *   the US, completely independent of the ordinary tier. This is the ADR-0015 amendment ratified by
 *   legal + the named owner (2026-08-04) given emerging US state health-privacy law. It is not a code
 *   preference and B7 did not reopen it.
 *
 * B7 (owner decision, 2026-08-05) is why read and write share this: previously the US wrote ordinary
 * facts on `"unknown"` (opt-out regime) but only SURFACED them on a literal `"in"`, so the system
 * accumulated ordinary facts it could never use. "Unknown and yes work the same in non-GDPR region" —
 * so the read bar moved down to meet the write bar, in non-GDPR regions, for the ordinary tier only.
 *
 * WHAT THIS DOES NOT DECIDE: whether memory is switched on at all (`isMemoryEnabled`, the double gate),
 * whether an operator has halted the tenant (the kill switch), or retention. Those sit outside and ahead
 * of it — a `true` here is a consent verdict, never a licence on its own.
 */
export function consentPermits(region: ConsentRegion, tier: ConsentTier, value: ConsentTriState): boolean {
  if (tier === "special") return value === "in";
  return region === "us" ? value !== "out" : value === "in";
}

/** `consentPermits` addressed by a fact's own `class` string, which is an untrusted value on the recall
 * path (a third-party MemoryRecallPort may return anything). Anything that is not exactly `"special"`
 * is treated as ordinary — the same collapse `consentedAtReadTime` and the memory service already use. */
export function consentPermitsFactClass(
  region: ConsentRegion,
  factClass: string | undefined,
  consent: { memoryOrdinary?: ConsentTriState; memorySpecial?: ConsentTriState } | undefined,
): boolean {
  return factClass === "special"
    ? consentPermits(region, "special", consent?.memorySpecial)
    : consentPermits(region, "ordinary", consent?.memoryOrdinary);
}
