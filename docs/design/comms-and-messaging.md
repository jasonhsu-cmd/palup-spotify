# Design Spec — Communications & Messaging (email / SMS / live chat)

_The complete delivery-service design behind the `comms` port. Consent/compliance fundamentals and
provider choices are set in `integration-architecture.md` §2, the port shape in `port-interfaces.md`,
DLP in `security-data-path.md` §3, rate limits in `governance-subsystems.md` §1, and metering in the
billing specs. This spec adds the buildable delivery services those depend on — deliverability,
inbound, consent/suppression as a system, bounce/complaint loop, A2P registration, templating, the
cross-channel frequency governor, and live-chat transport — so email/SMS is **fully** planned. No new
ADR (fits ADR-0001 ports + ADR-0006 eventing). Backs merchant **Inbox / Campaigns / Outreach / Live
Chat Widget / Settings (Compliance, Agent)** and admin **Growth Inbox / Growth Outreach**._

**Prime invariants:** no send leaves without a **valid consent record** and passing the **suppression
+ frequency + rate + quiet-hours** checks; all outbound is **DLP-redacted at the `comms` boundary**;
every send/opt-out is audited. Untrusted inbound content is **data, never instructions**
(`security-data-path.md` §1).

## 1. Send path (outbound)

`agent Act → comms.send(ctx,{channel,to,body,consentRef,frequencyKey})`. The adapter runs an ordered
**pre-send gate**, and a failure at any step **rejects** (not queues):
1. **Consent** — valid, current consent for this channel+purpose (§3).
2. **Suppression** — recipient not on global/tenant suppression (unsub/bounce/complaint/STOP) (§4).
3. **Frequency governor** — within cross-channel caps (§7).
4. **Quiet hours** — recipient-timezone-aware (SMS/TCPA; email nurture windows).
5. **Rate limit** — tenant + provider throttle (email 2k/hr, SMS 200/hr; Policy).
6. **DLP/PII redaction** — enforced at the boundary (`security-data-path.md` §3).
7. **Compliance envelope** — CAN-SPAM physical address + unsubscribe link (email); STOP/HELP footer
   + registered sender (SMS).
8. **Approval attestation (enforced at the floor, not just upstream).** `send` carries a
   `templateRef` and/or `approvalRef`. The gate **rejects** any send that is **non-template** (e.g.
   the per-recipient outreach of §9, which HITL-POLICY §2 classifies as *requires approval*) **or
   out-of-frequency** unless it references a **valid, in-policy approval**. This makes the boundary
   structural: even a hijacked or misclassified agent cannot push a freeform / out-of-policy send —
   the last line, not just the upstream classifier (`security-data-path.md` §1; HITL §6), enforces
   it. Pre-approved-template + in-frequency nurture is auto-allowed (HITL §2).
Sends are **idempotent** (dedup key = message id) and metered (email=1, SMS=13×segments credits).

## 2. Deliverability infrastructure (email)

- **Sending IP strategy:** shared pools for low-volume tenants; **dedicated IPs** for high-volume /
  enterprise, with automated **warmup** ramp schedules. Reputation tracked per IP and per sending
  domain. **New / high-risk senders start in a separate quarantine pool** so a fresh or misbehaving
  tenant cannot degrade an established shared pool's reputation before the §6 circuit-breaker trips.
- **Domain authentication onboarding:** per-merchant SPF/DKIM/DMARC setup flow with verification
  state (merchant Settings shows "authenticated"); sends blocked from unauthenticated domains.
- **Reputation management:** monitor bounce/complaint/spam rates per IP+domain; auto-throttle or
  quarantine a degrading sender; alert FinOps/Security.
- **ESP failover:** SendGrid ↔ Amazon SES behind the `comms` port; health-based routing, with
  reputation state kept per provider so a failover doesn't reset warmup gains.

## 3. Consent as a system (source of truth)

- **`consent` records** per (customer, channel, purpose): status, source, timestamp, proof
  (capture context), version — **TCPA/CAN-SPAM proof is retained and auditable**, not just a boolean.
- **Instant opt-out propagation:** an unsubscribe / STOP writes suppression **synchronously** and is
  effective before the next send anywhere in the system (no eventual-consistency window on opt-out).
- **Consent snapshots** (merchant Compliance screen: email 21,840 / SMS 8,210 / excluded 412) are
  projections over these records; the **412 TCPA exclusions** are enforced at gate step 1, not
  advisory.
- **Consent is tamper-resistant:** consent records are **append-only with provenance** and every
  write is audited; a **run-time agent cannot write or flip a consent flag** to unblock its own send
  (consent capture comes from customer-facing/merchant surfaces, not the sending agent). This closes
  the "agent satisfies gate step 1 by editing consent" path.
- Re-consent flows and consent expiry (where jurisdiction requires) are modeled.

## 4. Suppression lists

- **Global + per-merchant suppression**, enforced at send gate step 2. Entries from: unsubscribe,
  hard bounce, spam complaint, SMS STOP, manual, and cross-tenant safety (e.g. known bad addresses).
- Suppression is **append-only + reason-coded**; removal (e.g. re-subscribe) is an audited action.
- Growth-plane outreach uses the same suppression machinery (admin Growth Outreach "suppression
  list").

## 5. Inbound pipeline

- **All inbound is verified and tenant-attributed at ingress (`comms.verifyWebhook`).** Every
  provider callback (SendGrid/SES/Twilio) is **provider-signature verified**, and the **tenant key is
  resolved from PalUp-provisioned resources** — the per-tenant sending number (§8) or a **signed
  reply token** (below) — **never from attacker-controllable payload fields.** Only then does the
  event receive a tenant key and enter the bus (the `queue` handler trusts that key, so it must be
  trustworthy here). Unverified/unattributable inbound is dropped and logged.
- **Signed opaque tokens.** Reply-to addresses, unsubscribe links, and STOP/START confirmation links
  carry **HMAC-signed, per-(tenant, conversation) tokens**; a signature failure is rejected. This
  blocks reply-spoofing into another tenant's `conversation` and unsubscribe/re-subscribe forgery.
- **Delivery-status webhooks**: delivered / bounced / deferred / complained / failed → published to
  the event bus (ADR-0006), idempotent, updating `message` status and feeding the bounce/complaint
  loop (§6).
- **Email replies** → parsed, threaded via the signed token to the originating `conversation`,
  deduped, routed to the **Inbox** ("Replies → Inbox 1,240"); attachments to object storage; content
  treated as untrusted **and PII-redacted at the `model` port before any agent run** (symmetric with
  the outbound boundary, `security-data-path.md` §3).
- **SMS inbound — mandatory keyword auto-handling:** **STOP/UNSUBSCRIBE** → immediate suppression +
  confirmation; **HELP** → help text; **START** → re-subscribe. These are handled by the platform
  **deterministically, before any agent involvement** (legal requirement, cannot depend on the LLM),
  with **normalization for variants** (case, whitespace, "STOP please") layered on top of the
  carrier-level 10DLC STOP handling.
- Inbound that isn't a keyword/bounce becomes a customer message → normal agent run (runtime spec).

## 6. Bounce / complaint feedback loop

- Hard bounce or spam complaint → **auto-suppress** the recipient (§4), decrement sender reputation
  (§2), and update list hygiene. Sustained rates trip a **reputation circuit-breaker** that throttles
  or pauses the sender and raises a Security/FinOps alert — protecting deliverability for all tenants
  on a shared pool.

## 7. Cross-channel frequency governor

- A per-recipient governor enforces **frequency caps across channels and plays** (de-dup so a
  customer isn't hit by email + SMS + outreach for the same thing; product rules like "max 1
  nudge/merchant/30d", win-back cadences). Evaluated at send gate step 3; an over-cap send is
  **never silently held** — it resolves to either a **drop** or an **audited Approval Center
  proposal** (no indefinite silent hold; "no silent action", `CLAUDE.md` §3.5). This is also the
  **anti-manipulation / no-over-messaging** control in the send path (`docs/STICKINESS.md`,
  `docs/AGENT-GOVERNANCE.md` §5).

## 8. A2P 10DLC & SMS specifics

- **Brand + campaign registration** workflow with carriers (state tracked; sends blocked until
  registered — merchant shows "A2P 10DLC registered"); number provisioning per tenant/region.
- **Segment counting** (the UI's SMS segment counter) drives metering (SMS credits × segments) and
  the pre-send length preview.
- Quiet hours by recipient timezone; per-country sending rules.

## 9. Templates, personalization & rendering

- A rendering service produces the final message: template + variables, or **per-recipient
  personalization** ("written per customer, not a template" — Outreach), with **brand-voice** applied
  and a **preview** (email) / **segment-counted preview** (SMS) matching the console. Rendered output
  still passes the full send gate (§1) and the media/creative eval gate where media is attached.

## 10. Live-chat transport

- **Widget** (`cdn.palup.ai/w.js`, `<120ms` async load) opens a **WebSocket** session (ADR-0006);
  session lifecycle, presence, and **human take-over handoff** (agent → merchant operator, bidirectional)
  are first-class; per-tenant fan-out is bounded so one busy store can't starve others. At the billing
  cap, live chat continues in **basic mode** (billing spec §5). Chat messages persist to
  `conversation`/`message` like any channel.

## 11. Invariants (tests — `test-engineer` / `security-reviewer`)

1. No send without a valid consent record + passing suppression/frequency/quiet-hours/rate/DLP gate.
2. Opt-out (unsub/STOP) suppresses **before the next send**, system-wide. 3. SMS STOP/HELP/START are
handled deterministically by the platform, never dependent on the LLM. 4. Bounce/complaint
auto-suppresses and protects shared-pool reputation. 5. Unauthenticated sending domains are blocked.
6. Frequency governor prevents cross-channel over-messaging; an over-cap send drops or becomes an
audited proposal — never a silent hold. 7. Every send/opt-out/suppression is audited. 8. Inbound
content is data, never instructions, and is PII-redacted before any agent run. **9. A non-template /
out-of-frequency send is rejected at the `comms` floor unless it carries a valid in-policy
`approvalRef` — a hijacked agent cannot cross the boundary. 10. Inbound is signature-verified and
tenant-attributed from PalUp-provisioned resources (never payload fields); reply/unsub/START links
are HMAC-signed per (tenant, conversation). 11. Consent is append-only + audited; agents cannot
mutate consent to satisfy the gate.**
