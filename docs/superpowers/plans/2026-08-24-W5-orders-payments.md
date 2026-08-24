# W5 · Orders + Payments & Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trust-anchor money surfaces — a read-through Orders screen annotated with agent touchpoints, and a Payments & Payouts screen showing Shopify payouts plus a *computed-not-charged* transparent PalUp fee line — plus the propose-only refund path (tiny in-policy goodwill auto within the hard W4 refund floor; anything real routes to W1 or the merchant in Shopify).

**Architecture:** Everything is read-through: Shopify remains the system of record; PalUp overlays "what the agent did." Orders/payouts are read via ports (a new optional tenant-wide `CommercePort.listOrders`, a new read-only `PayoutsPort`) with sandbox adapters, so the service builds and runs dark until a human-gated Shopify Admin/Payments adapter is enabled. The one money action — refunds — never auto-applies beyond the existing `PALUP_FLOORS.refund` ceiling: it flows through the already-built `proposeOrExecute`/`executeApproved` (W1) loop with a **sandbox refund adapter that records but never issues real money**. The transparent fee line is computed from the single canonical incremental source (the outcome ledger, ADR-0007) — it is illustrative and never charged; real billing is W6.

**Tech Stack:** TypeScript. Backend: Node + Fastify (`@palup/merchant-backend`), ports in `@palup/platform-ports`, engine in `@palup/agent-runtime`, durable reads via `@palup/state-postgres`. Frontend: React + Vite + Tailwind + `@palup/design-system` (`@palup/merchant-console`). Tests: vitest across all packages.

**Spec:** `docs/superpowers/specs/2026-08-23-merchant-console-and-agent-runtime-design.md` (binding authority — see `### W5 · Orders + Payments & Payouts`, §10 decisions ledger, §11 build order item 5, §12 non-negotiables).

## Global Constraints

- **Read-through only.** Shopify owns orders, fulfilment, edits, and refunds. PalUp never mutates orders/fulfilment; money actions surface as Shopify **deep-links**. (Spec W5.)
- **PalUp never touches your money.** Payouts are a pure read-through of Shopify's own money movements. No card-with-PalUp, no money-transmitter path (ADR-0008). This is the trust anchor — copy it verbatim on the Payments screen.
- **Refunds are propose-only.** The agent auto-issues only tiny in-policy goodwill within the hard W4 limit; anything real → W1 proposal or the merchant in Shopify. The hard limit is `PALUP_FLOORS.refund` (`maxAutoUsd: 200`, `merchant-rules-store.ts:180`) — inviolable, clamped at classify-time by `createRulesProvider`. Never weaken it. (Spec §3, §12; NON-NEGOTIABLE #1.)
- **Touchpoint ≠ incremental.** Touchpoint = per-order, factual ("what the agent did on this order"). Incremental = aggregate, billed (W2/W6). **Never render incremental $ on the Orders screen.** The fee line (Payments screen only) is computed from incremental but labeled computed-not-charged.
- **Build dark.** All new port access defaults to sandbox/in-memory adapters that never call a real commerce/payments system. The live Shopify Admin-orders / Shopify-Payments-payouts / real-refund adapters are deferred, human-gated staging-enablement steps.
- **No fabricated numbers.** Every screen has honest loading / empty / error states. When a value is genuinely unknown (no live adapter, underpowered attribution), say so — never show a placeholder dollar figure. (Precedent: `RevenueHome.tsx`.)
- **Portability (ADR-0001).** All cloud/commerce access goes through a port with a swappable adapter; no provider SDK in feature code.
- **Tenant isolation.** Every route derives `ctx.tenantId` from `req.principal.merchantId` ONLY — never a body/query param.
- **Least privilege.** `GET /orders`, `GET /payments` are `console.view` (every role). The refund staging trigger is `agent.operate` (mirrors `/_internal/run-winback`). Every new route is added to `KNOWN_DATA_ROUTES` in `test/route-protection.test.ts`.
- **Audit everything.** The refund path audits via `proposeOrExecute`/`executeApproved` (already wired). Read routes are read-only (no audit write).
- **Console type-import rule:** in `@palup/merchant-console`, import canonical shapes from `@palup/platform-ports` as **types only** (`import type`) — value imports break the Vite build (W4 note, `api.ts:176-186`). Backend-only DTOs (`OrderView`, `PaymentsView`, `OrderTouchpoint`) are mirrored locally in `api.ts`, same as `HomeSummary`/`ActivityEntry`.

---

### Task 1: `CommercePort.listOrders` + `SandboxOrderDirectory` (tenant-wide order read-through)

**Files:**
- Modify: `packages/platform-ports/src/commerce-port.ts` (append after `SandboxCustomerDirectory`, ~line 178)
- Test: `packages/platform-ports/test/order-directory.test.ts` (create)

**Interfaces:**
- Consumes: nothing (pure port addition).
- Produces:
  - `interface MerchantOrderSummary { id: string; orderNumber: string; placedAt: string; totalUsd: number; currency: string; financialStatus: string; fulfillmentStatus: string; customerLabel: string; }`
  - `CommercePort.listOrders?(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<MerchantOrderSummary[]>` (optional — same rationale as `listCustomersWithLastOrder`: tenant-wide enumeration only an Admin-API-scoped adapter can do)
  - `interface OrderListingCommerce { listOrders(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<MerchantOrderSummary[]>; }`
  - `class SandboxOrderDirectory implements OrderListingCommerce` — constructor `(ordersByTenant?: Readonly<Record<string, MerchantOrderSummary[]>>)`, honors `ctx.tenantId`, `opts.limit`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/platform-ports/test/order-directory.test.ts
import { describe, expect, it } from "vitest";
import { SandboxOrderDirectory, type MerchantOrderSummary } from "../src/commerce-port.js";

const o = (id: string): MerchantOrderSummary => ({
  id,
  orderNumber: `#${id}`,
  placedAt: "2026-08-20T00:00:00Z",
  totalUsd: 42,
  currency: "USD",
  financialStatus: "paid",
  fulfillmentStatus: "unfulfilled",
  customerLabel: "Guest",
});

describe("SandboxOrderDirectory", () => {
  it("returns only the requested tenant's orders (isolation)", async () => {
    const dir = new SandboxOrderDirectory({ "tenant-a": [o("1"), o("2")], "tenant-b": [o("9")] });
    expect(await dir.listOrders({ tenantId: "tenant-a" })).toHaveLength(2);
    expect((await dir.listOrders({ tenantId: "tenant-b" }))[0]!.id).toBe("9");
  });

  it("returns an empty list for an unseeded tenant (never another tenant's data)", async () => {
    const dir = new SandboxOrderDirectory({ "tenant-a": [o("1")] });
    expect(await dir.listOrders({ tenantId: "unknown" })).toEqual([]);
  });

  it("honors opts.limit", async () => {
    const dir = new SandboxOrderDirectory({ t: [o("1"), o("2"), o("3")] });
    expect(await dir.listOrders({ tenantId: "t" }, { limit: 2 })).toHaveLength(2);
  });

  it("defaults to an empty directory", async () => {
    expect(await new SandboxOrderDirectory().listOrders({ tenantId: "t" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/platform-ports test -- order-directory`
Expected: FAIL — `SandboxOrderDirectory`/`MerchantOrderSummary` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/platform-ports/src/commerce-port.ts`:

```ts
/**
 * A tenant-facing order SUMMARY for the merchant Orders screen (W5). Deliberately NARROW and
 * display-oriented — NOT the per-shopper support `Order` above (which carries a `shopperId` and
 * line items for account-scoped support answers). `customerLabel` is a display string only
 * ("Jamie R." / "Guest"), never a raw email/PII field. `id` is also the Shopify admin deep-link key.
 */
export interface MerchantOrderSummary {
  id: string;
  /** Human order number, e.g. "#1001". */
  orderNumber: string;
  /** ISO-8601 placement timestamp. */
  placedAt: string;
  totalUsd: number;
  currency: string;
  /** Shopify financial status: "paid" | "refunded" | "partially_refunded" | "pending" | ... */
  financialStatus: string;
  /** Shopify fulfilment status: "fulfilled" | "unfulfilled" | "partial" | "restocked". */
  fulfillmentStatus: string;
  /** Display-only customer label (no raw PII). */
  customerLabel: string;
}

/**
 * The narrow capability the W5 Orders screen depends on — deliberately NOT the full `CommercePort`
 * (most per-shopper adapters cannot enumerate a whole tenant's orders; same reasoning as
 * `CustomerListingCommerce`). A real Shopify Admin-API adapter (`read_orders` scope) is a later,
 * human-gated staging-enablement concern.
 */
export interface OrderListingCommerce {
  listOrders(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<MerchantOrderSummary[]>;
}

/**
 * In-memory sandbox adapter for `listOrders` — seeded fixture data, never calls a real commerce
 * system. The Orders screen's dev/test/staging seam until a real Shopify Admin-API adapter is wired
 * (human-gated). Keyed by `tenantId`, so an unseeded tenant gets an empty list, never another
 * tenant's orders — the same tenant-isolation discipline `SandboxCustomerDirectory` follows.
 */
export class SandboxOrderDirectory implements OrderListingCommerce {
  constructor(private readonly ordersByTenant: Readonly<Record<string, MerchantOrderSummary[]>> = {}) {}

  async listOrders(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<MerchantOrderSummary[]> {
    const all = (this.ordersByTenant[ctx.tenantId] ?? []).map((o) => ({ ...o }));
    return typeof opts?.limit === "number" ? all.slice(0, opts.limit) : all;
  }
}
```

Add the optional method to the `CommercePort` interface (after `listCustomersWithLastOrder?`, ~line 141):

```ts
  /**
   * W5 Orders screen — enumerates THIS TENANT's recent orders for read-through display. OPTIONAL for
   * the same reason as `listCustomersWithLastOrder`: tenant-wide enumeration only an Admin-API-scoped
   * adapter can implement. A per-shopper Customer Account API adapter cannot, so it is not required.
   */
  listOrders?(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<MerchantOrderSummary[]>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/platform-ports test -- order-directory`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/platform-ports/src/commerce-port.ts packages/platform-ports/test/order-directory.test.ts
git commit -m "feat(platform-ports): add MerchantOrderSummary + optional CommercePort.listOrders + SandboxOrderDirectory (W5)"
```

---

### Task 2: Order-touchpoints read model (audit-backed, per-order agent activity)

**Files:**
- Create: `packages/merchant-backend/src/orders/touchpoints.ts`
- Test: `packages/merchant-backend/test/order-touchpoints.test.ts` (create)

**Interfaces:**
- Consumes: `AuditRecord` from `@palup/platform-ports` (`{ seq, at, actor, action, input?, decision?, prevHash, hash }`).
- Produces:
  - `interface OrderTouchpoint { orderRef: string; seq: number; at: string; actor: string; action: string; }`
  - `const ORDER_TOUCHPOINT_ACTIONS: ReadonlySet<string>`
  - `function orderRefOf(record: AuditRecord): string | undefined`
  - `function buildOrderTouchpoints(records: AuditRecord[]): Map<string, OrderTouchpoint[]>`

**Design note:** This REUSES the W2 activity read-model discipline (`routes/activity.ts`): an audit-log-backed ALLOWLIST read model, honest by construction (can only show what was audited). It differs in one narrow, deliberate way — to join an audited action to an order it must read exactly ONE scalar from the audit `input` (`input.action.params.orderId`), never the whole `input`. Because no current agent action carries an `orderId` param (win-back is customer-level; refunds not yet order-linked live), the map is **empty today** — every order renders "No agent activity yet." That is the correct dark posture: the annotation mechanism exists and lights up automatically once an order-scoped agent action is audited.

- [ ] **Step 1: Write the failing test**

```ts
// packages/merchant-backend/test/order-touchpoints.test.ts
import { describe, expect, it } from "vitest";
import type { AuditRecord } from "@palup/platform-ports";
import { buildOrderTouchpoints, orderRefOf, ORDER_TOUCHPOINT_ACTIONS } from "../src/orders/touchpoints.js";

const rec = (over: Partial<AuditRecord>): AuditRecord => ({
  seq: 1, at: "2026-08-20T00:00:00Z", actor: "agent:wb", action: "agent.action.auto",
  prevHash: "0".repeat(64), hash: "h", ...over,
});

describe("order touchpoints read model", () => {
  it("extracts orderRef from input.action.params.orderId only", () => {
    const r = rec({ input: { action: { type: "issue_refund", params: { orderId: "1001" } } } });
    expect(orderRefOf(r)).toBe("1001");
  });

  it("returns undefined when no order id is present (never fabricates one)", () => {
    expect(orderRefOf(rec({ input: { action: { type: "send_campaign", params: {} } } }))).toBeUndefined();
    expect(orderRefOf(rec({ input: {} }))).toBeUndefined();
    expect(orderRefOf(rec({ input: undefined }))).toBeUndefined();
    expect(orderRefOf(rec({ input: { action: { params: { orderId: 5 } } } }))).toBeUndefined(); // non-string
  });

  it("groups only ALLOWLISTED, order-linked actions by orderRef, newest-first", () => {
    const records: AuditRecord[] = [
      rec({ seq: 1, action: "agent.action.auto", input: { action: { params: { orderId: "1001" } } } }),
      rec({ seq: 2, action: "proposal.created", input: { action: { params: { orderId: "1001" } } } }), // not allowlisted
      rec({ seq: 3, action: "proposal.executed", input: { action: { params: { orderId: "1001" } } } }),
      rec({ seq: 4, action: "agent.action.auto", input: { action: { params: {} } } }),               // no orderRef
    ];
    const map = buildOrderTouchpoints(records);
    expect(map.get("1001")!.map((t) => t.seq)).toEqual([3, 1]); // newest-first, allowlisted only
    expect(map.size).toBe(1);
  });

  it("the allowlist excludes proposal.created (an unexecuted proposal is not a touchpoint on the order)", () => {
    expect(ORDER_TOUCHPOINT_ACTIONS.has("proposal.created")).toBe(false);
    expect(ORDER_TOUCHPOINT_ACTIONS.has("agent.action.auto")).toBe(true);
    expect(ORDER_TOUCHPOINT_ACTIONS.has("proposal.executed")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-backend test -- order-touchpoints`
Expected: FAIL — module `../src/orders/touchpoints.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/merchant-backend/src/orders/touchpoints.ts
import type { AuditRecord } from "@palup/platform-ports";

// W5 — the per-order "agent touchpoints" read model (spec §9 W5). Same discipline as W2's
// routes/activity.ts: an ALLOWLIST read model over the tenant's audit log, honest by construction.
// The ONE narrow difference is that a per-order JOIN needs a key, so `orderRefOf` reads exactly one
// scalar — `input.action.params.orderId` — and nothing else from `input`. Because no agent action
// currently writes an `orderId` param, this returns an empty map today (every order shows "no agent
// activity yet") and lights up automatically once an order-scoped agent action is audited.

/** The audited actions that COUNT as a factual touchpoint on an order. An EXECUTED auto-action or an
 * executed proposal is a real thing the agent did; a merely-CREATED proposal is not (it may be
 * rejected/expired), so it is deliberately excluded — mirroring activity.ts's allowlist stance. */
export const ORDER_TOUCHPOINT_ACTIONS: ReadonlySet<string> = new Set(["agent.action.auto", "proposal.executed"]);

export interface OrderTouchpoint {
  orderRef: string;
  seq: number;
  at: string;
  actor: string;
  action: string;
}

/** The single allowlisted projection from the audit `input`: `input.action.params.orderId` when it
 * is a non-empty string, else undefined. Never reads any other `input` field (input is typed
 * `unknown`, written by ~50 sites — this is the one deliberate, narrow read, not a general opening). */
export function orderRefOf(record: AuditRecord): string | undefined {
  const input = record.input as { action?: { params?: Record<string, unknown> } } | undefined;
  const orderId = input?.action?.params?.orderId;
  return typeof orderId === "string" && orderId.length > 0 ? orderId : undefined;
}

/** Groups allowlisted, order-linked audit records by orderRef, newest-first within each order. */
export function buildOrderTouchpoints(records: AuditRecord[]): Map<string, OrderTouchpoint[]> {
  const byOrder = new Map<string, OrderTouchpoint[]>();
  for (const r of records) {
    if (!ORDER_TOUCHPOINT_ACTIONS.has(r.action)) continue;
    const orderRef = orderRefOf(r);
    if (orderRef === undefined) continue;
    const list = byOrder.get(orderRef) ?? [];
    list.push({ orderRef, seq: r.seq, at: r.at, actor: r.actor, action: r.action });
    byOrder.set(orderRef, list);
  }
  for (const list of byOrder.values()) list.sort((a, b) => b.seq - a.seq); // newest-first
  return byOrder;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-backend test -- order-touchpoints`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/orders/touchpoints.ts packages/merchant-backend/test/order-touchpoints.test.ts
git commit -m "feat(merchant-backend): order-touchpoints read model (audit-backed, allowlisted) (W5)"
```

---

### Task 3: `GET /orders` route + Shopify admin deep-link helper

**Files:**
- Create: `packages/merchant-backend/src/shopify-links.ts`
- Create: `packages/merchant-backend/src/routes/orders.ts`
- Modify: `packages/merchant-backend/src/server.ts` (import + `buildServer` opt + register inside `merchantPlane`)
- Test: `packages/merchant-backend/test/orders-route.test.ts` (create)
- Modify: `packages/merchant-backend/test/route-protection.test.ts` (add `{ method: "GET", url: "/orders" }` to `KNOWN_DATA_ROUTES`, ~line 67)

**Interfaces:**
- Consumes: `OrderListingCommerce`, `MerchantOrderSummary`, `RuntimeStatePort` (`@palup/platform-ports`); `buildOrderTouchpoints`, `OrderTouchpoint` (Task 2); `requirePermission` (`@palup/identity-shopify`).
- Produces:
  - `function shopifyOrderAdminPath(orderId: string): string` → `` `admin/orders/${orderId}` ``
  - `interface OrderView extends MerchantOrderSummary { touchpoints: OrderTouchpoint[]; adminPath: string; }`
  - `interface OrdersRoutesDeps { orderCommerce: OrderListingCommerce; state: RuntimeStatePort; }`
  - `function registerOrdersRoutes(app: FastifyInstance, deps: OrdersRoutesDeps): void` — `GET /orders` (`console.view`) → `{ items: OrderView[]; source: "live" | "unavailable"; sourceNote: string }`

**Design note:** `buildServer` gains a NEW injectable dep `orderCommerce?: OrderListingCommerce` (default `new SandboxOrderDirectory({})`) — kept separate from the existing `commerce: CustomerListingCommerce` because they are different Shopify scopes (`read_orders` vs `read_customers`) and different sandbox seeds (least privilege). The audit read reuses `state.readAudit` with an over-fetch bound, exactly like `routes/activity.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/merchant-backend/test/orders-route.test.ts
import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore } from "@palup/state-postgres";
import { SandboxOrderDirectory, type MerchantOrderSummary } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { makeTestIdentity, bearer } from "./helpers/test-identity.js"; // existing test helper used by other route tests

const order = (id: string): MerchantOrderSummary => ({
  id, orderNumber: `#${id}`, placedAt: "2026-08-20T00:00:00Z", totalUsd: 42,
  currency: "USD", financialStatus: "paid", fulfillmentStatus: "unfulfilled", customerLabel: "Guest",
});

describe("GET /orders", () => {
  it("returns the tenant's orders annotated with (empty) touchpoints + a Shopify admin deep-link", async () => {
    const store = new InMemoryRuntimeStore();
    const orderCommerce = new SandboxOrderDirectory({ "shop-1": [order("1001")] });
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), orderCommerce });
    const res = await app.inject({ method: "GET", url: "/orders", headers: bearer("shop-1") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("live");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: "1001", adminPath: "admin/orders/1001", touchpoints: [] });
    await app.close();
  });

  it("reports source=unavailable (never a fake row) when the adapter cannot list orders", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), orderCommerce: {} as never });
    const res = await app.inject({ method: "GET", url: "/orders", headers: bearer("shop-1") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: "unavailable", items: [] });
    await app.close();
  });

  it("401s without a token", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity: makeTestIdentity("shop-1") });
    expect((await app.inject({ method: "GET", url: "/orders" })).statusCode).toBe(401);
    await app.close();
  });
});
```

> If `test/helpers/test-identity.ts` does not exist under that exact name, mirror the identity double + bearer construction the sibling suite `test/route-protection.test.ts` already uses (it constructs an `identity` and injects a valid token); reuse that exact pattern rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-backend test -- orders-route`
Expected: FAIL — `/orders` route not registered / `orderCommerce` opt unknown.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/merchant-backend/src/shopify-links.ts
// W5 — Shopify admin deep-links for money/read-through actions. Returns admin-RELATIVE paths (no shop
// origin): the embedded console resolves them against the merchant's admin via App Bridge, so the
// server never needs the shop domain and no host is hard-coded here (portability). Money actions
// (issuing a refund, viewing a payout) always land IN Shopify — PalUp never performs them.

/** Deep-link to an order's page in Shopify admin (where the merchant issues a refund / edits it). */
export function shopifyOrderAdminPath(orderId: string): string {
  return `admin/orders/${orderId}`;
}

/** Deep-link to the Shopify payments/payouts settings page. */
export function shopifyPayoutsAdminPath(): string {
  return "admin/settings/payments";
}
```

```ts
// packages/merchant-backend/src/routes/orders.ts
import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { MerchantOrderSummary, OrderListingCommerce, RuntimeStatePort } from "@palup/platform-ports";
import { buildOrderTouchpoints, type OrderTouchpoint } from "../orders/touchpoints.js";
import { shopifyOrderAdminPath } from "../shopify-links.js";

// W5 — `GET /orders`: read-through of the tenant's Shopify orders (system of record), annotated with
// per-order agent touchpoints (Task 2, audit-backed). READ-ONLY: no order/fulfilment mutation ever
// happens here — money actions surface as the `adminPath` Shopify deep-link. NEVER shows incremental
// $ (that is aggregate/billed, W2/W6) — only factual per-order data. Honest by construction: when the
// adapter cannot enumerate orders (no live Admin-API adapter enabled), `source: "unavailable"` + an
// empty list, never a fabricated row.

const AUDIT_OVERFETCH = 500; // same bounded most-recent window as routes/activity.ts

export interface OrderView extends MerchantOrderSummary {
  touchpoints: OrderTouchpoint[];
  /** Shopify admin deep-link (relative) — where the merchant manages/refunds this order. */
  adminPath: string;
}

export interface OrdersRoutesDeps {
  orderCommerce: OrderListingCommerce;
  state: RuntimeStatePort;
}

export function registerOrdersRoutes(app: FastifyInstance, deps: OrdersRoutesDeps): void {
  app.get("/orders", { preHandler: requirePermission("console.view") }, async (req) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    const ctx = { tenantId: principal.merchantId };

    if (typeof deps.orderCommerce.listOrders !== "function") {
      return {
        items: [] as OrderView[],
        source: "unavailable" as const,
        sourceNote: "Order read-through is not connected yet — orders will appear once your Shopify orders scope is enabled.",
      };
    }

    const [orders, records] = await Promise.all([
      deps.orderCommerce.listOrders(ctx),
      deps.state.readAudit(ctx, { limit: AUDIT_OVERFETCH }),
    ]);
    const touchpointsByOrder = buildOrderTouchpoints(records);

    const items: OrderView[] = orders.map((o) => ({
      ...o,
      touchpoints: touchpointsByOrder.get(o.id) ?? [],
      adminPath: shopifyOrderAdminPath(o.id),
    }));

    return {
      items,
      source: "live" as const,
      sourceNote: "Shopify is the system of record. PalUp shows what your agent did — refunds and edits happen in Shopify.",
    };
  });
}
```

Wire into `packages/merchant-backend/src/server.ts`:
- Add `SandboxOrderDirectory` and `type OrderListingCommerce` to the `@palup/platform-ports` import block (lines 6-24).
- Add `import { registerOrdersRoutes } from "./routes/orders.js";` next to the other route imports (~line 34).
- Add to the `buildServer` opts object (after `commerce?`):
  ```ts
  // W5 (Orders read-through): SEPARATE from `commerce` (customer listing) above — different Shopify
  // scope (read_orders) + seed. Absent → an empty sandbox directory (dark) until a live Admin-API
  // adapter is human-enabled.
  orderCommerce?: OrderListingCommerce;
  ```
- Add the composition default near the other adapter defaults (after `const commerce = ...`, ~line 87):
  ```ts
  const orderCommerce: OrderListingCommerce = opts?.orderCommerce ?? new SandboxOrderDirectory({});
  ```
- Register inside the `merchantPlane` block (after `registerActivityRoutes`, ~line 303):
  ```ts
  registerOrdersRoutes(merchantPlane, { orderCommerce, state: store });
  ```

Add `{ method: "GET", url: "/orders" }` to `KNOWN_DATA_ROUTES` in `test/route-protection.test.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-backend test -- orders-route route-protection`
Expected: PASS (orders-route 3 tests; route-protection still green with `/orders` covered).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/shopify-links.ts packages/merchant-backend/src/routes/orders.ts packages/merchant-backend/src/server.ts packages/merchant-backend/test/orders-route.test.ts packages/merchant-backend/test/route-protection.test.ts
git commit -m "feat(merchant-backend): GET /orders read-through + agent touchpoints + Shopify deep-link (W5)"
```

---

### Task 4: `PayoutsPort` + illustrative fee helper (`computeFeeLine`)

**Files:**
- Create: `packages/platform-ports/src/payouts-port.ts`
- Modify: `packages/platform-ports/src/index.ts` (barrel-export the new module)
- Test: `packages/platform-ports/test/payouts-port.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Payout { id: string; status: string; amountUsd: number; currency: string; issuedAt: string; bankReference?: string; }`
  - `interface PayoutsPort { listPayouts(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<Payout[]>; }`
  - `class SandboxPayoutsPort implements PayoutsPort` — constructor `(payoutsByTenant?: Readonly<Record<string, Payout[]>>)`
  - `function requirePayoutsTenant(tenantId: string): string`
  - `const PALUP_ILLUSTRATIVE_TAKE_RATE = 0.06`
  - `interface FeeLine { chargeable: false; ratePct: number; baseIncrementalUsd: number | null; computedFeeUsd: number | null; reason: "computed" | "attribution_underpowered"; }`
  - `function computeFeeLine(incrementalUsd: number, powered: boolean, rate?: number): FeeLine`

- [ ] **Step 1: Write the failing test**

```ts
// packages/platform-ports/test/payouts-port.test.ts
import { describe, expect, it } from "vitest";
import {
  SandboxPayoutsPort, computeFeeLine, PALUP_ILLUSTRATIVE_TAKE_RATE, type Payout,
} from "../src/payouts-port.js";

const p = (id: string): Payout => ({ id, status: "paid", amountUsd: 100, currency: "USD", issuedAt: "2026-08-20T00:00:00Z" });

describe("SandboxPayoutsPort", () => {
  it("isolates tenants and honors limit; unseeded tenant is empty", async () => {
    const port = new SandboxPayoutsPort({ a: [p("1"), p("2")], b: [p("9")] });
    expect(await port.listPayouts({ tenantId: "a" })).toHaveLength(2);
    expect(await port.listPayouts({ tenantId: "a" }, { limit: 1 })).toHaveLength(1);
    expect(await port.listPayouts({ tenantId: "unknown" })).toEqual([]);
  });
  it("defaults to empty", async () => {
    expect(await new SandboxPayoutsPort().listPayouts({ tenantId: "a" })).toEqual([]);
  });
});

describe("computeFeeLine (illustrative, never charged)", () => {
  it("computes 6% of incremental, rounded to cents, and is NEVER chargeable", () => {
    const fee = computeFeeLine(1000, true);
    expect(fee).toEqual({ chargeable: false, ratePct: 6, baseIncrementalUsd: 1000, computedFeeUsd: 60, reason: "computed" });
    expect(PALUP_ILLUSTRATIVE_TAKE_RATE).toBe(0.06);
  });
  it("rounds to cents", () => {
    expect(computeFeeLine(133.33, true).computedFeeUsd).toBe(8); // 133.33*0.06 = 7.9998 -> 8.00
  });
  it("withholds the number (null) when attribution is underpowered — never a fabricated fee", () => {
    expect(computeFeeLine(1000, false)).toEqual({
      chargeable: false, ratePct: 6, baseIncrementalUsd: null, computedFeeUsd: null, reason: "attribution_underpowered",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/platform-ports test -- payouts-port`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/platform-ports/src/payouts-port.ts
// Payouts port (ADR-0001, ADR-0008): READ-ONLY read-through of the merchant's Shopify Payments
// payouts. PalUp never touches this money — payouts flow merchant<->Shopify; this port only READS
// them so the console can show them alongside a transparent, COMPUTED-NOT-CHARGED fee line. A real
// Shopify-Payments adapter (`read_shopify_payments_payouts` scope) is a later, human-gated
// staging-enablement step; feature code depends only on this interface.

export interface Payout {
  id: string;
  /** Shopify payout status: "paid" | "in_transit" | "scheduled" | "failed" | "cancelled". */
  status: string;
  amountUsd: number;
  currency: string;
  /** ISO-8601 date the payout was issued/scheduled. */
  issuedAt: string;
  /** Optional bank/last-4 reference for display. */
  bankReference?: string;
}

export interface PayoutsPort {
  listPayouts(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<Payout[]>;
}

/** A non-blank tenantId is REQUIRED — an empty tenant is a cross-tenant wildcard (fail closed). */
export function requirePayoutsTenant(tenantId: string): string {
  if (!tenantId || !tenantId.trim()) throw new Error("PayoutsPort: a non-blank tenantId is required (tenant isolation)");
  return tenantId;
}

/** In-memory sandbox — seeded fixtures, never calls Shopify. Keyed by tenant (unseeded → empty). */
export class SandboxPayoutsPort implements PayoutsPort {
  constructor(private readonly payoutsByTenant: Readonly<Record<string, Payout[]>> = {}) {}
  async listPayouts(ctx: { tenantId: string }, opts?: { limit?: number }): Promise<Payout[]> {
    const all = (this.payoutsByTenant[requirePayoutsTenant(ctx.tenantId)] ?? []).map((p) => ({ ...p }));
    return typeof opts?.limit === "number" ? all.slice(0, opts.limit) : all;
  }
}

/**
 * The PalUp performance take-rate used to render the transparent fee LINE on the Payments screen.
 * ILLUSTRATIVE ONLY — this constant computes what the fee WOULD be so the merchant sees it plainly;
 * it is NEVER charged here. Actual billing (the real, separately-gated §3 fee model) is W6 / ADR-0007
 * and runs through Shopify Billing. ~6% on incremental per spec §10 (W6 decisions ledger).
 */
export const PALUP_ILLUSTRATIVE_TAKE_RATE = 0.06;

export interface FeeLine {
  /** ALWAYS false in W5 — this line is computed for transparency, never charged (billing is W6). */
  chargeable: false;
  ratePct: number;
  /** The incremental (holdout-proven) revenue the fee is computed on; null when not yet powered. */
  baseIncrementalUsd: number | null;
  computedFeeUsd: number | null;
  reason: "computed" | "attribution_underpowered";
}

/**
 * Computes the illustrative fee from the SINGLE canonical incremental source (the outcome ledger,
 * ADR-0007). When attribution is not yet powered, WITHHOLDS the number (null) with a reason — never a
 * fabricated fee. The fee rides on INCREMENTAL, never on payouts/GMV: the merchant keeps 100% of the
 * money they'd have made anyway, and 94% of the money PalUp created.
 */
export function computeFeeLine(incrementalUsd: number, powered: boolean, rate: number = PALUP_ILLUSTRATIVE_TAKE_RATE): FeeLine {
  const ratePct = Math.round(rate * 100);
  if (!powered) {
    return { chargeable: false, ratePct, baseIncrementalUsd: null, computedFeeUsd: null, reason: "attribution_underpowered" };
  }
  const computedFeeUsd = Math.round(incrementalUsd * rate * 100) / 100;
  return { chargeable: false, ratePct, baseIncrementalUsd: incrementalUsd, computedFeeUsd, reason: "computed" };
}
```

Add to `packages/platform-ports/src/index.ts`:

```ts
export * from "./payouts-port.js";
```

> Match the existing barrel style in `index.ts` (it may use explicit `export { ... } from`); if so, list `Payout`, `PayoutsPort`, `SandboxPayoutsPort`, `requirePayoutsTenant`, `PALUP_ILLUSTRATIVE_TAKE_RATE`, `FeeLine`, `computeFeeLine` explicitly instead of `export *`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/platform-ports test -- payouts-port`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/platform-ports/src/payouts-port.ts packages/platform-ports/src/index.ts packages/platform-ports/test/payouts-port.test.ts
git commit -m "feat(platform-ports): read-only PayoutsPort + SandboxPayoutsPort + illustrative computeFeeLine (W5)"
```

---

### Task 5: Payments read model (payouts + computed fee line, canonical incremental source)

**Files:**
- Create: `packages/merchant-backend/src/payments/read-model.ts`
- Test: `packages/merchant-backend/test/payments-read-model.test.ts` (create)

**Interfaces:**
- Consumes: `PayoutsPort`, `Payout`, `FeeLine`, `computeFeeLine`, `RuntimeStatePort`, `OutcomeLedgerEntry` (`@palup/platform-ports`); `readOutcomeLedger` (`@palup/state-postgres`); `currentPeriod` (`../home/read-model.js`); `shopifyPayoutsAdminPath` (`../shopify-links.js`, Task 3).
- Produces:
  - `interface PaymentsView { period: string; payouts: Payout[]; payoutTotalUsd: number; fee: FeeLine; payoutsAdminPath: string; trustNote: string; }`
  - `const PALUP_TRUST_NOTE: string`
  - `async function readPaymentsView(payouts: PayoutsPort, state: RuntimeStatePort, tenantId: string, opts?: { period?: string }): Promise<PaymentsView>`

**Design note:** REUSES the exact canonical incremental spine as W2's `readHomeSummary` (`readOutcomeLedger` → filter period → sum `attributedIncrementalRevenue`; `powered = periodEntries.length > 0`, the same D2 rule). No new attribution path. The fee is computed from that number only, never from payouts.

- [ ] **Step 1: Write the failing test**

```ts
// packages/merchant-backend/test/payments-read-model.test.ts
import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore } from "@palup/state-postgres";
import { SandboxPayoutsPort, type Payout } from "@palup/platform-ports";
import { readPaymentsView } from "../src/payments/read-model.js";

const LEDGER_STREAM = "outcome_ledger"; // matches state-postgres LEDGER_STREAM
const payout = (id: string, amt: number): Payout => ({ id, status: "paid", amountUsd: amt, currency: "USD", issuedAt: "2026-08-20T00:00:00Z" });

describe("readPaymentsView", () => {
  it("sums payouts and computes the fee from canonical incremental (powered)", async () => {
    const store = new InMemoryRuntimeStore();
    await store.appendStream({ tenantId: "t" }, LEDGER_STREAM, { period: "2026-08", play: "winback", attributedIncrementalRevenue: 1000, method: "holdout" });
    const port = new SandboxPayoutsPort({ t: [payout("po1", 500), payout("po2", 250)] });
    const view = await readPaymentsView(port, store, "t", { period: "2026-08" });
    expect(view.payoutTotalUsd).toBe(750);
    expect(view.payouts).toHaveLength(2);
    expect(view.fee).toMatchObject({ chargeable: false, computedFeeUsd: 60, baseIncrementalUsd: 1000, reason: "computed" });
    expect(view.payoutsAdminPath).toBe("admin/settings/payments");
    expect(view.trustNote).toContain("never touches your money");
  });

  it("withholds the fee (underpowered) when the period has no ledger entries — never $0 fabricated", async () => {
    const store = new InMemoryRuntimeStore();
    const view = await readPaymentsView(new SandboxPayoutsPort(), store, "t", { period: "2026-08" });
    expect(view.payouts).toEqual([]);
    expect(view.payoutTotalUsd).toBe(0);
    expect(view.fee).toMatchObject({ computedFeeUsd: null, baseIncrementalUsd: null, reason: "attribution_underpowered" });
  });
});
```

> Confirm the `InMemoryRuntimeStore` stream-append method name/signature (`appendStream`) against `packages/state-postgres` before running — if it differs (e.g. `writeStream`), use the store's actual append API. `LEDGER_STREAM`'s literal value is defined in `packages/state-postgres/src/outcome-ledger-store.ts`; match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-backend test -- payments-read-model`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/merchant-backend/src/payments/read-model.ts
import { computeFeeLine, type FeeLine, type PayoutsPort, type Payout, type RuntimeStatePort } from "@palup/platform-ports";
import { readOutcomeLedger } from "@palup/state-postgres";
import { currentPeriod } from "../home/read-model.js";
import { shopifyPayoutsAdminPath } from "../shopify-links.js";

// W5 — the Payments & Payouts READ MODEL (spec §9 W5). Two honest halves:
//   payouts ← the PayoutsPort (Shopify's own money movements; PalUp never touches them). Dark until a
//             live Shopify-Payments adapter is human-enabled → empty list, never fabricated.
//   fee     ← the transparent, COMPUTED-NOT-CHARGED PalUp fee line, computed from the SAME canonical
//             incremental source W2 uses (the outcome ledger, ADR-0007) — never from payouts/GMV, and
//             withheld (null) until attribution is powered. Real billing is W6.

const LEDGER_READ_LIMIT = 5000; // same bounded window as home/read-model.ts

/** The trust-anchor copy — the whole reason W5 exists. Rendered verbatim on the Payments screen. */
export const PALUP_TRUST_NOTE =
  "PalUp never touches your money. Payouts go straight from Shopify to your bank — we only read them. There's no card on file with PalUp.";

export interface PaymentsView {
  period: string;
  payouts: Payout[];
  payoutTotalUsd: number;
  fee: FeeLine;
  /** Shopify admin deep-link to payouts (money settings live in Shopify). */
  payoutsAdminPath: string;
  trustNote: string;
}

export async function readPaymentsView(
  payouts: PayoutsPort,
  state: RuntimeStatePort,
  tenantId: string,
  opts: { period?: string } = {},
): Promise<PaymentsView> {
  const period = opts.period ?? currentPeriod();
  const ctx = { tenantId };

  const payoutRows = await payouts.listPayouts(ctx);
  const payoutTotalUsd = Math.round(payoutRows.reduce((s, p) => s + p.amountUsd, 0) * 100) / 100;

  // Canonical incremental (D2, ADR-0007): the ledger sum for the period; powered iff any entries.
  const ledger = await readOutcomeLedger(state, tenantId, { limit: LEDGER_READ_LIMIT });
  const periodEntries = ledger.filter((e) => e.period === period);
  const incrementalUsd = periodEntries.reduce((s, e) => s + e.attributedIncrementalRevenue, 0);
  const powered = periodEntries.length > 0;

  return {
    period,
    payouts: payoutRows,
    payoutTotalUsd,
    fee: computeFeeLine(incrementalUsd, powered),
    payoutsAdminPath: shopifyPayoutsAdminPath(),
    trustNote: PALUP_TRUST_NOTE,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-backend test -- payments-read-model`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/payments/read-model.ts packages/merchant-backend/test/payments-read-model.test.ts
git commit -m "feat(merchant-backend): payments read model — payouts + computed-not-charged fee line (W5)"
```

---

### Task 6: `GET /payments` route

**Files:**
- Create: `packages/merchant-backend/src/routes/payments.ts`
- Modify: `packages/merchant-backend/src/server.ts` (import + `buildServer` opt + register)
- Test: `packages/merchant-backend/test/payments-route.test.ts` (create)
- Modify: `packages/merchant-backend/test/route-protection.test.ts` (add `{ method: "GET", url: "/payments" }`)

**Interfaces:**
- Consumes: `readPaymentsView`, `PaymentsView` (Task 5); `PayoutsPort`, `SandboxPayoutsPort`, `RuntimeStatePort` (`@palup/platform-ports`); `requirePermission`.
- Produces:
  - `interface PaymentsRoutesDeps { payouts: PayoutsPort; state: RuntimeStatePort; }`
  - `function registerPaymentsRoutes(app: FastifyInstance, deps: PaymentsRoutesDeps): void` — `GET /payments` (`console.view`) → `PaymentsView`

- [ ] **Step 1: Write the failing test**

```ts
// packages/merchant-backend/test/payments-route.test.ts
import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore } from "@palup/state-postgres";
import { SandboxPayoutsPort, type Payout } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { makeTestIdentity, bearer } from "./helpers/test-identity.js";

const payout = (id: string, amt: number): Payout => ({ id, status: "paid", amountUsd: amt, currency: "USD", issuedAt: "2026-08-20T00:00:00Z" });

describe("GET /payments", () => {
  it("returns payouts + a computed-not-charged fee line + the trust note", async () => {
    const store = new InMemoryRuntimeStore();
    const payouts = new SandboxPayoutsPort({ "shop-1": [payout("po1", 300)] });
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), payouts });
    const res = await app.inject({ method: "GET", url: "/payments", headers: bearer("shop-1") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.payoutTotalUsd).toBe(300);
    expect(body.fee.chargeable).toBe(false);
    expect(body.trustNote).toContain("never touches your money");
    await app.close();
  });

  it("401s without a token", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity: makeTestIdentity("shop-1") });
    expect((await app.inject({ method: "GET", url: "/payments" })).statusCode).toBe(401);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-backend test -- payments-route`
Expected: FAIL — `/payments` not registered / `payouts` opt unknown.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/merchant-backend/src/routes/payments.ts
import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { PayoutsPort, RuntimeStatePort } from "@palup/platform-ports";
import { readPaymentsView } from "../payments/read-model.js";

// W5 — `GET /payments`: read-through of Shopify payouts + the transparent, computed-not-charged PalUp
// fee line (Task 5). READ-ONLY; every money action stays in Shopify (the view carries a deep-link).
// The trust anchor: "PalUp never touches your money."

export interface PaymentsRoutesDeps {
  payouts: PayoutsPort;
  state: RuntimeStatePort;
}

export function registerPaymentsRoutes(app: FastifyInstance, deps: PaymentsRoutesDeps): void {
  app.get("/payments", { preHandler: requirePermission("console.view") }, async (req) => {
    const principal = req.principal!; // set by the enclosing requireMerchant preHandler
    return readPaymentsView(deps.payouts, deps.state, principal.merchantId);
  });
}
```

Wire into `server.ts`:
- Add `SandboxPayoutsPort` + `type PayoutsPort` to the `@palup/platform-ports` import.
- `import { registerPaymentsRoutes } from "./routes/payments.js";`
- Opts: `payouts?: PayoutsPort;`
- Default: `const payouts: PayoutsPort = opts?.payouts ?? new SandboxPayoutsPort({});`
- Register: `registerPaymentsRoutes(merchantPlane, { payouts, state: store });`

Add `{ method: "GET", url: "/payments" }` to `KNOWN_DATA_ROUTES`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-backend test -- payments-route route-protection`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/routes/payments.ts packages/merchant-backend/src/server.ts packages/merchant-backend/test/payments-route.test.ts packages/merchant-backend/test/route-protection.test.ts
git commit -m "feat(merchant-backend): GET /payments (payouts + computed fee line, trust anchor) (W5)"
```

---

### Task 7: `RefundPort` (dark) + `refundExecutor` + `REFUND_ACTION_TYPE`

**Files:**
- Create: `packages/platform-ports/src/refund-port.ts`
- Modify: `packages/platform-ports/src/index.ts` (barrel-export)
- Create: `packages/agent-runtime/src/refund.ts`
- Modify: `packages/agent-runtime/src/index.ts` (export `refundExecutor`, `REFUND_ACTION_TYPE`)
- Test: `packages/platform-ports/test/refund-port.test.ts` (create)
- Test: `packages/agent-runtime/test/refund-executor.test.ts` (create)

**Interfaces:**
- Consumes: `Executor`, `ExecutorInput`, `ExecutionResult` (`@palup/agent-runtime`, from `loop.ts`).
- Produces:
  - `interface RefundRequest { orderRef: string; amountUsd: number; reason: string; }`
  - `interface RefundResult { ok: boolean; detail: string; reversalPath: string; }`
  - `interface RefundPort { readonly isLive?: boolean; issueRefund(ctx: { tenantId: string }, req: RefundRequest): Promise<RefundResult>; }`
  - `class SandboxRefundAdapter implements RefundPort` — records to `public readonly issued: Array<{ tenantId: string } & RefundRequest>`, NEVER issues real money.
  - `const REFUND_ACTION_TYPE = "issue_refund"`
  - `function refundExecutor(port: RefundPort): Executor`

**Design note:** The executor is the ONLY place a refund side-effect runs, and it binds to a `RefundPort` whose default adapter is `SandboxRefundAdapter` (records, never issues) — so building this cannot move real money. A live Shopify refund adapter is a deferred, human + security-reviewer-gated enablement. The action carries a `usd` param so the classifier's `AUTO_ELIGIBLE_DIMENSIONS.refund = ["usd"]` + `PALUP_FLOORS.refund` govern auto-eligibility.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/platform-ports/test/refund-port.test.ts
import { describe, expect, it } from "vitest";
import { SandboxRefundAdapter } from "../src/refund-port.js";

describe("SandboxRefundAdapter", () => {
  it("records a refund intent but NEVER issues real money, and names a real reversal path", async () => {
    const adapter = new SandboxRefundAdapter();
    const res = await adapter.issueRefund({ tenantId: "t" }, { orderRef: "1001", amountUsd: 25, reason: "goodwill" });
    expect(res.ok).toBe(true);
    expect(res.reversalPath.length).toBeGreaterThan(0);
    expect(adapter.issued).toEqual([{ tenantId: "t", orderRef: "1001", amountUsd: 25, reason: "goodwill" }]);
    expect(adapter.isLive).toBeFalsy();
  });
});
```

```ts
// packages/agent-runtime/test/refund-executor.test.ts
import { describe, expect, it } from "vitest";
import { SandboxRefundAdapter } from "@palup/platform-ports";
import { refundExecutor, REFUND_ACTION_TYPE } from "../src/refund.js";

describe("refundExecutor", () => {
  it("maps action params to the RefundPort and returns an ExecutionResult", async () => {
    const adapter = new SandboxRefundAdapter();
    const exec = refundExecutor(adapter);
    const result = await exec({
      ctx: { tenantId: "t" }, agentId: "agent:svc", agentType: "service",
      action: { type: REFUND_ACTION_TYPE, params: { orderRef: "1001", usd: 25, reason: "damaged" } },
      executionId: "e1",
    });
    expect(result.ok).toBe(true);
    expect(adapter.issued[0]).toMatchObject({ orderRef: "1001", amountUsd: 25, reason: "damaged" });
  });

  it("throws (fail closed) when the required params are missing — never issues a malformed refund", async () => {
    const exec = refundExecutor(new SandboxRefundAdapter());
    await expect(
      exec({ ctx: { tenantId: "t" }, agentId: "a", agentType: "service", action: { type: REFUND_ACTION_TYPE, params: {} } }),
    ).rejects.toThrow(/orderRef|usd/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @palup/platform-ports test -- refund-port` and `pnpm --filter @palup/agent-runtime test -- refund-executor`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/platform-ports/src/refund-port.ts
// Refund port (ADR-0001, ADR-0008): issues a refund on the merchant's commerce system. The ONLY money
// MUTATION in W5 — everything else is read-through. Building it dark is safe: the default adapter is
// the SandboxRefundAdapter, which RECORDS an intent and NEVER contacts a real payment gateway. A live
// Shopify refund adapter is a deferred, human + security-reviewer-gated enablement. This port is only
// ever reached through the W1 proposal loop (auto within PALUP_FLOORS.refund, or post human-approval).

export interface RefundRequest {
  orderRef: string;
  amountUsd: number;
  reason: string;
}

export interface RefundResult {
  ok: boolean;
  detail: string;
  /** The real, callable way back (or honest containment) — refunds are money, so this is required. */
  reversalPath: string;
}

export interface RefundPort {
  /** TRUE only for an adapter that moves real money. Absent/false ⇒ sandbox (records, never issues). */
  readonly isLive?: boolean;
  issueRefund(ctx: { tenantId: string }, req: RefundRequest): Promise<RefundResult>;
}

/** Records refund intents, NEVER issues real money — the dev/test/staging seam (mirrors
 *  SandboxCommsAdapter). The live Shopify refund adapter is a separate, human-gated step. */
export class SandboxRefundAdapter implements RefundPort {
  public readonly issued: Array<{ tenantId: string } & RefundRequest> = [];
  async issueRefund(ctx: { tenantId: string }, req: RefundRequest): Promise<RefundResult> {
    this.issued.push({ tenantId: ctx.tenantId, ...req });
    return {
      ok: true,
      detail: `sandbox refund recorded (NOT issued): $${req.amountUsd} on order ${req.orderRef}`,
      reversalPath: "Re-charge the customer via Shopify admin — this sandbox refund was never sent to a real gateway.",
    };
  }
}
```

```ts
// packages/agent-runtime/src/refund.ts
import type { Executor } from "./loop.js";
import type { RefundPort } from "@palup/platform-ports";

// W5 — the refund executor. The ONLY place a refund side-effect runs, and only reachable via the W1
// loop: `proposeOrExecute` auto-executes it when the action is within PALUP_FLOORS.refund AND the
// merchant's rules allow it (tiny in-policy goodwill), otherwise a pending Proposal is created and
// this runs only from `executeApproved` post human-approval. Params carry `usd` so the classifier's
// refund floor/dimension logic governs auto-eligibility.

/** The AgentAction.type a refund carries — the key `resolveExecutor` (engine-wiring) maps to here. */
export const REFUND_ACTION_TYPE = "issue_refund";

function reqStr(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`refundExecutor: action.params.${key} must be a non-empty string`);
  return v;
}

function reqNum(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`refundExecutor: action.params.${key} must be a number`);
  return v;
}

export function refundExecutor(port: RefundPort): Executor {
  return async (input) => {
    const params = input.action.params;
    const orderRef = reqStr(params, "orderRef");
    const amountUsd = reqNum(params, "usd");
    const reason = typeof params.reason === "string" ? params.reason : "goodwill";
    const result = await port.issueRefund(input.ctx, { orderRef, amountUsd, reason });
    return { ok: result.ok, detail: result.detail };
  };
}
```

Export from `packages/agent-runtime/src/index.ts` (alongside `campaignExecutor`, `voiceChangeExecutor`):

```ts
export { refundExecutor, REFUND_ACTION_TYPE } from "./refund.js";
```

Add `export * from "./refund-port.js";` to `packages/platform-ports/src/index.ts` (or explicit names if the barrel is explicit).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @palup/platform-ports test -- refund-port` and `pnpm --filter @palup/agent-runtime test -- refund-executor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/platform-ports/src/refund-port.ts packages/platform-ports/src/index.ts packages/platform-ports/test/refund-port.test.ts packages/agent-runtime/src/refund.ts packages/agent-runtime/src/index.ts packages/agent-runtime/test/refund-executor.test.ts
git commit -m "feat: dark RefundPort + SandboxRefundAdapter + refundExecutor (records-never-issues) (W5)"
```

---

### Task 8: Wire refund into the engine registry + approvals + `buildServer`

**Files:**
- Modify: `packages/merchant-backend/src/engine-wiring.ts` (`EngineWiringDeps`, `resolveExecutor`, `resolveValidator`, `BuildEngineDepsInput`, `buildEngineDeps`)
- Modify: `packages/merchant-backend/src/routes/approvals.ts` (deps + `buildEngineDeps` call)
- Modify: `packages/merchant-backend/src/server.ts` (default `refundPort` + thread to approvals)
- Test: `packages/merchant-backend/test/engine-wiring-refund.test.ts` (create)

**Interfaces:**
- Consumes: `refundExecutor`, `REFUND_ACTION_TYPE` (`@palup/agent-runtime`); `RefundPort`, `SandboxRefundAdapter` (`@palup/platform-ports`).
- Produces:
  - `EngineWiringDeps.refundPort?: RefundPort`
  - `resolveExecutor(REFUND_ACTION_TYPE, deps)` → `refundExecutor(deps.refundPort)` (throws if unwired)
  - `resolveValidator("refund", deps)` → always-valid (kill/status guard + floor already gate)
  - `BuildEngineDepsInput.refundPort?: RefundPort`
  - `ApprovalsRoutesDeps.refundPort: RefundPort`

- [ ] **Step 1: Write the failing test**

```ts
// packages/merchant-backend/test/engine-wiring-refund.test.ts
import { describe, expect, it } from "vitest";
import { SandboxRefundAdapter } from "@palup/platform-ports";
import { REFUND_ACTION_TYPE } from "@palup/agent-runtime";
import { resolveExecutor, resolveValidator } from "../src/engine-wiring.js";

describe("engine-wiring refund", () => {
  it("resolves issue_refund to a refund executor bound to the RefundPort", async () => {
    const adapter = new SandboxRefundAdapter();
    const exec = resolveExecutor(REFUND_ACTION_TYPE, { comms: {} as never, refundPort: adapter });
    await exec({ ctx: { tenantId: "t" }, agentId: "a", agentType: "service", action: { type: REFUND_ACTION_TYPE, params: { orderRef: "1001", usd: 25 } } });
    expect(adapter.issued).toHaveLength(1);
  });

  it("throws (fail closed) when a refund is approved with no RefundPort wired", () => {
    expect(() => resolveExecutor(REFUND_ACTION_TYPE, { comms: {} as never })).toThrow(/refundPort/);
  });

  it("resolves the refund category to a validator (does not throw)", async () => {
    const validate = resolveValidator("refund", { comms: {} as never });
    expect(await validate({} as never, { tenantId: "t" })).toEqual({ valid: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-backend test -- engine-wiring-refund`
Expected: FAIL — `resolveExecutor` throws "no executor registered" for `issue_refund`; `resolveValidator` throws for `refund`.

- [ ] **Step 3: Write minimal implementation**

In `engine-wiring.ts`:
- Add to imports: `import { applyRuleChangeFromProposal, campaignExecutor, voiceChangeExecutor, refundExecutor, RULE_CHANGE_ACTION_TYPE, REFUND_ACTION_TYPE, ... } from "@palup/agent-runtime";` and `import type { ..., RefundPort } from "@palup/platform-ports";`
- Extend `EngineWiringDeps`:
  ```ts
    /** W5: needed only when `actionType === REFUND_ACTION_TYPE` — the (dark by default) refund
     *  adapter. Optional/irrelevant to other types; `resolveExecutor` throws fail-closed if a refund
     *  is approved without one wired. */
    refundPort?: RefundPort;
  ```
- Add the `resolveExecutor` case (before `default`):
  ```ts
    case REFUND_ACTION_TYPE:
      if (!deps.refundPort) {
        throw new Error(`resolveExecutor: ${REFUND_ACTION_TYPE} requires a refundPort, none was wired`);
      }
      return refundExecutor(deps.refundPort);
  ```
- Add `refund` to `resolveValidator`'s always-valid set:
  ```ts
    case "campaign":
    case "autonomy_scope":
    case "refund":
      return async () => ({ valid: true });
  ```
  Update its doc comment: `refund` validates here because the kill/status guard in `executeApproved` plus the `PALUP_FLOORS.refund` clamp already gate it; keep the existing `TODO(v2)` note that a live refund adapter should re-check the order is still eligible (not already refunded) before flipping this off always-valid.
- Extend `BuildEngineDepsInput`:
  ```ts
    /** W5: needed only when `actionType === REFUND_ACTION_TYPE` — see `EngineWiringDeps`. */
    refundPort?: RefundPort;
  ```
- Thread it in `buildEngineDeps`:
  ```ts
  const wiring: EngineWiringDeps = { comms: input.comms, learnedStore: input.learnedStore, rulesStore: input.rulesStore, refundPort: input.refundPort };
  ```

In `approvals.ts`:
- Add `refundPort: RefundPort;` to `ApprovalsRoutesDeps` (import the type) with a doc line mirroring `comms`.
- Pass it in the `buildEngineDeps({ ... })` call: `refundPort: deps.refundPort,`.

In `server.ts`:
- Import `SandboxRefundAdapter` + `type RefundPort` from `@palup/platform-ports`.
- Opts: `refundPort?: RefundPort;`
- Default: `const refundPort: RefundPort = opts?.refundPort ?? new SandboxRefundAdapter();`
- Pass to approvals: `registerApprovalsRoutes(merchantPlane, { proposalStore, state: store, rulesStore, comms, bus, learnedStore, refundPort });`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-backend test -- engine-wiring-refund approvals`
Expected: PASS (new test green; existing approvals suite still green).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/engine-wiring.ts packages/merchant-backend/src/routes/approvals.ts packages/merchant-backend/src/server.ts packages/merchant-backend/test/engine-wiring-refund.test.ts
git commit -m "feat(merchant-backend): wire issue_refund executor + refund validator into engine registry + approvals (W5)"
```

---

### Task 9: Refund propose-only staging trigger (`POST /_internal/propose-refund`)

**Files:**
- Create: `packages/merchant-backend/src/routes/internal-refund.ts`
- Modify: `packages/merchant-backend/src/server.ts` (import + register with `proposalStore`, `state`, `rulesStore`, `refundPort`)
- Test: `packages/merchant-backend/test/internal-refund-route.test.ts` (create)
- Modify: `packages/merchant-backend/test/route-protection.test.ts` (add `{ method: "POST", url: "/_internal/propose-refund" }`)

**Interfaces:**
- Consumes: `proposeOrExecute`, `createRulesProvider`, `EngineDeps` (`@palup/agent-runtime`); `refundExecutor`, `REFUND_ACTION_TYPE` (`@palup/agent-runtime`); `ProposalStore`, `MerchantRulesStore`, `RuntimeStatePort`, `RefundPort` (`@palup/platform-ports`); `requirePermission`.
- Produces:
  - `interface ProposeRefundDeps { state: RuntimeStatePort; proposalStore: ProposalStore; rulesStore: MerchantRulesStore; refundPort: RefundPort; }`
  - `function registerInternalRefundRoutes(app: FastifyInstance, deps: ProposeRefundDeps): void` — `POST /_internal/propose-refund` (`agent.operate`), body `{ orderRef: string; amountUsd: number; reason?: string }`, returns `{ kind: "executed" } | { kind: "proposed"; proposedId: string }`.

**Design note:** This mirrors `routes/internal-winback.ts` exactly — a staging trigger that runs one candidate action through `proposeOrExecute`. It proves the propose-only + tiny-goodwill behavior against the REAL `PALUP_FLOORS.refund` + `createRulesProvider`: default rules keep refund `allowedAuto:false` → pending Proposal (routes to W1); a merchant who widened `refund` within the $200 floor gets tiny in-policy goodwill auto-executed (via the sandbox adapter — dark); above the floor stays pending. Comment it: `// staging trigger; replaced by the scheduled runtime host (later plan)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/merchant-backend/test/internal-refund-route.test.ts
import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore } from "@palup/state-postgres";
import { InMemoryProposalStore, InMemoryMerchantRulesStore, SandboxRefundAdapter } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { makeTestIdentity, bearer } from "./helpers/test-identity.js";

async function server(rulesStore: InMemoryMerchantRulesStore, refundPort: SandboxRefundAdapter) {
  const store = new InMemoryRuntimeStore();
  return buildServer({
    store, identity: makeTestIdentity("shop-1"),
    proposalStore: new InMemoryProposalStore(store), rulesStore, refundPort,
  });
}

describe("POST /_internal/propose-refund", () => {
  it("creates a PENDING proposal (routes to W1) under default conservative rules — nothing issued", async () => {
    const store = new InMemoryRuntimeStore();
    const refundPort = new SandboxRefundAdapter();
    const app = await server(new InMemoryMerchantRulesStore(store), refundPort);
    const res = await app.inject({
      method: "POST", url: "/_internal/propose-refund", headers: bearer("shop-1"),
      payload: { orderRef: "1001", amountUsd: 25, reason: "goodwill" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("proposed");
    expect(refundPort.issued).toHaveLength(0); // propose-only — never auto-issued
    await app.close();
  });

  it("auto-issues tiny in-policy goodwill (within the W4 refund floor) when the merchant widened refund", async () => {
    const store = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(store);
    await rulesStore.set({ tenantId: "shop-1" }, { refund: { allowedAuto: true, maxUsd: 200 } }, "owner", "merchant_set");
    const refundPort = new SandboxRefundAdapter();
    const app = await buildServer({
      store, identity: makeTestIdentity("shop-1"),
      proposalStore: new InMemoryProposalStore(store), rulesStore, refundPort,
    });
    const res = await app.inject({
      method: "POST", url: "/_internal/propose-refund", headers: bearer("shop-1"),
      payload: { orderRef: "1001", amountUsd: 25, reason: "damaged" },
    });
    expect(res.json().kind).toBe("executed");
    expect(refundPort.issued).toEqual([{ tenantId: "shop-1", orderRef: "1001", amountUsd: 25, reason: "damaged" }]);
    await app.close();
  });

  it("stays PENDING above the hard PALUP_FLOORS.refund ceiling even when the merchant allowed auto", async () => {
    const store = new InMemoryRuntimeStore();
    const rulesStore = new InMemoryMerchantRulesStore(store);
    await rulesStore.set({ tenantId: "shop-1" }, { refund: { allowedAuto: true, maxUsd: 200 } }, "owner", "merchant_set");
    const refundPort = new SandboxRefundAdapter();
    const app = await buildServer({
      store, identity: makeTestIdentity("shop-1"),
      proposalStore: new InMemoryProposalStore(store), rulesStore, refundPort,
    });
    const res = await app.inject({
      method: "POST", url: "/_internal/propose-refund", headers: bearer("shop-1"),
      payload: { orderRef: "1001", amountUsd: 500 },
    });
    expect(res.json().kind).toBe("proposed"); // 500 > floor maxAutoUsd 200 -> requires approval
    expect(refundPort.issued).toHaveLength(0);
    await app.close();
  });

  it("400s a malformed body (missing orderRef / non-number amount)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await server(new InMemoryMerchantRulesStore(store), new SandboxRefundAdapter());
    const res = await app.inject({ method: "POST", url: "/_internal/propose-refund", headers: bearer("shop-1"), payload: { amountUsd: "x" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

> Confirm `InMemoryMerchantRulesStore.set(ctx, ruleset, userId, provenance)`'s exact argument order against `merchant-rules-store.ts` before running (Task references `rules.ts:199` — `set(ctx, value, userId, "merchant_set")`). Verify the classifier reads `params.usd` (not `params.amountUsd`) — `AUTO_ELIGIBLE_DIMENSIONS.refund = ["usd"]` (`merchant-rules-store.ts:228`), so the action built in Step 3 must put the dollar amount under `usd`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-backend test -- internal-refund-route`
Expected: FAIL — route not registered.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/merchant-backend/src/routes/internal-refund.ts
import type { FastifyInstance } from "fastify";
import { requirePermission } from "@palup/identity-shopify";
import type { MerchantRulesStore, ProposalStore, RefundPort, RuntimeStatePort } from "@palup/platform-ports";
import { createRulesProvider, proposeOrExecute, refundExecutor, REFUND_ACTION_TYPE, type EngineDeps } from "@palup/agent-runtime";

// W5 — `POST /_internal/propose-refund`: a STAGING TRIGGER that runs one candidate refund through the
// W1 loop (`proposeOrExecute`), proving the propose-only + tiny-goodwill behavior against the REAL
// PALUP_FLOORS.refund + merchant rules. Registered inside server.ts's authenticated `merchantPlane`
// (F3) so `requireMerchant` (401) already ran; `agent.operate` additionally 403s a bare viewer. `ctx`
// is `req.principal.merchantId` ONLY. Refunds NEVER auto beyond the floor (clamped at classify-time);
// the executor is the SandboxRefundAdapter (records, never issues) until a live adapter is human-gated.
//
// staging trigger; replaced by the scheduled runtime host (later plan)

export interface ProposeRefundDeps {
  state: RuntimeStatePort;
  proposalStore: ProposalStore;
  rulesStore: MerchantRulesStore;
  refundPort: RefundPort;
}

export function registerInternalRefundRoutes(app: FastifyInstance, deps: ProposeRefundDeps): void {
  app.post<{ Body: { orderRef?: unknown; amountUsd?: unknown; reason?: unknown } }>(
    "/_internal/propose-refund",
    { preHandler: requirePermission("agent.operate") },
    async (req, reply) => {
      const principal = req.principal!;
      const ctx = { tenantId: principal.merchantId };
      const now = new Date().toISOString();

      const { orderRef, amountUsd, reason } = req.body ?? {};
      if (typeof orderRef !== "string" || orderRef.length === 0 || typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
        return reply.code(400).send({ error: "orderRef (string) and amountUsd (number) are required" });
      }
      const reasonStr = typeof reason === "string" && reason.length > 0 ? reason : "goodwill";

      const engineDeps: EngineDeps = {
        store: deps.proposalStore,
        state: deps.state,
        rules: createRulesProvider(deps.rulesStore),
        executor: refundExecutor(deps.refundPort),
        validate: async () => ({ valid: true }),
      };

      const result = await proposeOrExecute(
        {
          ctx,
          agentId: `agent:${principal.merchantId}:refund`,
          agentType: "service",
          category: "refund",
          rationale: `Refund $${amountUsd} on order ${orderRef} (${reasonStr})`,
          reversalPlan: { reversible: true, plan: "Re-charge the customer via Shopify admin if issued in error." },
          now,
          action: { type: REFUND_ACTION_TYPE, params: { orderRef, usd: amountUsd, reason: reasonStr } },
        },
        engineDeps,
      );

      return result.kind === "executed"
        ? { kind: "executed" as const }
        : { kind: "proposed" as const, proposedId: result.proposal!.id };
    },
  );
}
```

Wire into `server.ts`:
- `import { registerInternalRefundRoutes } from "./routes/internal-refund.js";`
- Register: `registerInternalRefundRoutes(merchantPlane, { state: store, proposalStore, rulesStore, refundPort });`

Add `{ method: "POST", url: "/_internal/propose-refund" }` to `KNOWN_DATA_ROUTES`.

> Verify `agentType: "service"` is an accepted `RUNTIME_AGENT_TYPE` for the kill-switch/classifier path. If the codebase pins agent types to an enum, use the same literal `internal-winback.ts`/`proposeWinBack` uses for its win-back agent; grep `RUNTIME_AGENT_TYPE` in `@palup/agent-runtime` and match an existing value rather than inventing `"service"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-backend test -- internal-refund-route route-protection`
Expected: PASS (4 trigger tests; route-protection green with the new route).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-backend/src/routes/internal-refund.ts packages/merchant-backend/src/server.ts packages/merchant-backend/test/internal-refund-route.test.ts packages/merchant-backend/test/route-protection.test.ts
git commit -m "feat(merchant-backend): propose-refund staging trigger — propose-only + tiny-goodwill floor (W5)"
```

---

### Task 10: Console API client — `getOrders` + `getPayments`

**Files:**
- Modify: `packages/merchant-console/src/app/api.ts` (types + `ApiClient` interface + `makeApiClient` impl)
- Test: `packages/merchant-console/test/api-client-w5.test.ts` (create)

**Interfaces:**
- Consumes: `MerchantOrderSummary`, `Payout`, `FeeLine` (`@palup/platform-ports`, **type-only** imports).
- Produces (added to `ApiClient`):
  - `getOrders(): Promise<{ items: OrderView[]; source: "live" | "unavailable"; sourceNote: string }>`
  - `getPayments(): Promise<PaymentsView>`
  - Local mirror types: `OrderTouchpoint`, `OrderView`, `PaymentsView` (backend-only DTOs, not in platform-ports).

- [ ] **Step 1: Write the failing test**

```ts
// packages/merchant-console/test/api-client-w5.test.ts
import { describe, expect, it } from "vitest";
import { makeApiClient } from "../src/app/api";

function fetchStub(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as never;
}

describe("ApiClient W5", () => {
  it("getOrders hits GET /orders and returns items", async () => {
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchStub({ items: [], source: "unavailable", sourceNote: "x" }) });
    expect((await api.getOrders()).source).toBe("unavailable");
  });
  it("getPayments hits GET /payments and returns the fee line", async () => {
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchStub({ period: "2026-08", payouts: [], payoutTotalUsd: 0, fee: { chargeable: false, ratePct: 6, baseIncrementalUsd: null, computedFeeUsd: null, reason: "attribution_underpowered" }, payoutsAdminPath: "admin/settings/payments", trustNote: "PalUp never touches your money." }) });
    expect((await api.getPayments()).fee.chargeable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-console test -- api-client-w5`
Expected: FAIL — `getOrders`/`getPayments` not on `ApiClient`.

- [ ] **Step 3: Write minimal implementation**

In `api.ts`, add to the type-only `@palup/platform-ports` import (line 1): `MerchantOrderSummary, Payout, FeeLine`.

Add mirror types (near the other W-block mirrors, after the W4 block ~line 220):

```ts
// W5 (Orders + Payments & Payouts) — mirrors merchant-backend's wire contract
// (routes/orders.ts's OrderView + orders/touchpoints.ts's OrderTouchpoint; payments/read-model.ts's
// PaymentsView). MerchantOrderSummary/Payout/FeeLine are imported as TYPES from @palup/platform-ports
// (already a dependency); the backend-only composite DTOs are mirrored locally, same as HomeSummary.

export interface OrderTouchpoint {
  orderRef: string;
  seq: number;
  at: string;
  actor: string;
  action: string;
}

export interface OrderView extends MerchantOrderSummary {
  touchpoints: OrderTouchpoint[];
  adminPath: string;
}

export interface PaymentsView {
  period: string;
  payouts: Payout[];
  payoutTotalUsd: number;
  fee: FeeLine;
  payoutsAdminPath: string;
  trustNote: string;
}
```

Add to the `ApiClient` interface (after `applyRulePreset`):

```ts
  getOrders(): Promise<{ items: OrderView[]; source: "live" | "unavailable"; sourceNote: string }>;
  getPayments(): Promise<PaymentsView>;
```

Add to the returned object in `makeApiClient` (after `applyRulePreset`):

```ts
    async getOrders() {
      return request<{ items: OrderView[]; source: "live" | "unavailable"; sourceNote: string }>("/orders");
    },
    async getPayments() {
      return request<PaymentsView>("/payments");
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-console test -- api-client-w5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-console/src/app/api.ts packages/merchant-console/test/api-client-w5.test.ts
git commit -m "feat(merchant-console): ApiClient getOrders + getPayments (W5)"
```

---

### Task 11: Orders screen (`/orders`)

**Files:**
- Create: `packages/merchant-console/src/screens/orders/OrdersView.tsx`
- Create: `packages/merchant-console/src/screens/orders/OrdersView.test.tsx`
- Modify: `packages/merchant-console/src/App.tsx` (import + route `/orders`; remove `/orders` from `STUB_ROUTES`)

**Interfaces:**
- Consumes: `ApiClient` (`getOrders`), `OrderView` (`../../app/api`); design-system `Card`/`CardHeader`/`CardTitle`/`CardBody`/`Table*`/`Badge`/`Note`/`Button`.
- Produces: `function OrdersView({ api }: { api: Pick<ApiClient, "getOrders"> }): JSX.Element`

**Design note:** Load loading/ready/error states mirror `RevenueHome.tsx`. Each order row shows order number, date, total, financial + fulfilment status badges, a touchpoints summary (count or "No agent activity yet"), and a "Manage in Shopify" deep-link (from `adminPath`, opened via App Bridge — render as `admin/...` relative anchor; App Bridge resolves it in the embed). When `source === "unavailable"`, render an honest `Note` with `sourceNote`, no fabricated rows. **Never render any incremental/attributed $ here.** Load the `palup-design-system` skill and match `palup-merchant-app.html`'s Orders section before writing markup.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/merchant-console/src/screens/orders/OrdersView.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { OrdersView } from "./OrdersView";
import type { OrderView } from "../../app/api";

const order = (over: Partial<OrderView> = {}): OrderView => ({
  id: "1001", orderNumber: "#1001", placedAt: "2026-08-20T00:00:00Z", totalUsd: 42, currency: "USD",
  financialStatus: "paid", fulfillmentStatus: "unfulfilled", customerLabel: "Guest", touchpoints: [], adminPath: "admin/orders/1001", ...over,
});

describe("OrdersView", () => {
  it("renders orders with an honest 'no agent activity' touchpoint state and a Shopify deep-link", async () => {
    const api = { getOrders: async () => ({ items: [order()], source: "live" as const, sourceNote: "note" }) };
    render(<OrdersView api={api} />);
    await waitFor(() => expect(screen.getByText("#1001")).toBeInTheDocument());
    expect(screen.getByText(/no agent activity/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /manage in shopify/i })).toHaveAttribute("href", expect.stringContaining("admin/orders/1001"));
  });

  it("shows an honest unavailable state (no fabricated rows) when read-through is not connected", async () => {
    const api = { getOrders: async () => ({ items: [], source: "unavailable" as const, sourceNote: "Order read-through is not connected yet" }) };
    render(<OrdersView api={api} />);
    await waitFor(() => expect(screen.getByText(/not connected yet/i)).toBeInTheDocument());
  });

  it("shows a touchpoint count when the agent acted on an order", async () => {
    const api = { getOrders: async () => ({ items: [order({ touchpoints: [{ orderRef: "1001", seq: 3, at: "2026-08-20T01:00:00Z", actor: "agent:wb", action: "proposal.executed" }] })], source: "live" as const, sourceNote: "n" }) };
    render(<OrdersView api={api} />);
    await waitFor(() => expect(screen.getByText(/1 agent action/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-console test -- OrdersView`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/merchant-console/src/screens/orders/OrdersView.tsx
import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Card, CardBody, CardHeader, CardTitle, Note,
  Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow,
} from "@palup/design-system";
import type { ApiClient, OrderView } from "../../app/api";

// W5 — Orders screen (spec §9 W5). READ-THROUGH: Shopify is the system of record; every row links out
// to Shopify for money actions (adminPath). Annotated with per-order agent TOUCHPOINTS (factual). By
// governance rule this screen NEVER shows incremental/attributed $ (that is aggregate/billed — W2/W6);
// only factual per-order data. Honest loading/empty/error states; no fabricated rows.

type LoadState = "loading" | "ready" | "error";

function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function touchpointLabel(count: number): string {
  return count === 0 ? "No agent activity yet" : count === 1 ? "1 agent action" : `${count} agent actions`;
}

export function OrdersView({ api }: { api: Pick<ApiClient, "getOrders"> }) {
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<OrderView[]>([]);
  const [source, setSource] = useState<"live" | "unavailable">("live");
  const [sourceNote, setSourceNote] = useState("");

  const load = useCallback(() => {
    setState("loading");
    api.getOrders().then(
      (res) => { setItems(res.items); setSource(res.source); setSourceNote(res.sourceNote); setState("ready"); },
      () => setState("error"),
    );
  }, [api]);

  useEffect(() => { load(); }, [load]);

  if (state === "loading") {
    return <div role="status" className="p-6 text-[13px] text-ink-3">Loading orders…</div>;
  }
  if (state === "error") {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn&apos;t load orders.</span>
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        </div>
      </Note>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Note variant="info">
        Shopify is the system of record for your orders. PalUp shows what your agent did — refunds and
        edits happen in Shopify.
      </Note>

      {source === "unavailable" ? (
        <Note variant="warn">{sourceNote}</Note>
      ) : items.length === 0 ? (
        <Note variant="info">No orders in this window yet.</Note>
      ) : (
        <Card>
          <CardHeader><CardTitle>Recent orders</CardTitle></CardHeader>
          <CardBody>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Order</TableHeaderCell>
                  <TableHeaderCell>Total</TableHeaderCell>
                  <TableHeaderCell>Payment</TableHeaderCell>
                  <TableHeaderCell>Fulfilment</TableHeaderCell>
                  <TableHeaderCell>Agent activity</TableHeaderCell>
                  <TableHeaderCell>Manage</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{o.orderNumber}</TableCell>
                    <TableCell>{fmtUsd(o.totalUsd)}</TableCell>
                    <TableCell><Badge variant="gray" dot={false}>{o.financialStatus}</Badge></TableCell>
                    <TableCell><Badge variant="gray" dot={false}>{o.fulfillmentStatus}</Badge></TableCell>
                    <TableCell>{touchpointLabel(o.touchpoints.length)}</TableCell>
                    <TableCell><a href={o.adminPath} target="_blank" rel="noreferrer" className="text-brand underline">Manage in Shopify</a></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
```

> If `Badge`'s `dot` prop or the `text-brand`/`text-ink-3` token names differ from the design system, match the exact props/tokens the sibling screens (`RevenueHome.tsx`, `LearnedView.tsx`) already use — do not invent tokens (design-system skill).

In `App.tsx`: `import { OrdersView } from "./screens/orders/OrdersView";`, remove `{ path: "/orders", title: "Orders" }` from `STUB_ROUTES`, add `<Route path="/orders" element={<OrdersView api={api} />} />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-console test -- OrdersView`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-console/src/screens/orders/OrdersView.tsx packages/merchant-console/src/screens/orders/OrdersView.test.tsx packages/merchant-console/src/App.tsx
git commit -m "feat(merchant-console): Orders screen — read-through + agent touchpoints + Shopify deep-links (W5)"
```

---

### Task 12: Payments & Payouts screen (`/payments`)

**Files:**
- Create: `packages/merchant-console/src/screens/payments/PaymentsView.tsx`
- Create: `packages/merchant-console/src/screens/payments/PaymentsView.test.tsx`
- Modify: `packages/merchant-console/src/App.tsx` (import + route `/payments`; remove `/payments` from `STUB_ROUTES`)

**Interfaces:**
- Consumes: `ApiClient` (`getPayments`), `PaymentsView` type (`../../app/api`); design-system `Card`/`StatTile`/`Table*`/`Badge`/`Note`/`Button`.
- Produces: `function PaymentsView({ api }: { api: Pick<ApiClient, "getPayments"> }): JSX.Element` (component name `PaymentsScreen` to avoid clashing with the `PaymentsView` type — see note).

**Design note:** The type is named `PaymentsView` (mirrors backend). Name the COMPONENT `PaymentsScreen` to avoid a same-name collision with the imported type. Trust anchor front and center: render `trustNote` verbatim as a prominent `Note`. Fee line labeled explicitly "Computed — not charged. Billed through Shopify (see Billing)." When `fee.reason === "attribution_underpowered"`, show "Not yet — we only bill once we've proven incremental lift", never a $0 fee. Payouts table with a deep-link to Shopify payouts settings. Load `palup-design-system` skill + match `palup-merchant-app.html`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/merchant-console/src/screens/payments/PaymentsView.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PaymentsScreen } from "./PaymentsView";
import type { PaymentsView } from "../../app/api";

const base = (over: Partial<PaymentsView> = {}): PaymentsView => ({
  period: "2026-08", payouts: [], payoutTotalUsd: 0,
  fee: { chargeable: false, ratePct: 6, baseIncrementalUsd: null, computedFeeUsd: null, reason: "attribution_underpowered" },
  payoutsAdminPath: "admin/settings/payments", trustNote: "PalUp never touches your money.", ...over,
});

describe("PaymentsScreen", () => {
  it("renders the trust anchor verbatim", async () => {
    render(<PaymentsScreen api={{ getPayments: async () => base() }} />);
    await waitFor(() => expect(screen.getByText(/never touches your money/i)).toBeInTheDocument());
  });

  it("shows the fee line as computed-not-charged, never a $0 when underpowered", async () => {
    render(<PaymentsScreen api={{ getPayments: async () => base() }} />);
    await waitFor(() => expect(screen.getByText(/not charged/i)).toBeInTheDocument());
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText(/proven incremental/i)).toBeInTheDocument();
  });

  it("shows the computed fee amount when powered", async () => {
    render(<PaymentsScreen api={{ getPayments: async () => base({ fee: { chargeable: false, ratePct: 6, baseIncrementalUsd: 1000, computedFeeUsd: 60, reason: "computed" } }) }} />);
    await waitFor(() => expect(screen.getByText("$60.00")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @palup/merchant-console test -- PaymentsView`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/merchant-console/src/screens/payments/PaymentsView.tsx
import { useCallback, useEffect, useState } from "react";
import {
  Badge, Button, Card, CardBody, CardHeader, CardTitle, Note, StatTile,
  Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow,
} from "@palup/design-system";
import type { ApiClient, PaymentsView } from "../../app/api";

// W5 — Payments & Payouts screen (spec §9 W5): the trust anchor. Shopify payouts are read-through
// (PalUp never touches this money); the PalUp fee line is COMPUTED and clearly labeled NOT CHARGED
// (real billing is W6, through Shopify). No fabricated numbers — an underpowered fee is withheld.

type LoadState = "loading" | "ready" | "error";

function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export function PaymentsScreen({ api }: { api: Pick<ApiClient, "getPayments"> }) {
  const [state, setState] = useState<LoadState>("loading");
  const [view, setView] = useState<PaymentsView | null>(null);

  const load = useCallback(() => {
    setState("loading");
    api.getPayments().then((v) => { setView(v); setState("ready"); }, () => setState("error"));
  }, [api]);

  useEffect(() => { load(); }, [load]);

  if (state === "loading") {
    return <div role="status" className="p-6 text-[13px] text-ink-3">Loading payments…</div>;
  }
  if (state === "error" || view === null) {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn&apos;t load payments.</span>
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        </div>
      </Note>
    );
  }

  const feeValue = view.fee.reason === "computed" && view.fee.computedFeeUsd !== null ? fmtUsd(view.fee.computedFeeUsd) : "Not yet";
  const feeFootnote =
    view.fee.reason === "computed"
      ? `${view.fee.ratePct}% of proven incremental — computed, NOT charged. Billed through Shopify (see Billing).`
      : "Not yet — we only bill once we've proven incremental lift against your holdout. Computed, not charged.";

  return (
    <div className="flex flex-col gap-4">
      <Note variant="ever"><b>{view.trustNote}</b></Note>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <StatTile label="Shopify payouts (this period)" value={fmtUsd(view.payoutTotalUsd)} mono footnote={`${view.period} · straight from Shopify to your bank`} />
        <StatTile label="PalUp fee (illustrative)" value={feeValue} mono={view.fee.reason === "computed"} footnote={feeFootnote} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payouts</CardTitle>
          <a href={view.payoutsAdminPath} target="_blank" rel="noreferrer" className="text-brand text-sm underline">View in Shopify</a>
        </CardHeader>
        <CardBody>
          {view.payouts.length === 0 ? (
            <Note variant="info">No payouts to show yet. Payouts appear here once your Shopify Payments payouts are connected.</Note>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Date</TableHeaderCell>
                  <TableHeaderCell>Amount</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {view.payouts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{new Date(p.issuedAt).toLocaleDateString("en-US")}</TableCell>
                    <TableCell>{fmtUsd(p.amountUsd)}</TableCell>
                    <TableCell><Badge variant="gray" dot={false}>{p.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
```

In `App.tsx`: `import { PaymentsScreen } from "./screens/payments/PaymentsView";`, remove `{ path: "/payments", title: "Payments & Payouts" }` from `STUB_ROUTES`, add `<Route path="/payments" element={<PaymentsScreen api={api} />} />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @palup/merchant-console test -- PaymentsView`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/merchant-console/src/screens/payments/PaymentsView.tsx packages/merchant-console/src/screens/payments/PaymentsView.test.tsx packages/merchant-console/src/App.tsx
git commit -m "feat(merchant-console): Payments & Payouts screen — trust anchor + computed-not-charged fee line (W5)"
```

---

### Task 13: Full-suite green + governance check

**Files:** none (verification task).

- [ ] **Step 1: Run the merchant-backend + platform-ports + agent-runtime + merchant-console suites**

Run: `pnpm --filter @palup/platform-ports --filter @palup/agent-runtime --filter @palup/merchant-backend --filter @palup/merchant-console test`
Expected: PASS across all four packages (including `route-protection.test.ts` covering `/orders`, `/payments`, `/_internal/propose-refund`).

- [ ] **Step 2: Run the repo CI gate set**

Run the four-command local gate (typecheck + lint + build + test) per project memory `full-ci-gate-set`. Confirm the merchant-console Vite build passes (no value import of a platform-ports symbol leaked into a screen — types only).
Expected: all green.

- [ ] **Step 3: Governance self-check**

Confirm: (a) no route mutates orders/fulfilment; (b) the only money mutation (refund) is dark (`SandboxRefundAdapter`) and cannot exceed `PALUP_FLOORS.refund` (proved by Task 9 tests); (c) no incremental $ on the Orders screen; (d) the fee line is `chargeable:false` everywhere. Run `/governance-check` if wiring changed a HITL boundary interpretation.

- [ ] **Step 4: Commit (if any lint/format fixups were needed)**

```bash
git add -A && git commit -m "chore(W5): full-suite green + governance check"
```

---

## Deferred human/legal/enablement gates

These are explicitly OUT of scope for this plan — the mechanisms are built dark; turning them on is a human/legal/operator step, never a build agent's:

- **Shopify `read_orders` scope + PCD approval (prod).** The live `CommercePort.listOrders` Shopify Admin-API adapter needs the `read_orders` scope and Shopify Protected Customer Data approval before real orders can be read in production. Until then `SandboxOrderDirectory` (empty) backs `/orders` and the screen shows `source: "unavailable"`.
- **Shopify Payments payouts scope (prod).** The live `PayoutsPort` adapter needs the `read_shopify_payments_payouts` scope. Until then `SandboxPayoutsPort` (empty) backs `/payments`.
- **Live refund execution.** The real Shopify refund adapter (a `RefundPort` with `isLive: true`) is a security-reviewer + human-gated enablement (money mutation, §3). The build ships `SandboxRefundAdapter` (records, never issues). Enabling live refunds must not weaken `PALUP_FLOORS.refund`.
- **The illustrative fee becoming a real charge.** `PALUP_ILLUSTRATIVE_TAKE_RATE` / `computeFeeLine` are display-only. Actual billing (charging the fee through Shopify Billing) is W6 and its own §3 boundary — never enabled as a side effect of W5.
- **Scheduled runtime host for the refund agent.** `POST /_internal/propose-refund` is a staging trigger; a real order-linked refund agent running on the scheduled runtime host (writing an `orderId` param so touchpoints light up) is a later plan through the evolution pipeline.
- **Agent-plane review.** Adding the `issue_refund` executor touches run-time agent behavior — `agent-evolution-steward` + `security-reviewer` should sign off before any live enablement.

## Assumes from earlier blocks (already merged on `main`)

- **W1 (Approval Center loop):** `proposeOrExecute` / `executeApproved` (`agent-runtime/loop.ts`), `ProposalStore`, the `refund` `ProposalCategory` + TTL, kill-switch guard, hash-chained audit. W5's refund path routes through these unchanged.
- **W4 (Rules + floors):** `PALUP_FLOORS.refund` (`maxAutoUsd: 200`), `createRulesProvider`, `MerchantRulesStore`, `CONSERVATIVE_DEFAULTS` (refund `allowedAuto:false`), `AUTO_ELIGIBLE_DIMENSIONS.refund = ["usd"]`. These govern whether a refund auto-executes or becomes a pending proposal — W5 adds no new floor logic.
- **W2 (Revenue Home / activity):** `routes/activity.ts`'s audit-backed read-model discipline (reused by Task 2's touchpoints); the canonical incremental spine — `readOutcomeLedger` + `currentPeriod` + `attributedIncrementalRevenue` (ADR-0007) — reused by Task 5's fee base. W5 introduces no second attribution path.
- **Engine registry:** `engine-wiring.ts`'s `resolveExecutor`/`resolveValidator`/`buildEngineDeps` fail-closed registry; `approvals.ts`'s `buildEngineDeps` call. W5 adds the `issue_refund` case + `refund` validator + `refundPort` dep, following the exact pattern of the `change_voice`/`change_rules` additions.
- **CommercePort / Shopify commerce adapter:** the existing `CommercePort` (per-shopper support reads) + the sandbox/tenant-isolation conventions (`SandboxCustomerDirectory`, `CustomerListingCommerce`). W5 EXTENDS `CommercePort` with an optional tenant-wide `listOrders` + `MerchantOrderSummary` + `SandboxOrderDirectory`, mirroring the existing optional `listCustomersWithLastOrder`. No existing method is changed.
- **`store-profile-port` (peer's credential-enrollment/catalog-unified work):** exists (`StoreProfilePort`, brand + policy per tenant). W5 does NOT need it for orders/payouts read-through, but the live Shopify adapters (deferred) will resolve a shop's admin token via the same secrets/registry path the peer wired — noted so the live-adapter enablement reuses it rather than inventing a second token custody path.
- **Console shell + `ApiClient` conventions:** `App.tsx` routing + `STUB_ROUTES`, `app/api.ts`'s typed client (401 refresh/retry, typed errors), design-system components, fake-ApiClient screen tests. W5 replaces the `/orders` and `/payments` stubs.
