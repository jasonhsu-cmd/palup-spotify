# Cross-visit memory — open questions for counsel (DRAFT)

> ⚠️ **This is a DRAFT question list for counsel — NOT legal advice, NOT a sign-off, NOT a compliance
> assessment.** It states what the code does, cites where, and identifies the decision that a qualified
> attorney and the **Compliance/Legal owner** must make. It reaches **no legal conclusion** anywhere, and
> nothing here should be read as a claim that any option is permitted or prohibited. Nothing in this
> document changes ADR-0015's status (still **Proposed — NOT enacted**) or the
> `MEMORY_ADR_ACCEPTED = false` gate.
>
> Companions: `memory-privacy-notice-draft.md`, `memory-dpa-addendum-draft.md`, `provisions-brief.md`.
> Line numbers are as of commit `fea7c0d`.

---

## Q1 — The US Consent-2 fail-closed default

**What the code does.** `decideMemoryWrite` (`packages/widget-memory/src/consent.ts:49-62`) applies two
different regimes:

```
mayWriteOrdinary = region === "us" ? consent1 !== "out" : consent1 === "in"   // consent.ts:51
mayWriteSpecial  = consent2 === "in"                                          // consent.ts:52
```

So ordinary facts follow a US opt-out / everywhere-else opt-in split, while **special-category (health)
facts always require an explicit, separate `"in"` — in every region, including the US**, independent of
Consent 1. The doc comment records this as ratified by the ADR-0015 amendment of 2026-08-04 on the
reasoning of "emerging US state health-privacy law" (`consent.ts:43-47`; ADR-0015 Status amendment).

**The decision.** Confirm (or change) that default for the US market: is explicit in-widget consent the
right instrument for US health-adjacent data, and does the wording of the in-the-moment prompt
(`packages/widget/public/index.html:275-277`) meet whatever standard applies — e.g. a distinct,
non-bundled, revocable authorization? If a specific US state statute demands a particular form of consent
(separate signature, specific disclosures, a separate consent document), the current one-tap prompt will not
match it and the copy plus the recorded artifact would need to change (`server.ts:584-645` records only two
tri-states, no consent text version, no timestamp of the copy shown — see Q9).

---

## Q2 — 30-day retention as a *sliding* window with no absolute cap — and a wiring gap that changes the answer

**What the memory package implements.** Both classes retain 30 days
(`packages/widget-memory/src/retention.ts:20-31`), measured **from last activity**: on a return visit,
`recall` re-stamps a still-consented fact's expiry to `now + 30d`, at most once per day, each renewal
audited as `ttl_renew` (`packages/widget-memory/src/service.ts:158-168`; `retention.ts:33-37`). An expired
fact is never served and never renewed (`service.ts:154`). Because the window slides, **this is not a
30-day cap** — a fact can be held well beyond 30 days from first capture, for as long as the shopper keeps
returning, with no absolute ceiling anywhere in the code.

**What the current wiring does — the renewal branch can never fire.** Renewal is gated on
`ctx.consent1`/`ctx.consent2 === "in"` (`service.ts:164`). The only production caller of `recall` is the
memory-port adapter at `packages/widget-backend/src/server.ts:218-231`, and it passes
`consent1: "unknown", consent2: "unknown"` **hardcoded** (`server.ts:227-228`); the brain's own recall port
has no consent field in its signature at all (`packages/widget-brain/src/types.ts:137-139`, called at
`brain.ts:1127`). We searched `packages/` for every `.recall(` call site: those two are the only non-test
ones. So as wired today **no fact would ever be renewed, no `ttl_renew` audit would ever be emitted, and
retention would be a fixed 30 days from write.** (The in-code comment at `server.ts:224-226` stating that
"recall itself never consults them" is out of date — recall does consult them, for renewal. Correcting that
is a code change and is deliberately not made in this docs-only change.)

**The decision — now in two parts.**

(a) **Which model should the instruments describe?** The sliding model is what ADR-0015's 2026-08-04
amendment and `retention.ts` specify, and closing the wiring gap is a few lines; the fixed-30-day model is
what a deployment of today's code would actually do. These drafts describe the sliding model and flag the
gap, but counsel should say which one the notice and DPA are to commit to, because the shopper-facing copy
differs ("30 days after your last visit" vs "30 days").

(b) **If sliding: is "30 days of inactivity" defensible as *the* retention period**, or must the notice
describe it differently (e.g. "up to 30 days after your last visit, renewed while you keep coming back"),
and/or must an absolute cap (12 months? 24?) be added? A cap would be a code change in `retention.ts`, not
a copy change.

**Note on scope.** Neither model describes durable data today — the only fact-storage adapter in the repo is
in-memory (Q11), so retention is currently bounded above by the lifetime of the serving process.

---

## Q3 — Special-category TTL now **equal** to ordinary (ADR-0015 Inv 9 amendment)

**What the code does.** `SPECIAL_TTL_DAYS = 30 === ORDINARY_TTL_DAYS = 30` (`retention.ts:24,31`). Invariant
9 originally required a *shorter* TTL for special-category facts; the 2026-08-04 amendment changed the
constraint to `TTL_special ≤ TTL_ordinary` and set both to 30 days (`retention.ts:26-31`; ADR-0015 Status
amendment + Invariant 9). Inv 9's other stricter-handling elements (mandatory Consent 2, extra audit,
erasure-first) were not amended — but note that **erasure-first is not wired** (Q6) and **encryption at rest
is not implemented** (Q16).

**The decision.** Confirm that equal retention for health data is the intended legal position, given that the
compensating "stricter storage" controls the amendment relied on are currently partially unimplemented. If
counsel wants special-category data held for less time, that is a one-line constant change
(`retention.ts:31`) plus an ADR amendment.

---

## Q4 — The anonymous id is a bearer key on a destructive endpoint

**What the code does.** `POST /forget` erases the subject's entire namespace
(`packages/widget-backend/src/server.ts:660-710` → `eraseSubject`,
`packages/widget-memory/src/erasure.ts:63-69` → `deleteNamespace`). Authorization consists of:

- an optional widget token — but only enforced when `WIDGET_AUTH_REQUIRED === "true"`, which **defaults to
  false** (`server.ts:260,680-684`); with it off the call is unauthenticated and the tenant falls back to
  `RUNTIME_TENANT`;
- `validateAnonId` — a **format** check only (charset + length, `packages/widget-memory/src/identity.ts:64-74`);
- per-IP and per-tenant rate limits (`server.ts:661-693`) and the operator kill switch (`server.ts:697-700`).

There is **no proof of possession**: whoever presents a well-formed anonymous id can erase that subject's
memory. Guessing is not the intended threat model — the id is 128 random bits, base32-encoded — but note
**where it is actually minted**: in the browser (`packages/widget/public/index.html:194-202`, called at
`:342`), not by `identity.ts:35-37` (that is the server-side equivalent and is not on this path). The
browser mint prefers `crypto.getRandomValues` but **falls back to `Math.random()` if it is unavailable**
(`index.html:197`), which is not a cryptographic RNG. That fallback is rare in modern browsers, but since
this question asks counsel to accept a bearer design on the strength of unguessability, the premise should
be stated accurately. The larger exposure risk is unchanged — shared/kiosk devices, `localStorage` readable
by any script on the storefront page (`index.html:203-208`), logs, or a copied link.

**The same residual applies to `POST /consent`, and arguably matters more**: it accepts `anonId` under the
identical format-only validation and writes the two consent values **verbatim from the request body**
(`server.ts:600-605,636-643`), overwriting that subject's consent record — so a third party who learns an
id can *grant* Consent 1/Consent 2 on someone else's behalf, not just revoke it. This is the precise reason
neither draft claims that "the client cannot assert its own consent": the *subject* is server-derived and
unforgeable, the *choice* is not.

**The decision.** Is a bearer-style pseudonymous identifier acceptable authorization for (a) an irreversible
erasure and (b) a consent grant, in the target jurisdictions — or must go-live require
`WIDGET_AUTH_REQUIRED=true` plus a per-subject proof (e.g. a server-signed token bound to the anonymous id)?
Note the erasure direction is fail-safe from a privacy standpoint (it deletes data) while the consent
direction is fail-unsafe (it enables retention). Engineering intends to enforce `WIDGET_AUTH_REQUIRED`
before enablement; that intent is recorded in `memory-dpa-addendum-draft.md` §7 item 7 and nowhere else
inspectable in this repository.

---

## Q5 — US opt-out: writes can precede the notice, and are then unreadable

Two related asymmetries counsel should rule on.

**(a) The first turn may be written before any notice is displayed.** In US/opt-out mode a subject with no
recorded choice has `consent1 = "unknown"`, which permits the write (`consent.ts:51`). `remember()` runs at
the end of the same `/chat` turn (`server.ts:913-928`), while the widget only learns `memoryEnabled` /
`consentMode` **from that turn's response** and shows the notice afterwards
(`packages/widget/public/index.html:338-348`). So the first message can be distilled and stored before the
shopper has seen anything.

**(b) A US shopper who accepts is recorded as `"unknown"`, not `"in"`.** The opt-out card's primary button
("Got it") deliberately makes **no** server call — only a deviation from the regional default is recorded
(`index.html:253-257`). But every read path requires a literal `"in"`: recall filtering
(`packages/widget-brain/src/brain.ts:458-460,1135`) and TTL renewal (`service.ts:164`). Net effect in the US
default configuration: facts are **written but never surfaced and never renewed**, expiring in 30 days
unused.

**The decision.** (a) Is notice-after-first-write acceptable under the US opt-out theory, or must the widget
suppress the write until the notice has been rendered (a code change: gate `remember()` on a
notice-acknowledged signal)? (b) Data that is collected but structurally unusable is hard to justify on a
minimization argument — should the US path record an affirmative `"in"` on acknowledgement, or should the
write be deferred until it exists? This is a code-behavior decision with legal consequences either way.

---

## Q6 — Withdrawing consent does not delete what is already stored

**What the code does.** ADR-0015 ("Withdrawal is symmetric") and Invariant 9 call for erasure-first
withdrawal. The purge functions exist — `withdrawConsent2` and `withdrawConsent1`
(`packages/widget-memory/src/erasure.ts:77-96,107-126`), each deleting only its own tier and auditing
unconditionally — but **no HTTP route calls either one** (searched `packages/widget-backend/src`).
`POST /consent` records the tri-state and nothing else (`server.ts:643`). The widget's toggles call the same
endpoint (`index.html:224-235,291-318`). What withdrawal *does* achieve today: the fact stops being surfaced
(`brain.ts:1135`), stops being renewed (`service.ts:164`), and ages out within 30 days.

**The decision.** Must withdrawal purge immediately before go-live (wire `withdrawConsent1/2` to `/consent`),
or is "stop using + expire within 30 days" acceptable — and either way, what exactly may the shopper-facing
copy promise? The current widget helper text says *"Turning something off stops new saving"*
(`index.html:313-314`), which is accurate today; the health prompt says *"you can delete it anytime"*
(`index.html:277`), which is only true via the separate "Forget everything about me" button.

---

## Q7 — No access, portability, or rectification path for remembered facts

**What the code does.** Erasure is implemented (`server.ts:660-710`). Nothing reads a subject's facts back to
them: there is no `/memory`, `/export`, or equivalent route in `packages/widget-backend/src`, and the widget's
"What I remember" panel shows only the two consent toggles — not the stored facts
(`index.html:304-318`). A wrong fact can only be removed by erasing everything.

**The decision.** Are access/portability/rectification required at go-live for this data (both under the
merchant's obligations and PalUp's own "frictionless export / no lock-in" position in `provisions-brief.md`
§2)? If yes, this is new engineering, not a drafting change.

---

## Q8 — The sensitivity classifier is a keyword map, so Art.-9-style data can land in the ordinary tier

**What the code does.** `classifyFact` matches lower-cased substrings from a fixed map — allergy,
health_reaction, pregnancy, skin_sensitivity, biometric, genetic, sexual_orientation
(`packages/widget-memory/src/classifier.ts:34-49,53-58,67-74`). Anything unmatched defaults to `"ordinary"`
(`classifier.ts:69`). The bias is deliberately conservative (ambiguous terms like "sensitive skin" are in the
map) and a tenant policy may only narrow, never reclassify (`classifier.ts:22-30,70-73`). But it is still a
finite word list: a fact phrased outside it (e.g. "can't tolerate retinol", "avoids dairy on doctor's
advice") classifies as ordinary — and in the US that means it can be written under the opt-out default with
**no** Consent 2 (`consent.ts:51-52`).

**The decision.** Is a keyword classifier an acceptable control for Art.-9-style data, or must go-live require
a reviewed model-backed classifier plus an eval (ADR-0015 Invariant 11 already requires "their own eval +
review")? Counsel should also confirm whether the residual false-negative rate needs to be measured and
documented before enablement.

---

## Q9 — Immutable audit, consent records, and erasure

**What the code does.**
- The audit log is append-only and hash-chained; the Postgres adapter issues no UPDATE/DELETE against
  `rs_audit` (`packages/platform-ports/src/runtime-state-port.ts:37-41,100-117`;
  `packages/state-postgres/src/postgres-runtime-store.ts:14-18,60-67`), and the chain head is anchored to
  stdout/Cloud Logging (`server.ts:956-960`).
- Memory audit entries carry a **truncated sha256 of `tenantId::anonId`** (16 hex chars = 64 bits) plus class
  and count — never raw ids, never fact text (`packages/widget-memory/src/audit.ts:39-64`), same pattern in
  the consent store (`packages/state-postgres/src/runtime-consent-store.ts:51-53,73-74`).
- Consent records are written with **no TTL** (`runtime-consent-store.ts:68`) and `POST /forget` does **not**
  clear them (`server.ts:708` erases the vector namespace only).

**The decision.** Three parts. (i) How to reconcile an intentionally immutable audit log with erasure
requests — `provisions-brief.md` §7 item 5 anticipates "redaction-in-place for immutable audit"; nothing
implements it. (ii) Is the truncated hashed subject reference still personal data for retention purposes,
given the audit log outlives the 30-day fact TTL indefinitely? (iii) Should `/forget` also delete the consent
record (today the record survives under the old anonymous id after the shopper resets, `index.html:328`), and
should consent records carry their own retention period — noting that a consent *record* is also the evidence
that consent was given.

---

## Q10 — Region is a deploy-level setting, not per-shopper

**What the code does.** `MERCHANT_REGION` is read once at boot from the environment and defaults to `"us"`
(`server.ts:293-296`); it drives both the consent regime (`consent.ts:50-51`, via `signals.region`) and the
widget's consent-card mode (`CONSENT_MODE`, `server.ts:304`). The code comment states plainly that region
"should become geo-derived from the request". So an EU-resident shopper browsing a US-configured merchant is
processed under the US opt-out regime.

**The decision.** Is deploy-level regional configuration acceptable at launch (e.g. because the initial market
is US-only merchants), or must per-shopper geolocation gate the consent regime before enablement? If the
former, the merchant-facing terms probably need a warranty about where their shoppers are; if the latter, it
is new engineering.

---

## Q11 — "Expiry enforced on read" vs actual deletion

> **UPDATED 2026-08-06 — half of this question has dissolved; the other half is now sharper.** Both premises
> behind the second half are obsolete: **storage is durable** (`PostgresVectorStore` is merged and live in
> staging), and **the sweep is scheduled** (daily, via Cloud Scheduler). The title previously read
> "…; and storage is currently non-durable" and that clause has been dropped. The **first** half stands and
> is the live decision.

**What the code does.** Expired facts are filtered out at read time and never renewed (`service.ts:154`).
The sweep that actually deletes them (`packages/widget-memory/src/retention.ts:69-100`) still has **no caller
in serving code** — the `store.sweepExpired()` at `server.ts:964` is the unrelated runtime-KV sweep — but it
now runs **daily at 03:17 UTC** as a scheduled Cloud Run Job (`docs/DEPLOY.md`, "Retention sweep"). Facts are
stored durably in Cloud SQL Postgres whenever `DATABASE_URL` is set, so they survive restart, are shared
across instances, and `POST /forget` is a real cross-instance deletion — proven physical against a live
Postgres 16 server (`packages/widget-backend/test/b6-erasure-real-postgres.test.ts`).

**The decision (still open).** Does a retention commitment in the notice/DPA require *deletion* on schedule,
or is "never served after expiry" sufficient for the window between expiry and the next sweep? That window
is now bounded at roughly **24 hours** rather than unbounded, which is what makes the question answerable —
counsel should say whether a bounded gap of that size is acceptable, and whether it must be stated to
shoppers.

**Two facts to weigh, neither of which the earlier version could offer.** The schedule is a property of a
**deployment**, not of this code, so it must be confirmed per environment and could silently lapse; and **no
sweep has yet deleted anything** — every run so far reported `visited=0`, because memory is off and no fact
exists to expire, so the delete-and-audit path is evidenced by tests rather than by production execution.

**Withdrawn premise, recorded so the change is visible:** this question previously also asked whether the
notice/DPA could make *any* retention or erasure representation at all while storage was non-durable, on the
grounds that "how long is it kept" answered "until the process restarts". That no longer applies.

---

## Q12 — The model provider sees the raw turn during distillation

**What the code does.** `createModelDistiller` sends the shopper's message **and** the agent reply to the
model port (`packages/widget-memory/src/distiller.ts:218-225`), wrapped in the card/SSN redaction guardrail
(`server.ts:205-214`, `packages/platform-ports/src/redaction.ts:42-62`). The production adapter is Vertex AI
(Gemini) when configured (`packages/widget-backend/src/model.ts:12-17`). This is a **second** model call over
the same text, made specifically for the memory feature.

**The decision.** Confirm this is covered by the model-provider terms and the sub-processor exhibit, including
any provider-side retention. `provisions-brief.md` §4 already flags that some models carry provider-set
retention that overrides zero-data-retention preferences (the Claude Fable 5 "Covered Model" 30-day retention
note) — counsel should decide whether *memory distillation* specifically may run on any model with
provider-side retention, and whether the notice must disclose it. (I have not verified any provider's current
terms in this session; that claim is inherited from `provisions-brief.md` §4 and needs a source-and-date check.)

---

## Q13 — Children / minors

**What the code does.** Nothing. I searched `packages/widget-memory/src` and `packages/widget-backend/src`
for age/minor/child handling and found none; ADR-0015 does not mention it either.

**The decision.** Does the merchant-facing AUP/MSA need to prohibit enabling memory on stores directed to
children, and/or does the widget need an age signal before memory may be written? Health-adjacent memory for a
minor is likely the highest-severity variant of Q1/Q8.

---

## Q14 — Merchant control and who authors the sensitivity policy

**What the code does.** `memoryServiceEnabled` is process-wide (`server.ts:200`) — there is **no per-merchant
memory toggle**. The per-industry sensitivity policy exists as a type (`TenantSensitivityPolicy`,
`classifier.ts:22-30`) threaded through `MemoryCtx.tenantPolicy` (`packages/widget-memory/src/types.ts:19-20`),
but nothing populates it and no review workflow exists. ADR-0015 lists both under "Still open".

**The decision.** Controller-side: can a controller (merchant) be given a genuine on/off and a policy it
authors, given the DPA characterizes them as the controller? Who reviews a merchant-proposed narrowing before
it takes effect, and is PalUp's review of that policy itself a processing decision that needs documenting?

---

## Q15 — Guest → account merge

**What the code does.** `mergeGuestIntoAccount` migrates the guest namespace into `acct:${accountId}`, drops
special-category facts unless the **account** has `consent2 === "in"`, deletes the anonymous namespace, and
audits the migration as irreversible (`packages/widget-memory/src/merge.ts:46-68`;
`packages/widget-memory/src/audit.ts:33`). **No route calls it** — the account tier is unreachable today.

**The decision.** When the account tier ships: is account ToS an adequate basis for continuing to hold
previously guest-collected ordinary facts, must the shopper be told at sign-in that prior anonymous activity is
being linked to their account, and is the irreversibility (the pre-merge namespace is deleted) acceptable?

---

## Q16 — Encryption at rest for special-category facts ~~is a stated invariant that is not implemented~~ — IMPLEMENTED; only the copy question remains

> **RESOLVED 2026-08-06 — the premise is obsolete. Do not rule on "not implemented".** Special-category
> facts **are** encrypted at rest: `packages/widget-memory/src/service.ts` applies **AES-256-GCM** through a
> `CryptoPort` (`packages/platform-ports/src/crypto-port.ts`) to a health fact's `text`,
> `disposition[].value` and `sourceQuote` *before* the storage adapter sees them, and it is **fail-closed** —
> with no tenant key configured the write is **refused** rather than stored in the clear, with a
> `write.refused` audit. Checklist **B2 — MET (PR #150)**; the key is provisioned (**B8**). The durable
> at-rest store this depended on also exists now (**B1**), so the "no store to encrypt yet" qualifier is gone
> too.
>
> **Ordinary facts are still NOT encrypted** — that distinction is real and worth counsel's attention, since
> the invariant only ever required it for the special class.
>
> ~~**What the code does.** ADR-0015 Invariant 9 and the "Consequences" section require special-category
> facts to be encrypted at rest. There is **no encryption in `packages/widget-memory`** — the only
> `node:crypto` uses are `randomUUID`, `randomBytes` and the audit `sha256`. Application-layer AES-256-GCM
> exists elsewhere for OAuth grants and is not applied here. There is also no at-rest store to encrypt yet
> (Q11). Engineering intends to close this before enablement; that intent is recorded in
> `memory-dpa-addendum-draft.md` §7 item 1 and nowhere else inspectable in this repository.~~
>
> On that last clause: the intent is now inspectable — **`docs/MEMORY-GO-LIVE-CHECKLIST.md`** is an itemised
> gate list (A1–A7 / B1–B12 / C1–C14) with status and evidence per row.

**Copy hazard flagged for counsel.** ADR-0015's *illustrative* Consent-2 prompt copy contains the phrase
"I'll keep it encrypted" (`docs/adr/0015-cross-visit-memory-eu-consent-gated.md:105-108`). The copy actually
shipped in the widget does **not** make that claim (`packages/widget/public/index.html:277`), and neither do
these drafts. It must not be reinstated in any shopper- or merchant-facing text unless and until the control
exists.

**The decision.** Is encryption at rest (application-layer, over and above whatever the eventual storage
engine provides) a **blocking** precondition for enabling the health tier, and if so must it be
application-layer with a separately-managed key, or is storage-engine encryption acceptable? The answer
determines whether the health tier can ship in the first enablement wave at all.

---

## Q17 — Process items counsel should confirm are (or aren't) needed

Not code questions — listed so they are not forgotten:

1. Whether a **DPIA / Art. 35 assessment** is required before enablement (special-category data + systematic
   monitoring of shopper behavior). Nothing of the kind exists in this repo.
2. The **lawful basis** framing itself. ADR-0015 says only "(ordinary personal data, Art. 6)" and "(explicit
   special-category consent, Art. 9)" (`docs/adr/0015-cross-visit-memory-eu-consent-gated.md:102,105`) —
   we grepped the ADR and the string "9(2)" appears nowhere in it, so any narrowing to Art. 9(2)(a) is an
   inference, not the ADR's own framing. Either way it is an engineering assumption, not a legal
   determination.
3. The **sub-processor exhibit** for the memory path specifically (model provider + eventual vector store) and
   the change-notice/objection mechanics (`provisions-brief.md` §4).
4. **International transfers / residency**: nothing in the memory code addresses data location; residency is
   listed as a roadmap item in `provisions-brief.md` §2.
5. **Breach notification** obligations relating to a store of health-adjacent facts, and whether the current
   audit trail is sufficient to support a notification (it records classes and counts, never content —
   `audit.ts:58-64`).
6. Whether the **merchant** (as controller) must publish its own shopper-facing notice text before PalUp may
   enable the feature for that store, and who supplies/approves that text.

---

## Q18 — ~~The manage panel displays "off" while ordinary memory is being written (US default)~~ — FIXED

> **RESOLVED 2026-08-06 — this defect was fixed and the question no longer needs a ruling.** The panel used
> to bind its checkboxes to the value in the browser's own storage, so the tri-state `"unknown"` rendered
> "off" while the US opt-out regime (`!== "out"`) was permitting writes. Both `/chat` and `/consent` now
> return **`memoryActive`** — the effective write capability for the subject actually being served, derived
> from the same input object `remember()`'s own consent gate consumes — and the widget renders that
> (`packages/widget/public/index.html`, `memoryActive`). Panel and write path therefore **cannot** disagree.
> Checklist **B11 — MET (PR #152)**, verified by execution in
> `packages/widget-backend/test/manage-panel-honesty.test.ts`, which asserts the reported field against the
> real upsert count on the same turn.
>
> **What counsel may still want to rule on** is the underlying regime, not the UI: under the US opt-out
> default, a shopper who has never answered *is* written about, and the panel now says so honestly rather
> than hiding it. That is **Q5**'s write/read asymmetry question, which stays open. The
> displayed-state-versus-processing mismatch this question was about is gone.
>
> The superseded description follows, kept so the change is visible rather than silent.

**What the code did (superseded).** The "What I remember" panel's two checkboxes are rendered checked **only when the
stored value is literally `"in"`** (`packages/widget/public/index.html:291-296,298-303`). A US shopper who
has never answered sits at `consent1 = "unknown"` — the opt-out card's primary button ("Got it")
deliberately makes no server call, because only a deviation from the regional default is recorded
(`index.html:253-257`). But `"unknown"` **permits** ordinary writes under the US opt-out regime
(`packages/widget-memory/src/consent.ts:51`). Net effect in the default US configuration: the shopper opens
the panel, sees **"Preferences" unchecked**, and ordinary notes are nonetheless being written about them.

The same subject also has every *read* blocked, because recall requires a literal `"in"`
(`packages/widget-brain/src/brain.ts:458-460,1135`) — so the data is written, never surfaced, and (per Q2)
never renewed. Q5 covers the write/read asymmetry; this question is specifically about **what the interface
tells the shopper while that is happening**.

**The decision.** Does a control surface that displays "off" for processing that is in fact occurring
undermine the validity, transparency, or fairness of the consent artifact — and if so, what is the fix:
(a) render the US opt-out state as a distinct third state ("on by default — turn off"), (b) record an
affirmative `"in"` when the US shopper acknowledges the notice (which also resolves Q5(b)), or (c) defer
writes until an explicit choice exists? All three are code changes, and (b) and (c) change what data is
collected — so this should be decided before, not after, the copy is finalized.

---

## Q19 — May special-category (Art-9) data be carried from a guest subject to an account subject on a "both sides opted in" basis? (ADR-0019 R2-2 — NEW, and it amends a decision counsel already ratified)

> **This is the one gate left on ADR-0019's guest→account carry-over (task 10).** Owner re-accepted the
> design 2026-08-06; `security-reviewer` cleared it over three passes. Neither the reviewer nor the owner can
> answer this — it is a lawful-basis question, and it **modifies the special-category basis counsel ratified
> on 2026-08-04** (ADR-0015's amendment), so it needs a fresh look rather than being treated as settled.

> ### Counsel decision request — the one thing we need signed (self-contained; the rest of this section is the backup)
> **Ask:** may special-category (Art‑9 / health) memory notes be **copied from a signed‑out "guest" subject
> into the same person's signed‑in "account" subject**, on the basis that **both** subjects independently
> recorded an explicit health‑memory consent (`memorySpecial = "in"`) — *provided* the future account
> transfer was disclosed to the shopper **at the moment they gave the guest‑side health consent**?
> **We need one of:** (a) **Yes, sufficient** — optionally with conditions on the disclosure wording;
> (b) **No — re‑consent required under the account** (guest‑era health consent does not transfer; carried
> notes stay dropped until the account separately opts in); or (c) **Yes, but the sign‑in prompt must itself
> name health data** (which reopens a privacy disclosure — see part 2). The build is **inert and shipping
> nothing** until this is answered; the answer determines what the code may do and what the consent copy must
> say. Full framing, the three sub‑questions, the owner's proposed direction, and the residual risks you must
> factor are below.

**Background counsel needs, in plain terms.** A shopper can use the widget two ways on one device: signed
**out** (a "guest", keyed by a browser-held id) and signed **in** (an "account"). Cross-visit memory can hold
ordinary preference notes and — behind a *separate* explicit health consent (Consent 2) — **special-category
(Art-9) health notes**. ADR-0019 lets a shopper who built up guest notes carry them into their account when
they sign in. The security-relevant history: an earlier design let the *account holder's* consent alone
authorise migrating the *guest's* health notes, which on a shared/family device meant person B could pull
person A's health data into B's account. That is now prevented by (i) an explicit shopper authorisation
prompt that discloses nothing about the other session (R2-1), and (ii) the rule in question here.

**What the code will do (R2-2).** A special-category note carries over **only if BOTH** the source (guest)
subject recorded `memorySpecial === "in"` **AND** the destination (account) subject recorded
`memorySpecial === "in"`. Either side `unknown` or `out` ⇒ the note is dropped, never promoted. Ordinary
notes follow the ordinary consent rule and are out of scope of *this* question. Implementable exactly as
stated — the consent store can read both subjects' records on one request
(`packages/state-postgres/src/runtime-consent-store.ts:137`); the current code gates on the destination
only (the account-only `consent2` parameter, `packages/widget-memory/src/merge.ts:61`, applied at the drop
filter `merge.ts:145`: `if (meta?.class === "special" && ctx.consent2 !== "in") continue;`), which is the
defect R2-2 corrects by requiring the SOURCE guest's `memorySpecial === "in"` as well.

**The decision — three parts, please answer each:**

1. **Is "both subjects recorded an explicit Consent 2 = in" a sufficient lawful basis** under GDPR Art. 9
   (and any applicable US state health-privacy law — see Q1's list) to **move** special-category data from a
   guest-keyed subject to an account-keyed subject? Or does Art-9 require consent obtained *specifically for
   the account context* (i.e. the guest-era Consent 2 does not transfer, and the fact must be re-consented
   under the account before it may live there)?
2. **Does the shopper-authorisation step (R2-1) need to name health data explicitly** to be valid — e.g.
   must the carry-over prompt say "including health-related notes", accepting that this discloses to the
   signed-in shopper that health notes exist — or is the both-sides Consent-2 gate sufficient without a
   health-specific disclosure at the carry-over moment? (This trades against a privacy harm: naming health
   data in the prompt re-introduces a disclosure R2-1 was designed to avoid. Counsel should weigh which risk
   governs.)
3. **Does R2-2 change your 2026-08-04 ratification** of ADR-0015's special-category model, and if so how?
   That ratification covered *writing* special-category notes under Consent 2; it did not contemplate
   *carrying them between subjects*. Confirm whether the both-sides rule is within the ratified basis or
   needs a documented amendment.

**Why it must be settled before build, not after.** The answer changes what the carry-over code may do and
what the R2-1 prompt must say. If (1) is "re-consent required under the account", the carry-over drops all
guest-era health notes until the account separately opts in — a materially different feature. If (2) is
"must name health data", the prompt copy changes and a privacy trade-off is reopened. Both are cheaper to
decide now than to unwind from shipped code and a published notice.

**Residual risks that bear on your answer (each is a distinct question elsewhere in this doc; surfaced here
because the Art‑9 carry‑over's soundness depends on them).**

1. **The special‑category classifier is a keyword map, not semantic (see Q8).** The both‑sides Consent‑2 rule
   only protects a note that is *correctly classified* `special`. `classifyFact`
   (`packages/widget-memory/src/classifier.ts`) is a lower‑cased substring match over a fixed keyword list
   (`allerg`, `peanut`, `pregnan`, …); a health disclosure it does not match is classified **ordinary** and
   would carry over under the ordinary rule with **no Consent‑2 gate at all**. So the Art‑9 guarantee is
   bounded by the classifier's recall — a false negative routes health data through the ordinary path.
2. **The guest consent is a bearer‑capability, not an authenticated identity (see Q4/C1).** "The source
   guest recorded Consent 2" means *whoever held that browser id* did — on a shared/family device that need
   not be the person who later signs in. R2‑1's authorisation prompt and the both‑sides rule are the
   mitigations; the source‑side consent's provenance is not identity‑proven.
3. **Erasure after carry‑over is asymmetric (see F‑10).** Once copied, the note exists in two namespaces; a
   **signed‑out** forget clears only the guest copy — the account copy requires a signed‑in forget. The
   widget's erasure message is being corrected to say so honestly (shipped inert, `CARRY_OVER_PROMPT_ENABLED`
   off). Relevant to any right‑to‑delete representation about carried health data.
4. **Retention is unchanged by the carry‑over (see Q2/Q3).** Carried notes keep the sliding
   30‑days‑from‑last‑activity window with no absolute cap, and special‑category TTL equals ordinary (30d);
   the copy neither resets nor shortens it.
5. **Mitigating fact — encryption at rest is implemented (see Q16).** Special‑category facts are encrypted at
   rest, so the carried copy is encrypted in the account namespace as well; this is not an open risk, stated
   so the record is complete.

**Companions:** ADR-0019 R2-1/R2-2; ADR-0015's special-category amendment (the ratified basis this touches);
`memory-privacy-notice-draft.md` (the shopper-facing copy that would carry the answer to part 2);
`memory-dpa-addendum-draft.md` §3 (special-category categories).

### Owner's proposed answer — 2026-08-06 (a DIRECTION for counsel to confirm, NOT a legal sign-off)

The named owner (jason.hsu@framy.co) has proposed a resolution. **It is recorded here as the owner's chosen
design direction and the answer to route to counsel — it does not itself satisfy the Art-9 lawful-basis
question, which remains a legal determination this document exists to obtain.** The owner is not counsel;
this narrows what counsel is asked, it does not close the gate.

The proposal, in the owner's words: *"the guest consent may cover the transfer, provided the consent prompt
explicitly says something like: 'Remember this health information across visits and add it to your account
if you later sign in.'"* Mapped onto the three parts:

- **Part 1 → guest consent CAN cover the transfer**, on condition the transfer is disclosed **at the moment
  Consent 2 is given**. Counsel is asked to confirm this is sufficient under Art-9 (and Q1's US state list),
  rather than to decide it open-ended.
- **Part 2 → the disclosure goes in the CONSENT-2 prompt, NOT the sign-in (R2-1) prompt.** This is the
  important structural consequence: the transfer is disclosed to the shopper **about their own data, at
  guest-consent time**, so the R2-1 carry-over prompt stays disclosure-free and **B1 is not reopened**. The
  privacy trade-off part 2 worried about (naming health data at sign-in, to a possibly-different person) is
  avoided rather than accepted — the "different person" never sees a health-specific prompt.
- **Part 3 → still open for counsel.** Whether disclosing the transfer up front brings it inside the
  2026-08-04 ratification, or needs a documented amendment, is exactly the confirmation this question seeks.

**What this changes in the build, once counsel confirms:** the shipped Consent-2 prompt
(`packages/widget/public/index.html` `showSpecialConsentPrompt`, currently the generic "some health
information" copy) gains a clause disclosing the future account transfer. That is **health-consent copy**, so
it also falls under **A5** (legal review of consent wording) — the exact clause must be lawyer-approved
before it ships, not just its intent.

**Two things the owner's direction does NOT settle, flagged for counsel rather than resolved here:**
- Whether R2-2's **account-side** requirement (destination must ALSO have Consent 2 = "in") still stands, or
  whether up-front guest transfer-consent alone suffices. R2-2's both-sides rule was a *security* measure
  against a third party pulling a victim's data; with server-issued identity (ADR-0019) + the R2-1
  authorisation already preventing that, counsel should say whether the account-side gate is legally
  required or is now belt-and-suspenders. **The build keeps both-sides until told otherwise** — the stricter
  reading, safe by default.
- Whether "if you later sign in" is specific enough, or the copy must name that the data moves to a
  *durable account record* under different retention. A copy question for A5.

---

## Q20 — The async write queue transits the raw shopper turn through Pub/Sub, and erasure does not reach it (CONDITIONAL — dark until the queue is enabled)

> **CONDITIONAL — this question only bites once the async write queue is turned on.** The queue (#126) ships
> **dark**: nothing sets `MEMORY_PUBSUB_*` on any deployment, so no turn transits Pub/Sub today. It is
> post-`fea7c0d` code; references below are to files, not pinned line numbers.

**What the code does.** When the async write queue is enabled, `remember()` may hand the write off to a
Google Cloud **Pub/Sub** `memory-write` topic instead of running inline (`memory-write-queue.ts` publish →
OIDC-verified push route `routes/pubsub-push-memory.ts` → the same `remember()`). The message body carries
the **RAW shopper turn** — the `message` and the agent `reply`, i.e. the un-distilled text, which may contain
special-category (Art-9) content — as application-plaintext. It is CMEK-encrypted at rest on both
`memory-write` and its dead-letter queue (24h `message_retention_duration`), but `eraseSubject` / the
`POST /forget` erasure path does **not** reach Pub/Sub: an erasure request during the ≤24h retention window
leaves any in-flight or DLQ'd raw turns for that subject **unerased** until they age out.

**The decision.** (a) Must this raw-turn-in-transit exposure be recorded in the DPIA (special-category data
transiting a queue as app-plaintext) before the queue is enabled? (b) Is a bounded ≤24h gap where an
erasure does not reach queued/DLQ'd raw turns acceptable, or must the erasure path also purge Pub/Sub (or the
DLQ retention be shortened) before enablement? This is the legal half of the engineering precondition tracked
at `MEMORY-GO-LIVE-CHECKLIST.md` **§E1**. The queue is optional transport — a memory-enabled deployment can
run indefinitely on the inline-write path without ever raising this question.
