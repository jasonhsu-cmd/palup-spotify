import { describe, it, expect, afterAll } from "vitest";
import { InMemoryRuntimeStore, mintStepUp } from "@palup/platform-ports";
import { readPlatformEnabled, PLATFORM_TENANT, PLATFORM_STEPUP_ACTION, RUNTIME_AGENT_TYPE } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// The PLATFORM-MASTER auto-promote switch (ADR-0014 prereq #6, platform half). Mirrors
// /api/autopromote/optin exactly: operator-token gated (global onRequest mutate hook), then a real
// step-up assertion bound to THIS action ("autopromote.platform.set") + the reserved platform tenant
// ("__system__"), then setPlatformAutoPromote's own human-actor guard — an agent can never reach this
// route because the actor is always the server-authenticated operator, never client-supplied.
describe("POST /api/autopromote/platform — operator + step-up gated; human-only (ADR-0014 prereq #6, platform half)", () => {
  const prevOp = process.env.OPERATOR_TOKEN;
  const prevSu = process.env.AUTOPROMOTE_STEPUP_SECRET;
  afterAll(() => {
    if (prevOp === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prevOp;
    if (prevSu === undefined) delete process.env.AUTOPROMOTE_STEPUP_SECRET; else process.env.AUTOPROMOTE_STEPUP_SECRET = prevSu;
  });

  it("denies without operator token; requires a valid step-up; then writes the platform flag (audited)", async () => {
    process.env.OPERATOR_TOKEN = "op";
    process.env.AUTOPROMOTE_STEPUP_SECRET = "su";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      // no operator token → 401 from the onRequest mutate gate
      expect((await app.inject({ method: "POST", url: "/api/autopromote/platform", payload: { enabled: true } })).statusCode).toBe(401);
      expect(await readPlatformEnabled(store)).toBe(false);

      // operator token but NO step-up assertion → 403 (authenticated, but not authorized for this
      // sensitive SET without re-auth), nothing written
      const noStep = await app.inject({ method: "POST", url: "/api/autopromote/platform", headers: { authorization: "Bearer op" }, payload: { enabled: true } });
      expect(noStep.statusCode).toBe(403);
      expect(noStep.json().error).toMatch(/step-up/i);
      expect(await readPlatformEnabled(store)).toBe(false);

      // a step-up minted for the WRONG action (the tenant opt-in action, not the platform action)
      // must not authorize the platform switch — actions are not interchangeable
      const wrongAction = mintStepUp("su", { action: "autopromote.optin.set", tenantId: PLATFORM_TENANT, iat: Date.now(), nonce: "w1" });
      const wrong = await app.inject({ method: "POST", url: "/api/autopromote/platform", headers: { authorization: "Bearer op", "x-stepup-assertion": wrongAction }, payload: { enabled: true } });
      expect(wrong.statusCode).toBe(403);
      expect(await readPlatformEnabled(store)).toBe(false);

      // operator token + valid step-up bound to the platform action + tenant → ok, platform flag written
      const token = mintStepUp("su", { action: PLATFORM_STEPUP_ACTION, tenantId: PLATFORM_TENANT, iat: Date.now(), nonce: "r1" });
      const ok = await app.inject({ method: "POST", url: "/api/autopromote/platform", headers: { authorization: "Bearer op", "x-stepup-assertion": token }, payload: { enabled: true } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ok).toBe(true);
      expect(await readPlatformEnabled(store)).toBe(true);

      // audited, immutably (actor is the authenticated operator, never client-supplied)
      const audit = await store.readAudit({ tenantId: PLATFORM_TENANT });
      expect(audit.some((a) => a.action.startsWith("autopromote.platform.set") && a.actor === "operator")).toBe(true);
      expect((await store.verifyAudit({ tenantId: PLATFORM_TENANT })).ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("cannot be flipped by an agent actor: a client-supplied actor field is ignored — the audited actor is always the authenticated operator, never RUNTIME_AGENT_TYPE/'auto-loop'", async () => {
    process.env.OPERATOR_TOKEN = "op";
    process.env.AUTOPROMOTE_STEPUP_SECRET = "su";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      const token = mintStepUp("su", { action: PLATFORM_STEPUP_ACTION, tenantId: PLATFORM_TENANT, iat: Date.now(), nonce: "r2" });
      const res = await app.inject({
        method: "POST",
        url: "/api/autopromote/platform",
        headers: { authorization: "Bearer op", "x-stepup-assertion": token },
        // an attempt to spoof the audited actor as an agent — the route must ignore this and use the
        // server-authenticated operator identity instead (setPlatformAutoPromote's own assertHumanActor
        // is the backstop even if a caller found a way around this)
        payload: { enabled: true, actor: RUNTIME_AGENT_TYPE },
      });
      expect(res.statusCode).toBe(200);
      expect(await readPlatformEnabled(store)).toBe(true);
      const audit = await store.readAudit({ tenantId: PLATFORM_TENANT });
      const rec = audit.find((a) => a.action.startsWith("autopromote.platform.set"));
      expect(rec?.actor).toBe("operator");
      expect(rec?.actor).not.toBe(RUNTIME_AGENT_TYPE);
      expect(rec?.actor).not.toBe("auto-loop");
    } finally {
      await app.close();
    }
  });
});
