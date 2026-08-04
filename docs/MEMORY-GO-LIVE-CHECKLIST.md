# Cross-visit memory — go-live checklist

> **Status: NOT READY. Several conditions below are unmet.** This document is the single gate list for
> flipping `MEMORY_ADR_ACCEPTED` (`packages/widget-memory/src/flag.ts`) and moving ADR-0015 from
> *Proposed* to *Accepted*. That flip is **human-only** (CLAUDE.md §3, ADR-0015 Status): it requires a
> named human owner, a recorded `security-reviewer` sign-off, and a recorded **legal** sign-off. No build
> agent may perform it, and no amount of green CI substitutes for the legal conditions.

**What the flip actually does.** `isMemoryEnabled()` is `MEMORY_ENABLED === "true" && MEMORY_ADR_ACCEPTED`.
Both must be true. The env var alone can never enable memory (NN#1) — the const is a build-time change that
goes through code review. Until then the entire subsystem is inert: no fact is written, none is recalled,
and production behaviour is byte-identical to before the program.

**How to read this list.** Every item is either **MET** (with the evidence), **OPEN** (with what is
missing), or **ACCEPT** (a residual risk that must be consciously signed off rather than fixed). An item
being "in a PR" is *not* met — merged and verified is met.

_Last updated: 2026-08-04. Update the status column in the same PR that closes an item._

---

## A. Legal and governance — all OPEN, all human

These cannot be closed by engineering work. They are the reason this checklist exists.

| # | Condition | Status |
|---|---|---|
| A1 | **Privacy notice covering cross-visit memory, executed.** Draft exists (`docs/legal/memory-privacy-notice-draft.md`) — explicitly *not* legal advice, *not* executed. | **OPEN** |
| A2 | **DPA / processor terms covering health (Art-9) data, executed.** Draft exists (`docs/legal/memory-dpa-addendum-draft.md`). `docs/legal/provisions-brief.md` §0 records that no agreements currently exist. | **OPEN** |
| A3 | **Legal sign-off recorded in ADR-0015**, resolving `docs/legal/memory-open-questions-for-counsel.md` — in particular the US Consent-2 fail-closed default, the sliding-renewal retention model, and the Art-9 lawful basis. | **OPEN** |
| A4 | **`security-reviewer` sign-off recorded at the flip.** Per-PR security reviews across the program are *not* this: ADR-0015's Status line requires a sign-off on enablement itself. | **OPEN** |
| A5 | **Legal review of the shopper-facing consent copy** (the health/Consent-2 prompt shipped in PR-11b/11c is health-consent language). | **OPEN** |
| A6 | **DPIA / lawful-basis coverage for the classifier running on shopper messages.** Once live, `classifyFact` inspects every message to decide whether to *ask* for consent (pure, in-memory, stores nothing — but it does process message text). | **OPEN** |
| A7 | **ADR-0015 Status → Accepted** and **named human owner merges the flip.** | **OPEN** |

## B. Technical preconditions

| # | Condition | Status |
|---|---|---|
| B1 | **Durable vector storage.** Production ran `createInMemoryVectorStore()` — memory would evaporate on restart, not be shared across instances, and `/forget` erasure would not be real (Inv 5). | **OPEN — PR #145** |
| B2 | **Encryption-at-rest for special-category facts** (Inv 9). Art-9 payloads were stored in plaintext. | **OPEN — in review** |
| B3 | **Memory-live implies enforced widget auth.** `WIDGET_AUTH_REQUIRED` defaults false; in that window `/consent` and the destructive `/forget` are callable unauthenticated. | **OPEN — in review** |
| B4 | **Retention actually enforced** (Inv 4, "expiry is enforced, not aspirational"). `sweepExpired` had no production caller: with durable storage, expired facts are hidden on read but never deleted. | **OPEN — in review** |
| B5 | **Prod audit sink is the immutable, hash-chained log** — not `InMemoryRuntimeStore`. `consent.record`, `write.*`, `recall`, `ttl_renew`, `ttl_sweep`, and `erase.subject` must all be durably recorded. Verify against the deployed configuration, not the default. | **OPEN — verify at deploy** |
| B6 | **Erasure completeness re-confirmed against the real adapter.** Inv 5 is adapter-dependent; only the in-memory oracle and pglite are proven today. Re-run the erasure proof against the actual cloud store. | **OPEN** |
| B7 | **Consent write/read bar reconciled.** `decideMemoryWrite` allows *ordinary* US writes on `"unknown"` (opt-out regime) while recall requires literal `"in"`. Confirm this asymmetry is the intended product behaviour, or the system will persist ordinary facts it can never lawfully recall. | **OPEN — decision** |
| B8 | **Encryption key provisioned** in the secrets port for every serving tenant. Without it, special-category writes are refused (fail-closed by design) — consented health facts would silently not be stored. | **OPEN — deploy** |
| B9 | **FAIR-1 fairness floor is non-vacuous.** The graders measured `personaPriceInvariance` on a brain that could not see persona signals, so every candidate scored a perfect 1.0. Fixed + regression-locked. | **MET — PR #144** |
| B10 | **Kill switch halts memory.** A kill-switched turn must not write memory. | **MET — #139** |
| B11 | **Shopper controls shipped**: consent capture, manage panel, and "forget everything" (erasure + anonId reset). | **MET — #142, #143** |

## C. Residual risks to ACCEPT explicitly

These are known, bounded, and not planned to be fixed before go-live. The named owner must accept them in
writing — silence is not acceptance.

| # | Residual | Why it is bounded |
|---|---|---|
| C1 | **`anonId` is a bearer capability within a tenant.** Anyone holding a shopper's `anonId` can record consent for that subject and, via `/forget`, **delete** their memory. | 128-bit CSPRNG (not enumerable), per-tenant, rate-limited, kill-guarded. Blast radius is the victim's own preferences; no read access, no cross-tenant reach, orders/account untouched. **DELETE is the most impactful case** and is why this needs explicit sign-off. |
| C2 | **No subject-scoped auth.** Widget auth binds the *tenant*, not the shopper — `anonId` is not bound to a verified principal. | Consistent with the existing `/chat` memory-subject model; tightening it is tracked, not blocking. |
| C3 | **`query` is a brute-force namespace scan, not ANN.** | Embeddings were dropped in scope (FAST-V1); the only consumer uses the empty-text list-all idiom. Documented in-adapter. |
| C4 | **Free-text willingness-to-pay is prompt-governed, not structural.** The *disposition* WTP path is structurally blocked (no `inferred` provenance); a WTP claim inside free-text fact content is caught by the distiller prompt + eval, not a classifier. | Contained today by the read-time consent gate; confirm the distiller eval covers it. |
| C5 | **Merchant per-store disable toggle and the Invariant-11 sensitivity-policy authorship/review process** are ADR-0015 open items, not built. | Tenant policy may only *narrow* what is remembered; absence means the conservative default applies. |

## D. The flip itself (human, in order)

1. Confirm every **A** item is closed and recorded in ADR-0015 — not merely done, but *written down*.
2. Confirm every **B** item is MET and verified against the deployed configuration.
3. Sign off the **C** residuals explicitly, by name.
4. Set ADR-0015 Status → **Accepted**, recording owner + security + legal sign-offs.
5. Flip `MEMORY_ADR_ACCEPTED` to `true` (`packages/widget-memory/src/flag.ts`).
6. Set `MEMORY_ENABLED=true` and `WIDGET_AUTH_REQUIRED=true` in the target environment, with the
   encryption key provisioned.
7. Ship progressively (canary → full) per CLAUDE.md §3.2, watching the audit log and the kill switch.
   **Prod is never auto-deployed.**

**Rollback:** the kill switch halts memory writes immediately at any scope. Reverting the flag const
returns the system to fully inert. Neither undoes data already written — erasure (`/forget`, `erase.subject`)
is the data-removal path, so verify B5/B6 *before* the first real write, not after.
