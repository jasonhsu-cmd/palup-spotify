import { describe, expect, it } from "vitest";
import {
  InMemoryRuntimeStore,
  InMemoryProposalStore,
  InMemoryMerchantRulesStore,
  SandboxRefundAdapter,
} from "@palup/platform-ports";
import { armKill } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";
import { makeTestIdentity, bearer } from "./helpers/test-identity.js";

// W5 Task 9 — `POST /_internal/propose-refund`: a STAGING TRIGGER that runs one candidate refund
// through the real W1 loop (`proposeOrExecute`) against the REAL `PALUP_FLOORS.refund` +
// `createRulesProvider`, proving BOTH halves of the spec's propose-only/tiny-goodwill carve-out:
//   - default (conservative) rules -> refund.allowedAuto is false -> every refund proposes, none auto.
//   - a merchant who has explicitly widened `refund` gets a TINY in-policy goodwill auto-execute, but
//     only up to PALUP_FLOORS.refund.maxAutoUsd (200) -> above that, still pending regardless of the
//     merchant's own (looser) rule.
// Reuses the shared test-identity double from Task 3 (M1) rather than recreating an inline fake.

describe("POST /_internal/propose-refund", () => {
  it("creates a PENDING proposal (routes to W1) under default conservative rules — nothing issued", async () => {
    const store = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(store);
    const rulesStore = new InMemoryMerchantRulesStore(store);
    const refundPort = new SandboxRefundAdapter();
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-1"),
      proposalStore,
      rulesStore,
      refundPort,
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { orderRef: "1001", amountUsd: 25, reason: "goodwill" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("proposed");
    expect(typeof body.proposedId).toBe("string");

    // propose-only — never auto-issued.
    expect(refundPort.issued).toHaveLength(0);

    const list = await proposalStore.list({ tenantId: "shop-1" });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).toBe(body.proposedId);
    expect(list.items[0]?.status).toBe("pending");
    expect(list.items[0]?.category).toBe("refund");
    expect(list.items[0]?.tenantId).toBe("shop-1");
    // M3: the proposed refund action carries the dedicated refund_desk agent type — never a shared
    // "service"/"win_back" type — so an operator can arm a type-scoped kill on just the money-mover.
    expect(list.items[0]?.agentType).toBe("refund_desk");

    await app.close();
  });

  it("auto-issues tiny in-policy goodwill (within the W4 refund floor) when the merchant widened refund", async () => {
    const store = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(store);
    const rulesStore = new InMemoryMerchantRulesStore(store);
    await rulesStore.set({ tenantId: "shop-1" }, { refund: { allowedAuto: true, maxUsd: 200 } }, "owner", "merchant_set");
    const refundPort = new SandboxRefundAdapter();
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-1"),
      proposalStore,
      rulesStore,
      refundPort,
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { orderRef: "1001", amountUsd: 25, reason: "damaged" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("executed");

    // The sandbox adapter RECORDED the intent — it never issues real money — and nothing is pending.
    expect(refundPort.issued).toEqual([{ tenantId: "shop-1", orderRef: "1001", amountUsd: 25, reason: "damaged" }]);
    const list = await proposalStore.list({ tenantId: "shop-1" });
    expect(list.items).toHaveLength(0);

    await app.close();
  });

  it("stays PENDING above the hard PALUP_FLOORS.refund ceiling even when the merchant allowed auto", async () => {
    const store = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(store);
    const rulesStore = new InMemoryMerchantRulesStore(store);
    await rulesStore.set({ tenantId: "shop-1" }, { refund: { allowedAuto: true, maxUsd: 200 } }, "owner", "merchant_set");
    const refundPort = new SandboxRefundAdapter();
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-1"),
      proposalStore,
      rulesStore,
      refundPort,
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { orderRef: "1001", amountUsd: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("proposed"); // 500 > PALUP_FLOORS.refund.maxAutoUsd (200) -> requires approval

    expect(refundPort.issued).toHaveLength(0);
    const list = await proposalStore.list({ tenantId: "shop-1" });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.status).toBe("pending");

    await app.close();
  });

  // Coordinator review follow-up: the two tests above both used a merchant `maxUsd:200` that EQUALS
  // `PALUP_FLOORS.refund.maxAutoUsd` (200), so they can't isolate "the inviolable PLATFORM floor is
  // what capped it" from "the merchant's own (coincidentally identical) number capped it". These two
  // tests use a merchant rule GENUINELY LOOSER than the floor (maxUsd: 1000) so only `clampToFloor`
  // pulling the auto-limit down to the $200 platform ceiling — never the merchant's own $1000 — can
  // explain the observed behavior. If `clampToFloor` were ever bypassed (the merchant's raw $1000
  // used instead of the floor), the $500 case below would wrongly auto-execute.
  it("a merchant rule genuinely LOOSER than the floor ($1000) still proposes above the $200 floor — the platform floor binds, not the merchant's number", async () => {
    const store = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(store);
    const rulesStore = new InMemoryMerchantRulesStore(store);
    await rulesStore.set({ tenantId: "shop-1" }, { refund: { allowedAuto: true, maxUsd: 1000 } }, "owner", "merchant_set");
    const refundPort = new SandboxRefundAdapter();
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-1"),
      proposalStore,
      rulesStore,
      refundPort,
    });

    // $500 is > the $200 platform floor but well within the merchant's own $1000 ceiling — a
    // proposal here can ONLY be explained by clampToFloor pulling the auto-limit down to $200.
    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { orderRef: "1001", amountUsd: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("proposed");

    expect(refundPort.issued).toHaveLength(0);
    const list = await proposalStore.list({ tenantId: "shop-1" });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.status).toBe("pending");

    await app.close();
  });

  it("a merchant rule genuinely LOOSER than the floor ($1000) still auto-executes AT the $150 within-floor amount", async () => {
    const store = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(store);
    const rulesStore = new InMemoryMerchantRulesStore(store);
    await rulesStore.set({ tenantId: "shop-1" }, { refund: { allowedAuto: true, maxUsd: 1000 } }, "owner", "merchant_set");
    const refundPort = new SandboxRefundAdapter();
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-1"),
      proposalStore,
      rulesStore,
      refundPort,
    });

    // $150 is within BOTH the $200 platform floor and the merchant's $1000 ceiling — proves the
    // floor is the binding constraint (not that the merchant's $1000 disabled auto-act entirely).
    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { orderRef: "1001", amountUsd: 150, reason: "goodwill" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("executed");

    expect(refundPort.issued).toEqual([{ tenantId: "shop-1", orderRef: "1001", amountUsd: 150, reason: "goodwill" }]);
    const list = await proposalStore.list({ tenantId: "shop-1" });
    expect(list.items).toHaveLength(0);

    await app.close();
  });

  it("400s a malformed body (missing orderRef / non-number amount)", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-1"),
      proposalStore: new InMemoryProposalStore(store),
      rulesStore: new InMemoryMerchantRulesStore(store),
      refundPort: new SandboxRefundAdapter(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { amountUsd: "x" },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("a viewer is forbidden — the route requires agent.operate", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-1", "viewer"),
      refundPort: new SandboxRefundAdapter(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { orderRef: "1001", amountUsd: 25 },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1") });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      payload: { orderRef: "1001", amountUsd: 25 },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("scopes to the requesting tenant only — ctx comes from the principal, never the body", async () => {
    const store = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(store);
    const rulesStore = new InMemoryMerchantRulesStore(store);
    const refundPort = new SandboxRefundAdapter();
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-2"),
      proposalStore,
      rulesStore,
      refundPort,
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { orderRef: "1001", amountUsd: 25 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Never lands on shop-1's partition — the request body carries no tenant field at all.
    expect((await proposalStore.list({ tenantId: "shop-1" })).items).toHaveLength(0);
    const shop2 = await proposalStore.list({ tenantId: "shop-2" });
    expect(shop2.items).toHaveLength(1);
    expect(shop2.items[0]?.id).toBe(body.proposedId);

    await app.close();
  });

  it("blocks on a tenant-scoped kill switch — nothing is issued and no proposal is created", async () => {
    const store = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(store);
    const rulesStore = new InMemoryMerchantRulesStore(store);
    const refundPort = new SandboxRefundAdapter();
    await armKill(store, "tenant:shop-1", "incident");
    const app = await buildServer({
      store,
      identity: makeTestIdentity("shop-1"),
      proposalStore,
      rulesStore,
      refundPort,
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/propose-refund",
      headers: bearer(),
      payload: { orderRef: "1001", amountUsd: 25 },
    });
    // The route has no bespoke KillSwitchError mapping (same as the other staging triggers) — it
    // propagates to server.ts's generic, message-redacted 500 handler. The important assertion is
    // the SIDE EFFECT: no refund issued, no proposal created.
    expect(res.statusCode).toBe(500);
    expect(refundPort.issued).toHaveLength(0);
    expect((await proposalStore.list({ tenantId: "shop-1" })).items).toHaveLength(0);

    await app.close();
  });
});
