# Persona Walkthrough — palup-widget-staging storefront + assistant panel

**Method note (read first):** This is a qualitative simulation of three personas walking the
captured screenshots and source, not statistical evidence or real usability-test data. Findings
are strong hypotheses to validate with real users, not proven facts. Grounded at `file:line`
where the underlying behavior is verified in source; anything not directly visible in a
screenshot is marked as such.

Screens referenced: `mobile-390-viewport.png`, `mobile-390-light.png`, `desktop-1440-light.png`,
`panel-390-open.png`, `panel-390-card.png`, `keyboard-focus-skiplink.png`.

---

## Persona A — Rushed Mobile User

**Mara, 31.** Ducking into the assistant on her phone, one thumb, between two other things.
Search intent: "does this specific item work / how much is it" — she wants a yes/no fast, not a
browsing session.

**Five-second test (mobile-390-viewport.png):** *"OK, skincare store... there's a brown chat
button and a green chat button both saying the same thing, why are there two?... whatever, I'll
tap one."* — She gets the "what is this" and "is it for me" answers fine; "what should I do" costs
an extra half-beat because of finding #1 below.

Ranked by severity:

### 1. [Blocker] The one thing she asked the assistant for — a price — is exactly what it won't give her
- **Where:** Panel, RECOMMENDING state · `packages/widget-brain/src/brain.ts:141` (`PRICE_UNCONFIRMED_TEXT = "current price needs confirming"`), `:782-787` (`buildProductCards` renders that string instead of a number whenever `priceConfirmed === false`)
- **Evidence:** `panel-390-card.png` — the card for "The Art of Shaving After Shave Balm - Unscented 3.3 OZ" shows "current price needs confirming" with no `$` amount, while the exact same product is listed at `$50.0` on the storefront grid (`mobile-390-light.png`, `desktop-1440-light.png`).
- **Why it hurts:** Mara's whole reason for tapping the chat instead of scrolling the grid was to get an answer without hunting. Instead she gets a non-answer plus a question back ("Would you like me to check that price...?") — a worse outcome than if she'd never opened the chat, because the storefront right behind it already has the number. For a rushed persona this reads as *broken*, not *careful*.
- **Fix:** Don't hedge a price the storefront is already displaying live for the identical SKU. Either surface the storefront's displayed price (with an "as of" caveat) instead of `PRICE_UNCONFIRMED_TEXT`, or have the hedged card deep-link straight to the PDP where the number *is* shown, instead of asking her to wait on a confirmation she can't get from the assistant anyway.
- **What good looks like:** the assistant is never less informative than the page it's floating on top of.

### 2. [Major] Two "💬 Ask the expert" buttons, two different colors, same label, both on screen at once
- **Where:** Storefront hero CTA (terracotta) vs. floating launcher (evergreen)
- **Evidence:** `mobile-390-viewport.png` — terracotta `#a6482f` hero button (`packages/widget/public/storefront/home.html:28`, color from `packages/widget/public/storefront/app.css:18`) and evergreen `#0c4a3c` floating pill (`packages/widget/src/loader-core.ts:91`) visible in the same frame.
- **Why it hurts:** A rushed, one-handed scan is pattern-matching for "the button," and now there are two visually distinct candidates for the identical action. It's a half-second of "wait, which one?" that a hurried user shouldn't have to spend — and it looks like two different features, not one.
- **Fix:** One CTA identity for "ask the expert," reused everywhere. Either the hero CTA opens the same floating panel and is recolored to match the launcher's evergreen, or the launcher is recolored to the storefront's terracotta accent. Confirmed independent color systems today: `app.css`'s `--accent` (storefront) has no relationship to `loader-core.ts`'s hardcoded launcher fill or the merchant-brand evergreen resolved in `packages/widget-backend/src/widget-theme.ts:61-62` for this tenant.
- **What good looks like:** one visual identity per action, site-wide.

### 3. [Major] Cold-open panel has a dead empty zone between the opener chips and the input
- **Where:** Panel, cold/greeting state
- **Evidence:** `panel-390-open.png` — greeting + 3 chips ("Find my match" / "Bestsellers" / "New here?") at the top, then roughly half the panel is blank gray/white before the input field.
- **Why it hurts:** On a phone held one-handed, this looks like a loading glitch, not a designed empty state, and it pushes the actual typing field further from the natural thumb reach zone at the bottom of the screen — the opposite of what a rushed user needs.
- **Fix:** Size the panel to its content in the empty state (auto-height up to a max, rather than a fixed tall panel with `#messages{flex:1}` stretching to fill it), so chips sit close to the input with no dead flex-grown gap.
- **What good looks like:** chat surfaces (Intercom, Drift) shrink to fit an empty conversation instead of reserving full height up front.

### 4. [Minor] "Sign in to view your orders" tap target is well under thumb size
- **Where:** Panel tools row · `packages/widget/public/index.html:132` (`#tools #signin{ font-size:12px; padding:3px 9px; ... }`), button markup at `:265`
- **Evidence:** Visible in both `panel-390-open.png` and `panel-390-card.png` as a small pill near the input; not independently measured (no DOM inspection run), but the CSS values put the tappable box at roughly 20-22px tall — well under the ~44px one-handed thumb target the other objective measurements in `EVIDENCE.md` already flag for the cart link (63×42).
- **Why it hurts:** a rushed thumb tap on a 20px target risks a miss-tap, forcing a second attempt — friction that compounds with everything else she's trying to do quickly.
- **Fix:** raise to at least 44px total height (e.g. `padding:12px 14px`), matching the ≥44px bar the rest of this review holds the storefront to.
- **What good looks like:** every tappable control clears 44×44px, no exceptions for "secondary" buttons.

**The moment she almost leaves:** fold with the hedged price card (`panel-390-card.png`) — that's the exact moment the assistant fails the one job she opened it for.

---

## Persona B — Non-Technical Older User

**Walter, 68.** Reading glasses on, unfamiliar with chat widgets, cautious about anything that
might be "tracking" him or signing him up for something. Decision style: slow, wants to
understand before he clicks anything.

**Five-second test (mobile-390-viewport.png):** *"Skincare... there's a phone-shaped button that
says 'Ask the expert' — is that a person? A phone call? I don't know if I should press it."* The
copy doesn't say "chat" anywhere above the fold, so what pressing the button *does* isn't obvious
to someone without prior chat-widget exposure — noted here as ambiguous, not scored as a
standalone finding since it isn't demonstrably wrong, just untested with this persona.

Ranked by severity:

### 1. [Major] Memory-consent card uses vague, undefined terms with no plain "yes/no" framing
- **Where:** Panel, RECOMMENDING state · `packages/widget/public/index.html:557-568` (`showConsentPrompt` copy)
- **Evidence:** `panel-390-card.png` — "I remember your preferences to help you shop. I keep a few basics — like fragrance-free — just for this store, for 30 days after your last visit. You're in control: manage or turn this off anytime." Buttons: "Don't remember me" / "Got it."
- **Why it hurts:** Walter doesn't know what "remember your preferences" means technically — is this a cookie? Is someone reading his messages later? "Manage or turn this off anytime" assumes he already knows there's a settings panel to find (see #2). "Got it" doesn't read as consent to anything — it reads like dismissing a notification, so he may tap it without realizing he just agreed to something being stored about him. This is exactly the kind of ambiguity that makes an older, cautious user distrust the whole page.
- **Fix:** Replace with an explicit binary choice and one plain sentence: e.g. "Can we remember what you tell us (like 'fragrance-free') just for your next visit to this store? — [Yes, remember] [No thanks]." Drop "manage" entirely from this first-touch copy.
- **What good looks like:** the choice and its consequence are both statable by the user immediately after reading it, with no jargon ("manage," "preferences") load-bearing on comprehension.

### 2. [Major] "▸ What I remember" disclosure is a tiny unlabeled triangle — easy to never discover
- **Where:** Panel, RECOMMENDING state · `packages/widget/public/index.html:174-176` (`::before{ content:"\25B8" }`, summary text `font-size:12.5px`)
- **Evidence:** `panel-390-card.png` — "▸ What I remember" sits below the consent card at small size, no visible affordance beyond the ▸ glyph.
- **Why it hurts:** a 12.5px triangle isn't a control convention Walter necessarily recognizes as "click here to expand and see/change what's stored." If he never taps it, he never finds the toggles or the "Forget everything about me" button (`index.html:633`) — meaning the one place he could act on the consent he may have misunderstood in #1 is invisible to him.
- **Fix:** enlarge to at least 14-15px, replace the bare ▸ with a labeled affordance ("Show what's remembered ▾"), and consider surfacing it automatically right after the consent card is answered rather than requiring him to notice and tap it separately later.
- **What good looks like:** a disclosure control carries a visible verb, not just a symbol, especially when it gates a privacy control.

### 3. [Minor] "Sign in to view your orders" reads as throwaway text, and its popup-blocked fallback is easy to miss
- **Where:** `packages/widget/public/index.html:132` (12px font, 3-9px padding), `:796-808` (`startShopperSignIn` — `window.open(..., "width=480,height=760")`, falls back to small inline text if the popup is blocked)
- **Evidence:** small button visible in `panel-390-open.png` / `panel-390-card.png`; popup-blocked fallback text not visible in the captured screenshots (not independently verified in a live click).
- **Why it hurts:** styled as barely-there ghost text, it doesn't register to Walter as "the button for my orders." If his browser blocks the popup (common on older devices with stricter defaults) and nothing visibly happens, the recovery message is itself small system text (`.system{font-size:12.5px}`) — he's likely to conclude the site is broken and give up rather than notice the fallback link.
- **Fix:** style as a real, bordered button at ≥14px text and ≥44px height; on popup-block, show a visually prominent inline card (not 12.5px system text) with a large "Click to sign in" button.
- **What good looks like:** account access gets a real button, and a blocked popup gets an obvious, not incidental, recovery path.

### 4. [Minor] Secondary UI text sits at 11.5-12.5px throughout the panel
- **Where:** `packages/widget/public/index.html` — consent body `:159` (12.5px), consent buttons `:161` (12.5px), opener chips `:168` (12.5px), memory-toggle rows `:180` (12.5px), memory helper text `:182` (11.5px)
- **Evidence:** legible in `panel-390-open.png` / `panel-390-card.png` at the captured 390px width, but small; not independently measured for absolute on-screen size (a phone-dependent variable), flagged from the CSS values.
- **Why it hurts:** these aren't decorative footnotes — they're the consent choice, the memory toggles, and the quick-reply options. Sub-13px text is a real reading barrier for the presbyopia that's near-universal past ~50, and this is exactly the population most likely to need the extra beat these controls are meant to give them.
- **Fix:** raise anything the user must read to decide or act on to at least 14px; reserve sub-13px sizing for pure attribution text like "Powered by PalUp" (`:151`, 11px — appropriately deprioritized already).
- **What good looks like:** a 14px floor for any interactive/decision-bearing text.

**The moment he almost leaves:** the consent card (#1) — if he can't tell what agreeing or declining actually does, the safest move for a cautious persona is to close the tab.

---

## Persona C — Power User

**Priya, 35.** Shops online constantly, uses AI assistants as a matter of course, has zero
patience for a tool that's slower than just looking herself. Decision style: fast, evaluates
efficiency ruthlessly.

**Five-second test:** passes cleanly — she knows what "Ask the expert" does and where the input
is. Her friction shows up once she's actually mid-conversation.

Ranked by severity:

### 1. [Major] Asking the assistant for a price gets her *less* information than the grid she skipped
- **Where:** Panel, RECOMMENDING state · `packages/widget-brain/src/brain.ts:141,782-787`
- **Evidence:** `panel-390-card.png` vs. `desktop-1440-light.png`/`mobile-390-light.png` (same SKU listed at `$50.0`).
- **Why it hurts:** Priya deliberately routes around the grid because the assistant is supposed to be *faster*. When it hedges a price the storefront already shows, she's now slower than if she'd never asked — the single worst outcome for this persona, and it will teach her not to trust the assistant with the next question either.
- **Fix:** same as Persona A #1 — never render `PRICE_UNCONFIRMED_TEXT` for a SKU whose price is already live on the storefront; surface the number (with a staleness caveat if genuinely needed) rather than nothing.
- **What good looks like:** the assistant is a shortcut, never a detour.

### 2. [Minor] Opener chips are all discovery prompts — no shortcut exists for someone who already knows what they want
- **Where:** Panel, cold state · `packages/widget/public/index.html:1096` (chip rung currently unbuilt/inert per code comment) and `:1091` `CHIP_MESSAGES` = `find_my_match` / `bestsellers` / `new_here`
- **Evidence:** `panel-390-open.png` — "Find my match," "Bestsellers," "New here?"
- **Why it hurts:** all three chips assume the shopper is undecided. Priya isn't — she wants to type a specific question immediately, so the chips are pure visual overhead she scrolls past every single session, never a shortcut for her use case.
- **Fix:** add at least one chip aimed at a shopper with existing intent (e.g. jump straight to search/catalog), rather than only browsing prompts — worth doing before this rung ships, since it's currently inert per the code comment at `:1096`.
- **What good looks like:** quick replies cover both "help me decide" and "I already know," not just the former.

### 3. [Minor] Two visually different actions on the same card do overlapping jobs, with no signal that one leaves the panel
- **Where:** Product card · `packages/widget/public/index.html:970-991` — "View in cart" (`rec-cart`, underlined text link, `:977-981`) opens the store's cart in a **new tab**; "Add to checkout" (`rec-add`, pill button, `:990-991`) adds to an **in-panel** checkout selection.
- **Evidence:** `panel-390-card.png` shows "View in cart" and "Add to checkout" stacked with no distinguishing context about what each does or where it takes her.
- **Why it hurts:** for someone optimizing for speed, two similarly-purposed controls that behave differently (context-switch to a new tab vs. stay in-panel) without labeling that distinction costs a beat of "which one do I actually want" — small, but avoidable friction for exactly the persona who notices it.
- **Fix:** either label the difference explicitly ("View in cart (opens store)" vs. "Add without leaving chat") or converge on one control if both ultimately lead to the same checkout.
- **What good looks like:** when two controls look different, their behavior difference is stated, not implied.

### 4. [Polish] The prose before the product card is longer than the decision it's making
- **Where:** Panel reply text, visible at top of `panel-390-card.png`: "...formula designed to hydrate and calm sensitive skin after shaving. Since the current price for this item needs to be confirmed, I will gladly verify the exact price for you before you make a purchase. Would you like me to check that price, or are you interested in pairing this with an unscented pre-shave oil?"
- **Why it hurts:** three sentences to say "I don't have the price, want me to check, or want a pairing instead?" — a scanning power user has to read past filler to find the actual fork in the road.
- **Fix:** cap the hedge-accompanying reply to one sentence stating the hedge, and turn the "check price / pair with X" choice into two tappable chips instead of prose.
- **What good looks like:** the answer leads, the follow-up is a tap, not a re-read.

**The moment she almost leaves:** identical to #1 — the instant "current price needs confirming" appears is the instant the assistant proves it's slower than the alternative she skipped.

---

## Cross-persona pattern

All three personas hit the same wall from different angles: **the price hedge (`brain.ts:141`)
is a Blocker for the rushed user, a credibility problem for the older user (though not flagged
directly by Walter, since he wasn't price-hunting in this walkthrough), and a Major efficiency
failure for the power user.** It is the single highest-leverage fix on this page — everything
else here is comparatively cosmetic by contrast.
