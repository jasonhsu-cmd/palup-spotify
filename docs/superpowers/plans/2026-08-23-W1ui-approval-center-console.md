# Approval Center Console (W1-UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **merchant console app** and its first screen — the **Approval Center** — so a merchant, embedded in Shopify admin, sees the win-back agent's real proposals, approves/rejects them (with the reversal plan and irreversibility surfaced), hits the Kill Switch, reads the audit log, and sees it all update live. This is the UI half of W1 and the first end-to-end proof of "console + engine."

**Architecture:** A new Vite + React app `packages/merchant-console` consuming F1 (`@palup/design-system`) for every visual, F2's App Bridge for the **session token** (attached to every `merchant-backend` call), and W1-API for data. This plan scaffolds the reusable **app shell** (App Bridge session provider, typed API client, router, F1 sidebar layout) — which every later screen reuses — and delivers the Approval Center as its first screen. The store is the source of truth; SSE (`GET /events`) is a live nudge that triggers a reconcile, never the sole state.

**Tech Stack:** TypeScript, React 19, Vite, Tailwind (F1 preset), `@palup/design-system`, react-router, `@shopify/app-bridge` (session token), vitest + `@testing-library/react` (F1's test setup), MSW (or a fetch fake) for API mocking. ATDD. `env -u GOOGLE_CLOUD_PROJECT PGVECTOR_TESTCONTAINER=off pnpm exec vitest run`.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` — §9 W1, §5, §7 F1/F2. Visual source of truth: `palup-merchant-app.html` (the Approval Center screen + sidebar). Depends on **F1**, **F2**, **W1-API**. Pairs with **WB** (the producer of the proposals shown).

## Global Constraints

- **F1 only for visuals** — every color/spacing/component comes from `@palup/design-system`; do not invent styles or import raw Tailwind colors. Match `palup-merchant-app.html`.
- **Session token on every request** — the API client obtains the App Bridge session token (F2) per call and sends `Authorization: Bearer <token>`; a 401 triggers a token refresh + one retry, then a re-auth prompt. Never store the token in localStorage.
- **Nothing auto-applies from the UI** — approve/reject are explicit; a money approval goes through a hard-to-misclick **confirm dialog** (F1 `Dialog`); the reversal plan and any `irreversible` flag are shown *before* the confirm.
- **Optimistic-concurrency honesty** — a 409 shows "someone else just decided this" and re-fetches; a 423 (killed) shows the kill banner and disables approve. The UI never hides a conflict.
- **Store is source of truth** — SSE updates trigger a re-fetch/reconcile; a dropped stream never loses a proposal.
- **Accessibility** — carry the a11y discipline from the shipped widget work: focus management on dialogs, headings, keyboard-operable actions (F1 components are Radix-backed, so this is mostly free — verify).
- Build-time dev against an APPROVED, owned spec; **security-reviewer** (it renders money-approval + kill controls) — self-merge on gate-green.

## File Structure

- Create `packages/merchant-console/` — Vite app: `index.html`, `vite.config.ts`, `package.json`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`.
- Create `src/app/session.tsx` — App Bridge init + `useSessionToken()`.
- Create `src/app/api.ts` — typed API client (`listApprovals`, `getApproval`, `approve`, `reject`, `getKill`, `kill`, `unkill`, `listAudit`, `openEvents`).
- Create `src/app/shell.tsx` — the F1 sidebar layout + nav (Approval Center + stubs) + the "N to approve" pill.
- Create `src/screens/approvals/` — `ApprovalsQueue.tsx`, `ProposalDetail.tsx`, `ApproveDialog.tsx`, `RejectDialog.tsx`, `KillSwitch.tsx`, `AuditView.tsx`, `useApprovalsLive.ts`.
- Tests: `packages/merchant-console/src/**/*.test.tsx`.

## Interfaces (the API client — mirrors W1-API)

```ts
// src/app/api.ts — types mirror @palup/agent-runtime Proposal (import the types package if shared, else a local DTO)
export interface ApiClient {
  listApprovals(q: { status?: string; category?: string; cursor?: string }): Promise<{ items: Proposal[]; cursor?: string }>;
  getApproval(id: string): Promise<Proposal>;
  approve(id: string, version: number, note?: string): Promise<Proposal>;   // throws ConflictError(409) | KilledError(423)
  reject(id: string, reason: string): Promise<Proposal>;
  getKill(): Promise<{ killed: boolean }>;
  kill(reason: string): Promise<void>;
  unkill(): Promise<void>;
  listAudit(cursor?: string): Promise<{ items: AuditEntry[]; cursor?: string }>;
  openEvents(onEvent: (e: ConsoleEvent) => void): () => void;               // SSE; returns unsubscribe
}
```

---

### Task 1: Scaffold the app + shell + session-token API client

**Files:** Create the Vite app files, `src/app/session.tsx`, `src/app/api.ts`, `src/app/shell.tsx`, `src/App.tsx`; `src/app/api.test.ts`, `src/app/shell.test.tsx`.

- [ ] **Step 1: Write the failing test** — the API client attaches the session token; the shell renders the F1 sidebar with an Approval Center nav item:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeApiClient } from "./api.js";
import { Shell } from "./shell.js";
describe("app shell + api", () => {
  it("sends the App Bridge session token as a bearer", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const api = makeApiClient({ baseUrl:"/api", getToken: async () => "sess-123", fetch: fetchSpy });
    await api.listApprovals({ status:"pending" });
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe("Bearer sess-123");
  });
  it("renders the sidebar with Approval Center", () => {
    render(<Shell pendingCount={4}><div/></Shell>);
    expect(screen.getByText(/Approval Center/i)).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument(); // the pill
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the Vite app (consuming F1's Tailwind preset + components), `session.tsx` (App Bridge init + `useSessionToken`; in tests `getToken` is injected), `api.ts` (`makeApiClient({baseUrl, getToken, fetch})` — attaches the bearer, maps 401→refresh+retry, 409→`ConflictError`, 423→`KilledError`, `openEvents` via `EventSource`), `shell.tsx` (F1 sidebar + nav groups from the mockup, Approval Center with the pending pill; other items are visible-but-stub). Wire routing in `App.tsx`.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-console): app scaffold, App Bridge session client, F1 shell"`

---

### Task 2: Approvals queue

**Files:** Create `src/screens/approvals/ApprovalsQueue.tsx`, `.test.tsx`.

- [ ] **Step 1: Write the failing test** — renders pending proposals from the API; empty state when none:
```tsx
// render <ApprovalsQueue api={fakeApi([winBackProposal])}/> → shows the proposal's rationale + a "campaign" badge + reach;
// with [] → shows an empty "You're all caught up" state. Assert the count matches.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the queue: `listApprovals({status:"pending"})`, render each as an F1 `Card`/row with category badge, rationale, estimatedImpact (reach/$), and an `irreversible` marker; empty state; loading state; click → detail.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-console): approvals queue with empty/loading states"`

---

### Task 3: Proposal detail — reversal plan + irreversibility surfaced

**Files:** Create `src/screens/approvals/ProposalDetail.tsx`, `.test.tsx`.

- [ ] **Step 1: Write the failing test** — detail shows rationale, boundaryReasons, estimatedImpact, and the reversal plan prominently with an irreversible warning:
```tsx
// render detail for an irreversible campaign proposal → shows the reversalPlan.plan text,
// an "irreversible" warning callout (F1 note/callout), each boundaryReason, and the reach.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `ProposalDetail` rendering all decision-relevant fields; the reversal plan and `irreversible` flag get a prominent F1 callout (the merchant must see the blast radius before approving).
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-console): proposal detail surfacing reversal plan + irreversibility"`

---

### Task 4: Approve — confirm dialog, 409/423 handling

**Files:** Create `src/screens/approvals/ApproveDialog.tsx`; wire into detail; `.test.tsx`.

- [ ] **Step 1: Write the failing test** — approve opens a confirm dialog, calls `approve(id, version)`, shows success; a 409 shows a conflict message + re-fetch; a 423 shows the kill banner:
```tsx
// click Approve → F1 Dialog opens (focus trapped); confirm → api.approve called with the proposal.version;
// on ConflictError → "someone else decided this" + list refreshes; on KilledError → kill banner shown, approve disabled.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `ApproveDialog` (F1 `Dialog`, focus-trapped), the approve mutation passing `proposal.version`, and the 409/423/success handling (toast + reconcile).
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-console): approve confirm dialog with conflict + kill handling"`

---

### Task 5: Reject — reason required

**Files:** Create `src/screens/approvals/RejectDialog.tsx`; wire; `.test.tsx`.

- [ ] **Step 1: Write the failing test** — reject requires a non-empty reason; submits `reject(id, reason)`; the item leaves the pending queue:
```tsx
// open reject → confirm disabled until a reason is typed → submit → api.reject called → queue refreshes without it.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `RejectDialog` (F1 dialog + required textarea), the reject mutation, list reconcile.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-console): reject dialog (reason required)"`

---

### Task 6: Kill Switch control

**Files:** Create `src/screens/approvals/KillSwitch.tsx`; wire into the shell/screen; `.test.tsx`.

- [ ] **Step 1: Write the failing test** — the kill button confirms, calls `kill(reason)`, and when killed a banner shows + approve is disabled; unkill restores:
```tsx
// click "Halt all agents" → confirm dialog → api.kill; getKill()→{killed:true} → red banner "Agents halted", approve buttons disabled;
// unkill (manager+) → banner clears. A 403 on unkill → "you don't have permission to resume".
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** the `KillSwitch` (prominent, F1 destructive button + confirm dialog), the killed banner state (from `getKill` + the `kill.changed` SSE event), and disabling approve while killed. Handle the 403-on-unkill (permission) message.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-console): Kill Switch control + halted banner"`

---

### Task 7: Audit view + live updates (SSE reconcile)

**Files:** Create `src/screens/approvals/AuditView.tsx`, `src/screens/approvals/useApprovalsLive.ts`; wire; `.test.tsx`.

- [ ] **Step 1: Write the failing test** — audit lists entries; an SSE `proposal.created` event triggers a queue re-fetch (new item appears); a `proposal.decided` updates it:
```tsx
// AuditView renders entries from listAudit; useApprovalsLive subscribes openEvents and, on proposal.created,
// re-fetches listApprovals (the new proposal appears). Assert the fetch happens on the event, not polling.
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3: Implement** `AuditView` (F1 table) and `useApprovalsLive` (subscribe `openEvents`; on any event, invalidate/re-fetch the queue + kill state; on stream error, reconnect + full re-fetch). The store stays the source of truth.
- [ ] **Step 4:** Run — expect PASS. **Commit:** `git commit -am "feat(merchant-console): audit view + SSE-driven live reconcile"`

---

## Final: gate + PR
- [ ] Full gate green; **security-reviewer pass** (renders money-approval + kill); open PR (governance-touching); auto-merge on green. Add a follow-up note: a Playwright e2e of the embedded Approval Center against the deployed staging `merchant-backend` + a seeded win-back proposal is the acceptance test once both are deployed (deploy is a human enablement step). On staging the comms adapter is the sandbox, so approving a campaign sends nothing to a real shopper.

## Self-Review
- **Spec coverage:** the Approval Center screen (§9 W1) — queue, detail with reversal plan + irreversibility, approve/reject with confirm + reason, Kill Switch + halted banner, audit, live SSE reconcile ✓; store as source of truth ✓; 409/423 surfaced honestly ✓; RBAC is enforced server-side (W1-API) and the UI reflects 403s ✓.
- **Foundations fit:** visuals from F1 only; session token from F2's App Bridge; data from W1-API; proposals produced by WB. No new design tokens, no second API path.
- **Type consistency:** the API client DTOs mirror `Proposal`/`AuditEntry`/`ConsoleEvent` from W1-API / `@palup/agent-runtime` (import the shared types where possible to avoid drift).
- **Accessibility:** F1's Radix-backed components give focus-trapped dialogs + keyboard operability; verified per component (carries the shipped a11y discipline).
- **Placeholder scan:** the screen tests are described in the testing-library style established by F1 (the spots to finalize at authoring); Task 1 carries full red/green code as the anchor.
- **Deploy/e2e honesty:** the true end-to-end acceptance (embedded, against deployed staging) is called out as a post-deploy Playwright follow-up, not claimed as done by unit tests; the sandbox comms adapter guarantees no real shopper contact on staging.
