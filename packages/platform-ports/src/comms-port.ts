import { redactPII } from "./redaction.js";

// Comms port (ADR-0001; port-interfaces.md `comms`; full design in docs/design/comms-and-messaging.md):
// the ONLY way run-time agent/feature code sends an outbound message (email/SMS) or opens a human
// take-over live-chat session. Feature code depends on this interface; provider adapters (SendGrid/SES
// for email, Twilio for SMS, a WebSocket transport for live chat) implement it and swap behind it, so no
// provider SDK leaks into feature code (portability-guard, ADR-0001).
//
// The port's reason for existing is a FAIL-CLOSED pre-send gate. A message leaves ONLY if it clears an
// ordered set of guardrails — consent -> suppression -> frequency -> quiet-hours -> rate -> DLP
// (comms-and-messaging.md §1). A failure at ANY step REJECTS (never silently sends, never queues); the
// rejection carries a STRUCTURED reason so the caller/audit log records exactly which guardrail fired.
// This is the CAN-SPAM/TCPA + DLP boundary: an un-redacted card/SSN can never leave, an unsubscribed or
// no-consent recipient can never be messaged, and a hijacked agent cannot spam past the frequency/rate
// caps. `check()` runs the identical gate with NO side effects (a preview: allow | deny + reasons).
//
// Consent is treated as a SOURCE OF TRUTH the sender cannot forge. `send` verifies the adapter's consent
// registry (seeded from customer-facing capture surfaces / merchant Compliance settings), so a caller
// asserting `consent: true` on the message without a matching registry grant is STILL denied — an agent
// cannot flip a consent flag to unblock its own send (comms-and-messaging.md §3 / invariants #1, #11).
// The message's `consent` field is the caller's per-send attestation: necessary but not sufficient.
//
// This module is the FOUNDATION: an in-memory reference adapter (the behavioral oracle a provider adapter
// must match) plus the gate. No real provider send is wired here. No external deps; DLP reuses redactPII.

/** The outbound channels this port gates. Additional channels are added by extending the adapter, not
 *  by widening feature code. */
export type CommsChannel = "email" | "sms";

/** Which guardrail blocked a send, in gate order. Surfaced on both `check()` and the rejection so the
 *  audit log records the precise cause ("no silent action"). */
export type CommsDenyReason =
  | "consent"
  | "suppression"
  | "frequency"
  | "quiet-hours"
  | "rate"
  | "dlp";

/** An outbound message presented to the gate. `consent` is the caller's per-send attestation; the
 *  adapter ALSO verifies its consent registry (see module header), so a forged `true` cannot pass. */
export interface CommsMessage {
  /** Tenant/merchant id — the isolation key for consent, suppression, frequency, and rate state. */
  tenantId: string;
  channel: CommsChannel;
  /** Recipient address (email) or E.164 number (sms). */
  to: string;
  body: string;
  /** Caller attestation that a consent record exists for this send. Verified against the registry. */
  consent: boolean;
  /** Cross-channel frequency-governor key; defaults to `to` (de-dups a recipient across channels). */
  frequencyKey?: string;
  /** Wall-clock send time used for the quiet-hours window (UTC hour). Defaults to now. */
  at?: Date;
}

/** A committed send receipt. `body` is the COMPLIANCE-SAFE (DLP-redacted) body that actually left, so no
 *  un-redacted PII is ever recorded. */
export interface SentMessage {
  tenantId: string;
  channel: CommsChannel;
  to: string;
  body: string;
  /** ISO-8601 timestamp the send was recorded. */
  at: string;
}

/** The result of a side-effect-free `check()` preview. */
export interface CommsCheck {
  /** True only if EVERY gate passes. */
  allow: boolean;
  /** The failing guardrails in gate order (empty when `allow`). */
  reasons: CommsDenyReason[];
  /** The DLP-redacted body that WOULD be sent (equals `body` when clean). */
  preview: string;
}

/** A minimal human take-over handle for a live-chat session (agent -> merchant operator). Abstract: a
 *  provider adapter backs it with a real WebSocket transport (comms-and-messaging.md §10). */
export interface LiveChatHandle {
  readonly sessionId: string;
  readonly tenantId: string;
  /** True while a human operator holds the session. */
  isOpen(): boolean;
  /** Hand the session back / end the take-over. Idempotent. */
  close(): Promise<void>;
}

export interface CommsPort {
  /** Run the fail-closed pre-send gate and, ONLY if every guardrail passes, record the send. Rejects
   *  with a `CommsRejection` (carrying the structured reasons) on any failure — never silently sends. */
  send(msg: CommsMessage): Promise<SentMessage>;
  /** Preview the identical gate with NO side effects: allow | deny + reasons + the redacted body. */
  check(msg: CommsMessage): Promise<CommsCheck>;
  /** Open a human take-over live-chat session for a tenant. */
  openLiveChat(tenantId: string): Promise<LiveChatHandle>;
}

/** The structured rejection thrown by `send` when the gate blocks. `reasons` lists every failing
 *  guardrail; `reason` is the first in gate order. */
export class CommsRejection extends Error {
  readonly reason: CommsDenyReason;
  readonly reasons: CommsDenyReason[];
  constructor(reasons: CommsDenyReason[]) {
    super(`comms: send blocked by pre-send gate — ${reasons.join(", ")}`);
    this.name = "CommsRejection";
    this.reasons = reasons;
    this.reason = reasons[0]!;
  }
}

/** Options for the in-memory adapter. Every gate is permissive-by-absence EXCEPT consent and DLP, which
 *  are fail-closed by default (no consent grant => deny; a PII hit => block). */
export interface InMemoryCommsOpts {
  /** Seed granted consent: tenantId -> channel -> recipients. This is the source of truth. */
  consent?: Record<string, Partial<Record<CommsChannel, string[]>>>;
  /** Seed suppression (unsub/bounce/complaint/STOP): tenantId -> recipients. */
  suppression?: Record<string, string[]>;
  /** Max sends per recipient (cross-channel), per tenant. Default: Infinity (governor off). */
  frequencyCap?: number;
  /** UTC hours during which sending is SUPPRESSED; wraps past midnight (e.g. 22..6). Default: none. */
  quietHours?: { startHour: number; endHour: number };
  /** Fixed-window per-tenant rate limit. Default: none. */
  rateLimit?: { max: number; windowMs: number };
  /** DLP behavior on a PII hit: 'block' (reject — fail closed, default) or 'redact' (mask, then send). */
  dlp?: "block" | "redact";
  /** Clock for rate-limit windows (injectable for tests). Default: Date.now. */
  now?: () => number;
}

/** The in-memory adapter, plus inspection/mutation helpers used by tests and opt-out flows. */
export interface InMemoryComms extends CommsPort {
  /** Recorded sends (compliance-safe bodies), optionally filtered to one tenant. Deep-cloned. */
  sent(tenantId?: string): SentMessage[];
  /** Grant consent for (tenant, channel, recipient) — models a customer-facing capture. */
  grantConsent(tenantId: string, channel: CommsChannel, to: string): void;
  /** Revoke consent for (tenant, channel, recipient). */
  revokeConsent(tenantId: string, channel: CommsChannel, to: string): void;
  /** Add a recipient to a tenant's suppression list (unsub / STOP) — effective before the next send. */
  suppress(tenantId: string, to: string): void;
}

function requireField(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim())
    throw new Error(`CommsPort: a non-blank ${name} is required`);
  return v;
}

function requireChannel(c: unknown): CommsChannel {
  if (c !== "email" && c !== "sms")
    throw new Error("CommsPort: channel must be 'email' or 'sms'");
  return c;
}

/** True if `hour` (0-23) is inside the quiet window; supports windows that wrap past midnight. */
function inQuietHours(hour: number, w: { startHour: number; endHour: number }): boolean {
  if (w.startHour === w.endHour) return false; // degenerate window suppresses nothing
  if (w.startHour < w.endHour) return hour >= w.startHour && hour < w.endHour;
  return hour >= w.startHour || hour < w.endHour;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * In-memory reference adapter for CommsPort — the DEV/TEST implementation and the behavioral oracle a
 * provider adapter must match. Enforces the full ordered pre-send gate. Consent is verified against a
 * registry (the caller's `msg.consent` attestation is necessary but NOT sufficient), suppression/
 * frequency/rate state is per tenant (isolation), quiet-hours is UTC-hour based, and DLP reuses
 * `redactPII`. No provider is wired; a passing send is recorded in memory for assertions. No external deps.
 */
export function createInMemoryComms(opts: InMemoryCommsOpts = {}): InMemoryComms {
  const frequencyCap = opts.frequencyCap ?? Infinity;
  const quietHours = opts.quietHours;
  const rateLimit = opts.rateLimit;
  const dlpMode = opts.dlp ?? "block";
  const now = opts.now ?? Date.now;

  const consent = new Map<string, Map<CommsChannel, Set<string>>>();
  const suppression = new Map<string, Set<string>>();
  const freq = new Map<string, Map<string, number>>();
  const rate = new Map<string, { windowStart: number; count: number }>();
  const sentLog: SentMessage[] = [];
  const sessions = new Map<string, { tenantId: string; open: boolean }>();
  let sessionSeq = 0;

  function grantConsent(tenantId: string, channel: CommsChannel, to: string): void {
    let byChannel = consent.get(tenantId);
    if (!byChannel) {
      byChannel = new Map();
      consent.set(tenantId, byChannel);
    }
    let set = byChannel.get(channel);
    if (!set) {
      set = new Set();
      byChannel.set(channel, set);
    }
    set.add(to);
  }
  function revokeConsent(tenantId: string, channel: CommsChannel, to: string): void {
    consent.get(tenantId)?.get(channel)?.delete(to);
  }
  function hasConsent(tenantId: string, channel: CommsChannel, to: string): boolean {
    return consent.get(tenantId)?.get(channel)?.has(to) ?? false;
  }
  function suppress(tenantId: string, to: string): void {
    let set = suppression.get(tenantId);
    if (!set) {
      set = new Set();
      suppression.set(tenantId, set);
    }
    set.add(to);
  }
  function isSuppressed(tenantId: string, to: string): boolean {
    return suppression.get(tenantId)?.has(to) ?? false;
  }
  function freqCount(tenantId: string, key: string): number {
    return freq.get(tenantId)?.get(key) ?? 0;
  }
  function bumpFreq(tenantId: string, key: string): void {
    let m = freq.get(tenantId);
    if (!m) {
      m = new Map();
      freq.set(tenantId, m);
    }
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  function currentRate(tenantId: string, nowMs: number): number {
    if (!rateLimit) return 0;
    const st = rate.get(tenantId);
    if (!st || nowMs - st.windowStart >= rateLimit.windowMs) return 0;
    return st.count;
  }
  function bumpRate(tenantId: string, nowMs: number): void {
    if (!rateLimit) return;
    const st = rate.get(tenantId);
    if (!st || nowMs - st.windowStart >= rateLimit.windowMs)
      rate.set(tenantId, { windowStart: nowMs, count: 1 });
    else st.count += 1;
  }

  // Seed registries from opts (after the helpers so the declarations are in scope).
  for (const [tenant, byChannel] of Object.entries(opts.consent ?? {})) {
    for (const [channel, recipients] of Object.entries(byChannel ?? {})) {
      for (const to of recipients ?? []) grantConsent(tenant, channel as CommsChannel, to);
    }
  }
  for (const [tenant, recipients] of Object.entries(opts.suppression ?? {})) {
    for (const to of recipients ?? []) suppress(tenant, to);
  }

  /** Run every guardrail in gate order (pure — NO state mutation). `send` mutates only after this passes. */
  function evaluate(msg: CommsMessage, nowMs: number): { reasons: CommsDenyReason[]; redacted: string } {
    const reasons: CommsDenyReason[] = [];
    // 1. Consent — registry is the source of truth; the caller's attestation must ALSO agree.
    if (!(msg.consent === true && hasConsent(msg.tenantId, msg.channel, msg.to))) reasons.push("consent");
    // 2. Suppression — unsub/bounce/complaint/STOP.
    if (isSuppressed(msg.tenantId, msg.to)) reasons.push("suppression");
    // 3. Frequency governor — per recipient (cross-channel), per tenant.
    const fkey = msg.frequencyKey ?? msg.to;
    if (freqCount(msg.tenantId, fkey) >= frequencyCap) reasons.push("frequency");
    // 4. Quiet hours — UTC-hour window (a provider adapter uses recipient timezone).
    const when = msg.at ?? new Date(nowMs);
    if (quietHours && inQuietHours(when.getUTCHours(), quietHours)) reasons.push("quiet-hours");
    // 5. Rate limit — per tenant fixed window.
    if (rateLimit && currentRate(msg.tenantId, nowMs) >= rateLimit.max) reasons.push("rate");
    // 6. DLP — no un-redacted PII leaves. block => reject; redact => the sent body is masked.
    const redacted = redactPII(msg.body);
    if (redacted !== msg.body && dlpMode === "block") reasons.push("dlp");
    return { reasons, redacted };
  }

  const port: InMemoryComms = {
    async send(msg) {
      requireField(msg?.tenantId, "tenantId");
      requireField(msg?.to, "to");
      requireChannel(msg?.channel);
      const nowMs = now();
      const { reasons, redacted } = evaluate(msg, nowMs);
      if (reasons.length > 0) throw new CommsRejection(reasons); // fail closed — never a silent send
      // Gate cleared: consume budget and record the compliance-safe (redacted) body.
      bumpFreq(msg.tenantId, msg.frequencyKey ?? msg.to);
      bumpRate(msg.tenantId, nowMs);
      const rec: SentMessage = {
        tenantId: msg.tenantId,
        channel: msg.channel,
        to: msg.to,
        body: redacted,
        at: new Date(nowMs).toISOString(),
      };
      sentLog.push(rec);
      return clone(rec);
    },

    async check(msg) {
      requireField(msg?.tenantId, "tenantId");
      requireField(msg?.to, "to");
      requireChannel(msg?.channel);
      const { reasons, redacted } = evaluate(msg, now());
      return { allow: reasons.length === 0, reasons, preview: redacted };
    },

    async openLiveChat(tenantId) {
      requireField(tenantId, "tenantId");
      const sessionId = `lc_${++sessionSeq}`;
      sessions.set(sessionId, { tenantId, open: true });
      return {
        sessionId,
        tenantId,
        isOpen: () => sessions.get(sessionId)?.open === true,
        async close() {
          const s = sessions.get(sessionId);
          if (s) s.open = false;
        },
      };
    },

    sent(tenantId) {
      const rows = tenantId ? sentLog.filter((m) => m.tenantId === tenantId) : sentLog;
      return rows.map((m) => clone(m));
    },
    grantConsent,
    revokeConsent,
    suppress,
  };

  return port;
}

// --- SandboxCommsAdapter (WB win-back agent, 2026-08-23) ------------------------------------------
//
// A SEPARATE, additive capability from the `CommsPort` fail-closed gate above: a batch-send
// recorder for run-time CAMPAIGN agents (e.g. the win-back agent's `campaignExecutor`,
// `@palup/agent-runtime`). Deliberately NOT the same interface as `CommsPort` — that port's
// `send(msg)` is a single-message, per-recipient call gated by consent/suppression/frequency/
// quiet-hours/rate/DLP (comms-and-messaging.md §1); a campaign blast needs a BATCH call across a
// whole lapsed-customer segment. Named/typed distinctly (`CampaignCommsPort`/`CampaignMessage`,
// not `CommsPort`/`CommsMessage`) so this addition never collides with, weakens, or bypasses that
// existing compliance gate.
//
// OPEN CONCERN (flag before any live enablement): `SandboxCommsAdapter` itself runs NO consent/
// suppression/DLP check — it only records, deterministically, and never delivers, which is exactly
// what makes it safe for dev/test/staging (a campaign agent wired to this adapter can send nothing
// to a real shopper). A LIVE adapter for real campaign sends must still clear the same consent/
// suppression/DLP guardrails `CommsPort` already enforces (CAN-SPAM/TCPA) before it ships — that
// wiring is a later, human-gated task, not assumed here.

/** The outbound channels a campaign send may use. Reuses `CommsPort`'s channel vocabulary so a
 *  future live adapter can share it rather than defining a second, divergent union. */
export type CampaignMessage = {
  channel: CommsChannel;
  /** Recipient address (email) or E.164 number (sms). */
  to: string;
  /** Email subject line; meaningless for `sms` (adapters ignore it there). */
  subject?: string;
  body: string;
};

/** A committed batch-send receipt: how many messages were recorded, and their minted ids
 *  (index-order, same length as the input batch). */
export interface CampaignSendResult {
  sent: number;
  ids: string[];
}

/** The batch-campaign-send port a run-time campaign agent's executor depends on (never a vendor
 *  SDK directly — ADR-0001). */
export interface CampaignCommsPort {
  send(messages: CampaignMessage[], ctx: { tenantId: string }): Promise<CampaignSendResult>;
}

/** One recorded campaign message: the input message plus the tenant it was sent for and the
 *  minted id. Deep-cloned on read so a caller can't mutate the adapter's internal record. */
export interface RecordedCampaignMessage extends CampaignMessage {
  tenantId: string;
  id: string;
}

/**
 * The sandbox/dev/test/staging implementation of `CampaignCommsPort`: RECORDS every message and
 * NEVER delivers anything to a real provider. Ids are minted deterministically from the adapter's
 * own running count (`sandbox:<index>`) — no `Math.random`, no `Date.now()` — so a staging deploy
 * of a campaign agent behind this adapter is provably incapable of reaching a real shopper.
 */
export class SandboxCommsAdapter implements CampaignCommsPort {
  readonly recorded: RecordedCampaignMessage[] = [];

  async send(messages: CampaignMessage[], ctx: { tenantId: string }): Promise<CampaignSendResult> {
    const ids: string[] = [];
    for (const msg of messages) {
      const id = `sandbox:${this.recorded.length}`;
      this.recorded.push({ ...msg, tenantId: ctx.tenantId, id });
      ids.push(id);
    }
    return { sent: messages.length, ids };
  }
}
