import { describe, it, expect } from "vitest";
import {
  InMemoryRuntimeStore,
  InMemoryProposalStore,
  InMemoryMerchantRulesStore,
  SandboxCommsAdapter,
  SandboxCustomerDirectory,
  type MerchantIdentityPort,
  type MerchantPrincipal,
} from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// Task 5: the WB win-back agent's staging trigger route. Registered inside server.ts's authenticated
// `merchantPlane` context (F3), so route-protection.test.ts already proves the no-token path 401s;
// this suite covers the RBAC + agent-behavior contract this route adds on top of that.

const owner: MerchantPrincipal = {
  kind: "merchant_user", merchantId: "t1", userId: "u1", role: "owner", authLevel: "session", sessionId: "s1",
};
const viewer: MerchantPrincipal = { ...owner, role: "viewer" };

const identityFor = (p: MerchantPrincipal): MerchantIdentityPort => ({
  authenticate: async (cred) => (cred === "good" ? p : { kind: "anonymous" }),
  authorize: () => true,
});

describe("POST /_internal/run-winback", () => {
  it("an owner triggers a win-back run: lands one pending campaign proposal, sends NOTHING", async () => {
    const state = new InMemoryRuntimeStore();
    const proposalStore = new InMemoryProposalStore(state);
    const rulesStore = new InMemoryMerchantRulesStore(state);
    const comms = new SandboxCommsAdapter();
    // A fake CommercePort (SandboxCustomerDirectory) yielding one lapsed customer for this tenant —
    // their last order is years old, so it is lapsed under any reasonable window.
    const commerce = new SandboxCustomerDirectory({
      t1: [{ customerId: "c1", contact: "c1@x.com", lastOrderAt: "2020-01-01T00:00:00Z" }],
    });

    const app = await buildServer({
      store: state,
      identity: identityFor(owner),
      commerce,
      comms,
      proposalStore,
      rulesStore,
    });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/run-winback",
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.proposedId).toBe("string");

    const list = await proposalStore.list({ tenantId: "t1" });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).toBe(body.proposedId);
    expect(list.items[0]?.status).toBe("pending");
    expect(list.items[0]?.category).toBe("campaign");
    expect(list.items[0]?.tenantId).toBe("t1");

    // Nothing sent pre-approval — the sandbox comms adapter recorded no deliveries at all.
    expect(comms.recorded).toHaveLength(0);

    await app.close();
  });

  it("a viewer is forbidden — the route requires agent.operate", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({ store: state, identity: identityFor(viewer) });

    const res = await app.inject({
      method: "POST",
      url: "/_internal/run-winback",
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it("an anonymous caller is 401'd before RBAC is even evaluated", async () => {
    const state = new InMemoryRuntimeStore();
    const app = await buildServer({
      store: state,
      identity: { authenticate: async () => ({ kind: "anonymous" }), authorize: () => false },
    });

    const res = await app.inject({ method: "POST", url: "/_internal/run-winback" });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
