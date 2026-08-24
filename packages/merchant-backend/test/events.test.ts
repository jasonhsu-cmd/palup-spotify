import { describe, it, expect } from "vitest";
import * as http from "node:http";
import {
  InMemoryRuntimeStore,
  InMemoryProposalStore,
  InMemoryMerchantRulesStore,
  SandboxCommsAdapter,
  SandboxCustomerDirectory,
  type MerchantIdentityPort,
  type MerchantPrincipal,
} from "@palup/platform-ports";
import { findLapsedSegment, draftWinBack, proposeWinBack, createRulesProvider, campaignExecutor } from "@palup/agent-runtime";
import { buildServer } from "../src/server.js";
import { InMemoryEventBus, type ConsoleEvent, type EventBus } from "../src/events.js";

// W1-API Task 7: `InMemoryEventBus` (pure unit tests) + the SSE `GET /events` wire + the mutating
// routes (approve/reject/kill/unkill) publishing to it. Same fixtures/pattern as
// approve.test.ts/reject.test.ts/kill-routes.test.ts.

const owner: MerchantPrincipal = { kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1" };
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };
const operator: MerchantPrincipal = { ...owner, role: "operator" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

async function seedPendingCampaign(state: InMemoryRuntimeStore, proposalStore: InMemoryProposalStore, rulesStore: InMemoryMerchantRulesStore, comms: SandboxCommsAdapter) {
  const commerce = new SandboxCustomerDirectory({
    t1: [{ customerId: "c1", contact: "c1@x.com", lastOrderAt: "2020-01-01T00:00:00Z" }],
  });
  const ctx = { tenantId: "t1" };
  const now = "2026-08-23T00:00:00Z";
  const segment = await findLapsedSegment(commerce, ctx, { lapsedDays: 60, now });
  const draft = draftWinBack(segment, "t1");
  const result = await proposeWinBack(
    { segment, draft, ctx, now },
    {
      store: proposalStore,
      state,
      rules: createRulesProvider(rulesStore),
      executor: campaignExecutor(comms),
      validate: async () => ({ valid: true }),
    },
  );
  if (!result.proposal) throw new Error("test setup: expected a pending proposal");
  return result.proposal;
}

describe("InMemoryEventBus", () => {
  it("delivers a published event to a subscriber of the same tenant", () => {
    const bus = new InMemoryEventBus();
    const received: ConsoleEvent[] = [];
    bus.subscribe("t1", (e) => received.push(e));
    bus.publish("t1", { type: "kill.changed", killed: true });
    expect(received).toEqual([{ type: "kill.changed", killed: true }]);
  });

  it("tenant isolation: a subscriber for t1 never receives an event published to t2", () => {
    const bus = new InMemoryEventBus();
    const t1Received: ConsoleEvent[] = [];
    const t2Received: ConsoleEvent[] = [];
    bus.subscribe("t1", (e) => t1Received.push(e));
    bus.subscribe("t2", (e) => t2Received.push(e));
    bus.publish("t2", { type: "kill.changed", killed: true });
    expect(t1Received).toEqual([]);
    expect(t2Received).toEqual([{ type: "kill.changed", killed: true }]);
  });

  it("publishing to a tenant with no subscribers is a no-op, never throws", () => {
    const bus = new InMemoryEventBus();
    expect(() => bus.publish("nobody", { type: "kill.changed", killed: false })).not.toThrow();
  });

  it("multiple subscribers for the same tenant all receive the event", () => {
    const bus = new InMemoryEventBus();
    const a: ConsoleEvent[] = [];
    const b: ConsoleEvent[] = [];
    bus.subscribe("t1", (e) => a.push(e));
    bus.subscribe("t1", (e) => b.push(e));
    bus.publish("t1", { type: "proposal.created", id: "p1" });
    expect(a).toEqual([{ type: "proposal.created", id: "p1" }]);
    expect(b).toEqual([{ type: "proposal.created", id: "p1" }]);
  });

  it("unsubscribe stops further delivery to that listener only", () => {
    const bus = new InMemoryEventBus();
    const a: ConsoleEvent[] = [];
    const b: ConsoleEvent[] = [];
    const unsubscribeA = bus.subscribe("t1", (e) => a.push(e));
    bus.subscribe("t1", (e) => b.push(e));
    unsubscribeA();
    bus.publish("t1", { type: "proposal.created", id: "p1" });
    expect(a).toEqual([]);
    expect(b).toEqual([{ type: "proposal.created", id: "p1" }]);
  });

  it("a throwing listener does not break delivery to other subscribers or the publisher", () => {
    const bus = new InMemoryEventBus();
    const b: ConsoleEvent[] = [];
    bus.subscribe("t1", () => {
      throw new Error("boom");
    });
    bus.subscribe("t1", (e) => b.push(e));
    expect(() => bus.publish("t1", { type: "proposal.created", id: "p1" })).not.toThrow();
    expect(b).toEqual([{ type: "proposal.created", id: "p1" }]);
  });
});

describe("mutating routes publish to the shared EventBus", () => {
  it("an approve publishes proposal.decided(executed) to the tenant's subscribers", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const bus = new InMemoryEventBus();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const received: ConsoleEvent[] = [];
    bus.subscribe("t1", (e) => received.push(e));

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, bus });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toEqual([{ type: "proposal.decided", id: proposal.id, status: "executed" }]);
    await app.close();
  });

  it("a reject publishes proposal.decided(rejected) to the tenant's subscribers", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const bus = new InMemoryEventBus();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const received: ConsoleEvent[] = [];
    bus.subscribe("t1", (e) => received.push(e));

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, bus });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: { reason: "off-brand" },
    });
    expect(res.statusCode).toBe(200);
    expect(received).toEqual([{ type: "proposal.decided", id: proposal.id, status: "rejected" }]);
    await app.close();
  });

  it("a forbidden approve attempt (403) never publishes", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const bus = new InMemoryEventBus();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const received: ConsoleEvent[] = [];
    bus.subscribe("t1", (e) => received.push(e));

    const app = await buildServer({ store: state, identity: identityFor(viewer), proposalStore, rulesStore, comms, bus });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res.statusCode).toBe(403);
    expect(received).toEqual([]);
    await app.close();
  });

  it("kill publishes kill.changed(true); unkill publishes kill.changed(false)", async () => {
    const state = new InMemoryRuntimeStore();
    const bus = new InMemoryEventBus();
    const received: ConsoleEvent[] = [];
    bus.subscribe("t1", (e) => received.push(e));

    const app = await buildServer({ store: state, identity: identityFor(operator), bus });
    const killRes = await app.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: { reason: "halt" },
    });
    expect(killRes.statusCode).toBe(200);

    const app2 = await buildServer({ store: state, identity: identityFor(owner), bus }); // manager+ for /unkill
    const unkillRes = await app2.inject({ method: "POST", url: "/unkill", headers: { authorization: "Bearer good" } });
    expect(unkillRes.statusCode).toBe(200);

    expect(received).toEqual([
      { type: "kill.changed", killed: true },
      { type: "kill.changed", killed: false },
    ]);

    await app.close();
    await app2.close();
  });

  it("publishing is tenant-scoped: a subscriber for another tenant never receives this tenant's decision", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const bus = new InMemoryEventBus();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms); // tenant t1

    const t1Received: ConsoleEvent[] = [];
    const t2Received: ConsoleEvent[] = [];
    bus.subscribe("t1", (e) => t1Received.push(e));
    bus.subscribe("t2", (e) => t2Received.push(e));

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, bus });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res.statusCode).toBe(200);
    expect(t1Received).toHaveLength(1);
    expect(t2Received).toEqual([]);
    await app.close();
  });
});

describe("GET /events (SSE)", () => {
  it("401s with no token — before the reply is ever hijacked", async () => {
    const state = new InMemoryRuntimeStore();
    const bus = new InMemoryEventBus();
    const app = await buildServer({ store: state, identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false }, bus });
    const res = await app.inject({ method: "GET", url: "/events" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("streams text/event-stream and delivers a live event published to this tenant", async () => {
    const state = new InMemoryRuntimeStore();
    const bus = new InMemoryEventBus();
    const app = await buildServer({ store: state, identity: identityFor(owner), bus });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("expected a network address");
    const port = address.port;

    const result = await new Promise<{ contentType: string | undefined; line: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for SSE data")), 3000);
      const req = http.get(
        { host: "127.0.0.1", port, path: "/events", headers: { authorization: "Bearer good" } },
        (res) => {
          let buf = "";
          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            const idx = buf.indexOf("\n\n");
            if (idx !== -1) {
              clearTimeout(timer);
              const line = buf.slice(0, idx);
              req.destroy();
              resolve({ contentType: res.headers["content-type"], line });
            }
          });
        },
      );
      // destroying `req` while the response is still open raises a benign socket error/abort —
      // swallow it (this test resolves via the `data` handler above, not via `req`'s error path).
      req.on("error", () => {});
      // Give the client a moment to actually receive the flushed headers (proving the connection is
      // observably open) before publishing — mirrors a real subscriber that connects before an event
      // happens.
      setTimeout(() => bus.publish("t1", { type: "kill.changed", killed: true }), 50);
    });

    expect(result.contentType).toContain("text/event-stream");
    expect(result.line).toBe(`data: ${JSON.stringify({ type: "kill.changed", killed: true })}`);

    await app.close();
  });

  it("tenant isolation over the wire: a t2 connection never receives a t1 publish", async () => {
    const state = new InMemoryRuntimeStore();
    const bus = new InMemoryEventBus();
    const t2Owner: MerchantPrincipal = { ...owner, merchantId: "t2" };
    const app = await buildServer({ store: state, identity: identityFor(t2Owner), bus });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("expected a network address");
    const port = address.port;

    let sawData = false;
    const req = http.get(
      { host: "127.0.0.1", port, path: "/events", headers: { authorization: "Bearer good" } },
      (res) => {
        res.on("data", () => {
          sawData = true;
        });
      },
    );
    req.on("error", () => {});

    // wait long enough for headers to flush and for a (never-sent) event to have arrived if the
    // isolation were broken
    await new Promise((r) => setTimeout(r, 100));
    bus.publish("t1", { type: "kill.changed", killed: true }); // a DIFFERENT tenant than the connection above
    await new Promise((r) => setTimeout(r, 100));

    expect(sawData).toBe(false);
    req.destroy();
    await app.close();
  });
});

// Coordinator review (post-approval fragility): a `publish` failure must never change the HTTP
// result of a mutation that has ALREADY committed. `InMemoryEventBus.publish` happens to swallow
// per-listener errors, but that guarantee lives on that concrete class, not the route call site — a
// future bus (e.g. a real pub/sub adapter) could throw. This double proves the call sites (not the
// bus) are what makes publish best-effort.
const throwingBus: EventBus = {
  publish: () => {
    throw new Error("bus unavailable");
  },
  subscribe: () => () => {},
};

describe("a throwing EventBus never turns an already-committed mutation into a failure response", () => {
  it("approve still returns 200/executed when bus.publish throws", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, bus: throwingBus });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/approve`,
      headers: { authorization: "Bearer good" },
      payload: { version: proposal.version },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("executed");
    expect(comms.recorded).toHaveLength(1); // the approve genuinely executed, not short-circuited
    await app.close();
  });

  it("reject still returns 200/rejected when bus.publish throws", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    const proposal = await seedPendingCampaign(state, proposalStore, rulesStore, comms);

    const app = await buildServer({ store: state, identity: identityFor(owner), proposalStore, rulesStore, comms, bus: throwingBus });
    const res = await app.inject({
      method: "POST",
      url: `/approvals/${proposal.id}/reject`,
      headers: { authorization: "Bearer good" },
      payload: { reason: "off-brand" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("rejected");
    await app.close();
  });

  it("kill still returns 200/killed:true when bus.publish throws — the halt itself must never be reported as failed", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(operator), bus: throwingBus });
    const res = await app.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: { reason: "halt" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ killed: true });

    // the halt genuinely took effect despite the publish failure
    const statusRes = await app.inject({ method: "GET", url: "/kill", headers: { authorization: "Bearer good" } });
    expect(statusRes.json()).toEqual({ killed: true });
    await app.close();
  });

  it("unkill still returns 200/killed:false when bus.publish throws", async () => {
    const state = new InMemoryRuntimeStore();
    const killApp = await buildServer({ store: state, identity: identityFor(operator), bus: throwingBus });
    await killApp.inject({
      method: "POST",
      url: "/kill",
      headers: { authorization: "Bearer good" },
      payload: { reason: "halt" },
    });
    await killApp.close();

    const app = await buildServer({ store: state, identity: identityFor(owner), bus: throwingBus }); // manager+ for /unkill
    const res = await app.inject({ method: "POST", url: "/unkill", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ killed: false });
    await app.close();
  });
});
