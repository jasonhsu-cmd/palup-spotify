import type { HistoryTurn } from "./types.js";

// PURE text-handling shared by the brain and the history fence. Lives in its own module so
// `history-fence.ts` can reuse the EXACT sanitizer and discount detector the brain uses without a
// brain.ts <-> history-fence.ts import cycle (the package deliberately avoids dep cycles — see the
// widget-memory note in brain.ts). Nothing here reads env, does I/O, or depends on a port.

export function sanitizeGroundingText(s: string | undefined, max = 600): string {
  return (s ?? "")
    .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, " ") // strip real HTML tags only (bare "< 2 days" prose survives)
    .replace(/&(amp|#38);/gi, "&").replace(/&(quot|#34);/gi, '"').replace(/&(apos|#39);/gi, "'").replace(/&(nbsp|#160);/gi, " ") // decode SAFE entities only (never &lt;/&gt; -> no tag revival)
    .replace(/[\u0000-\u001F\u007F\u0085\u2028\u2029]+/g, " ") // control + NEL / line / paragraph separators -> space
    .replace(/={3,}/g, "==") // never let merchant text forge the === fence
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Deterministic reply-integrity backstop (M2 hardening a): PalUp grounds NO promos/discounts, so a
// specific "% off" or a discount/coupon/promo code appearing in a MODEL reply is invented or injected
// (e.g. from a poisoned catalog description). We never serve that false money promise — flag it and hand
// to a human (NN#1). When a grounded promo field later exists, check the claim against it instead.
const UNGROUNDED_DISCOUNT = new RegExp(
  [
    "\\b\\d{1,4}\\s*%\\s*(off|discount)\\b", // "20% off", "1000% off"
    "\\b\\d{1,3}\\s*percent\\s*(off|discount)\\b", // "fifty" is spelled but "50 percent off" caught
    "\\$\\s?\\d+(\\.\\d+)?\\s*off\\b", // "$10 off"
    "\\b\\d{1,4}\\s*dollars?\\s*off\\b", // "10 dollars off"
    "\\bhalf\\s*(off|price)\\b", // "half off" / "half price"
    "\\b(use|apply|enter|redeem)\\s+(the\\s+)?(?:promo|coupon|discount|voucher)?\\s*code\\s+[a-z0-9]{2,}", // "use/apply/enter/redeem [promo] code X"
    "\\b(promo|coupon|discount|voucher)\\s+code\\s+[a-z0-9]{2,}", // "<promo> code X"
    "\\bthe\\s+code\\s+is\\s+[a-z0-9]{2,}", // "the code is X"
  ].join("|"),
  "i",
);
export function replyOffersUngroundedDiscount(reply: string): boolean {
  return UNGROUNDED_DISCOUNT.test(reply);
}

// In-session multi-turn memory bounds (docs/design/shopper-widget.md §3.2, §6A). The CLIENT replays a
// bounded recent transcript on each /chat; the brain threads it into the model context (groundedMessages)
// so the model has prior-turn context. This is NOT server-side memory: the transcript is never persisted
// (SessionState stays control-only) and — being non-system messages — is redacted at the model port
// before egress. Bounds are enforced at the choke point so a client can't blow up the context window.
export const HISTORY_MAX_TURNS = 8; // keep only the most recent N turns (messages)
export const HISTORY_MAX_CHARS = 4_000; // total char budget across kept turns (matches MAX_MESSAGE_CHARS)

/**
 * Validate + BOUND an untrusted history array into safe, ordered prior turns: keep only well-formed
 * turns (valid role + non-empty string content), cap the COUNT to the most-recent `maxTurns`, then cap
 * the TOTAL characters newest→oldest (the boundary turn is truncated, older overflow is dropped). A
 * non-array or malformed input yields `[]`. Shared by the server (bounds the request) and the brain
 * (final guarantee), so however history arrives it can never exceed the cap. Never throws.
 */
export function normalizeHistory(
  raw: unknown,
  maxTurns = HISTORY_MAX_TURNS,
  maxChars = HISTORY_MAX_CHARS,
): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const valid: HistoryTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const role = (t as { role?: unknown }).role;
    const content = (t as { content?: unknown }).content;
    if ((role === "user" || role === "agent") && typeof content === "string" && content.length > 0) {
      valid.push({ role, content });
    }
  }
  const recent = valid.slice(-Math.max(0, maxTurns)); // most-recent N turns
  const out: HistoryTurn[] = [];
  let budget = Math.max(0, maxChars);
  for (let i = recent.length - 1; i >= 0 && budget > 0; i--) {
    const turn = recent[i]!;
    const content = turn.content.length > budget ? turn.content.slice(0, budget) : turn.content;
    budget -= content.length;
    out.unshift({ role: turn.role, content });
  }
  return out;
}
