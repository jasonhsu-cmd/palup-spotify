# ADR-0015: Cross-visit shopper memory — two-tier (guest / signed-up), EU-consent-gated

- **Status: Proposed — NOT enacted.** Records the design + the consent/retention/erasure model for durable,
  cross-visit shopper memory. It enables nothing on its own: no memory is written until this ADR is
  **Accepted** by the named owner, `security-reviewer` + legal (privacy) sign-off is recorded, and the
  consent/notice UX + retention/erasure subsystem exist. The **in-session** multi-turn memory already
  shipped (PR #76) is unaffected — that holds no server-side transcript; this ADR is the *durable,
  cross-visit* half.
- **Owner (named, CLAUDE.md §5):** jason.hsu@framy.co.
- **Plane:** run-time (the shopper agent's personalization). **Customer data → governed** (`HITL-POLICY`,
  CLAUDE.md §3/§7, `SECURITY.md`).

## Context

The widget's moat and the §3.1–§3.2 personalization goal require the agent to *remember this shopper*
across visits — "recall this shopper; learned store patterns; tenant-isolated" (`shopper-widget.md:24,32`).
Today `relationship` is hardcoded `anonymous` and no durable memory exists; the vector port
(`packages/platform-ports/src/vector-port.ts`, tenant-namespaced, right-to-erasure) is built but unwired.
Cross-visit memory is **personal data** (a persistent identifier + behavioral facts is *pseudonymous
personal data* under GDPR even when "anonymous"), so it is governed and needs an explicit consent,
retention, and erasure model — this ADR.

## Decision

A **two-tier** memory model, **consent-gated by region**, storing **distilled facts, never transcripts**.

### Tier 1 — Guest (anonymous, cross-session)
- A stable **first-party, per-tenant anonymous id** (a random id in the shopper's browser storage; **not**
  device fingerprinting) lets the agent recall across visits **without an account**.
- What is stored: **distilled, redacted memory facts** — short, minimal preference/observation records
  (e.g. "prefers fragrance-free", "sensitive skin", "viewed the vitamin-C serum"), **never the raw
  conversation transcript**. Stored via the vector port under `namespace = tenant`, `id = anon-id`.
- **EU-consent-gated (the load-bearing rule):** the `region` signal (already server-derived) governs the
  write. `region = eu` (or **unknown** — fail closed) → **no fact is written without explicit consent**;
  `region = us` → notice + store, with a clear **opt-out** that stops writes and triggers erasure.

### Tier 2 — Signed-up (identified account)
- On sign-up/login, **merge the anonymous id's facts into the account namespace** (a one-time, audited
  migration), then continue under the account. Consent is the account ToS; **erasure is by account**;
  the **relationship** states (VIP / subscriber / lapsed) derive from account + order history.

## Invariants (must hold; tests enforce before any write path ships)

1. **Distilled facts only** — never persist the raw transcript; every stored fact passes the model-port
   redaction (no card/SSN/PII) and a length cap.
2. **Per-tenant isolation** — memory is namespaced by tenant; **no cross-merchant super-profile**, no
   cross-namespace read (the vector port guarantees this).
3. **EU-consent-gated, fail-closed** — `region ∈ {eu, unknown}` → require explicit consent before any
   write; `region = us` → notice + store + honor opt-out. The consent decision is **server-derived**
   (region + consent signals), never client-forced.
4. **Retention TTL** — guest facts expire (default **60 days** since last activity); account facts follow
   the account lifecycle. Expiry is enforced, not aspirational.
5. **Right-to-erasure** — a data-rights delete erases the shopper's namespace/id via the vector port
   (`deleteById` / `deleteNamespace`); the guest→account merge and every erasure are **audited** on the
   immutable log.
6. **Consent + memory access are audited** — grant/withdraw and each read/write class are recorded (no
   silent memory action).
7. **Behind the vector port** (ADR-0001 portability) — feature code never touches a vendor memory SDK.
8. **Anonymous id is not a tracking identifier** — first-party, per-tenant, random; not shared across
   merchants, not derived from device fingerprints, resettable by the shopper (clearing it forgets them).

## The build (once Accepted; behind the already-merged vector port)

1. **Guest id + consent gate:** the widget carries a per-tenant anon id; `/chat` (server-derived region +
   consent) decides whether memory may be read/written for this turn.
2. **Fact distillation (audited):** on a consented turn, extract 0–N short facts (an LLM extraction step
   whose output is redacted + capped + reviewed), upsert to `vector(tenant, anon-id)`.
3. **Recall:** read the shopper's facts into the brain's grounding/personalization (drives `relationship`
   + tailored recommendations) — under the same honesty/anti-manipulation guardrails.
4. **Erasure + retention:** a data-rights handler + a TTL sweep, both via the vector port.
5. **Account merge:** on login, migrate anon-id facts → account namespace (one-time, audited).

## Alternatives considered

- **Store by default everywhere (no EU gate).** Rejected — GDPR/e-Privacy risk for EU shoppers;
  pseudonymous behavioral data needs a lawful basis.
- **Store full transcripts cross-visit.** Rejected — a large PII surface for marginal benefit over
  distilled facts; higher breach/erasure burden.
- **No cross-visit memory (in-session only).** Rejected — forfeits the personalization value and the moat;
  in-session (#76) is the reversible first slice, this is the durable half.
- **A cross-merchant shopper profile.** Rejected — violates tenant isolation / the moat and multiplies the
  privacy/consent surface.

## Governance sign-off (required before Accepted / any write path)

- **`security-reviewer`** — customer-data handling, consent enforcement, tenant isolation, erasure
  completeness, redaction of distilled facts.
- **Legal / privacy** — lawful basis + consent copy (EU), a **privacy notice** update, the **DPA**, and
  retention policy. `docs/design/README.md` already flags legal instruments as **not started**; this
  depends on them.
- **Named owner** merge (this ADR) = the explicit policy decision to build the tier.

## Open questions (resolve before Accepted)

- **Consent UX** — an in-widget consent prompt for EU, merchant-configured copy, or reuse the storefront's
  existing CMP signal? (Prefer honoring an existing CMP where present.)
- **Default retention** — 60 days for guest facts? Per-merchant configurable?
- **Merchant control** — can a merchant disable cross-visit memory for their store (some will want to)?
- **Fact distillation** — the extraction prompt is itself a governed behavior (it decides what's
  remembered); does it need its own eval + review?
- **Guest-id lifetime / reset** — surface a "forget me" control?

## Consequences

- (+) Real personalization + the per-tenant memory moat, portable behind the vector port; erasure and
  isolation are first-class.
- (−) EU shoppers get **no** cross-visit memory without consent (by design) — the agent must degrade
  gracefully to anonymous behavior there.
- (−) Prerequisites are real: a consent/notice UX, a retention/erasure subsystem, and **legal instruments**
  (privacy notice, DPA) that do not yet exist. This ADR is inert until those land + sign-off is recorded.
