# DPA Addendum — cross-visit shopper memory (DRAFT FOR COUNSEL)

> ⚠️ **This is a DRAFT for counsel — NOT legal advice, NOT a binding agreement, NOT executed terms, NOT a
> sign-off.** It is an engineering description of the processing performed by the cross-visit memory
> subsystem, in the shape of a DPA addendum, so a qualified attorney and the **Compliance/Legal owner** can
> draft the real instrument. **No DPA exists in this repo** — `provisions-brief.md`'s header disclaimer
> (lines 7-8) states "No agreements currently exist in this repo", and we confirmed `docs/legal/` contained
> only `provisions-brief.md` before this branch. This addendum presupposes a base DPA that has not been
> written. Every clause below must be validated, completed and made jurisdiction-correct by a licensed
> lawyer before use. It asserts **no legal conclusion** — in particular it does not claim the measures
> described are "appropriate", "adequate", or sufficient under Art. 28/32 or any other provision.
>
> Companions: `memory-privacy-notice-draft.md` (shopper-facing), `memory-open-questions-for-counsel.md`
> (decisions counsel must make), `provisions-brief.md` §4 (instrument **C**, the base DPA).

## 0. Status and scope of this addendum

The processing described is **not occurring**. `MEMORY_ADR_ACCEPTED` is a hardcoded `false`
(`packages/widget-memory/src/flag.ts:12`) and `isMemoryEnabled()` requires that constant **and** the
operator flag (`flag.ts:16-18`), so in production the memory service is never constructed
(`packages/widget-backend/src/server.ts:200-217`) and no fact is written or read. This addendum describes
the processing that **would** occur after a human-only flip of that constant. Line numbers are as of commit
`fea7c0d`.

Scope: cross-visit shopper memory only. Other processing (chat serving, the traffic/shadow-grading log,
telemetry, Shopify order lookups, marketing comms) is out of scope here and belongs in the base DPA.

**Storage is non-durable today, and that qualifies §8 and §9.** The only `VectorPort` adapter in the repo
is an in-memory reference implementation (§5), so as the code stands there is no at-rest fact store: facts
would live in the serving process, be lost on restart, and not be shared between instances. Retention,
erasure and data-subject-request statements below describe what the code does **to whatever store it is
given** — they are not representations about durable data. A durable adapter is in development on a
separate, unmerged branch and is **not** part of the code described here.

## 1. Roles

Consistent with `provisions-brief.md` §4: merchant = **controller**, PalUp = **processor**, downstream
vendors = **sub-processors**. Nothing in the code contradicts that allocation; it is a legal
characterization for counsel to confirm, not something the code can establish.

## 2. Categories of data subjects

- **Shoppers on a merchant's storefront**, in two states:
  - *guest* — known only by a per-merchant random anonymous id (`packages/widget-memory/src/identity.ts:35-37`);
  - *account* — post sign-up merge, keyed `acct:${accountId}` (`packages/widget-memory/src/merge.ts:21-23`).
    **Note:** the merge function exists but **no route calls it** (searched `packages/widget-backend/src`),
    so today only the guest tier is reachable.

## 3. Categories of personal data

| Category | Content | Where written |
|---|---|---|
| **Pseudonymous identifier** | 128-bit random, base32, per merchant; browser-stored; not device-derived | `identity.ts:35-37`; widget mirror `packages/widget/public/index.html:194-202` |
| **Ordinary "commerce" facts** | ≤160-char distilled preference/observation sentences, card/SSN-redacted, discarded if they still contain an email or phone number | `packages/widget-memory/src/distiller.ts:30,42-43,51-61`; stored `packages/widget-memory/src/service.ts:100-108` |
| **Special-category facts (Art.-9-style)** | Same shape, but classified as health/allergy/pregnancy/biometric/genetic/sexual-orientation by a conservative keyword map | `packages/widget-memory/src/classifier.ts:34-49,67-74` |
| **Disposition metadata** | Optional `{axis, value, provenance ∈ {stated, observed}, confidence, sourceQuote}` style signals; "inferred" provenance is structurally impossible; invalid ⇒ whole candidate rejected | `distiller.ts:102,125,183-189`; re-validated at the persistence boundary `service.ts:92` |
| **Consent records** | Two tri-states (`in`/`out`/`unknown`) per (merchant, anonymous id) | `packages/state-postgres/src/runtime-consent-store.ts:26-31,60-81` |
| **Audit records** | Action, hashed subject reference, sensitivity class, count, reversal path — **no fact text, no raw id** | `packages/widget-memory/src/audit.ts:39-64` |
| **Derived expiry metadata** | `expiresAt` ISO timestamp per fact | `service.ts:103`; `packages/widget-memory/src/types.ts:43-49` |

Explicitly **not** collected by design: demographics, psychographics, and inferred willingness-to-pay
(prompt rules 2-3, `distiller.ts:143-150`); raw transcripts (`distiller.ts:36,55`).

## 4. Purposes and processing operations

1. **Distillation** — one model call per turn over the raw shopper message + agent reply to extract 0-N
   candidate facts (`distiller.ts:213-262`, invoked from `service.ts:66`).
2. **Classification** — sensitivity class assigned before any write (`classifier.ts:67-74`, `service.ts:78`).
3. **Consent gating** — server-side decision table (`packages/widget-memory/src/consent.ts:49-62`, applied
   `service.ts:81-82`).
4. **Storage** — upsert into the subject's vector namespace with class + expiry metadata
   (`service.ts:100-136`).
5. **Recall / personalization** — read the subject's unexpired facts, re-check the shopper's *current*
   consent per tier, and append them to the model prompt as fenced data that may only add caution
   (`service.ts:141-189`; `packages/widget-brain/src/brain.ts:1126-1156`, read-time gate `brain.ts:458-460`).
6. **Retention maintenance** — TTL-on-read drop plus throttled sliding renewal (`service.ts:154,158-168`);
   a reclamation sweep function exists but is unscheduled (`packages/widget-memory/src/retention.ts:69-100`).
   The renewal half is **unreachable on the current wiring** — see §8.
7. **Erasure** — whole-subject erasure on shopper request (`packages/widget-memory/src/erasure.ts:63-69`,
   route `server.ts:660-710`).
8. **Audit** — every one of the above is logged (`audit.ts:11-21`).

## 5. Sub-processing and portability posture

All external capability access is through the **ports** in `packages/platform-ports/` (ADR-0001; CLAUDE.md
§3.3), so the sub-processor set is a function of which adapter is deployed, not of feature code:

| Capability | Port | Adapter in this repo today |
|---|---|---|
| Fact storage | `VectorPort` (`packages/platform-ports/src/vector-port.ts:43-53`) | **In-memory reference adapter only** (`vector-port.ts:117-159`), selected at `server.ts:198`. **No durable/cloud adapter exists.** |
| Model inference (distillation + serving) | `ModelPort` | Vertex AI (Gemini) when `GOOGLE_CLOUD_PROJECT` is configured, else a local mock (`packages/widget-backend/src/model.ts:12-17`); wrapped in card/SSN redaction (`server.ts:214`) |
| Consent records, audit log, rate limits | `RuntimeStatePort` | Postgres (Cloud SQL via `DATABASE_URL`) or in-memory (`packages/state-postgres/src/postgres-runtime-store.ts`) |

Consequences counsel should note:
- Because the only `VectorPort` adapter is in-memory, memory facts today live **in the serving process**,
  are lost on restart, and `POST /forget` can only erase from the instance that receives the call. A durable
  adapter is a tracked prerequisite, not shipped.
- The model provider processes the **raw turn text** during distillation, not just the distilled fact. The
  sub-processor exhibit and any zero-/limited-retention commitments must cover that call
  (`provisions-brief.md` §4, "Model-provider commitment" and "Model-specific retention").

## 6. Security measures — **as actually implemented today, on a reachable code path**

Each is verifiable in code; none of them is offered as a legal adequacy claim. Controls that exist in the
package but that **no route reaches** are deliberately excluded from this section and listed in §7 instead,
so nothing here can be mistaken for an operative safeguard.

**Isolation**
- Namespace = `${tenantId}::${anonId}`; blank namespaces rejected; no cross-namespace query
  (`identity.ts:55-59`, `vector-port.ts:57-61,131-145`).
- `::` rejected inside either component, blocking namespace injection into another subject/tenant
  (`identity.ts:39-46`).
- Client-supplied anonymous ids must pass a charset/length check before keying anything
  (`identity.ts:64-74`; applied `packages/widget-backend/src/signals.ts:104`, `server.ts:636,702`).
- **Limit on the above:** the namespace scheme only separates merchants to the extent `tenantId` is
  merchant-derived. It comes from a verified widget token, which requires a configured
  `WIDGET_TOKEN_SECRET` and a registered embed key (`server.ts:355-361`); any untokenized request to
  `/chat`, `/consent` or `/forget` falls back to the single hardcoded `RUNTIME_TENANT = "demo"`
  (`server.ts:54`, applied `server.ts:618,684,751`), which is the default posture because
  `WIDGET_AUTH_REQUIRED` defaults to `false` (`server.ts:260`; §7 item 7). In that configuration
  untokenized shoppers share one tenant prefix, and per-merchant isolation is not in force.
- Postgres adapter applies a `tenant_id` predicate on essentially every statement
  (`postgres-runtime-store.ts:13-15`). **One documented exception:** `sweepExpired` issues
  `DELETE FROM rs_kv WHERE expires_at IS NOT NULL AND expires_at <= now()` with no tenant predicate
  (`postgres-runtime-store.ts:126-131`). It touches only already-expired rows, but the adapter's own
  "every statement" header comment is not literally true and should not be quoted as an isolation
  guarantee. All `rs_audit` statements are INSERT/SELECT only — that part holds.

**Data minimization**
- Transcript-shaped input rejected outright; card/SSN redaction; contact-info rejection; 160-char cap
  (`distiller.ts:36,51-61`).
- Extraction prompt forbids demographic/psychographic/inferred-budget facts; invalid provenance rejects the
  whole candidate, re-validated at the persistence boundary (`distiller.ts:143-159,183-189`; `service.ts:92`).
- Redaction wrapper on the model call so pasted cards/SSNs do not reach the provider (`server.ts:205-214`).
- Audit records carry a hashed, truncated subject reference and never the fact text (`audit.ts:39-64`;
  `runtime-consent-store.ts:51-53,73-74`).

**Consent enforcement**
- **On the serving path, the consent decision reads only the server's own stored record** — both tiers are
  populated from the consent-store lookup and `signals.consent` from the `/chat` request body is never
  used (`signals.ts:71-83`). A client cannot make itself look consented inline on a chat request. **This is
  not the same as "the client cannot assert its own consent":** `POST /consent` writes the two consent
  values verbatim from the request body for the supplied `anonId` (`server.ts:600-605,636-643`), and that
  endpoint is unauthenticated whenever `WIDGET_AUTH_REQUIRED` is `false` — the default (`server.ts:260,
  614-618`). The *subject* (tenant + format-validated anonymous id) is server-derived and cannot be forged;
  the *choice* is client-supplied. See §7 item 7 and `memory-open-questions-for-counsel.md` **Q4**.
- Fail-closed defaults: no record ⇒ `"unknown"` (`runtime-consent-store.ts:46`); every non-US region
  requires explicit `"in"`; special-category requires explicit `"in"` everywhere (`consent.ts:49-62`).
- Re-checked at read time, per tier, on every turn (`brain.ts:458-460,1135`).

**Integrity / accountability**
- Append-only, hash-chained audit with a verification routine
  (`packages/platform-ports/src/runtime-state-port.ts:37-41,100-117`); the Postgres adapter issues no
  UPDATE/DELETE against `rs_audit` (`postgres-runtime-store.ts:14-18,60-67`).
- Chain head anchored out-of-band to stdout → Cloud Logging (`server.ts:956-960`).
- Consent write and its audit record commit in one transaction (`runtime-consent-store.ts:67-80`).
- Whole-tenant erasure **throws** `NotImplemented` rather than silently no-op-ing, so a caller can never
  mistake "not implemented" for "already erased" (`erasure.ts:138-144`). This is a fail-loud guard, not an
  erasure capability — see §7 item 3.

> ⚠️ Two controls that a previous draft of this section listed have been **moved to §7**, because they sit
> on code paths that no route reaches and so cannot be represented as operative today:
> (a) the fail-closed erasure enumeration `enumerateSubjectOrFail` (`erasure.ts:44-54`), whose only callers
> are `withdrawConsent1`/`withdrawConsent2` — which nothing calls (§7 item 4); and (b) "special-category
> facts never migrate to an account without account-level Consent 2" (`merge.ts:55`), which lives in
> `mergeGuestIntoAccount` — also uncalled (§2, §7 item 13). We verified by searching all of `packages/` that
> the only references to any of these four symbols are their definitions, the `index.ts` re-export, and
> tests.

**Availability / abuse control**
- Operator kill switch halts memory writes on `/chat` (`server.ts:913`) and returns 503 on `/consent`
  (`server.ts:631-634`) and `/forget` (`server.ts:697-700`).
- Per-IP and per-tenant rate limits on `/consent` and `/forget` (`server.ts:590-599,619-627,661-670,687-694`).
  **Each of these four checks fails OPEN** — a store error is caught and the request proceeds
  (`server.ts:597-599,625-627,668-670,692-694`), a deliberate availability trade-off. They are throttles,
  not access controls, and under store distress they provide no limit at all.
- Feature-level inertness: the double gate cannot be flipped by configuration alone (`flag.ts:1-18`).

## 7. Security measures **NOT implemented today** (open items — must not be represented as in place)

Each item below is a gap in the code as of commit `fea7c0d`. Where an item says engineering intends to
close it, that is a statement of intent recorded in this document only: **there is no numbered go-live
tracker in this repository that counsel could inspect**, so this list is the reference.

1. **Encryption at rest for special-category facts.** ADR-0015 Invariant 9 calls for it; there is **no
   encryption anywhere in `packages/widget-memory`** (searched the package for `encrypt`/`crypto` — the only
   `node:crypto` uses are `randomUUID`, `randomBytes` and the audit `sha256`: `service.ts:1`,
   `identity.ts:1`, `audit.ts:1`). Application-layer AES-256-GCM exists elsewhere in the codebase
   (`packages/widget-backend/src/customer-grant-store.ts:28-48`, for OAuth grants) and is **not** applied to
   memory facts. Nothing in these drafts, in the widget copy, or in the merchant's own notice may state or
   imply that memory facts — of either class — are encrypted at rest. Intended before enablement; see
   **Q16**.
2. **Durable, portable fact storage.** Only the in-memory `VectorPort` adapter exists (`vector-port.ts:117`),
   so there is no at-rest storage layer to encrypt, back up, or reason about yet — and no basis for
   representing retention, deletion, or backup handling as applying to durable data. A durable adapter is in
   development on a separate branch that is **not merged**; it is not part of the code this addendum
   describes. See **Q11**.
3. **Whole-tenant erasure.** `eraseTenant` throws `NotImplemented` (`erasure.ts:138-144`) — there is no
   "delete every subject under this merchant" operation, which is what a controller offboarding/termination
   clause would need.
4. **Erasure-first consent withdrawal.** `withdrawConsent1` / `withdrawConsent2` exist (`erasure.ts:77-126`)
   but **no route calls them**; `POST /consent` only records the choice (`server.ts:643`). Their
   fail-closed enumeration guard `enumerateSubjectOrFail` (`erasure.ts:44-54`) is consequently also
   unreachable — it is a property of code that does not run, and must not be counted as a live safeguard.
   See **Q6**.
5. **Data-subject access / portability for memory.** No route returns a subject's stored facts. See **Q7**.
6. **Scheduled retention sweep.** `sweepExpired` (`retention.ts:69-100`) has no caller in serving code; the
   `store.sweepExpired()` at `server.ts:964` is the *runtime KV* sweep, a different mechanism. Expiry is
   enforced on read (`service.ts:154`), so expired facts are not served — but they are not yet deleted.
7. **Authentication on the memory endpoints in the default configuration.** `WIDGET_AUTH_REQUIRED` defaults
   to `false` (`server.ts:260`); with it off, `/consent` and `/forget` accept unauthenticated calls and fall
   back to `RUNTIME_TENANT = "demo"` (`server.ts:54,614-618,679-684`). Two consequences carry into §6: the
   per-merchant isolation guarantee is not in force for untokenized requests, and a `POST /consent` consent
   record can be written by anyone who presents a well-formed anonymous id. Intended to be enforced before
   enablement; see **Q4**.
8. **Per-shopper region determination.** `MERCHANT_REGION` is a deploy-level env var defaulting to `"us"`
   (`server.ts:293-296`), with an in-code note that it "should become geo-derived from the request". See
   **Q10**.
9. **Per-merchant memory on/off control.** `memoryServiceEnabled` is process-wide (`server.ts:200`); there is
   no per-tenant toggle. ADR-0015 lists this as still open ("Merchant control").
10. **Retention limits on consent records and audit entries.** `recordConsent` writes with no TTL
    (`runtime-consent-store.ts:68`), and the audit log is append-only by design — both outlive the 30-day
    fact TTL. `POST /forget` does not clear the consent record (`server.ts:708`). See **Q9**.
11. **Row-level security, the audit-table GRANT, and tamper-proof audit.** RLS and the INSERT-only GRANT are
    documented as *deploy/infra* obligations, not enforced by this code
    (`postgres-runtime-store.ts:13-18,65-67`). We have not verified any deployed database configuration —
    that is outside this repo. Relatedly, the hash chain is **tamper-evident, not tamper-proof**: in-place
    mutation, reorder, mid-chain removal and naive insertion are caught by `verifyAudit`, but
    tail-truncation and a full re-hash are not detectable from the chain alone, because no secret is stored
    (`runtime-state-port.ts:98-104`). "Immutable audit log" should be read with that qualification
    throughout this addendum.
12. **Contractual/operational measures** (breach notification timelines, SCCs/transfer mechanism, audit
    rights, sub-processor change notice, residency commitments, retention of backups) exist nowhere in code
    and must be drafted from scratch — `provisions-brief.md` §4 sketches the shape.
13. **Guest → account merge safeguards.** `mergeGuestIntoAccount` drops special-category facts unless the
    **account** has `consent2 === "in"` (`merge.ts:55`), but **no route calls the function** (§2), so that
    safeguard is not operative and the account tier is unreachable. See **Q15**.

## 8. Retention

- Facts: **30 days measured from last activity**, both classes equal, as a **sliding** window — renewal
  throttled to once/day and separately audited (`retention.ts:20-31,33-37,45-48`; `service.ts:158-168`).
  **This is not a 30-day cap:** an actively returning shopper's fact can be held well beyond 30 days from
  first capture, for as long as they keep returning, and there is **no absolute ceiling** in the code (see
  **Q2**). Any retention clause must be drafted as "30 days of inactivity", not "30 days".
- **As wired today the sliding renewal can never fire.** Renewal requires `consent1`/`consent2 === "in"` on
  the recall context (`service.ts:164`), but the only production caller — the memory-port adapter at
  `packages/widget-backend/src/server.ts:218-231` — hardcodes both to `"unknown"` (`server.ts:227-228`),
  and the brain's recall port carries no consent field (`packages/widget-brain/src/types.ts:137-139`,
  called at `brain.ts:1127`); those are the only two non-test `.recall(` call sites in `packages/`. So on
  the current wiring retention would be a fixed 30 days from write, and no `ttl_renew` audit would ever be
  emitted. The gap is a few lines of wiring, so counsel should be told which model to commit to
  contractually; this addendum describes the sliding model because that is what the ADR amendment and the
  memory package specify, but that is an assumption, not a verified deployment fact.
- Enforcement is on read today; deletion depends on the unscheduled sweep (§7 item 6).
- **There is no durable at-rest store, so none of the above yet describes durable data** (§0, §7 item 2).
- Consent records and audit entries: unbounded (§7 item 10).
- On termination/offboarding: no whole-tenant erasure exists (§7 item 3), so a "delete or return on
  termination" clause has no implementation behind it yet.

## 9. Assistance with data-subject requests

| Right | Status |
|---|---|
| Erasure ("forget me") | Implemented per subject, audited, and reachable even while the feature is off (`server.ts:655-659,708`; `erasure.ts:63-69`). **Not a durable-deletion guarantee today:** it deletes from the in-memory store held by the instance that receives the call (§0, §7 item 2), and it does not clear the subject's consent record (§7 item 10). |
| Withdrawal of consent | Recorded and forward-effective; **does not purge** (§7 item 4) |
| Access / portability | Not implemented (§7 item 5) |
| Objection / restriction | No dedicated mechanism beyond withdrawal + erasure |
| Rectification | No mechanism (a wrong remembered fact can only be erased wholesale) |
| Merchant-initiated bulk erasure | Not implemented (§7 item 3) |

## 10. Audit and evidence available to a controller

Per-action audit entries with hashed subject reference, class and count (`audit.ts:11-64`) for:
`consent.granted`, `consent.withdrawn`, `write.ordinary`, `write.special`, `recall`, `erase.subject`,
`erase.tenant`, `merge`, `ttl_sweep`, `ttl_renew`. Plus `consent.record` from the consent store
(`runtime-consent-store.ts:72`). Chain integrity is verifiable (`runtime-state-port.ts:109-117`) and anchored
out-of-band (`server.ts:956-960`). There is **no controller-facing UI or API** to read these today — access
is operator-side only.
