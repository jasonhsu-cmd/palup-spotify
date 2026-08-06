# Human-in-the-Loop (HITL) Boundary Policy

This is the definitive list of what an agent may do on its own versus what must route to a
human via the **Approval Center**. Both the merchant-side and PalUp-side agents follow the
same shape; only the "who approves" differs. When a case is ambiguous, treat it as
**requires approval**.

## 1. The rule in one sentence

> Agents may act freely on **reversible, low-stakes, in-policy** actions and must get human
> approval for anything that changes **money, model, or business model** — i.e. revenue,
> margin, pricing, marketing/ROI spend, the business model, or an agent's own autonomy.

## 2. Merchant plane (agent acts for a Shopify merchant; **merchant** approves)

**Auto-allowed (act, then log):**
- Answering customer questions in live chat / email within policy.
- Drafting content, campaign ideas, and upsell suggestions (proposing ≠ launching).
- Routine customer nurture messages within pre-approved templates and frequency caps.
- Tagging, segmenting, and updating internal CRM notes.
- Read-only Shopify operations (looking up orders, inventory, customer history).

**Requires merchant approval:**
- Anything changing **price, discounts, or promotions**.
- **Launching** a marketing campaign or paid spend / changing ad budget.
- Changes to the merchant's **sales or marketing ROI** posture or business model.
- Issuing refunds, cancellations (incl. **subscription cancel** — it ends recurring revenue),
  or anything moving money.
- Contacting customers outside approved templates/frequency, or new outreach channels.
- Any action that materially affects the merchant's revenue.
- Changing the agent's own behavior scope (autonomy escalation).

> **Subscription skip/pause — classification approved (owner jason.hsu@framy.co, 2026-07-31),
> NOT yet enacted.** A reversible skip/pause *defers* a shipment/charge and never ends the plan or
> moves money now, so per §1 it belongs in "auto-allowed" — the owner has approved that classification.
> It is **not enacted**: the enforcement controls it relies on do not exist yet — a per-request
> **verified shopper identity** (today the widget authenticates only the merchant; the shopper is
> anonymous and `shopperId` is a constant), an **audited** autonomous action with a real reversal path,
> an **executable reversal** capability on the port, and a **skip cap / idempotency**. Both governance
> reviewers returned **BLOCK** on an un-preconditioned build. Until those prerequisites land and
> `security-reviewer` + `agent-evolution-steward` sign off, subscription **skip/pause is human-routed,
> exactly like cancel**. Design + prerequisites: `docs/adr/0016-subscription-skip-pause-selfserve.md`.

## 3. PalUp plane (agent acts for PalUp; **PalUp administrator** approves)

**Auto-allowed (act, then log):**
- Responding to prospect/merchant questions in chat/email within policy.
- Drafting outreach, growth-campaign ideas, and expansion (upsell) suggestions.
- Routine support resolution within playbooks.
- Read-only analytics and pipeline updates.

**Requires administrator approval:**
- Anything affecting **PalUp's profit margin**.
- **Pricing/plan** changes, discounts, or offers to merchants.
- Launching paid acquisition spend or changing **sales/marketing ROI** posture.
- Changes to **PalUp's business model** or moat strategy.
- Collecting or altering **revenue** flows.
- Autonomy escalation for any PalUp-side agent.

## 4. Monitoring plane (self-healing)

**Auto-allowed (self-recover / self-optimize):**
- Restart, retry, reroute, scale, cache, and revert failed components.
- Apply non-cost-changing performance and reliability fixes.
- Contain security incidents (isolate, rotate short-lived creds, block) — then alert.

**Requires administrator approval:**
- Any fix or optimization that **changes cost** or resource spend beyond budget policy.
- Anything that changes the **business model**, margin, or ROI.
- Anything that changes an agent's autonomy or a policy boundary.

## 5. Evolution boundary (ties to `docs/AGENT-GOVERNANCE.md`)

- Proposing / shadow / canary of an agent change: **auto-allowed** (contained, reversible).
- **Promotion** of any agent behavior/prompt/model change to real users: **requires human
  approval** — always.
- Removing or weakening a gate, or granting an agent self-promotion: **prohibited** (not
  even approvable through the normal flow; requires an explicit policy change with security
  signoff).
- A governed auto-promote carve-out for opted-in tenants (`VALUE_VOICE_PROACTIVITY` only) is
  **proposed** in `docs/adr/0014-merchant-opt-in-governed-auto-optimize.md` — **not enacted**
  (both gate agents returned BLOCK). Until that ADR is Accepted with the recorded steward +
  security sign-offs and its preconditions met, **human approval is never skipped** for any
  agent behavior/prompt/model change to real users.

> **Shopper-disposition persona layer (`DISPOSITION_STYLE` flag) — NOT yet flipped, no owner assigned
> (governance BLOCK closure, Finding 12, 2026-08-04).** `packages/widget-brain`'s persona-STYLE
> (PR-3/5/7/8) and persona-ROLE (PR-3 deferred follow-up) directives both ship behind the SAME
> `DISPOSITION_STYLE` posture flag, default OFF (inert — no production call site enables it; no
> `DISPOSITION_STYLE` env read exists anywhere in the repo). The flag now gates TWO accumulated
> behavior axes (service/guidance STYLE voice, and buyer ROLE voice + the reused b2b escalation rung),
> added across separate PRs without a single combined-surface review at flip time. Flipping it for any
> tenant is a run-time agent behavior/prompt change and is governed exactly like every other promotion
> under §5 above: it requires a named human owner and explicit Approval Center sign-off *before*
> enablement. **Neither has happened.** No env wiring, ADR, or runbook exists for the flip today — this
> note exists only to make that gap visible, not to authorize it.

> **Catalog retrieval (`CATALOG_RETRIEVAL` flag) — NOT yet flipped, no owner assigned (E1).**
> `packages/widget-brain` can narrow the CATALOG block of its system prompt to the top-k candidates a
> `CatalogRetrieverPort` returns for the shopper's turn, instead of rendering the merchant's whole
> catalog. That changes **what the agent sees and therefore what it says**, so it is a run-time
> behaviour/prompt change governed by §5 exactly like any other promotion: eval gate → shadow → canary →
> **named human approval** → promote. **None of that has happened.**
> Its inertness is structural, not just a default: the flag defaults OFF, **no `CATALOG_RETRIEVAL` env
> read exists anywhere in the repo**, and `widget-backend/src/server.ts` **does not construct the
> retriever at all**, so flipping a flag alone cannot turn it on — enabling it requires a deliberate
> composition change reviewed as part of the promotion. With it off, the prompt, every `Decision` and
> every reply are byte-identical to before the change (pinned by
> `packages/widget-brain/test/retrieval-flag-off.test.ts` against a golden captured on the prior commit).
> Two things a reviewer must weigh **at flip time**, neither settled here: retrieval **quality** (no
> recall/latency number in this repo is real — the fakes say nothing about semantic retrieval), and the
> fact that a narrowed catalog is a **partial** one, mitigated in-prompt by a rule forbidding "we don't
> carry that" from mere absence but not eliminated.

> **Product citations (`PRODUCT_CITATIONS` flag) — NOT yet flipped, no owner assigned (E2).**
> `packages/widget-brain` can prefix each rendered CATALOG line with a per-turn citation tag
> (`[P<n>-<nonce>]`), instruct the model to copy the tag for any product it names, then resolve the tags
> back to product ids, strip every tag out of the reply, and attach the survivors to
> `Decision.recommendedProducts`. These are **internal bookkeeping tags, stripped before the shopper sees
> the reply** — *not* the Tier-3 source citations for external claims that
> `docs/design/shopper-widget.md` §"Full (web-enabled)" describes, which remain unbuilt (no web port
> exists). That adds a rule to the system prompt and asks the model to produce
> something it does not produce today, so it **changes what the agent says** and is a run-time
> behaviour/prompt change governed by §5 exactly like any other promotion: eval gate → shadow → canary →
> **named human approval** → promote. **None of that has happened.**
> Its inertness is structural, not just a default: the flag defaults OFF, **no `PRODUCT_CITATIONS` env
> read exists anywhere in the repo**, and `widget-backend/src/server.ts` is **unchanged** (its
> `createBrain` call passes seven positional arguments and never reaches this one), so flipping a flag
> alone cannot turn it on. With it off, the prompt, every `Decision` and every reply are byte-identical to
> before E1 *and* E2 — `packages/widget-brain/test/citations-flag-off.test.ts` re-runs E1's 37-probe
> golden, which was captured on the commit before E1's implementation existed, through a recording model
> port (so the system prompt itself is inside the assertion).
> Three things a reviewer must weigh **at flip time**, none settled here:
> (1) **Nothing here measures whether citing helps.** No real model has been run against this; the tests
>     use a scripted model whose reply the test chooses. Citation *rate* and any effect on reply quality
>     are unknown until the eval gate runs on a real model.
> (2) **The field UNDER-REPORTS by construction.** A model that recommends a product in prose without
>     copying its tag yields no entry, so `recommendedProducts` is a lower bound, never complete coverage.
>     It is pinned as a defect by a test, not papered over.
> (3) **It is not a billing basis.** Chaining `recommended → clicked → purchased` off this field is
>     last-touch attribution, which **ADR-0007 §2 and `docs/PRICING.md` §2 forbid as a fee basis**. Any
>     use of it in the outcome ledger would itself be a money/business-model boundary crossing.

> **Product cards (`PRODUCT_CARDS` flag) — NOT yet flipped, no owner assigned (E3).**
> `packages/widget-brain` can attach the display fields (title, price, three-state availability) of each
> product a reply CITED to `Decision.recommendedProductCards`, and `packages/widget-backend` forwards
> both that and E2's `recommendedProducts` onto the `/chat` response, plus
> `TelemetryEvent.recommendedProductIds` onto the per-turn telemetry row. The widget renders the cards as
> an aside below the reply. That puts **new content on a shopper's screen**, so it is a run-time
> behaviour change governed by §5 exactly like any other promotion: eval gate → shadow → canary →
> **named human approval** → promote. **None of that has happened.**
> Its inertness is structural: the flag defaults OFF, **no `PRODUCT_CARDS` env read exists anywhere in the
> repo**, and although `server.ts` **is** changed here (E2 deferred this and E3 cannot), the change is two
> spreads of functions that return `{}` unless the `Decision` already carries cited products — which this
> composition root cannot produce, because its `createBrain` call still passes seven positional arguments
> and never reaches either flag. Byte-identical when off is proven **twice**: at the brain, by re-running
> E1's 37-probe golden (`widget-brain/test/cards-cart-flag-off.test.ts`), and **on the wire**, by
> `widget-backend/test/chat-wire-flag-off.test.ts` against a golden of the verbatim `/chat` response bytes
> and telemetry rows captured on the commit before this implementation existed.
> Three things a reviewer must weigh **at flip time**, none settled here:
> (1) **It is not a billing basis** — the same prohibition as E2's ids, now with a second consumer. A
>     `recommended → clicked → purchased` chain off `recommendedProductIds` is last-touch attribution,
>     which **ADR-0007 §2 and `docs/PRICING.md` §2 forbid as a fee basis**; introducing one would itself
>     be a money/business-model boundary crossing. `rollupEvents` deliberately does not aggregate the
>     field, so no headline number can appear by accident.
> (2) **The cards UNDER-DISPLAY and the telemetry UNDER-COUNTS**, inheriting every limit of the citation
>     mechanism: a model that recommends in prose without copying its tag yields nothing, and citations
>     are minted only on the clean sales path, so a proactive exit-intent turn reports nothing at all. A
>     shopper seeing three cards has been shown what the reply *cited*, not what it recommended.
> (3) **The label is deliberately weaker than the field name.** The prompt rule tags anything the model
>     "recommends, names, or discusses", so a product the agent talked the shopper *out* of is in the
>     list. The heading therefore reads "Mentioned in this reply", never "Recommended for you", and a
>     card is neither a link nor an add-to-cart (`Product` carries no url and this system has no
>     checkout). Any reviewer widening that copy is making a **capability claim** and owns it.

> **Cart line items (`CART_LINE_ITEMS` flag) — NOT yet flipped, no owner assigned (E4).**
> `packages/widget-brain` can render what is actually in the shopper's cart into its system prompt as a
> fenced DATA block, instead of knowing only the coarse `"empty" | "has_items" | "high_value"` enum. That
> changes **what the agent sees and therefore what it says**, so it is governed by §5 exactly like any
> other promotion: eval gate → shadow → canary → **named human approval** → promote. **None of that has
> happened.**
> Its inertness is structural at **two** layers, and deliberately so: the brain flag defaults OFF, the
> `deriveServingSignals` gate (`ctx.cartLineItemsEnabled`) defaults OFF **and `server.ts` does not pass
> it**, so a client-posted `signals.cartItems` is not even parsed in production. **No `CART_LINE_ITEMS`
> env read exists anywhere in the repo.** Byte-identical when off is proven in the strong form: E1's
> golden is re-run with `signals.cartItems` **supplied on every probe**, which shows the signal is
> ignored rather than merely absent.
> Three things a reviewer must weigh **at flip time**, none settled here:
> (1) **Cart contents are client-supplied** — no port in this repo exposes a cart. The mitigation is that
>     the accepted shape is ids and quantities only (no field a shopper can put prose into), every id is
>     resolved against the merchant's live catalog and dropped if absent, and the cart STATE is
>     re-derived server-side with only `empty`/`has_items` reachable, so a `high_value` treatment cannot
>     be manufactured from line items. What this does **not** close: the pre-existing bare
>     `cart: "high_value"` enum a client can still send with no line items — behaviourally inert today
>     (`selectPitch` treats it identically to `has_items`) but a real, separate gap, left alone because
>     tightening it would change flag-off behaviour.
> (2) **A resolved cart is a PARTIAL view.** An unresolvable id is dropped, so the prompt declares itself
>     incomplete and forbids reasoning from absence — #180's lesson, mitigated in-prompt but not
>     eliminated.
> (3) **Nothing here measures whether it helps.** No real model has been run against a cart block; the
>     tests use a recording model whose reply is fixed. Whether richer cart context improves the reply,
>     or merely lengthens the prompt, is unknown until the eval gate runs on a real model.

## 6. How this is enforced in code

- Every agent action is classified against this policy before execution. Boundary-crossing
  actions are converted into **Approval Center proposals** with a reversible plan, not
  executed.
- The `hitl-approval-gate` skill (`.claude/skills/hitl-approval-gate/`) gives Claude Code a
  checklist for wiring this correctly whenever it builds or edits agent-action code.
- The `/governance-check` command runs before merging anything that might touch a boundary.
- The Approval Center, Automation Rules, and Audit Log in both consoles are the human-facing
  surfaces for this policy.

## 7. Default when unsure

If you cannot confidently place an action in "auto-allowed," it is "requires approval."
Reversibility and stakes decide; cost, model, and business-model impact always decide
toward a human.

## 8. Statutory obligations — the one case §7 cannot decide

§7 resolves ambiguity toward a human. That is right for every *discretionary* action, and wrong
for one class: an obligation **the law imposes on us with a deadline**, where not acting is
itself the violation. A GDPR erasure is the live example — `customers/redact` and `shop/redact`
carry a **30-day** completion requirement (Shopify's privacy-law compliance docs), so "queue it
for a human" is not a safe default. If nobody answers, we have broken the law rather than
avoided a risk.

**The distinction that resolves it:** the agent is not *choosing* to delete. The law is. So the
human decision that §7 is reaching for does not exist here — there is no "may we?" to approve.
What a human is genuinely needed for is different, and narrower:

1. **Whether we can meet the obligation at all.** Our erasure is partial today (`eraseTenant`
   throws `NotImplemented`; a guest namespace is `randomBytes(16)` and cannot be named from a
   Shopify customer id; the traffic log is not keyed by `anonId`). A request we cannot fully
   satisfy is a legal exposure a person must know about.
2. **Anything the erasure would take with it** that is not the subject's — blast radius.
3. **A dispute** about whether the requester is who they claim to be.

**Therefore:**

- An action that is **statutorily mandated, deadline-bound, and scoped to the requester's own
  data** is **auto-allowed to proceed**, and must be **recorded as an obligation** the moment it
  arrives — with its deadline, what was done, and **what could not be done** — never silently
  dropped and never blocked on a human who may not answer.
- The obligation record is the human's entry point: it is **visible before the deadline**, and a
  human may intervene, but their **non-response cannot cause a breach**.
- **Everything else about customer data stays under §7.** A deletion we chose, a bulk operation,
  anything crossing beyond the requester's own data, or anything whose scope we cannot bound —
  those still require approval. This section is a narrow carve-out for *compelled* acts, not a
  general licence over customer data.
- **It never widens autonomy.** A statutory obligation can only compel the *minimum* act the law
  requires. It is not a reason to delete more, to act faster than the deadline demands, or to
  skip an audit record.

**Status: DRAFTED, NOT ENACTED.** This resolves a gap found while building the GDPR webhooks
(the handlers already defer-with-a-dated-obligation rather than dropping or executing blindly),
but it is a policy decision with legal consequences and it needs the named owner's sign-off — and
should have counsel's eye on the 30-day figure and on point 1's exposure. Until then, treat the
webhook handlers' current behaviour as the interim position, not as policy.

