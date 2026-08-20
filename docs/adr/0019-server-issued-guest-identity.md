# ADR-0019: Server-issued guest identity (signed guest token) — security-cleared + owner-accepted (Revision 2); ONE gate left (legal)

> ## ⚠️ UPDATE 2026-08-20 (reconciliation — authoritative over the historical banners below)
>
> Two facts stated as present tense throughout this file are now STALE:
> - **`MEMORY_ADR_ACCEPTED` is now `true`** (`widget-memory/src/flag.ts:18`), flipped 2026-08-17 (ADR-0015
>   "Accepted for internal staging"); memory is ENABLED on the staging service for internal users, tenant
>   `palup-skincare-jason`. Every "the const is `false` / nothing has ever been written / the window closes
>   when flipped" statement below is historical — **the window has closed** (still OFF in production).
> - **Task 10 (the carry-over) now HAS a gated production caller** — `POST /memory/merge` calls
>   `mergeGuestIntoAccount` (`widget-backend/src/server.ts:2679`, #334). It is gated (404s only while memory
>   is dark — which it is NOT on staging; requires a verified shopper token + a verified signed guest token +
>   both consent tiers + a client-asserted `healthDisclosed`; the widget carry-over prompt is still off,
>   `CARRY_OVER_PROMPT_ENABLED=false`). **This does not by itself resolve the legal gate.**
>
> **⛔ GOVERNANCE FLAG (security-reviewer + owner, do NOT self-resolve):** ADR-0015's 2026-08-17 acceptance and
> `MEMORY-GO-LIVE-CHECKLIST.md` A4 both state that the staging security acceptance holds *because*
> `mergeGuestIntoAccount` has **no production caller**, and that **"if task 10 is ever wired, this acceptance
> is VOID and the verdict reverts to BLOCK."** A gated caller is now wired (#334) while memory is live on
> staging. Whether the #334 gating means the VOID trigger is or is not met is a `security-reviewer` + owner
> call — it must be adjudicated, not assumed benign. See the matching flags in ADR-0015 and the go-live checklist A4.
>
> ## Security gate CLEARED, owner re-accepted. ONE human gate remains (legal). Tasks 1–9 BUILT (2026-08-17); task 10 (carry-over) NOT built.
>
> **UPDATE 2026-08-17 (reconciliation).** The "Nothing built" language throughout this file is STALE. Tasks
> 1–9 shipped per-task to `main`: #224 (task 1, token port), #227 (task 3, `POST /widget/guest`), #228
> (tasks 4+9, verified-token subject + drop client-`anonId`), #230 (task 5, revocation). **Task 10 — the
> B12(b) Art-9 carry-over — is NOT built** (`mergeGuestIntoAccount` has no production caller) and stays gated
> on the legal question below (R2-2, Q19). `MEMORY_ADR_ACCEPTED` remains `false`. Open question for the
> owner + `security-reviewer` to resolve: confirm that tasks 1–9's build was authorized under this ADR's
> "tasks 1–9 cleared to build" clearance and that each shipped under its own §4.4 review — the header having
> read "Nothing built" while the code shipped is the drift this update closes.
>
> **CURRENT STATE (read this first).** Revision 2 (at the bottom of this file) is:
> - **security-cleared** — three `security-reviewer` passes: BLOCK (6 findings) → BLOCK (B1) → **PASS on
>   B1, 2026-08-06** (the §4.4 gate for the design);
> - **owner-accepted** — jason.hsu@framy.co re-accepted the corrected design 2026-08-06, superseding the
>   pre-BLOCK acceptance the reviews invalidated.
>
> **ONE gate remains, and it is not the owner's to give:** **legal** on R2-2's both-sides Art-9 rule —
> whether "both subjects opted in" is a sufficient lawful basis to carry special-category (health) data
> between subjects at all. Outside the reviewer's competence and the owner's. Brief for counsel:
> `docs/legal/memory-open-questions-for-counsel.md` **Q19**.
>
> **Tasks 1–9 of Revision 2's list are cleared to build; task 10 (the carry-over) is gated only on that
> legal sign-off.** Every task's eventual CODE gets its own §4.4 review, the named build-time conditions
> bind, and a named human still merges the governance-touching PRs. **Tasks 1–9 are now BUILT (2026-08-17,
> see the update at the top); task 10 is not.** `MEMORY_ADR_ACCEPTED`
> is `false`.
>
> The historical record of all three reviews follows — kept so the trail draft → block → correction →
> re-block → correction → PASS stays legible, and because the design took three passes to clear a disclosure
> the author kept re-introducing. Sequence: design → owner accepted → reviewed → BLOCK → Revision 2 →
> re-reviewed → BLOCK on B1 → B1 remediated → **third review → PASS on B1.**

- **Status: SECURITY-CLEARED + OWNER-ACCEPTED (Revision 2, 2026-08-06); PENDING legal only.** The security
  block is lifted and the named owner has re-accepted the corrected design; the single remaining gate is
  legal (R2-2, Q19). The **superseded** *Accepted by the named owner, 2026-08-06 (pre-BLOCK)* — that first
  acceptance stands as a matter of record but **was not a licence to build**, because F-1 and F-8 below
  show it was given on the strength of two claims in this document that are wrong in the direction that
  matters. The re-acceptance above is on the corrected text, after the reviews. The **direction** — replace the client-minted `anonId` with a **server-generated** id delivered in
  a **PalUp-signed guest token**, and derive the guest subject from the *verified claim* — survives review.
  The **specification does not**.
- This record **enables and builds nothing.** With the security gate cleared and the owner re-accepted,
  tasks 1–9 are cleared to build; task 10 is held only by the legal gate (Q19). No task authorises itself,
  and each task's code gets its own §4.4 review.
- **CORRECTION (F-4) — the shared-secret justification in the earlier draft was factually wrong.** It said
  this "reuses `WIDGET_TOKEN_SECRET` via the `typ`-claim separation that `shopper-token-identity.ts` already
  justifies over per-token-type secrets". **No such precedent exists.** Shopper tokens use a *separate*
  secret (`SHOPPER_TOKEN_SECRET`, `server.ts:374,601`) **in addition to** `typ` separation, alongside
  `WIDGET_TOKEN_SECRET` (`server.ts:581`); `token-codec.ts:1-6` justifies sharing the **codec**, never the
  key. Verified independently. The consequence is the opposite of what the draft claimed: one key compromise
  would yield merchant-tenant impersonation **and** forgeable guest tokens for any `aid` — i.e. squatting
  restored, the exact failure this design asserts is structurally impossible.
- **This REVERSES a recorded named-owner decision.** `MEMORY-GO-LIVE-CHECKLIST.md` C1 —
  "`anonId` is a bearer capability" — was **ACCEPTED AS IS** on 2026-08-04, and that acceptance is cited
  there as load-bearing for **C8, C10 and C14** and as the reason **B12(a)** was withdrawn. Reopening it is
  the whole point of this ADR, and the owner approved doing so on **2026-08-06**.
- **Owner (named):** jason.hsu@framy.co. **Plane:** run-time (shopper identity for cross-visit memory).
- **Governance-touching** (customer data + the identity that gates it). `security-reviewer` required.
- ~~**Depends on nothing new being provisioned:** reuses `WIDGET_TOKEN_SECRET` … via the `typ`-claim
  separation that `shopper-token-identity.ts` already justifies over per-token-type secrets. No new Secret
  Manager entry, and therefore no repeat of the missing-IAM-grant deploy failure that B5 hit.~~
  **STRUCK — F-4: the precedent is imaginary (see the correction above).** An open owner decision replaces
  it: provision a separate `GUEST_TOKEN_SECRET`, or knowingly accept a widened blast radius plus
  rotation-equals-data-loss. The extra Secret Manager entry does reintroduce the missing-IAM-grant
  operational risk — that is a **cost to weigh, not an argument** for sharing the key.
- **Deferred, deliberately:** **C14** (an authenticated opt-out not governing that browser's signed-out
  turns) becomes *fixable* under this design but is **NOT fixed here** — see *Deferred* below.

## Context

### The immediate blocker

`mergeGuestIntoAccount` has existed and been tested since ADR-0015 with **no production caller**, so a
shopper's guest-era facts are stranded the moment they sign in (checklist **B12(b)**). On 2026-08-06 that
caller was built and reverted the same day, because it fails a protected security test by construction:

> `packages/widget-backend/test/subject-scoped-memory-auth.test.ts` → **"THE ATTACK (recall)"**: a shopper
> holding a **valid** shopper token who supplies a **victim's** `anonId` must never cause the victim's
> namespace to be read.

Migrating requires reading the namespace the client just named. No amount of care in the merge changes that
— **F1 is the binding constraint, and it is structural.**

Copy-not-move (shipped separately) removes the *destruction* half of the old vector and is a real
improvement, but it is **not sufficient**: an attacker acting as themselves still ends up with a durable
copy of a victim's health facts inside their own account.

### The reasoning error this ADR corrects

An earlier revision of the checklist's B12 row dismissed a server-issued credential as buying
*"principle, not protection"*, on the grounds that the credential would live in the same partitioned
iframe `localStorage` the `anonId` already occupies and travel on the same calls — so the acquisition
requirement (device access) is unchanged. **That is true and it is the wrong test.**

It judges the credential on **theft resistance**, where it genuinely adds little. The property that
matters is **claim verification**: whether the server can establish that the presented guest id *belongs
to this caller* rather than merely that it is well-formed (`validateAnonId` checks charset and length and
nothing else). F1's attack is exactly *"supply a string you learned"* — and a signature defeats exactly
that, while leaving the device-access residual C1 already accepts by name.

This is also the industry pattern, arrived at independently: Firebase anonymous authentication issues a
**real, server-verifiable** anonymous identity, and `linkWithCredential()` upgrades it while **preserving
the UID** — so there is no data migration to attack. The generalisation is *don't migrate data, make the
anonymous identity authenticated*, which is what "a server-known association" in B12's own rule means.

### Why now, and why this window closes

**Nothing has to be migrated.** `MEMORY_ADR_ACCEPTED` is `false` (`widget-memory/src/flag.ts`) and
`MEMORY_ENABLED` is set in no environment, so **no fact has ever been written anywhere**. Client-minted
`anonId`s carry no data today.

Do this *before* the flip and compatibility is free. Do it *after* and every guest in the field holds facts
under an id they can no longer prove, recoverable only by trusting the client claim this ADR exists to
remove. **The window closes when `MEMORY_ADR_ACCEPTED` is flipped.**

### Why the two previous attempts failed, and why this is not a third

Both withdrawn branches built a **persistent server-side link table** (`guest-link-store.ts`) mapping
`anonId → accountId`, and both failed on **consent resolution**, not on migration:

- `feat/b12-guest-account-link` — immutable, first-writer-wins ⇒ **squatting**: a third party binds a
  victim's `anonId` to their own account first, denying the victim indefinitely with no non-destructive
  escape.
- `feat/c15-revocable-link` @ `d654c66` — revocable, last-verified-writer-wins ⇒ a **permissive-direction
  capability**, proven by execution: re-pointing a victim's link defeats their recorded opt-out on
  signed-out turns.

This ADR builds **no link table and records no association.** Both failure modes require an attacker to
name a *victim's* `anonId`; here the id is **server-generated and never client-proposed**, so squatting is
impossible by construction rather than detected after the fact. The carry-over is a one-shot operation
between two identities the server has verified in the same request — there is nothing persistent to
re-point.

## Decision

Six pieces. Each is additive; the guest identity is inert until the widget presents a token.

1. **`mintGuestToken` / `createGuestTokenIdentity`** in `packages/platform-ports`, mirroring
   `shopper-token-identity.ts` exactly: HMAC-SHA256 + base64url over `{typ:"guest", aid:<anonId>, exp}`
   — **F-5: plus a mandatory `tid` (tenant) claim, which this draft omitted.** Both existing token types are
   tenant-bound and cross-checked (`server.ts:640`); a guest token carrying no `tid` is valid at EVERY
   tenant, so one subject id would key `A::aid` and `B::aid`, breaking the per-tenant property ADR-0015
   Inv 8 asserts and re-identifying one browser across merchants via the unhashed id in
   `subject-index.ts:18`. Verification must reject a `tid` that differs from the verified merchant principal.
   Then:
   `constantTimeEqual` signature check, **anonymous on ANY failure** (absent/unconfigured secret, tampered
   signature, wrong `typ`, malformed claims, expiry) and never throwing. `typ:"guest"` gives token-type
   separation, so a widget or shopper token can never verify as a guest principal and vice versa.
2. **The id is generated SERVER-SIDE**, by the already-present but unused `generateGuestId`
   (`widget-memory/src/identity.ts` — 128 bits of `randomBytes`, base32, inside `validateAnonId`'s bound).
   **The mint endpoint MUST NOT accept a client-proposed id.** This single rule is what makes squatting
   structurally impossible and is the property `security-reviewer` should attack first.
3. **⚠️ F-6 + F-7 both land here — reconsider the endpoint.** `GET /widget/token` sets no `Cache-Control`
   (`server.ts:857-884`), which is safe *only because* its response is identical for every visitor of a
   merchant. Putting a **per-visitor secret** on it means any shared cache — browser, corporate proxy, or a
   CDN anyone would reasonably front a public widget with — hands **one guest identity to many shoppers**,
   with no attacker involved. At minimum this needs `Cache-Control: no-store`; better, mint on a separate
   POST, which also decouples it from the 401 re-mint in F-3. Separately (F-7), minting at boot issues a
   durable identifier to **every visitor of every merchant, pre-consent, for a feature that is off
   everywhere** — today nothing mints until `/chat` confirms `memoryEnabled` (`index.html:328-345,560`).
   Keep the mint conditional on the tenant's memory posture, or do not persist it client-side until memory
   is live. The original text follows.
   **Minted on the existing `GET /widget/token` call**, which the widget already makes at boot — no new
   endpoint, no extra round-trip. It stays **unauthenticated**, which is correct: creating a *fresh*
   anonymous identity is an unprivileged act (as it is in Firebase anonymous sign-in). Already rate-limited
   per IP (`RL_IP`/`RL_WINDOW`); note that limiter is **fail-open** by design, so minting must remain cheap
   and side-effect-free.
4. **Sliding TTL aligned to retention.** Re-mint when the token is within a threshold of `exp`, mirroring
   the sliding 30-day fact retention (`ORDINARY_TTL_DAYS`/`SPECIAL_TTL_DAYS`, re-stamped from last
   activity per ADR-0015's 2026-08-04 amendment). ~~A token that does expire corresponds to facts that have
   also expired, so no data is ever stranded behind a dead credential.~~
   **⛔ UNDERSPECIFIED — F-3 blocks this piece.** The struck sentence is unproven: token slide and fact
   re-stamping fire on *different events* (a page load vs a chat turn), and client storage eviction is
   independent of both. Worse, this piece and Invariant 3 **contradict each other** — "every mint produces a
   fresh id" cannot coexist with "a slide preserves the same `aid`" unless a distinct renewal path exists,
   and none is defined here. Concretely, the widget re-fetches `/widget/token` on any `/chat` 401
   (`index.html:839`), which under Invariant 3 silently issues a NEW identity and orphans the shopper's
   memory. **Before task 1 this must specify a renewal path that takes the TOKEN (never a raw id), verifies
   signature and `typ`, re-issues the same `aid`, and REFUSES an expired token** — without that last rule the
   TTL is decorative and a stolen guest token is renewable forever.
5. **ONE derivation helper, used by `/chat`, `/consent` and `/forget`.** C13 already records two
   independent shopper-principal derivations as a drift risk; a third derivation would make that worse.
   **F-12 corrects the reasoning:** a shared *guest* helper does not unify C13's two *shopper* derivations
   (`server.ts:1605-1606` inline vs `verifiedShopperIdFor`, `server.ts:629-642`) — and after this change a
   drift between them causes a **cross-subject copy** rather than a narrow inconsistency, so **C13 must be
   closed before the carry-over ships**, not treated as a follow-up.
   Consequently **`signals.anonId` ceases to be an input** — the guest subject becomes server-derived like
   `tenantId` and `shopperId`, which is what `signals.ts`'s own trust-boundary doctrine has always said
   should be true of anything that grants treatment.
6. **⛔ F-1 + F-2 BLOCK THIS PIECE — do not build it as written.** Firing merely because two credentials
   co-exist on one request is the defect: on a shared browser, person A's guest token is legitimately present
   when person B signs in, so A's facts — including Art-9 health facts — are copied durably into B's account
   and recalled into B's prompts. And `merge.ts:59-61,117` gates special-category migration on the
   **destination account's** Consent 2, never the source subject's, so B's own consent authorises migrating
   A's health data. Before this ships: pick a mitigation (an explicit one-time shopper confirmation per guest
   id; or bind a guest identity to the first shopper it is seen with and refuse any other; or drop the
   carry-over and ship identity-only), gate on **both** subjects' consent, and get **legal** on the
   cross-person Art-9 case. The original text follows.
   **Only then, B12(b):** the guest→account carry-over fires when a verified **guest** token and a
   verified **shopper** token are both present on the same request. F1 holds, because the server is no
   longer trusting a client-named namespace. The merge stays a **COPY** (see `merge.ts`'s header) — the
   guest namespace survives so signing out does not wipe guest memory, and the scheduled retention sweep
   (checklist B4) reclaims it on the ordinary TTL.

## What this closes

| row | today | after |
|---|---|---|
| **C1** — `anonId` is a bearer capability | ACCEPTED AS IS; named as the root cause of the three below | **Mostly closed.** Residual: a *stolen token* — device access, which C1 already accepts by name |
| **C8** — cross-subject consent oracle / denial primitive | Open: `lookupConsent` runs against a **caller-supplied** `anonId` | **NARROWED, not closed (corrected per F-8).** A caller cannot *name* another subject, but can still *present* one it holds — stolen token, or a shared browser where the credential is legitimately there. The residual is C1's device access |
| **C9** — that cross-subject read is unaudited | Open | **NOT moot (corrected per F-8).** The carry-over is itself a cross-subject read, and it is unaudited when nothing moves (`merge.ts:105,122`) and records only the *source* ref when it does (`merge.ts:129-132`) — so C9's complaint survives verbatim |
| **C10** — third party durably denies a victim's memory | Open: `POST /consent` for a victim's `anonId` | **NARROWED, not closed (corrected per F-8).** Naming a victim's subject becomes impossible; presenting a held credential does not |
| **B12(b)** — guest-era fact stranding | Open, blocked on F1 | **Unblocked** |
| **C2** — subject-scoped auth | Closed only for verified turns | **Strengthened** — the guest side is verified too |

## What this does NOT close

Stated explicitly so a signer is not accepting more than is true:

- **Device access.** A stolen token works. Unavoidable, and exactly the residual C1 accepts.
- **The shared-browser case**, which C1 identifies as the *dominant* threat. Server-issued ids do not help:
  on a shared device the credential is legitimately present.
  **CORRECTED per F-1 — the earlier claim here was wrong.** It said "what limits the damage there is
  copy-not-move — the previous person never loses their facts". Copy-not-move addresses **LOSS**; the harm on
  a shared browser is **DISCLOSURE** — one person's facts, including Art-9 health facts, ending up durably
  inside another person's account and recalled into their prompts. Nothing in this design as specified limits
  that, which is why F-1 blocks it. A mitigation must be chosen and written in before task 1: an explicit
  one-time shopper confirmation per guest id, or binding a guest identity to the first shopper it is seen
  with and refusing carry-over for any other, or dropping the carry-over and shipping identity-only.
- **XSS in our own widget** could read the token from `localStorage`. A **partitioned `HttpOnly` cookie**
  (CHIPS, Baseline "newly available" since December 2025) would place it out of JavaScript's reach
  entirely, and is the natural next hardening step. **Deliberately out of scope for v1:** older browsers
  need a fallback, and the fallback would become the weak path — a guarantee is only as strong as its
  weakest branch.
- **C7** — a stale guest opt-out overriding a later authenticated opt-in involves the shopper's **own**
  record, not an attacker's. Untouched.
- **C14** — see *Deferred*.

## Invariants (tests must enforce these before any write path ships)

1. A guest token minted for id *A* **never** yields a principal for id *B* (signature + `aid` binding).
2. A **widget** or **shopper** token presented as a guest token yields `anonymous` (`typ` separation), and
   the mirror-image holds.
3. The mint endpoint **never** returns a token for a client-supplied id — every mint produces a fresh
   `generateGuestId` value. Attempting to propose one is ignored, not honoured.
4. With no guest token, the guest subject is **absent**, and no namespace is read or written — never a
   fallback to `signals.anonId`.
5. **F1 preserved and extended:** a verified shopper presenting a victim's `anonId` *or* a victim's guest
   token they do not hold causes no read of the victim's namespace. The existing
   `subject-scoped-memory-auth.test.ts` attack must stay green throughout.
6. Expiry is honoured; a re-mint (slide) preserves the **same** `aid`, so a slid token never orphans facts.
7. The B12(b) carry-over fires **only** with both tokens verified, copies (never deletes), is idempotent by
   content, and audits only when something moved.

## Alternatives considered

- **Keep the client-minted id and trust the claim** (status quo + a naive caller). Built and reverted
  2026-08-06: fails F1 by construction. This is the withdrawn data-theft vector.
- **Persistent `anonId → accountId` link table.** Built twice, withdrawn twice — squatting when immutable,
  a permissive capability when revocable (`d654c66`, proven by execution). This ADR records no association
  at all.
- **Partitioned `HttpOnly` cookie instead of a bearer token.** Strictly stronger against widget XSS; needs
  a long-tail fallback that reintroduces the weakness. Deferred as follow-up hardening, not rejected.
- **Do nothing; accept fact stranding.** Rejected by the owner on 2026-08-06: guest facts must follow the
  shopper, to minimise friction.

## Deferred

**C14** — an authenticated opt-out does not govern that same browser's *signed-out* turns. Its row records
that fixing it needs "a server-recorded association keyed on a client-supplied `anonId`, and nothing in
this system proves an `anonId` belongs to its caller (C1)". Under this ADR that association becomes
*recordable safely*, because the guest side is verified and squatting is impossible. **It is still not
fixed here**, by explicit owner decision (2026-08-06): bundling a behaviour change into a security fix
makes both harder to review, and C14 is currently ACCEPTED BY DESIGN rather than pending. It should be
reconsidered on its own once this lands.

## Consequences

- **Production code is small and additive**: one new `platform-ports` module, the mint on `/widget/token`,
  one derivation helper, three call sites, and the widget storing/presenting a token instead of a bare id.
- **Test churn is the real cost**: **17 `widget-backend` test files** POST a raw `anonId` and will need a
  minted guest token, plus `e2e/tests/widget.spec.ts`. The **9 `widget-memory`** files call functions
  directly with an id string and are unaffected — the token gates *server entry points*, not internals.
- **`/consent` and `/forget` contracts change.** Both sit deliberately outside the memory double gate, so
  this is a genuine API change; no legitimate caller has a namespace to act on yet, which is why it is
  cheap now.
- **Any existing consent records** keyed to client-minted ids would be orphaned by the switch. An orphaned
  record fails to the fail-closed default, which the US opt-out regime reads as *allowed* — so this must be
  done while no meaningful consent record exists, i.e. before the flip.
- **The `anonId` remains a bearer credential in the browser.** This ADR changes *who can assert it*, not
  *where it lives*. Anyone reading this expecting the credential to be unstealable will be disappointed;
  see *What this does NOT close*.

## Task list (ATDD-ready, once Accepted)

1. `platform-ports`: `mintGuestToken` + `createGuestTokenIdentity` + contract tests (invariants 1, 2, 6).
2. `/widget/token`: mint a fresh server-generated guest id alongside the merchant token (invariant 3).
3. One shared guest-subject derivation helper; route `/chat`, `/consent`, `/forget` through it; stop
   reading `signals.anonId` (invariants 4, 5).
4. Widget: store `{anonId, guestToken}`, present the token, re-mint on slide and after forget-me rotation.
5. Migrate the 17 server-level test files + the e2e spec to minted tokens.
6. **Only then** the B12(b) carry-over caller (invariant 7), with F1's attack test green throughout.
7. Update `MEMORY-GO-LIVE-CHECKLIST.md` C1/C8/C9/C10/B12 and ADR-0015's residual set to match what
   actually shipped — not what this ADR proposed.

## Security review outcome — BLOCK (2026-08-06)

Attacked in the order this ADR nominated. **Invariant 3 held** against the existing `/widget/token` handler
(`server.ts:878-883` derives the claim server-side; `JSON.stringify` leaves no claim-injection path) — but
fails at the renewal path (F-3). **Invariant 5's test stays green, its property does not** (F-1).

### Blockers — implementation may not begin

| # | Sev | Finding |
|---|---|---|
| **F-1** | HIGH | **The carry-over discloses one person's facts to another.** On the shared/kiosk browser C1 calls the *dominant* threat: A chats as guest, B signs in on the same browser, A's guest token is legitimately present, and the carry-over fires because two credentials co-exist on one request — copying A's Art-9 facts durably into B's account, recalled into B's prompts, surviving A's forget-me. **This ADR's answer — "copy-not-move limits the damage" — addresses LOSS. The harm is DISCLOSURE.** Copy-not-move does nothing about it. Also a cross-subject memory-poisoning path. |
| **F-2** | HIGH | **Art-9 migration is gated on the DESTINATION account's consent.** `merge.ts:59-61,117` reads `consent2` as the *account's*; the source subject's own `memorySpecial` is never consulted. So B grants themselves health-memory consent and thereby authorises migration of A's health facts. Enforces Inv 9 against the wrong record even same-person. **Needs legal.** |
| **F-3** | HIGH | **Invariants 3 and 6 contradict each other, and the renewal path is unspecified.** "Every mint produces a fresh id" vs "a slide preserves the same `aid`" cannot both hold without a distinct signature-verifying renewal path, which this ADR never defines. Concretely: the widget re-fetches `/widget/token` on any `/chat` 401 (`index.html:839`), so under Invariant 3 that silently issues a NEW identity and orphans the shopper's memory — unreachable and un-erasable by them. Decision 4's "no data is ever stranded behind a dead credential" is unproven: token slide and fact re-stamping are driven by different events. |
| **F-4** | HIGH | **The shared-secret justification cited a precedent that does not exist** — see the Status correction. Also makes rotating `widget-token-secret` an irreversible customer-data-loss event, since the `aid` is recoverable only from the token. |
| **F-5** | MED-HIGH | **No `tid` claim, so no cross-shop check is possible.** Both existing token types are tenant-bound and cross-checked (`server.ts:640`). A guest token carrying only `{typ,aid,exp}` is valid at *every* tenant, so one subject id keys `A::aid` and `B::aid` — breaking the per-tenant property ADR-0015 Inv 8 asserts, and re-identifying one browser across merchants via the unhashed id in `subject-index.ts:18`. |
| **F-6** | MED | **A per-visitor credential placed on a cacheable GET.** `GET /widget/token` sets no `Cache-Control` (`server.ts:857-884`) — safe today *because* the response is identical for every visitor of a merchant. Adding a per-visitor secret means any shared cache hands **one guest identity to many shoppers**. No attacker required. |

### Conditions to satisfy during implementation

**F-7** minting a durable identifier at boot, pre-consent, while memory is off everywhere (today nothing
mints until `/chat` confirms `memoryEnabled`) · **F-8** "Closed" overstates C8/C10 — the honest wording is
"narrowed to the device-access residual C1 accepts" — and **C9 is not moot**: the carry-over is itself an
unaudited cross-subject read (`merge.ts:105,122` return early with no audit) and when it does audit it
records only the *source* ref (`merge.ts:129-132`), so an operator cannot reconstruct whose facts went where
· **F-9** the merge's recorded reversal path in `audit.ts:51` still says the guest namespace is DELETED,
which copy-not-move made false · **F-10** after a carry-over the same facts exist twice, so a signed-out
`/forget` erases one copy while the widget still says "I've cleared what I remembered" — the C6 class of UI
dishonesty, re-created · **F-11** no revocation of an issued guest token (no `jti`, no server state at
verify); forget-me rotates the client id while the old token stays valid. A restrictive-only
`aid → revokedAt` record would be safe — it is keyed on a *server-minted* id, so it reintroduces neither
withdrawn failure mode · **F-12** C13's two shopper-principal derivations are untouched and their blast
radius grows: a drift now causes a cross-subject copy · **F-13** make Invariant 4 unconditional (no flag —
a re-enable path would be a squatting re-entry), stop carrying the raw `aid` alongside the token, and still
run it through `validateAnonId` before it keys a namespace · **F-14** keep the mint side-effect-free — **no
store write at mint time**, or the fail-open limiter becomes an unauthenticated write amplifier.

### Verified safe, so the block is scoped rather than blanket

No postMessage identity-fixation path (`index.html:615-617`, exact-origin checked) · no credential-in-logs
path (Fastify logging off `server.ts:768`; audit refs keyed) · the design genuinely builds **no link table**,
and neither withdrawn branch's failure mode reappears as a persistent table · the compatibility-free window
claim is true.

### What the review did NOT verify

No build and no test were run — every finding is from reading source. The two withdrawn branches were
confirmed to exist but not read; their withdrawal rationale was taken from the checklist. Browser
storage-partitioning/eviction behaviour (F-3's stranding analysis) and the CHIPS Baseline claim were not
checked against a primary source.

## Governance sign-off

- [x] **Named owner** (jason.hsu@framy.co) accepted reversing C1's 2026-08-04 acceptance — **2026-08-06.**
      **⚠️ SUPERSEDED IN EFFECT (this line is the FIRST review's record):** F-1 and F-8 showed that
      acceptance was given on two wrong claims, so it did not carry to the corrected design and re-acceptance
      was required. **RESOLVED: the owner re-accepted Revision 2 on 2026-08-06** after the third-review PASS
      — see the current *Sign-offs still required* block, which is authoritative over this historical line.
- [ ] **`security-reviewer`** — **RUN 2026-08-06: BLOCK.** Six design blockers, eight conditions; see above.
      Not a pass, and not waivable by the owner: the reviewer is the gate CLAUDE.md §4.4 requires for auth
      and customer data.
- [x] Confirmed **before** `MEMORY_ADR_ACCEPTED` is flipped — **VERIFIED 2026-08-06:** the const is `false`
      and `MEMORY_ENABLED` is set in no environment, so no fact has ever been written and the window is open.
- [ ] **LEGAL (new, from F-2)** — Art-9 data migrating on the destination account holder's consent. ADR-0015's
      special-category amendment was legally ratified; this changes its basis.
- [ ] **Owner decision (new, from F-4)** — whether to provision a separate `GUEST_TOKEN_SECRET` or accept a
      widened blast radius plus rotation-equals-data-loss. It cannot rest on the misread precedent.
- [ ] **Named human merger** for the resulting PRs (governance-touching: HITL boundary set + the C-row
      residual list), CLAUDE.md §4 step 7.

---

# Revision 2 — the corrected specification (2026-08-06)

**This section supersedes *Decision*, *Invariants* and *What this closes* above.** Those are kept verbatim,
with the review's annotations, so the trail from first draft → BLOCK → correction stays legible. Where they
disagree with this section, **this section wins**.

**Status of Revision 2: RE-REVIEWED 2026-08-06 → BLOCK on one finding (B1), now remediated in the R2-1 text
above, pending a THIRD review.** The token-identity foundation (R2-3..R2-8) passed: ten of twelve verifiable
findings fixed, F1 preserved. The block was a *new* self-inflicted disclosure in the R2-1 prompt — see
*Revision 2 — security review outcome* immediately below. The B1 remediation is applied above but **the
block is not cleared by the author's own fix**: it needs re-review, plus the still-unmet owner re-acceptance
and legal sign-off. See *Sign-offs still required*.

## The honest starting point

One finding changed how the rest of this design has to be written. **F-1 was not a detail; it was the design
answering the wrong question.** The first draft asked "can an attacker *name* someone else's namespace?" and
solved that. The threat C1 calls dominant is not naming — it is a **shared browser**, where the credential is
legitimately present and no attacker exists at all. So Revision 2 separates two cases that the first draft
conflated, and is explicit that only one of them is fixable:

- **The accidental case** — a family/kiosk device where person B signs in and would silently absorb person
  A's facts. Nobody is attacking. **This is the common case and Revision 2 fixes it.**
- **The deliberate case** — someone who has stolen a guest token and wants the victim's facts. **Revision 2
  does not fix this, and no mechanism in this design can.** It is exactly C1's accepted device-access
  residual. Saying so plainly is the point; the first draft implied copy-not-move handled it, which is what
  F-1 caught.

## R2-1 (fixes F-1) — the carry-over is shopper-authorised, never automatic

Two credentials co-existing on one request **is not authorisation**. The carry-over fires only after the
shopper answers a question they can answer from their own knowledge. **THE prompt string — the only one this
ADR specifies — is:**

> "Were you using this device before without signing in? If so, I can carry that session's preferences over
> to your account."

~~"Have you chatted with me on this device before, without signing in? I have some notes from then — want me
to keep them on your account?"~~ **STRUCK (B1, third-review finding): "I have some notes from then" asserts
A's notes EXIST — the same pre-authorisation disclosure the bullet below claims to have removed. The earlier
fix struck the count/health clause in the bullet but left this blockquote live, so the leak survived in the
one place an implementer would copy. This was the disclosure blind spot a fourth time; the whole point of
the corrected string is that it presupposes nothing about the other session's data.**

Deliberately designed:

- **RENDERED FROM CLIENT STATE ALONE — no server read of the other session's namespace.** The trigger is
  the presence of a guest token in *this browser's* own `localStorage` (`packages/widget/public/index.html`,
  `MEM_KEY`/`memState`), which proves only that "a signed-out session existed on this device", never that it
  holds facts, how many, or their class. **Build condition (do not defeat the fix):** the widget must NOT
  add a server precheck of the other namespace to decide whether to show the prompt — that would reintroduce
  exactly the read B1 removed and violate invariants 4/5. The corrected string says "preferences", not "N
  notes", precisely so it commits to nothing the client cannot know.
- **The prompt discloses NOTHING about the other session's data — corrected per Revision 2's review (B1).**
  ~~Only that notes exist, how many, and whether any are health-related.~~ **STRUCK: that was the F-1 mistake
  a third time.** The bullet suppressed the fact *list* on the principle "recall surfaces what is
  contextually relevant, an enumerated list is a deliberate dump" — and then disclosed the **count and a
  health-related flag**, which that same principle forbids. **Corrected rule:** the prompt asserts nothing
  about whether prior notes exist, how many, or their class. Default-NO. The both-sides consent gate (R2-2)
  still governs what actually carries over on an affirmative answer.
- **Accepted residual, stated not implicit:** the prompt is B-observable evidence that *someone* used the
  widget signed-out on this device. That leaks no fact, count, or class, and it is within C1's already-accepted
  device-access residual — the widget already persists a transcript and consent state in this browser's
  storage. Recorded here so a signer is not surprised by it.
- **The question is about the shopper's own history, not about the facts.** An honest B who has never used
  the widget signed-out answers "no" without ever seeing A's data.
- **Default is NO.** Silence, dismissal, a closed widget, or any unparseable answer means no carry-over. The
  facts stay in the guest namespace and expire on the ordinary TTL.
- **The answer is recorded** as a first-class consent-style artifact (actor, subject pair, timestamp,
  outcome), so an operator can reconstruct who authorised what.

## R2-2 (fixes F-2) — special-category needs consent on BOTH sides

`merge.ts` currently reads `consent2` as the **destination account's** (`merge.ts:59-61,117`), which let B's
own consent authorise migrating A's Art-9 data. Corrected rule:

> A special-category fact carries over **only if the SOURCE subject recorded `memorySpecial === "in"` AND the
> DESTINATION account records `memorySpecial === "in"`.** Either side unknown or out ⇒ the fact is dropped,
> never promoted.

Implementable as-is: `lookupConsent(store, {tenantId, anonId})`
(`state-postgres/src/runtime-consent-store.ts:137`) takes any subject, so both records are readable on the
same turn. `MergeCtx.consent2` becomes two fields so the asymmetry cannot be reintroduced by a caller passing
the wrong one. **Legal sign-off is still required** — R2-1 prevents the cross-person case rather than
consenting to it, but counsel must confirm that a both-sides rule is the right basis for Art-9 carry-over at
all.

**Owner direction, 2026-08-06 (routed to counsel as Q19, not yet a legal sign-off):** the transfer is to be
disclosed **up front, in the Consent-2 prompt** — *"Remember this health information across visits and add it
to your account if you later sign in"* — so guest consent (with that disclosure) is the proposed basis for
the carry-over. Structural consequence worth stating: because the disclosure lands at the guest's **own**
health-consent moment, the **R2-1 sign-in prompt stays disclosure-free and B1 is not reopened** — the
person who signs in never sees a health-specific prompt about a prior session. The build keeps R2-2's
account-side gate until counsel says otherwise (the stricter reading). The new Consent-2 clause is
health-consent copy, so it also needs A5 legal-copy approval before it ships. See Q19.

## R2-3 (fixes F-3) — MINT and RENEW are two different operations

The contradiction was treating one operation as both. Split them, and the invariants stop fighting:

| | MINT | RENEW |
|---|---|---|
| Input | nothing from the client | the **existing token** — never a raw id |
| Verifies | — | signature, `typ`, `tid`, **and expiry** |
| Output | a **fresh** `generateGuestId` | the **same** `aid`, new `exp` |
| Refuses | never | an expired, forged, wrong-`typ` or wrong-tenant token |

**RENEW must refuse an expired token.** Without that the TTL is decorative and a stolen guest token is
renewable forever. **The widget calls RENEW, not MINT, on a `/chat` 401** — the first draft's fatal detail,
since `index.html:839` re-fetches on 401 and MINT would have silently orphaned the shopper's memory.

The struck claim "a token that expires corresponds to facts that have also expired" is **withdrawn, not
re-argued**: slide and fact re-stamping fire on different events, and storage eviction is independent of
both. Consequence, stated rather than hidden: a shopper who loses their token **loses access to those facts**,
which then expire unread on the TTL. They are not erasable by that shopper in the meantime — the same
unnameable-namespace exposure `HITL-POLICY.md:258-261` already records.

## R2-4 (fixes F-4) — a separate `GUEST_TOKEN_SECRET`

No shared key. The imaginary precedent is struck above. A separate secret because sharing
`WIDGET_TOKEN_SECRET` would mean (i) one compromise yields merchant impersonation **and** forgeable guest
tokens for any `aid` — squatting restored, the exact failure this design claims to make impossible; and
(ii) rotating it, today a one-hour blip, would become **permanent loss of every guest's memory**, since the
`aid` is recoverable only from the token.

The cost is real and is accepted knowingly: one more Secret Manager entry, and one more chance to repeat
B5's missing-IAM-grant deploy failure. `DEPLOY.md` now documents that as a **three-step** procedure
(create → **grant `roles/secretmanager.secretAccessor` to the runtime SA** → set the repo variable), which is
precisely why this cost is now cheap to pay correctly.

## R2-5 (fixes F-5) — the token is tenant-bound

Claims become **`{typ:"guest", tid, aid, exp}`**. Verification rejects a token whose `tid` differs from the
verified merchant principal, mirroring the shopper token's own cross-shop check (`server.ts:640`). Without
`tid` one subject id would key `A::aid` and `B::aid`, breaking the per-tenant property ADR-0015 Inv 8 asserts
and allowing cross-merchant re-identification through the unhashed id in `subject-index.ts:18`.

## R2-6 (fixes F-6, F-7) — a POST on its own route, minted lazily

- **`POST /widget/guest`**, not the cacheable `GET /widget/token`. A per-visitor secret must never share a
  response with a per-tenant one that is identical for every visitor and therefore safely cacheable today.
  `Cache-Control: no-store` on the response regardless. This also decouples the credential from the 401
  re-fetch path (R2-3).
- **Minted lazily, not at boot.** Only when the tenant's memory posture is live, preserving today's
  behaviour where nothing mints until `/chat` reports `memoryEnabled` (`index.html:328-345,560`). Otherwise
  every visitor of every merchant would be issued a durable identifier, pre-consent, for a feature that is
  off everywhere — including in the EU, where ADR-0015 is consent-gated.
- **MINT performs no store write** (F-14): pure HMAC, no audit row, no subject-index row, no consent row.
  The per-IP limiter is fail-open (`rate-limit.ts:46-64`), so a write here would make it an unauthenticated
  write amplifier. The first write under a new subject is already audited, which is the right place.

## R2-7 (fixes F-11) — guest credentials are revocable

An `aid → revokedAt` record, consulted at verify. Written on forget-me, so rotating away from a credential
actually invalidates it instead of leaving a working copy in a thief's hands.

Why this is not a third link table: it is keyed on a **server-minted** id, so it cannot be squatted (you
cannot choose your `aid`, and you must hold the signed token to use it); and it moves in the **restrictive
direction only**, so it can never become the permissive capability proven on `feat/c15-revocable-link`
@ `d654c66`. It is written on an authenticated path, so it does not violate F-14's no-write-at-mint rule.

## R2-8 (fixes F-9, F-10, F-12, F-13) — the conditions

- **F-9:** `audit.ts:51`'s `merge` reversal path still says the guest namespace is DELETED. Copy-not-move
  made that false. Fix it **before** any carry-over ships, or the first one writes a false reversal path into
  an append-only log.
- **F-10:** after a carry-over the facts exist twice, so a signed-out `/forget` clears one copy while the
  widget says "I've cleared what I remembered" (`index.html:550`). Either erase both when both credentials
  are present, or narrow the copy. **Added to *what this does NOT close* below.**
- **F-12:** **C13 must close before the carry-over ships**, not as a follow-up. Its two shopper-principal
  derivations (`server.ts:1605-1606` vs `verifiedShopperIdFor`, `server.ts:629-642`) now gate a
  cross-subject copy, so a drift between them stops being a narrow inconsistency.
- **F-13:** Invariant 4 is unconditional — **no flag**, the client-minted path is removed outright, because a
  re-enable switch would be a squatting re-entry. Safe only inside the open window. The client stores the
  **token only**, never the raw `aid` alongside it; and after signature verification the `aid` still passes
  `validateAnonId` before it keys a namespace.

## Revised invariants

1. A guest token minted for `aid` A never yields a principal for `aid` B.
2. A widget or shopper token presented as a guest token yields `anonymous`, and the mirror holds. Separate
   secrets make this structural rather than claim-dependent (R2-4).
3. **MINT** never returns a token for a client-supplied id; every call produces a fresh `generateGuestId`.
4. With no guest token the guest subject is **absent** — no namespace read, no write, and **no fallback** to
   `signals.anonId`.
5. **F1 preserved:** a verified shopper cannot cause a namespace they do not hold a credential for to be read.
6. **RENEW** preserves `aid`, issues a new `exp`, and **refuses an expired token**.
7. A guest token is valid only at the tenant in its `tid` (R2-5).
8. A revoked `aid` verifies as `anonymous` (R2-7).
9. The carry-over requires a **recorded shopper authorisation** for that (`aid`, account) pair; absent it,
   nothing is read or copied (R2-1).
10. Special-category facts carry over only on **both** subjects' `memorySpecial === "in"` (R2-2).
11. MINT writes nothing to any store (F-14).

## Revised — what this closes

| row | after Revision 2 |
|---|---|
| **C1** | **Narrowed**, not closed. An `anonId` alone is useless; a *token* is required. Residual: device access — unchanged and still accepted |
| **C8** | **Narrowed.** A caller cannot *name* another subject; one whose token they hold, they can still present |
| **C9** | **Still open.** The carry-over is itself a cross-subject read. It must audit **both** subject refs and record the read even when nothing moves — neither is true of `merge.ts` today |
| **C10** | **Narrowed** on the same basis as C8 |
| **C2** | **Strengthened** — the guest side becomes verified too |
| **B12(b)** | **Unblocked**, gated on R2-1's authorisation |

## Revised — what this does NOT close

Device access · the **deliberate** stolen-token case · **C9** (see above) · **C7** · widget XSS reading the
token from `localStorage` (a partitioned `HttpOnly` cookie would fix it; deliberately out of scope because
its older-browser fallback becomes the weak path) · **F-10's double-copy erasure gap** · a shopper who loses
their token loses access to those facts until they expire (R2-3) · **backups** — Cloud SQL backup handling is
a deployment setting this ADR does not describe.

## Revised task list

1. `platform-ports`: `mintGuestToken` / `renewGuestToken` / `createGuestTokenIdentity` with `tid`, plus
   contract tests for invariants 1, 2, 3, 6, 7.
2. Provision `GUEST_TOKEN_SECRET` — three-step, per `DEPLOY.md`.
3. `POST /widget/guest` (no-store, lazy, no store write) + the RENEW path; widget calls RENEW on 401.
4. One shared guest-subject derivation helper; route `/chat`, `/consent`, `/forget` through it; drop
   `signals.anonId` outright (invariants 4, 5).
5. Revocation record + forget-me writes it (invariant 8).
6. **Close C13.**
7. Fix `audit.ts:51`'s false reversal path; make the merge audit both subject refs and record zero-move reads.
8. Widget: store the token only; the R2-1 authorisation prompt.
9. Migrate the 18 server-level test files + `e2e/tests/widget.spec.ts`.
10. **Only then** the carry-over, with both-sides consent (invariants 9, 10) and F1's attack test green
    throughout.

## Sign-offs still required

- [x] **`security-reviewer`** on Revision 2 — **CLEARED 2026-08-06.** Three passes: BLOCK (6) → BLOCK (B1) →
      **PASS on B1** after the prompt string itself was corrected (see *Revision 2 — third review* below).
      The build-time §4.4 gate for the DESIGN is satisfied. Each task's eventual CODE still gets its own
      review, and the named build-time conditions bind.
- [x] **Owner re-acceptance** — **GIVEN 2026-08-06 by jason.hsu@framy.co, on Revision 2 as security-cleared.**
      A fresh acceptance of the corrected design, distinct from the superseded 2026-08-06 pre-BLOCK one:
      covers reversing C1 and rewriting C8/C9/C10, the direction and specification of Revision 2, and the
      residuals in *what this does NOT close* (device access, C9, C7, F-10's double-copy erasure gap, a
      lost token losing access until expiry, backups, widget XSS). Does **not** cover the legal question
      below, and does not build anything.
- [ ] **Legal** — R2-2's both-sides Art-9 rule. Confirmed by the reviewer as out of their competence and
      still unmet. **Brief for counsel prepared 2026-08-06:** `docs/legal/memory-open-questions-for-counsel.md`
      **Q19**. This is the ONLY remaining gate on task 10.
- [ ] **Named human merger** for the implementation PRs (governance-touching).

---

## Revision 2 — security review outcome — BLOCK (2026-08-06)

Second `security-reviewer` pass, on Revision 2. **Verdict: BLOCK (scoped).** The token-identity foundation
— R2-3 MINT/RENEW split, R2-4 separate secret, R2-5 `tid`, R2-6 endpoint, R2-7 revocation, R2-8 conditions —
is design-sound and closed **ten of the twelve** code-level findings. **F1 is preserved.** The block is on
the load-bearing carry-over (R2-1 / task 10), which the task list already sequences last: tasks 1–9 are
design-approved and may proceed; **task 10 may not begin** until B1 is resolved and re-reviewed and legal +
owner re-acceptance land.

### B1 (HIGH, DESIGN) — the R2-1 prompt disclosed A's note count and health-status flag to B, pre-authorisation

The prompt was specified to show "how many [notes], and whether any are health-related". On a shared
browser that renders A's count and Art-9 status to B *before* B authorises anything and regardless of B's
answer — the leak is in showing the prompt, not in the answer, so default-NO does not help. Internally
inconsistent: R2-1 suppressed the fact *list* on the principle that recall never proactively dumps, then
disclosed the count + health flag, which that same principle forbids. **This is my error, the third variant
of the loss-vs-disclosure mistake in this ADR.** **Remediated above:** the prompt now asserts nothing about
A's data and asks only about the shopper's own session history. The remediation needs its own review — the
author's fix does not clear a security block.

### Original F-1 … F-14 under Revision 2 — reviewer's disposition

FIXED: **F-3** (MINT/RENEW split coherent; the `/chat` 401 refreshes only the *widget* token via
`index.html:839→252-256`, so the guest credential is untouched — no orphan), **F-4** (separate
`GUEST_TOKEN_SECRET`; separate shopper/widget secrets confirmed `server.ts:374,581,601`), **F-5** (`tid`,
cross-checked like `server.ts:640`), **F-6** (POST + `no-store`), **F-7** (lazy mint), **F-8** (wording now
matches code), **F-9** (dispositioned before carry-over), **F-11** (revocation is not a third link table —
server-minted key, restrictive-only), **F-12** (C13 sequenced before task 10), **F-13** (Invariant 4
unconditional). FIXED-design-LEGAL-open: **F-2** (both-sides rule implementable; `lookupConsent` reads any
subject). PARTIALLY FIXED: **F-1** (durable-copy harm fixed by the authorisation gate; B1 was the residual
leak, now remediated), **F-10** (acknowledged but under-weighted — fix the erasure-honesty message or erase
both before carry-over ships). F-14: property holds; **Invariant 11 wording is imprecise** — the fail-open
per-IP rate limiter does a bounded windowed counter write, so "writes nothing to any store" should read "no
per-subject store write".

### Implementation conditions the review named (bind during build, not blockers)

- **Revocation and erasure MUST key off the token-derived `aid`, never `body.anonId`.** Today `/consent`
  (`server.ts:1207-1208`) and `/forget` (`server.ts:1375-1376`) derive the guest subject from client-supplied
  `body.anonId`; task 4's "drop `signals.anonId`" must convert these, or revoking on a *named* `aid` becomes
  a C10 denial primitive.
- **Task 4 must also convert the `mergeAccountConsent` sub-path** (`server.ts:1636-1642`) — a second
  per-turn cross-subject consumer of `signals.anonId`, restrictive-direction so low severity, but a named
  landmine that would silently reopen invariant 4/5 for the consent store.
- **Re-check the revocation record at carry-over execution time** (TOCTOU), and handle a `/forget` racing a
  carry-over (the account copy the shopper authorised survives — acceptable).
- **F-3(b) wording:** "RENEW refuses an expired token" does NOT bound an *active* thief who refreshes before
  each expiry; the only real control on a stolen token is R2-7 revocation, which depends on the victim
  performing forget-me. Consistent with the explicitly-not-closed deliberate-theft case — clarify, don't
  re-argue.
- **F-7:** the endpoint checks memory posture server-side, never a client claim.

### Reviewer's stated limits

No build/test run (design review, code unwritten). Browser storage-partitioning/CHIPS not checked against a
primary source. The two withdrawn branches not read; their failure modes taken from this ADR. **Legal's
Art-9 both-sides question (R2-2) is out of the reviewer's competence and remains an unmet named gate.**

### Path to unblock

(1) The B1 remediation above → **re-review**; (2) **legal** on R2-2; (3) **owner re-acceptance**. Tasks 1–9
may proceed in parallel; task 10 is gated on all three.

---

## Revision 2 — third review — PASS on B1 (2026-08-06)

Third `security-reviewer` pass, scoped to the B1 remediation plus a regression check. **Verdict: PASS on
B1.** The last security objection to task 10 is cleared.

**What the second review's BLOCK actually caught, and why the first fix missed it:** the second-review B1
remediation struck the count/health-flag clause in the *bullet* but left the quoted prompt *blockquote*
live — and that blockquote ("…I have some notes from then…") still asserted A's notes exist. Fixing the
reasoning while leaving the copied-from string intact was the disclosure blind spot a **fourth** time, in
the one place an implementer copies from. The third-pass fix replaced the string itself.

Confirmed by the reviewer against the file:
- **Exactly one live prompt string in R2-1**, and it asserts nothing about A's data: *"Were you using this
  device before without signing in? If so, I can carry that session's preferences over to your account."*
  A question about **B's own** history, conditional offer, "preferences" (the widget's existing
  ordinary-memory word, `index.html:414`) — no existence-of-facts, count, or Art-9 assertion. The old string
  is struck; the second inline string was removed too.
- **Client-side render trigger sound:** the prompt renders from guest-token presence in this browser's own
  `localStorage` (`index.html:335,346-351,560`) with zero server read of the other namespace, and the build
  condition forbidding a server precheck is present and correct.
- **No regression:** default still NO, recorded-authorisation (inv 9) intact, both-sides consent (R2-2 /
  inv 10) untouched, invariants 4/5 unaffected — the edit is confined to R2-1's bullets (`git diff HEAD`
  `@@ -383,25 +383,39 @@`).

**What this PASS does NOT do:** it clears the security gate for the *design* only. Task 10 remains gated on
**legal** (R2-2 Art-9) and **owner re-acceptance**, both human and both unmet; and the eventual task-8/task-10
**code** gets its own review, with the build-time conditions (token-derived `aid` not `body.anonId`; convert
the `mergeAccountConsent` sub-path at `server.ts:1636-1642`; TOCTOU re-check; no-server-precheck at render)
binding then. Reviewer ran no build/test — design review, no task-10 code exists.

**Process note.** This design cleared security only after three passes, each catching a variant of the same
disclosure error the author kept re-introducing. The clearance is the review's, not the author's — recorded
that way deliberately.
