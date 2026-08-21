# Panel Polish (Workstream C1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the assistant panel's *cold* state look composed (no big empty gap), the "What I remember" disclosure obviously tappable, and decision-bearing text large enough for older eyes — all presentation, no consent-flow logic.

**Architecture:** All changes are in the panel's inline CSS/JS (`packages/widget/public/index.html`) plus two E2E test updates. No change to consent copy, timing, or storage (that is C2, legal-gated and out of scope here).

**Tech Stack:** vanilla HTML/CSS/JS, Playwright. `env -u GOOGLE_CLOUD_PROJECT`.

**Spec:** `docs/superpowers/specs/2026-08-21-ux-review-remediation-program-design.md` (Workstream C1). C2 (consent wording/sequencing) is explicitly NOT in this plan.

## Global Constraints
- **Do not change consent copy, when the consent card fires, or any memory logic** — those are legal-gated (C2). Font-size and layout of the consent card are presentation and allowed; the words are not.
- **Preserve every `data-testid`.** The disclosure summary keeps `data-testid="manage-memory-heading"`; if its visible text changes, update the assertion in `widget.spec.ts` in the same task.
- Non-§3, auto-merge on green.

---

### Task 1: Cold-state — center the greeting+chips, kill the empty gap

**Files:**
- Modify: `packages/widget/public/index.html` (the `#messages` rule ~`:89`; the send handler / message-append path)
- Test: `e2e/tests/widget.spec.ts`

**Interfaces:** `#messages` carries a `cold` class while the conversation has only the greeting (+ opener chips); the class is removed the first time a real shopper/agent turn is added. `.cold` centers content vertically.

- [ ] **Step 1: Write the failing E2E** (open the panel; assert the message block is vertically centered — i.e., there is not a large gap below it):
```ts
test("cold panel centers the greeting instead of leaving a large empty gap", async ({ page }) => {
  await page.goto("/embed/panel?shop=palup-skincare-jason.myshopify.com");
  const messages = page.locator("#messages");
  await expect(messages).toHaveClass(/cold/);
  // the last child's bottom is not stranded far above the input: gap under content < 40% of the log height
  const gapRatio = await messages.evaluate((m) => {
    const last = m.lastElementChild as HTMLElement; if (!last) return 1;
    return (m.clientHeight - (last.offsetTop - m.offsetTop + last.offsetHeight)) / m.clientHeight;
  });
  expect(gapRatio).toBeLessThan(0.4);
});
```

- [ ] **Step 2: Run `pnpm e2e:embed`, verify it fails.**

- [ ] **Step 3: Implement.**
  - CSS: add `#messages.cold{ justify-content:center; }` next to the `#messages` rule (`:89`).
  - JS: set the class on boot (the log starts cold): after the static greeting is added, `msgs.classList.add("cold")`. In the single message-append entry point (`add(...)` / the send flow), when a `user` turn is added, `msgs.classList.remove("cold")`. (Do NOT remove it for the greeting or opener chips.)

- [ ] **Step 4: Run it, verify it passes. Commit** — `git commit -am "fix(widget): center the cold-state panel, remove the empty gap"`

---

### Task 2: Make the "What I remember" disclosure obviously tappable

**Files:**
- Modify: `packages/widget/public/index.html` (the `.manage-memory > summary` rules ~`:161-167`)
- Test: none new (the existing `manage-memory-heading` assertions must still pass — do NOT change the summary's text).

**Interfaces:** the summary keeps `data-testid="manage-memory-heading"` and its text "What I remember"; it becomes visually an obvious control — ≥14px, a chevron that reads as expandable, a brand-text color and a hover/underline affordance.

- [ ] **Step 1** — Update the summary CSS (`:161-167`):
```css
.manage-memory > summary{ list-style:none; cursor:pointer; font-size:14px; font-weight:600;
  color:var(--brand-text); display:flex; align-items:center; gap:8px; padding:6px 0; user-select:none; }
.manage-memory > summary:hover{ text-decoration:underline; text-underline-offset:2px; }
.manage-memory > summary::before{ content:"\25B8"; font-size:12px; line-height:1; color:var(--brand-text);
  transition:transform .15s ease; }
.manage-memory[open] > summary::before{ transform:rotate(90deg); }
```
(Was 12.5px muted-triangle; now 14px brand-colored with a hover underline so it reads as an expandable control. Keep the reduced-motion override that already zeroes the caret transition.)

- [ ] **Step 2** — Run `pnpm e2e:embed` + `pnpm e2e` (the `manage-memory-heading` `toHaveText("What I remember")` + collapsed/expand tests must still pass). Verify green.

- [ ] **Step 3: Commit** — `git commit -am "fix(widget): make the 'What I remember' disclosure read as a tappable control"`

---

### Task 3: 14px floor on decision-bearing panel text

**Files:**
- Modify: `packages/widget/public/index.html` (the small font-sizes: consent body `:150`, consent-action buttons `:152`, opener chips `:159`, memory-toggle rows `:163`; leave `mm-helper` `:165` and "Powered by PalUp" `:143` at their smaller sizes — they are secondary/attribution)
- Test: `e2e/tests/widget.spec.ts` (a11y-adjacent assertion)

**Interfaces:** every control a shopper must read to *decide or act* (consent buttons, opener chips, memory toggles, consent body) renders ≥14px. Attribution/helper text may stay smaller.

- [ ] **Step 1: Write the failing E2E** (open panel, send a turn to surface the consent card + chips, assert font-size ≥14 on the decision controls):
```ts
test("decision-bearing panel controls are at least 14px", async ({ page }) => {
  await page.goto("/embed/panel?shop=palup-skincare-jason.myshopify.com");
  // opener chips are on the cold panel
  const chip = page.getByTestId("opener-chip").first();
  if (await chip.count()) {
    const size = await chip.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(14);
  }
});
```

- [ ] **Step 2: Run it, verify it fails** (chips are 12.5px).

- [ ] **Step 3: Implement** — bump the four rules from `12.5px` to `14px`: `.consent [data-testid="consent-body"]` (`:150`), `.consent-actions button` (`:152`), `.opener-chips button` (`:159`), `.mm-row` (`:163`). Do not touch `.mm-helper` (`:165`, 11.5px) or `.powered` (`:143`).

- [ ] **Step 4: Run it, verify it passes. Commit** — `git commit -am "fix(widget): 14px floor on decision-bearing panel text"`

---

## Final: gate + PR
- [ ] Full gate green (esp. `pnpm e2e` + `pnpm e2e:embed` — the widget + embed suites exercise this panel); open PR; `merge-gate.sh`; auto-merge on green.

## Self-review notes
- Coverage: cold-state gap (T1), disclosure discoverability (T2), 14px floor (T3). All C1 items. C2 (consent copy/sequencing) intentionally absent.
- T2 keeps the summary TEXT unchanged, so no `manage-memory-heading` assertion breaks. If a later product decision renames it, that test moves with it — but not here.
- The consent card's font-size change (T3) is presentation only; the copy string is untouched (legal-gated).
