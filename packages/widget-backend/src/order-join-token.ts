import { randomBytes } from "node:crypto";
import type { Arm, Play, RuntimeStatePort } from "@palup/platform-ports";
import { HOLDOUT_PLAY, readHoldoutAssignment, readHoldoutConfig } from "./holdout.js";

// Wave 2 / W2-C (item 1) — the OPAQUE JOIN TOKEN that turns a holdout EXPOSURE (W2-B,
// `assignHoldoutArm`) into something an order webhook (W2-C item 2, `order-attribution-queue.ts`)
// can look up. Realizes the "opaque join token" half of the design this ticket describes: a
// per-(tenant, identity, period) token, minted at checkout handoff, mapping durably back to the
// arm/play/period it was minted for — and NOTHING ELSE.
//
// WHY THIS IS OUR OWN KEY, NEVER CUSTOMER DATA. The token is `randomBytes(24)` — 192 bits of entropy
// from this process's own CSPRNG, with no derivation from a shopper id, session id, email, or any
// other input. It carries no information on its own (unlike a hash, which could in principle be
// dictionary-attacked back to its input): possessing the token proves nothing except "this backend
// minted it", so it is safe to hand to the widget, attach to a Shopify cart as a `note_attribute`,
// and see echoed back on the resulting order — none of that crosses a PII boundary, because there is
// no PII IN the token to cross. This mirrors the guest anonId's own "128 bits of randomBytes with
// nothing to reconstruct it from" property (`shopify-webhooks.ts`'s CUSTOMER_REDACT_RESIDUAL note).
//
// WHY READ-ONLY ASSIGNMENT LOOKUP, NEVER ASSIGN-ON-MINT. `readHoldoutAssignment` (holdout.ts) is a
// pure read — if the identity has no assignment yet (holdout off, or this identity never reached a
// /chat turn this period), NOTHING is minted. There is no arm to attribute a token to, and minting one
// anyway would either (a) silently create a NEW holdout assignment for an identity /chat never saw —
// which is `assignHoldoutArm`'s job, not this file's, and would corrupt the holdout's own "assigned
// once per period, on FIRST /chat turn" invariant — or (b) mint a token that resolves to nothing,
// which is worse than not minting: a later order webhook would find a token but no arm behind it,
// indistinguishable from an expired/corrupted one. "Mint nothing" is the only honest answer.
//
// NO WIDGET WIRING HERE (deliberately out of scope for this increment — see the work-item's own
// scope note). This file exports the pure mint/resolve/revoke primitives; a later increment that
// owns the checkout-handoff HTTP surface calls `mintOrderJoinToken` and hands the token to the widget,
// which attaches it as a Shopify cart `note_attribute` (a widget change, tracked separately).

/** KV collection: one row per minted token, `token → JoinTokenAssignment`. Opaque token as the KEY
 *  (never as a value alongside a shopper id — there is no shopper id anywhere in this collection). */
export const JOIN_TOKEN_COLLECTION = "holdout_jointoken";

/**
 * How long a minted token is resolvable. 7 days — generous slack over the ordinary checkout→webhook
 * latency (seconds to minutes) to absorb a delayed/retried Shopify delivery or a shopper who completes
 * checkout on an abandoned-cart recovery email days later, while still being a bounded, self-expiring
 * grant rather than a forever-lived credential. This is an ENGINEERING default, not a verified Shopify
 * SLA or a business policy — flagged for a human to revisit if real delivery latency needs more slack.
 */
export const JOIN_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The durable value behind a minted token — the arm/play/period it resolves to, plus the tenant it
 *  belongs to (so a worker that only has the token can still scope its lookup correctly). NO shopper
 *  identity, session id, or any other PII: this is the entire justification for why the token itself
 *  needs no redaction/erasure wiring — there is nothing personal in what it maps to. */
export interface JoinTokenAssignment {
  tenantId: string;
  arm: Arm;
  play: Play;
  period: string;
}

/** 192 bits from this process's CSPRNG, base64url-encoded (URL/attribute-value safe, no padding). Not
 *  derived from any input — see the file header for why that is the load-bearing property. */
function mintOpaqueToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Mint a fresh, opaque join token for `(tenantId, identity, period)` — or mint NOTHING (`null`) when
 * there is no arm to attribute one to: the holdout is off for this tenant, or this identity has no
 * recorded assignment for this period. Never guesses an arm.
 *
 * `identity`/`period` are the SAME values `holdoutIdentity()`/`holdoutPeriod()` (holdout.ts) compute
 * for the /chat serving path — a caller mints a token for the identity/period the shopper was already
 * bucketed under, never a fresh identity of its own invention.
 */
export async function mintOrderJoinToken(
  store: RuntimeStatePort,
  tenantId: string,
  identity: string,
  period: string,
  opts: { now?: () => number } = {},
): Promise<string | null> {
  const config = await readHoldoutConfig(store, tenantId);
  if (!config.enabled) return null;

  const arm = await readHoldoutAssignment(store, tenantId, identity, period);
  if (!arm) return null;

  const token = mintOpaqueToken();
  const record: JoinTokenAssignment = { tenantId, arm, play: HOLDOUT_PLAY, period };
  const at = new Date(opts.now?.() ?? Date.now()).toISOString();

  // Write + audit atomically (NN #5) — a mid-write failure can never leave a minted token unaudited.
  await store.tx({ tenantId }, async (t) => {
    await t.put(JOIN_TOKEN_COLLECTION, token, record, { ttlSeconds: JOIN_TOKEN_TTL_SECONDS });
    await t.audit(
      {
        actor: "order-join-token",
        action: "order_jointoken.mint",
        // The token itself is NEVER audited (it is a bearer credential for a measurement-only lookup;
        // logging it would let anyone who can read the audit chain resolve arm assignments they should
        // not need to). `period`/`arm` are the same non-PII fields the holdout's own assignment audit
        // (holdout.ts `holdout_arm.assign`) already records.
        input: { period, arm },
        decision: { minted: true, ttlSeconds: JOIN_TOKEN_TTL_SECONDS },
        reversalPath:
          `call revokeOrderJoinToken(store, "${tenantId}", <token>, <reason>) before it resolves, or let its ` +
          `${JOIN_TOKEN_TTL_SECONDS}s TTL lapse — either stops it resolving to an arm on a later order webhook. ` +
          "The token carries no PII and authorizes nothing destructive, so there is nothing shopper-facing to undo.",
      },
      at,
    );
  });

  return token;
}

/** Read-only resolution: `token → {arm, play, period}` for this tenant, or `null` if the token is
 *  absent, expired, or was minted for a DIFFERENT tenant (tenant isolation — a token minted for one
 *  tenant is looked up scoped to that same tenant; a caller that got the tenant wrong finds nothing,
 *  never another tenant's row). This is the ONLY thing the order-attribution worker needs. */
export async function resolveOrderJoinToken(
  store: RuntimeStatePort,
  tenantId: string,
  token: string,
): Promise<JoinTokenAssignment | null> {
  if (!token || !token.trim()) return null;
  const row = await store.get<JoinTokenAssignment>({ tenantId }, JOIN_TOKEN_COLLECTION, token);
  if (!row || row.tenantId !== tenantId) return null;
  return row;
}

/**
 * Explicit, audited reversal: delete a minted token before it resolves. `reason` is recorded, never
 * guessed — the reversal path `mintOrderJoinToken`'s own audit record names. Deleting an ALREADY
 * resolved token (one an order webhook already looked up) does not undo the tally it produced — see
 * `accumulateArmTally`'s own reversal (a compensating negative delta) for that.
 */
export async function revokeOrderJoinToken(store: RuntimeStatePort, tenantId: string, token: string, reason: string): Promise<void> {
  const at = new Date().toISOString();
  await store.tx({ tenantId }, async (t) => {
    await t.delete(JOIN_TOKEN_COLLECTION, token);
    await t.audit(
      {
        actor: "order-join-token",
        action: "order_jointoken.revoke",
        input: { reason },
        decision: { revoked: true },
        reversalPath: "n/a — this IS the reversal of a mint. A revoked token cannot be un-revoked; mint a new one if needed.",
      },
      at,
    );
  });
}
