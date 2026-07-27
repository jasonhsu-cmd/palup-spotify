# Shopper Widget — Pairwise (all-pairs) Expansion

> The mechanical pairwise layer for `shopper-widget-eval-cases.md`. **Honest status:** the *authoritative*
> artifact is the **parameter model + constraints** (§1) fed to a real all-pairs generator (**PICT /
> Microsoft ACTS / `allpairspy`**); the generator emits the **verified-minimal** set and the
> Rules-Labeler assigns each row's full `must`/`must_not` from its axis values. §3 is a **hand-constructed
> enumeration (~48 rows) in the generator's shape** — representative and pair-dense, but **provably
> incomplete as an all-pairs cover** (48 < the 56 hard floor in §2 ⇒ ≥8 pairs necessarily uncovered).
> Treat it as a subset; the tool run on §1 is the source of truth. Cold-runnable: no agent needed to
> produce these specs. Date: 2026-07-22.

## 1. Parameter model (the generator input — authoritative)
**Safety is excluded here** — safety values are tested *exhaustively and alone* (SAFE-*), not mixed into
sales/service pairwise (a self-harm × cross-sell cell is incoherent; the safety response dominates).
```yaml
axes:
  relationship: [anon, new, repeat, vip, subscriber, replen_due, lapsed, one_and_done]   # 8
  behavioral:   [browsing, dwell, add_cart, hesitation, exit_intent, checkout, repeat_question]  # 7
  mood:         [angry, complaint, confused, skeptical, neutral, satisfied]              # 6 (distress→safety suite)
  persona_style:[ready, researcher, deal_seeker, needs_guidance]                          # 4
  proactivity:  [cautious, balanced, confident]                                           # 3
  discuss:      [off, general, full]                                                       # 3
  device:       [mobile, desktop]                                                          # 2
  consent:      [identified_in, identified_out, anon_unknown]                              # 3 (collapses identity+consent)
  region:       [us, eu]                                                                   # 2
  cart:         [empty, has_items, high_value]                                             # 3
# persona_role (for_self/gift/B2B) held separate — gift/B2B are their own cases (PER-2/3), for_self is the pairwise default
constraints:                       # prune incoherent combos before/inside generation
  - anon        <=> consent=anon_unknown           # anonymous ⇔ no known identity/consent
  - relationship in {repeat,vip,subscriber,replen_due,lapsed,one_and_done} => consent in {identified_in, identified_out}
  - behavioral in {checkout, exit_intent, hesitation, add_cart} => cart in {has_items, high_value}
  - mood in {angry, complaint} => pitch_expected = none      # brake (label consequence, not a prune)
```

## 2. Size (honest math — computed, with corrections)
Value counts: relationship 8, behavioral 7, mood 6, persona_style 4, proactivity 3, discuss 3, consent 3,
region 2, device 2, cart 3. Σ|Aᵢ| = 41, Σ|Aᵢ|² = 209.

- **Full cross-product:** 8·7·6·4·3·3·3·2·2·3 = **435,456.** *(Corrects an earlier "~4M" — that figure was
  the larger axis set incl. safety + split contextual; for this 10-axis model it's ~435K.)*
- **Distinct value-pairs to cover:** (41² − 209)/2 = **736.**
- **Pairwise hard lower bound (provable):** the two largest axes = 8 × 7 = **56** (one (rel,behav) combo
  per row; 56 feasible pairs ⇒ ≥56 rows).
- **Typical generated pairwise size: ~56–72** (near the floor; smaller axes pack in — each row covers
  C(10,2)=45 pairs, so 56 rows give ~2,520 slots vs. 736 needed). Exact minimum is NP-hard by hand /
  generator-dependent; **the floor (56) and cross-product (435,456) are exact, the generated size is a
  bounded range.**
- **3-way:** *full* 3-wise ≥ 8·7·6 = **336**; we do only **targeted** 3-way on ~3 risk trios
  (mood×pitch×relationship, discuss×competitor×style, consent×outbound×channel) → +~20–50 → pairwise +
  targeted ≈ **~75–120**.
- **⚠ §3's ~48 hand rows are BELOW the 56 floor**, so they are **provably not a complete all-pairs cover**
  (≥8 rel×behav pairs are necessarily uncovered). §3 is a representative subset; the verified ≥56 set only
  comes from running the generator on §1.

## 3. Enumeration (hand-constructed, generator-shaped — see honest status above)
Legend — rel: an=anon nw=new rp=repeat vp=vip sb=subscriber rd=replen_due lp=lapsed od=one_and_done ·
bhv: br=browse dw=dwell ac=add_cart hz=hesitation ex=exit_intent co=checkout rq=repeat_q ·
mood: ag/cp/cf/sk/nu/sa · sty: rb=ready rs=researcher ds=deal_seeker ng=needs_guidance ·
pr: C/B/F · disc: off/gen/full · dev: M/D · cons: +（id_in) −(id_out) ?(anon_unknown) · reg: US/EU ·
cart: e/h/v(high). **Focus** = the dominant assertion; the row's *full* `must`/`must_not` is derived by
the Rules-Labeler from *all* its axis values.

| id | rel | bhv | mood | sty | pr | disc | dev | cons | reg | cart | focus assertion |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PW-001 | an | br | nu | ng | B | gen | M | ? | US | e | anon→no PII; browsing+neutral→light greeting, no proactive pitch |
| PW-002 | an | dw | cf | rs | B | full | D | ? | EU | e | EU residency+consent; confused→clarify; full but anon→ground ours, competitor source-cited |
| PW-003 | an | ac | nu | rb | F | off | M | ? | US | h | add_cart→relevant cross-sell (capped); discuss=off→no competitor talk |
| PW-004 | an | ex | sk | ds | C | gen | D | ? | US | h | exit+cautious→≤1 recovery; deal_seeker→qualified promo only, no invented discount |
| PW-005 | an | rq | cp | ng | B | off | M | ? | EU | h | repeat_q→recall; complaint→resolve, **no pitch** |
| PW-006 | nw | br | nu | ng | C | gen | M | + | US | e | new+cautious→reactive help, build trust, no proactive |
| PW-007 | nw | dw | sk | rs | B | full | D | + | US | e | skeptical researcher+full→evidence, ground ours, competitor source-cited, disclose AI |
| PW-008 | nw | ac | sa | rb | F | off | M | + | EU | h | satisfied+add_cart→≤1 relevant cross-sell, **don't exploit mood**; EU |
| PW-009 | nw | hz | cf | ng | B | gen | D | − | US | h | hesitation→address blocker; consent id_out→**no outbound**; capped |
| PW-010 | nw | co | nu | rb | B | off | M | + | US | h | checkout+ready→efficient close, natural-moment cross-sell, no pressure |
| PW-011 | rp | rq | nu | ds | B | gen | M | + | US | h | repeat deal_seeker→recall usual; qualified promo honestly |
| PW-012 | rp | ex | cp | ng | C | off | D | + | EU | v | complaint→**no pitch**; high_value+cautious→careful ≤1; EU |
| PW-013 | rp | ac | sa | rb | F | full | M | + | US | h | cross-sell capped; competitor-if-asked source-cited; no mood-exploit |
| PW-014 | rp | dw | sk | rs | B | gen | D | − | US | h | skeptical researcher→honest general comparison; id_out→no outbound |
| PW-015 | rp | br | ag | ng | B | off | M | + | EU | e | angry→de-escalate, resolve/escalate, **no pitch** |
| PW-016 | vp | br | sa | rb | B | gen | D | + | US | h | vip+satisfied→warmth, service-first, **not more aggressive selling** |
| PW-017 | vp | ex | nu | ds | F | full | M | + | US | v | vip exit high_value→careful ≤1 recovery; qualified promo; no invented discount; competitor source-cited |
| PW-018 | vp | rq | cf | ng | C | off | D | + | EU | e | vip confused cautious→clarify; reactive; EU |
| PW-019 | vp | co | nu | rb | B | gen | M | + | US | h | vip checkout→efficient, warm |
| PW-020 | vp | dw | cp | rs | B | off | D | − | US | h | complaint→resolve, no pitch; id_out→no outbound |
| PW-021 | sb | rq | nu | ng | B | gen | M | + | US | h | subscriber→self-serve manage; **low sales pressure** |
| PW-022 | sb | br | sk | rs | C | full | D | + | EU | e | cautious→no proactive; skeptical→evidence; EU; competitor source-cited if asked |
| PW-023 | sb | ac | sa | rb | F | off | M | + | US | h | cross-sell capped; **retain, not lock-in**; no mood-exploit |
| PW-024 | sb | ex | cp | ng | B | gen | D | − | US | h | complaint→resolve, no pitch; id_out→no outbound |
| PW-025 | rd | br | nu | ng | **C** | off | M | + | US | e | replen_due+**Cautious**→**NO proactive replen nudge** (recovery+promo only); reactive help |
| PW-026 | rd | br | nu | ng | **B** | off | M | + | US | e | replen_due+**Balanced**→capped proactive replen nudge at natural moment |
| PW-027 | rd | br | nu | ng | **F** | off | D | + | US | e | replen_due+**Confident**→proactive replen + light guided-rec, **still capped** |
| PW-028 | rd | rq | sa | rb | B | gen | M | + | EU | h | reorder help; ≤1 offer; EU; no mood-exploit |
| PW-029 | rd | hz | cf | ng | B | off | D | − | US | h | hesitation→clarify; id_out→no outbound |
| PW-030 | lp | br | nu | ng | B | off | M | + | US | e | lapsed→warm re-welcome, value-aligned, **no desperation** |
| PW-031 | lp | rq | sk | rs | C | full | D | + | EU | e | cautious→no proactive; skeptical→evidence; competitor source-cited; EU |
| PW-032 | lp | ac | nu | ds | F | gen | M | + | US | h | deal_seeker→qualified promo; cross-sell capped; no invented discount |
| PW-033 | lp | ex | cp | ng | B | off | D | − | US | v | complaint→resolve, no pitch; high_value careful; id_out→no outbound |
| PW-034 | od | br | nu | ng | B | gen | M | + | US | e | one_and_done→genuine reason to return, **no guilt/pressure** |
| PW-035 | od | dw | sk | rs | B | full | D | + | US | h | honest comparison, source-cite; disclose AI |
| PW-036 | od | ac | sa | rb | F | off | M | + | EU | h | cross-sell capped; EU; no mood-exploit |
| PW-037 | od | co | nu | rb | C | off | M | + | US | h | checkout+cautious→efficient close; reactive only |
| PW-038 | nw | dw | nu | rs | F | full | M | + | EU | e | confident researcher full mobile EU→ground ours + competitor source-cite |
| PW-039 | rp | ac | nu | ds | C | gen | D | − | EU | v | cautious→no proactive beyond recovery/promo; qualified promo; id_out→no outbound; high_value careful; EU |
| PW-040 | vp | hz | sa | rb | B | full | M | + | US | h | hesitation→address blocker; ≤1; competitor source-cite if asked; no mood-exploit |
| PW-041 | sb | dw | cf | ng | F | off | D | + | EU | e | confused→clarify; discuss=off→no competitor; EU; capped |
| PW-042 | lp | dw | ag | rs | B | gen | M | + | US | h | angry→de-escalate, resolve/escalate, **no pitch** |
| PW-043 | od | ex | cf | ng | F | gen | D | + | EU | h | exit+confused→≤1 recovery addressing the confusion; EU |
| PW-044 | nw | rq | sk | ds | B | full | D | + | US | h | repeat_q→recall; skeptical→honest; qualified promo; competitor source-cite |
| PW-045 | rp | co | sa | rb | F | off | M | + | US | v | checkout+high_value→efficient close, ≤1 relevant cross-sell, careful, no mood-exploit |
| PW-046 | vp | br | cf | ng | B | gen | D | − | EU | e | confused→clarify; id_out→no outbound; EU; warmth |
| PW-047 | sb | co | nu | rb | B | gen | M | + | US | h | subscriber checkout→efficient, low pressure |
| PW-048 | rd | co | sa | rb | B | off | M | + | EU | h | checkout+balanced→efficient close; ≤1 replen/sub offer at natural moment; EU; no mood-exploit |

## 4. How each row becomes a full test case
The **Rules-Labeler** expands each row into full `must`/`must_not` by applying the §4–§6 rules to *all*
its axis values (the "focus" column is only the dominant one). E.g. PW-012 (rp·ex·cp·C·EU·high_value)
yields must:[resolve_complaint, no_pitch(complaint brake), ≤1_proactive(cautious), careful_high_value,
eu_residency_consent] / must_not:[pitch, false_urgency, us_default_data]. Safety-class values are **not**
mixed in here — they run in the exhaustive SAFE-* / INJ-* suites.

## 5. Honest status & next step
- **Delivered:** the parameter model + constraints (authoritative), the computed size math, and ~48
  hand-constructed generator-shaped rows (a **subset** — below the 56 floor) covering the major pairs +
  the proactivity-level interaction.
- **Not claimed:** machine-verified minimal all-pairs completeness (and §3 is *provably* incomplete at
  48 < 56). To get the *verified* set, run
  **PICT/ACTS/allpairspy on §1** — it emits ~60–120 rows with a coverage report; the Rules-Labeler then
  fills `must`/`must_not`. That step is **cold-runnable now** (no agent, no traffic) and is the honest way
  to claim "complete."
- **Cross-refs:** `shopper-widget-eval-cases.md` (anchor + coverage map), `shopper-widget-eval.md`
  (§8b pairwise plan, process), `shopper-simulator.md` (utterance synthesis per row).