# ADR-0019: Server-issued guest identity (signed guest token) — Proposed

- **Status: Proposed.** Replace the **client-minted** `anonId` with a **server-generated** guest id
  delivered in a **PalUp-signed guest token** (`typ:"guest"`), and derive the guest memory subject from the
  *verified claim* instead of from client input. Enables nothing on its own; builds nothing until Accepted.
- **This REVERSES a recorded named-owner decision.** `MEMORY-GO-LIVE-CHECKLIST.md` C1 —
  "`anonId` is a bearer capability" — was **ACCEPTED AS IS** on 2026-08-04, and that acceptance is cited
  there as load-bearing for **C8, C10 and C14** and as the reason **B12(a)** was withdrawn. Reopening it is
  the whole point of this ADR, and the owner approved doing so on **2026-08-06**.
- **Owner (named):** jason.hsu@framy.co. **Plane:** run-time (shopper identity for cross-visit memory).
- **Governance-touching** (customer data + the identity that gates it). `security-reviewer` required.
- **Depends on nothing new being provisioned:** reuses `WIDGET_TOKEN_SECRET` (already mounted as secret
  `widget-token-secret`) via the `typ`-claim separation that `shopper-token-identity.ts` already justifies
  over per-token-type secrets. No new Secret Manager entry, and therefore no repeat of the missing-IAM-grant
  deploy failure that B5 hit on 2026-08-06.
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
   `shopper-token-identity.ts` exactly: HMAC-SHA256 + base64url over `{typ:"guest", aid:<anonId>, exp}`,
   `constantTimeEqual` signature check, **anonymous on ANY failure** (absent/unconfigured secret, tampered
   signature, wrong `typ`, malformed claims, expiry) and never throwing. `typ:"guest"` gives token-type
   separation, so a widget or shopper token can never verify as a guest principal and vice versa.
2. **The id is generated SERVER-SIDE**, by the already-present but unused `generateGuestId`
   (`widget-memory/src/identity.ts` — 128 bits of `randomBytes`, base32, inside `validateAnonId`'s bound).
   **The mint endpoint MUST NOT accept a client-proposed id.** This single rule is what makes squatting
   structurally impossible and is the property `security-reviewer` should attack first.
3. **Minted on the existing `GET /widget/token` call**, which the widget already makes at boot — no new
   endpoint, no extra round-trip. It stays **unauthenticated**, which is correct: creating a *fresh*
   anonymous identity is an unprivileged act (as it is in Firebase anonymous sign-in). Already rate-limited
   per IP (`RL_IP`/`RL_WINDOW`); note that limiter is **fail-open** by design, so minting must remain cheap
   and side-effect-free.
4. **Sliding TTL aligned to retention.** Re-mint when the token is within a threshold of `exp`, mirroring
   the sliding 30-day fact retention (`ORDINARY_TTL_DAYS`/`SPECIAL_TTL_DAYS`, re-stamped from last
   activity per ADR-0015's 2026-08-04 amendment). A token that does expire corresponds to facts that have
   also expired, so no data is ever stranded behind a dead credential.
5. **ONE derivation helper, used by `/chat`, `/consent` and `/forget`.** C13 already records two
   independent shopper-principal derivations as a drift risk; a third derivation would make that worse.
   Consequently **`signals.anonId` ceases to be an input** — the guest subject becomes server-derived like
   `tenantId` and `shopperId`, which is what `signals.ts`'s own trust-boundary doctrine has always said
   should be true of anything that grants treatment.
6. **Only then, B12(b):** the guest→account carry-over fires when a verified **guest** token and a
   verified **shopper** token are both present on the same request. F1 holds, because the server is no
   longer trusting a client-named namespace. The merge stays a **COPY** (see `merge.ts`'s header) — the
   guest namespace survives so signing out does not wipe guest memory, and the scheduled retention sweep
   (checklist B4) reclaims it on the ordinary TTL.

## What this closes

| row | today | after |
|---|---|---|
| **C1** — `anonId` is a bearer capability | ACCEPTED AS IS; named as the root cause of the three below | **Mostly closed.** Residual: a *stolen token* — device access, which C1 already accepts by name |
| **C8** — cross-subject consent oracle / denial primitive | Open: `lookupConsent` runs against a **caller-supplied** `anonId` | **Closed.** A caller can only ever present their own verified id |
| **C9** — that cross-subject read is unaudited | Open | **Moot.** No cross-subject read remains to audit |
| **C10** — third party durably denies a victim's memory | Open: `POST /consent` for a victim's `anonId` | **Closed.** A victim's subject cannot be named |
| **B12(b)** — guest-era fact stranding | Open, blocked on F1 | **Unblocked** |
| **C2** — subject-scoped auth | Closed only for verified turns | **Strengthened** — the guest side is verified too |

## What this does NOT close

Stated explicitly so a signer is not accepting more than is true:

- **Device access.** A stolen token works. Unavoidable, and exactly the residual C1 accepts.
- **The shared-browser case**, which C1 identifies as the *dominant* threat. Server-issued ids do not help:
  on a shared device the credential is legitimately present. What limits the damage there is **copy-not-move**
  — the previous person never loses their facts.
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

## Governance sign-off (required before Accepted)

- [ ] **Named owner** (jason.hsu@framy.co) accepts reversing C1's 2026-08-04 acceptance, and the four C
      rows being rewritten rather than only C1.
- [ ] **`security-reviewer`** signs off, attacking invariant 3 (no client-proposed id) and invariant 5
      (F1 preserved) first — those two carry the whole design.
- [ ] Confirmed **before** `MEMORY_ADR_ACCEPTED` is flipped, per *why this window closes*.
