# ADR-0015: Cross-visit shopper memory — two-tier (guest / signed-up), EU-consent-gated

- **Status: Proposed — NOT enacted.** Records the design + the consent/retention/erasure model for durable,
  cross-visit shopper memory. It enables nothing on its own: no memory is written until this ADR is
  **Accepted** by the named owner, `security-reviewer` + legal (privacy) sign-off is recorded, and the
  consent/notice UX + retention/erasure subsystem exist. The **in-session** multi-turn memory already
  shipped (PR #76) is unaffected — that holds no server-side transcript; this ADR is the *durable,
  cross-visit* half.
- **Enablement gate list: [`docs/MEMORY-GO-LIVE-CHECKLIST.md`](../MEMORY-GO-LIVE-CHECKLIST.md)** — the
  single checklist of everything that must be MET (and the residuals that must be explicitly ACCEPTED)
  before `MEMORY_ADR_ACCEPTED` may be flipped and this Status moved to *Accepted*. Human-only step.
- **Amendment (2026-08-04 — named owner + legal, retention):** resolves the retention "Still open" items
  below. Ordinary **and** special-category facts both retain **30 days**, as a **sliding window** measured
  from last activity — a return re-stamps the fact's expiry to `now + TTL` (throttled to ≤ once/day; each
  extension audited via the `ttl_renew` action). Invariant 9's original **"shorter TTL"** element is amended
  to **`TTL_special ≤ TTL_ordinary`** (special retained no LONGER than ordinary); Inv 9's other stricter-
  storage elements (mandatory Consent 2, extra audit, erasure-first) are unchanged. The US **Consent-2
  fail-closed** default is confirmed (special-category always needs explicit `consent2 = "in"`, every
  region). This amendment resolves the *retention* opens only; the overall **Status stays Proposed** until
  the full `Accepted` + `MEMORY_ADR_ACCEPTED` go-live flip (named-owner + `security-reviewer` + legal,
  human-only). Implemented INERT in `packages/widget-memory` (`retention.ts`/`service.ts`/`consent.ts`).
- **Decisions recorded (owner, this revision):** (a) **scope = B** — special-category (health/allergy)
  facts *may* be remembered, but **only behind a separate, explicit Article-9 health-data consent**;
  **not** non-sensitive-only, and **not** accounts-only (a consented guest may also have one remembered);
  (b) consent is delivered via the **contextual two-layer flow** below (ordinary personal data, then an
  explicit health tier, each just-in-time). Both still require legal + `security-reviewer` sign-off before
  Accepted — the decision sets the design, not the go-live.
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

A **two-tier** memory model (guest / signed-up), **consent-gated by region**, storing **distilled facts,
never transcripts**, with every fact assigned one of two **sensitivity classes** — ordinary commerce facts
and **special-category (health) facts** — the latter behind a *separate* explicit consent (scope **B**).

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
  migration), then continue under the account. Consent is the account ToS — **except** special-category
  facts, which **still require the separate explicit health consent** (Consent 2) and are never folded
  into sign-up ToS; **erasure is by account**; the **relationship** states (VIP / subscriber / lapsed)
  derive from account + order history.

### Fact sensitivity — two classes; the health-consent tier (scope decision **B**)

Every candidate fact is classified *before* any write:

- **Ordinary commerce facts** — preferences, likes, sizes, viewed items, routine (e.g. "prefers
  fragrance-free", "viewed the vitamin-C serum"). Remembered under the ordinary cross-visit consent
  (**Consent 1**), per the tier + region rules above.
- **Special-category facts** — health / allergy / medical and anything GDPR Art. 9 covers. Remembered
  **only behind a separate, explicit health-data consent (Consent 2)**, with **stricter handling**:
  encrypted at rest, a **TTL no longer than ordinary** (amended 2026-08-04: both 30 days), extra audit, and
  erasure-first on withdrawal. Available in **both tiers** — a *consented* anonymous guest may have one
  remembered; it is
  **not** restricted to accounts.

Two rules keep this safe:

- **The safety guardrail is independent of memory.** An allergy/ingredient question is always answered
  reactively — ground the ingredient scan, caveat cross-contact, never guarantee, escalate — and that
  answer needs **no** consent (it stores nothing). Only *remembering* the fact engages Consent 2.
- **Remembered sensitive facts may only ADD caution.** A recalled "tree-nut allergy" lets the agent
  proactively steer away from and flag at-risk products; it may **never** assert a product is safe, skip
  the caveat, or bypass escalation. Memory can raise caution, never lower a guardrail.

**Keep other industries in mind — the sensitivity map is per-industry, the guardrails are not.** What
counts as "sensitive" varies: skincare / food → allergies, pregnancy, skin & medical conditions;
supplements / pharmacy → medications, diagnoses (strictest, may exceed GDPR); apparel → health-driven fit
needs; general electronics / retail → effectively none. So the classifier is a **governed,
per-industry-configurable policy with a conservative default**: Art-9 categories (health, biometric,
genetic, sexual-orientation, …) are treated as special-category **unless** a tenant's *reviewed* policy
narrows what is remembered — a tenant policy may only **narrow** memory, never reclassify special-category
data as ordinary. The universal guardrails (safety branch, honesty, anti-manipulation) do not vary by
industry; only the sensitivity map does.

### Consent UX — contextual, two-layer (resolves the *Consent UX* open question)

Consent is **just-in-time**, never two upfront walls:

- **Layer 0 — default, zero consent.** The widget fully works: it answers, and the **reactive safety
  branch works normally**. Nothing persists cross-visit. The product must be fully usable here, or later
  consent is not *freely given*.
- **Layer 1 — Consent 1 (ordinary personal data, Art. 6).** Offered when a durable preference is worth
  keeping, **or honored from the storefront's existing CMP** preferences/functional category where
  present. Enables ordinary-fact cross-visit memory.
- **Layer 2 — Consent 2 (explicit special-category consent, Art. 9).** Prompted **only when a sensitive
  fact actually arises** (the shopper volunteers an allergy) and **after** the reactive answer — e.g.
  *"You mentioned a nut allergy — want me to remember it so I can flag products to avoid next time? It's
  health info; I'll keep it encrypted, only with your explicit OK, and you can delete it anytime."*

Flow invariants:

- The **answer** needs no consent; only **storage** does.
- **Consent 2 is independent of Consent 1** and never bundled — not into the prefs consent, not into
  account sign-up ToS. Either may be granted without the other.
- **Decline / no prompt ⇒ non-persisted for that fact**: used only for the current session's answer,
  re-asked next visit.
- **Withdrawal is symmetric** — an in-widget "manage what I remember / forget me" control; withdrawing
  Consent 2 **purges** the sensitive fact (right-to-erasure).
- **Region-gated exactly like Tier 1** — `region ∈ {eu, unknown}` fail-closed (explicit consent
  required); `region = us` notice + opt-out, with explicit health consent still best practice (and
  tracking emerging US state health-data law — confirm specifics with legal).

## Invariants (must hold; tests enforce before any write path ships)

1. **Distilled facts only** — never persist the raw transcript; every stored fact passes the model-port
   redaction (no card/SSN/PII) and a length cap.
2. **Per-tenant isolation** — memory is namespaced by tenant; **no cross-merchant super-profile**, no
   cross-namespace read (the vector port guarantees this).
3. **EU-consent-gated, fail-closed** — `region ∈ {eu, unknown}` → require explicit consent before any
   write; `region = us` → notice + store + honor opt-out. The consent decision is **server-derived**
   (region + consent signals), never client-forced.
4. **Retention TTL** — guest facts expire (default **30 days** since last activity — a **sliding window**:
   each return re-stamps the fact's expiry to `now + TTL`, throttled to ≤ once/day and audited via
   `ttl_renew`; amended 2026-08-04); account facts follow the account lifecycle. Expiry is enforced, not
   aspirational.
5. **Right-to-erasure** — a data-rights delete erases the shopper's namespace/id via the vector port
   (`deleteById` / `deleteNamespace`); the guest→account merge and every erasure are **audited** on the
   immutable log.
6. **Consent + memory access are audited** — grant/withdraw and each read/write class are recorded (no
   silent memory action).
7. **Behind the vector port** (ADR-0001 portability) — feature code never touches a vendor memory SDK.
8. **Anonymous id is not a tracking identifier** — first-party, per-tenant, random; not shared across
   merchants, not derived from device fingerprints, resettable by the shopper (clearing it forgets them).
9. **Special-category facts need separate explicit consent** — no Art-9 (health/allergy/medical) fact is
   ever written under the ordinary memory consent or account ToS; it requires **Consent 2** and stricter
   storage (encryption, extra audit, erasure-first). Enforced fail-closed. **[Amended 2026-08-04]** the
   original "shorter TTL" element is amended to **`TTL_special ≤ TTL_ordinary`** (special retained no
   LONGER than ordinary); legal set both classes to 30 days — see the amendment note under Status.
10. **Memory never lowers a guardrail** — a remembered sensitive fact may only *increase* caution
    (proactive avoidance / flag); it never lets the agent assert safety, skip the safety branch, or
    bypass escalation. The reactive safety answer is memory-independent and consent-free.
11. **Conservative, narrow-only sensitivity classification** — the classifier defaults to treating Art-9
    categories as sensitive; a per-tenant/industry policy may only **narrow** what is remembered, never
    reclassify special-category data as ordinary. The classifier + distillation prompt are a **governed
    behavior with their own eval + review** (they decide *what* is remembered and *its class*).

## The build (once Accepted; behind the already-merged vector port)

1. **Guest id + consent gate:** the widget carries a per-tenant anon id; `/chat` (server-derived region +
   consent) decides whether memory may be read/written for this turn.
2. **Fact distillation + sensitivity classification (audited, governed):** on a consented turn, extract
   0–N short facts (an LLM step whose output is redacted + capped) and classify each as ordinary vs
   special-category using the tenant's **per-industry sensitivity policy** (conservative default). Ordinary
   facts gate on Consent 1; special-category facts gate on **Consent 2** + stricter storage. The extraction
   prompt + classifier ship with their **own eval + governance review** (Invariant 11).
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

## Open questions

**Resolved this revision:**
- **Consent UX** — ✅ the **contextual two-layer flow** above (Layer 0 default → Consent 1 ordinary →
  Consent 2 explicit health, each just-in-time; reuse the storefront CMP for Layer 1 where present).
- **Fact distillation governance** — ✅ **yes**: the extraction prompt + the sensitivity classifier are a
  governed behavior with their **own eval + review** (Invariant 11) — they decide *what* is remembered and
  *its sensitivity class*.
- **Memory scope** — ✅ **B**: special-category facts remembered only behind explicit Consent 2.

**Still open (resolve before Accepted):**
- **Sensitive-fact TTL** — ✅ **RESOLVED 2026-08-04** (amendment, with legal): special-category retention =
  **30 days**, EQUAL to ordinary (Inv 9 amended to `TTL_special ≤ TTL_ordinary`, no longer strictly shorter).
- **Default retention (ordinary)** — ✅ **RESOLVED 2026-08-04**: **30 days**, sliding from last activity
  (per-merchant configurability deferred).
- **Merchant control** — a per-store disable toggle **and** who authors/reviews the per-industry
  sensitivity policy (Invariant 11) — merchant-proposed, PalUp-reviewed?
- **Guest-id lifetime / reset** — surface the "manage what I remember / forget me" control (also the
  Consent-2 withdrawal path).

## Consequences

- (+) Real personalization + the per-tenant memory moat, portable behind the vector port; erasure and
  isolation are first-class.
- (+) Safety-relevant facts (allergies) can be remembered to **protect** the shopper — behind explicit
  consent — so the agent flags at-risk products proactively instead of forgetting a stated allergy. The
  per-industry sensitivity map carries this to other verticals without changing the guardrails.
- (−) EU shoppers get **no** cross-visit memory without consent (by design) — the agent must degrade
  gracefully to anonymous behavior there.
- (−) The **health tier is the heaviest slice**: special-category data means encryption, a TTL no longer
  than ordinary (amended 2026-08-04: both 30 days), the explicit Consent-2 UX, legal instruments (privacy
  notice + DPA that cover health data), and a
  reviewed per-industry sensitivity policy **plus its eval**. This ADR is inert until those land + the
  `security-reviewer` and legal/privacy sign-offs are recorded.
