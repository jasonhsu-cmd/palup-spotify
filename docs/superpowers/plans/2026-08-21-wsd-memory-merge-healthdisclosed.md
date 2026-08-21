# WS-D — Memory-merge `healthDisclosed` server-recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the MED-1 security defect in `POST /memory/merge` — stop trusting the client-asserted `body.healthDisclosed` for the Art-9 special-category carry-over gate; read a **server-recorded** disclosure instead.

**Architecture:** Add a tiny consent-store sibling (`runtime-disclosure-store.ts`) that records/looks up "health-data carry-over was disclosed to the shopper at sign-in", keyed by `(tenantId, accountSubject, guestAnonId)`, on the SAME `RuntimeStatePort` (no new port surface), audited atomically — exactly like `runtime-consent-store.ts`. The merge route reads it in place of the body boolean. No production caller writes a disclosure yet (the carry-over prompt stays prod/legal-gated), so on staging the lookup returns its fail-closed default `false` and special-category rows simply do not carry — the correct, un-forgeable posture.

**Tech Stack:** TypeScript, Node, Fastify, Vitest. In-memory `RuntimeStatePort` + vector store in tests.

**Spec:** `docs/superpowers/specs/2026-08-21-staging-signal-engine-durable-enablement-design.md` (§WS-D, §2, §3).

## Global Constraints

- **Governance-touching PR — NAMED HUMAN OWNER MERGES** (touches customer memory + a security gate; spec §2). Do NOT auto-merge. Run `security-reviewer` before requesting merge.
- **Staging-only; legal deferred.** This fixes the *security* leg only. Do NOT enable `CARRY_OVER_PROMPT_ENABLED`, do NOT change any legal gate or `docs/MEMORY-GO-LIVE-CHECKLIST.md`, do NOT wire a production disclosure writer.
- **Test runner:** `pnpm test <path>` (= `PGVECTOR_TESTCONTAINER=off vitest run <path>`). **Never set `GOOGLE_CLOUD_PROJECT`** (routes to real Vertex → timeouts).
- **No new port method** — reuse `RuntimeStatePort` (`store.tx` / `store.get`), mirroring `runtime-consent-store.ts`.
- **Fail-closed default:** an absent disclosure record reads as `false` (never `true` by omission), mirroring `runtime-consent-store.ts`'s `NO_RECORD`.
- **Full local gate** (`.claude/scripts/merge-gate.sh <PR>`) must pass before merge.

---

### Task 1: Disclosure store (`recordHealthDisclosure` / `lookupHealthDisclosure`)

**Files:**
- Create: `packages/state-postgres/src/runtime-disclosure-store.ts`
- Modify: `packages/state-postgres/src/index.ts` (add exports)
- Test: `packages/state-postgres/test/runtime-disclosure-store.test.ts`

**Interfaces:**
- Consumes: `RuntimeStatePort` from `@palup/platform-ports` (`store.tx({tenantId}, cb)`, `store.get<T>({tenantId}, collection, key)`).
- Produces (later tasks rely on these exact signatures):
  - `lookupHealthDisclosure(store: RuntimeStatePort, input: { tenantId: string; accountSubject: string; guestAnonId: string }): Promise<boolean>`
  - `recordHealthDisclosure(store: RuntimeStatePort, input: { tenantId: string; accountSubject: string; guestAnonId: string; hmacKey?: string }, at?: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/state-postgres/test/runtime-disclosure-store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { recordHealthDisclosure, lookupHealthDisclosure } from "../src/runtime-disclosure-store.js";

const ACCT = "acct:shopify:demo:1";
const GUEST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

describe("runtime-disclosure-store", () => {
  it("fail-closed: no record -> false", async () => {
    const store = new InMemoryRuntimeStore();
    expect(await lookupHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST })).toBe(false);
  });

  it("record then lookup -> true (same tenant/account/guest)", async () => {
    const store = new InMemoryRuntimeStore();
    await recordHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST });
    expect(await lookupHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST })).toBe(true);
  });

  it("tenant-isolated: a record under tenant A is invisible to tenant B", async () => {
    const store = new InMemoryRuntimeStore();
    await recordHealthDisclosure(store, { tenantId: "A", accountSubject: ACCT, guestAnonId: GUEST });
    expect(await lookupHealthDisclosure(store, { tenantId: "B", accountSubject: ACCT, guestAnonId: GUEST })).toBe(false);
  });

  it("guest-scoped: a disclosure for guest X does not authorize guest Y", async () => {
    const store = new InMemoryRuntimeStore();
    await recordHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST });
    expect(await lookupHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ234567" })).toBe(false);
  });

  it("writes exactly one audit row on record", async () => {
    const store = new InMemoryRuntimeStore();
    await recordHealthDisclosure(store, { tenantId: "demo", accountSubject: ACCT, guestAnonId: GUEST });
    const rows = await store.listAudit({ tenantId: "demo" });
    expect(rows.filter((r) => r.action === "memory.health_disclosure.record").length).toBe(1);
  });
});
```

> Note: if `InMemoryRuntimeStore`'s audit-listing accessor is named differently than `listAudit`, mirror the accessor `runtime-consent-store.test.ts` uses for its audit assertion — read that test first and match it. If that test does not assert audit rows, drop this fifth test case rather than invent an accessor.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/state-postgres/test/runtime-disclosure-store.test.ts`
Expected: FAIL — `Cannot find module '../src/runtime-disclosure-store.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/state-postgres/src/runtime-disclosure-store.ts` (mirrors `runtime-consent-store.ts`):

```typescript
import { createHash, createHmac } from "node:crypto";
import type { RuntimeStatePort } from "@palup/platform-ports";

// WS-D (ADR-0015 Q19(c), MED-1 remediation) — server-recorded "health-data carry-over was disclosed to
// the shopper at sign-in". Mirrors runtime-consent-store.ts exactly: tenant-scoped rows on the SAME
// RuntimeStatePort, the write committed INSIDE a transaction with its immutable audit record (NN #5). This
// replaces the CLIENT-ASSERTED body.healthDisclosed the /memory/merge route trusted. No production caller
// writes a disclosure yet (the R2-1 carry-over prompt stays legal-gated, CARRY_OVER_PROMPT_ENABLED off);
// until one does, lookup returns its fail-closed default (false), so special-category rows never carry —
// the correct un-forgeable posture.

const MEMORY_HEALTH_DISCLOSURE = "memory_health_disclosure"; // KV collection under the subject's OWN tenant

interface DisclosureRecord {
  /** ISO timestamp the disclosure was recorded. Presence == disclosed; absence == fail-closed false. */
  disclosedAt: string;
}

export interface DisclosureInput {
  tenantId: string;
  /** The account subject key — the SAME value the merge route computes via memorySubjectId({verifiedShopperId}). */
  accountSubject: string;
  /** The server-verified guest subject the disclosure was named FOR (never a raw body.anonId). */
  guestAnonId: string;
}

/** Composite key: a disclosure authorizes exactly one (account, guest) carry-over, not the account broadly. */
const disclosureKey = (accountSubject: string, guestAnonId: string) => `${accountSubject}::${guestAnonId}`;

/** Opaque audit ref — never the raw ids. HMAC when a key is supplied (low-entropy acct: subject), else sha256. */
function subjectRef(tenantId: string, key: string, hmacKey?: string): string {
  const input = `${tenantId}::${key}`;
  return hmacKey ? createHmac("sha256", hmacKey).update(input).digest("hex").slice(0, 16) : createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Record that health-data carry-over was disclosed for this (account, guest) pair. TENANT-SCOPED. Audited
 * atomically with the write. Idempotent-ish: a repeat overwrites the timestamp (no history to reconcile).
 */
export async function recordHealthDisclosure(
  store: RuntimeStatePort,
  input: DisclosureInput & { hmacKey?: string },
  at = new Date().toISOString(),
): Promise<void> {
  const { tenantId, accountSubject, guestAnonId, hmacKey } = input;
  const key = disclosureKey(accountSubject, guestAnonId);
  const record: DisclosureRecord = { disclosedAt: at };
  await store.tx({ tenantId }, async (t) => {
    await t.put(MEMORY_HEALTH_DISCLOSURE, key, record);
    await t.audit(
      {
        actor: "agent:shopper-memory",
        action: "memory.health_disclosure.record",
        // PII-safe: only a hashed subjectRef — never the raw account/guest ids.
        input: { subjectRef: subjectRef(tenantId, key, hmacKey) },
        decision: "recorded",
        reversalPath: "n/a — a disclosure is an append-only fact that the shopper was informed; it is not a consent that can be withdrawn (withdrawal is Consent 2 via /consent).",
      },
      at,
    );
  });
}

/**
 * Was health-data carry-over disclosed for this (account, guest) pair? TENANT-SCOPED. Fail-closed: absent
 * record -> false (never true by omission).
 */
export async function lookupHealthDisclosure(store: RuntimeStatePort, input: DisclosureInput): Promise<boolean> {
  const rec = await store.get<DisclosureRecord>({ tenantId: input.tenantId }, MEMORY_HEALTH_DISCLOSURE, disclosureKey(input.accountSubject, input.guestAnonId));
  return rec != null;
}
```

> Before writing, open `runtime-consent-store.ts` and match its exact `store.tx` / `t.put` / `t.audit` call shapes and the audit-record field names (`actor`, `action`, `input`, `decision`, `reversalPath`). If `t.audit`'s signature differs from what's shown, mirror `recordConsent`'s call verbatim.

- [ ] **Step 4: Add exports**

Modify `packages/state-postgres/src/index.ts` — add next to the `recordConsent, lookupConsent` export line:

```typescript
export { recordHealthDisclosure, lookupHealthDisclosure, type DisclosureInput } from "./runtime-disclosure-store.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test packages/state-postgres/test/runtime-disclosure-store.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/state-postgres/src/runtime-disclosure-store.ts packages/state-postgres/src/index.ts packages/state-postgres/test/runtime-disclosure-store.test.ts
git commit -m "feat(memory): server-recorded health-disclosure store (WS-D task 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire the server-recorded lookup into `POST /memory/merge`

**Files:**
- Modify: `packages/widget-backend/src/server.ts` (the `/memory/merge` handler, ~2686-2762: import, body type, the `healthDisclosed` line 2749, MED-1 comment 2740-2748)
- Test: `packages/widget-backend/test/memory-merge-route.test.ts` (update the 3 `healthDisclosed`-body cases; add the forgery case)

**Interfaces:**
- Consumes: `lookupHealthDisclosure` (Task 1); the route's existing `tenantId`, `accountSubject` (`= memorySubjectId({ verifiedShopperId })`, server.ts:2735), `guestAnonId` (server.ts:2730), `store`.
- Produces: no new exported symbol; changes route behavior — the client `body.healthDisclosed` is now ignored; carry-over of special-category rows requires a recorded disclosure.

- [ ] **Step 1: Update the failing tests**

In `packages/widget-backend/test/memory-merge-route.test.ts`:

(a) Add the import at the top (next to the `recordConsent, armKill` import):

```typescript
import { recordConsent, armKill, recordHealthDisclosure } from "@palup/state-postgres";
```

(b) Replace the `"NOT copied when healthDisclosed is explicitly false…"` test (currently lines ~143-158) with a **forgery** test — a forged body flag with NO recorded disclosure must not carry:

```typescript
    it("SECURITY: a forged body.healthDisclosed:true does NOT carry special rows without a server-recorded disclosure", async () => {
      armAuth();
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      await seedSpecialGuestFact(vector);
      await recordConsent(store, { tenantId: "demo", anonId: accountSubjectId(SHOPPER_ID), memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      await recordConsent(store, { tenantId: "demo", anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      // NO recordHealthDisclosure — the client forges the flag in the body instead.
      const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

      const res = await postMerge(app, { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) }, { healthDisclosed: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: 0 });
      const acctFloor = await vector.query(floorNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
      expect(acctFloor).toEqual([]);
      await app.close();
    });
```

(c) Update the `"COPIED to the account FLOOR namespace…"` test (currently ~177-194) so the carry is driven by a **recorded disclosure**, not the body flag. Replace its body-flag post with a recorded disclosure + a plain post:

```typescript
    it("COPIED to the account FLOOR namespace only when both consents are 'in' AND a disclosure is server-recorded", async () => {
      armAuth();
      const store = new InMemoryRuntimeStore();
      const vector = createInMemoryVectorStore();
      await seedSpecialGuestFact(vector);
      await recordConsent(store, { tenantId: "demo", anonId: accountSubjectId(SHOPPER_ID), memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      await recordConsent(store, { tenantId: "demo", anonId: GUEST_ANON_ID, memoryOrdinary: "in", memorySpecial: "in", source: "shopper" });
      await recordHealthDisclosure(store, { tenantId: "demo", accountSubject: accountSubjectId(SHOPPER_ID), guestAnonId: GUEST_ANON_ID });
      const app = await buildServer({ store, vectorPort: vector, memoryEnabled: true });

      const res = await postMerge(app, { "x-shopper-token": shopperToken(), ...guestTokenHeader(GUEST_SECRET, "demo", GUEST_ANON_ID) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: 1 });
      const acctFloor = await vector.query(floorNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
      expect(acctFloor.map((f) => f.id)).toEqual(["spec-1"]);
      const acctMain = await vector.query(subjectNamespace("demo", accountSubjectId(SHOPPER_ID)), { text: "", k: 10 });
      expect(acctMain).toEqual([]);
      await app.close();
    });
```

(d) The `"NOT copied when healthDisclosed is omitted…"` test (~126-141) stays valid as-is (no disclosure recorded → still `merged:0`) — leave it, it now documents the fail-closed default.

> Confirm `accountSubjectId(SHOPPER_ID)` equals the route's `memorySubjectId({ verifiedShopperId })` — the existing consent tests rely on exactly this equivalence (they record consent under `accountSubjectId(SHOPPER_ID)` and the route matches it), so the disclosure key lines up the same way.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test packages/widget-backend/test/memory-merge-route.test.ts`
Expected: FAIL — the forgery test still shows `merged:1` (body flag trusted), and the COPIED test shows `merged:0` (no body flag) — because the route still reads `body.healthDisclosed`.

- [ ] **Step 3: Change the route**

In `packages/widget-backend/src/server.ts`:

(a) Add `lookupHealthDisclosure` to the existing `@palup/state-postgres` import that already brings in `lookupConsent`.

(b) Remove `healthDisclosed?: unknown;` from the `/memory/merge` body type (~line 2688) — the client value is no longer read.

(c) Replace the MED-1 block + line 2749:

```typescript
    // WS-D — Q19(c) is now SERVER-RECORDED, not client-asserted. `healthDisclosed` reads a disclosure event
    // written (by the future R2-1 carry-over prompt, still legal-gated CARRY_OVER_PROMPT_ENABLED) via
    // recordHealthDisclosure, keyed by (tenant, accountSubject, guestAnonId) — like the two consent legs.
    // Until a production writer exists, this is fail-closed false, so special-category rows do not carry.
    // A forged body.healthDisclosed can no longer promote Art-9 facts (MED-1 remediated).
    const healthDisclosed = await lookupHealthDisclosure(store, { tenantId, accountSubject: accountSubject!, guestAnonId });
```

(`accountSubject` and `guestAnonId` are already in scope from lines 2735 and 2730.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test packages/widget-backend/test/memory-merge-route.test.ts`
Expected: PASS — forgery → `merged:0`; recorded disclosure + both consents → `merged:1`; omitted → `merged:0`.

- [ ] **Step 5: Run the surrounding memory suites (no regression)**

Run: `pnpm test packages/widget-memory/test/merge.test.ts packages/widget-backend/test/memory-merge-route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/widget-backend/src/server.ts packages/widget-backend/test/memory-merge-route.test.ts
git commit -m "fix(memory): server-record healthDisclosed for /memory/merge (WS-D task 2, MED-1)

Client body.healthDisclosed is no longer trusted for the Art-9 carry-over
gate; the route reads a server-recorded disclosure (fail-closed false).
Legal/carry-over-prompt enablement remains prod-gated.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Security review + gate + human-owned merge

- [ ] **Step 1: Run the security reviewer**

Dispatch the `security-reviewer` subagent on the diff (merge route + disclosure store). It must confirm: the forgery path is closed, no raw ids in audit input, fail-closed default holds, tenant + guest isolation, no new port surface, no legal gate touched.

- [ ] **Step 2: Reconcile the memory note**

Update the `memory-merge-void-condition-open` memory: the *security* leg of the ADR-0015 staging-memory VOID condition is remediated (forgeable `healthDisclosed` closed); the *legal* leg (Art-9 sign-off, carry-over prompt) remains deferred to prod.

- [ ] **Step 3: Open PR and run the full gate**

```bash
git push -u origin HEAD
# open PR (gh pr create), then:
.claude/scripts/merge-gate.sh <PR>
```

- [ ] **Step 4: STOP — hand to the named human owner to merge**

Governance-touching (customer memory + security gate). Do **not** auto-merge. Surface the green gate + security-reviewer PASS to the owner for merge.

---

## Self-Review

**Spec coverage (§WS-D):** ✅ server-record `healthDisclosed` replacing the body boolean (Task 2); ✅ acceptance "forged `body.healthDisclosed:true` no longer carries special rows" (Task 2 forgery test); ✅ "only a server-recorded disclosure does" (Task 2 COPIED test); ✅ "ordinary-category merge unaffected" (the existing ordinary test at route-test ~100-117 is untouched); ✅ security-reviewer PASS + named-human merge (Task 3); ✅ legal leg deferred (Global Constraints + Task 2 comment).

**Placeholder scan:** none — every step has real code/commands. Two "before writing, confirm X" notes point at named files to mirror, not TBDs.

**Type consistency:** `lookupHealthDisclosure(store, { tenantId, accountSubject, guestAnonId })` and `recordHealthDisclosure(store, { tenantId, accountSubject, guestAnonId, hmacKey? })` are used identically in Task 1 (definition + tests) and Task 2 (route + route tests). `DisclosureRecord`/`disclosureKey` are internal to the store file. `accountSubject`/`guestAnonId` names match the server.ts locals.
