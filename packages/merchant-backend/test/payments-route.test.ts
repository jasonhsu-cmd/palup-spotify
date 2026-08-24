import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStore, SandboxPayoutsPort, type Payout } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { makeTestIdentity, bearer } from "./helpers/test-identity.js";

// W5 Task 6 — `GET /payments`: read-through of Shopify payouts (system of record) + the transparent,
// computed-not-charged PalUp fee line (Task 5's readPaymentsView). Reuses the shared test-identity
// double from Task 3 (M1) rather than recreating an inline fake.

const payout = (id: string, amt: number): Payout => ({
  id,
  status: "paid",
  amountUsd: amt,
  currency: "USD",
  issuedAt: "2026-08-20T00:00:00Z",
});

describe("GET /payments", () => {
  it("returns payouts + a computed-not-charged fee line + the trust note", async () => {
    const store = new InMemoryRuntimeStore();
    const payouts = new SandboxPayoutsPort({ "shop-1": [payout("po1", 300)] });
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), payouts });
    const res = await app.inject({ method: "GET", url: "/payments", headers: bearer() });
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

  it("scopes payouts to the requesting tenant only — shop-2 never sees shop-1's payout", async () => {
    const store = new InMemoryRuntimeStore();
    const payouts = new SandboxPayoutsPort({ "shop-1": [payout("po1", 300)] });
    const app = await buildServer({ store, identity: makeTestIdentity("shop-2"), payouts });
    const res = await app.inject({ method: "GET", url: "/payments", headers: bearer() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.payoutTotalUsd).toBe(0);
    expect(body.payouts).toEqual([]);
    await app.close();
  });

  it("never presents the fee as chargeable even when attribution is powered", async () => {
    // computeFeeLine's return type hardcodes chargeable:false; assert the route's actual JSON
    // response preserves that all the way through serialization, not just the TS type.
    const store = new InMemoryRuntimeStore();
    const payouts = new SandboxPayoutsPort({ "shop-1": [payout("po1", 1000)] });
    const app = await buildServer({ store, identity: makeTestIdentity("shop-1"), payouts });
    const res = await app.inject({ method: "GET", url: "/payments", headers: bearer() });
    const body = res.json();
    expect(body.fee).toHaveProperty("chargeable", false);
    await app.close();
  });

  it("is honest/empty (never crashes) when no PayoutsPort is supplied", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore(), identity: makeTestIdentity("shop-1") });
    const res = await app.inject({ method: "GET", url: "/payments", headers: bearer() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.payouts).toEqual([]);
    expect(body.fee.chargeable).toBe(false);
    await app.close();
  });
});
