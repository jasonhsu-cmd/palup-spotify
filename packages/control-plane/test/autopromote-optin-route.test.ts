import { describe, it, expect, afterAll } from "vitest";
import { InMemoryRuntimeStore, mintStepUp } from "@palup/platform-ports";
import { readTenantOptIn } from "@palup/state-postgres";
import { buildServer } from "../src/server.js";

// ADR-0014 #6 — the opt-in SET endpoint. POST ⇒ already operator:mutate-gated by the global hook; on top
// of that it requires a real STEP-UP assertion (x-stepup-assertion header) bound to this action+tenant.
// The flag defaults OFF, so nothing is enabled until a step-up'd operator sets it.
describe("POST /api/autopromote/optin — operator + step-up gated (ADR-0014 prereq #6)", () => {
  const prevOp = process.env.OPERATOR_TOKEN;
  const prevSu = process.env.AUTOPROMOTE_STEPUP_SECRET;
  afterAll(() => {
    if (prevOp === undefined) delete process.env.OPERATOR_TOKEN; else process.env.OPERATOR_TOKEN = prevOp;
    if (prevSu === undefined) delete process.env.AUTOPROMOTE_STEPUP_SECRET; else process.env.AUTOPROMOTE_STEPUP_SECRET = prevSu;
  });

  it("denies without operator token; requires a valid step-up; then writes the merchant opt-in", async () => {
    process.env.OPERATOR_TOKEN = "op";
    process.env.AUTOPROMOTE_STEPUP_SECRET = "su";
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    try {
      // no operator token → 401 from the onRequest mutate gate
      expect((await app.inject({ method: "POST", url: "/api/autopromote/optin", payload: { tenantId: "acme", enabled: true } })).statusCode).toBe(401);

      // operator token but NO step-up assertion → refused, nothing written
      const noStep = await app.inject({ method: "POST", url: "/api/autopromote/optin", headers: { authorization: "Bearer op" }, payload: { tenantId: "acme", enabled: true } });
      expect(noStep.json().error).toMatch(/step-up/i);
      expect(await readTenantOptIn(store, "acme")).toBe(false);

      // operator token + valid step-up → ok, merchant opt-in written
      const token = mintStepUp("su", { action: "autopromote.optin.set", tenantId: "acme", iat: Date.now(), nonce: "r1" });
      const ok = await app.inject({ method: "POST", url: "/api/autopromote/optin", headers: { authorization: "Bearer op", "x-stepup-assertion": token }, payload: { tenantId: "acme", enabled: true } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().ok).toBe(true);
      expect(await readTenantOptIn(store, "acme")).toBe(true);
    } finally {
      await app.close();
    }
  });
});
