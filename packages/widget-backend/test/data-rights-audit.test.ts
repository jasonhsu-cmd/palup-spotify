import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { buildAuditInput } from "../src/audit.js";
import type { Decision } from "@palup/widget-brain";

const SERVING = { tenantId: "demo" }; // RUNTIME_TENANT

// The mechanism behind the one thing the DSAR reply is now allowed to claim: "I've recorded your
// request". Before this, an erasure request landed in the immutable log as a generic
// `escalation.to_human` row — indistinguishable from a shipping complaint — so the record the shopper
// was told about existed but could not be found as a data-rights request. A DSAR carries a statutory
// response clock (GDPR Art. 12(3) / CCPA), so "recorded" has to mean recorded AS THAT.
//
// This is also the mechanism the shopper-promise guard's ALLOWED_CLAIMS entry names
// (packages/widget-backend/test/shopper-promise-guard.ts). If this action string is ever removed, that
// guard turns red too — the claim and its mechanism are pinned to each other, not just asserted apart.

function dsarDecision(): Decision {
  return {
    mode: "support",
    reply: "…",
    pitch: "none",
    escalateToHuman: true,
    outbound: false,
    safetyClass: "none",
    flags: ["data_rights_erasure", "escalate", "no_pitch"],
    model: "guardrail",
  };
}

describe("a data-rights (DSAR) turn is audited AS a data-rights request", () => {
  it("buildAuditInput names the erasure request, not a generic escalation", () => {
    const rec = buildAuditInput({ sessionId: "s1", messageLength: 30, servedBy: "prop-0", decision: dsarDecision() });
    expect(rec).not.toBeNull();
    expect(rec?.action).toBe("data_rights.erasure_requested");
    expect(rec?.actor).toBe("agent:shopper");
    // The reversal path must stay honest: this row is a RECORD of a request, not a completed erasure.
    expect(rec?.reversalPath).toMatch(/request/i);
  });

  it("an ordinary escalation is unchanged (this did not reclassify every escalating turn)", () => {
    const d = { ...dsarDecision(), flags: ["escalate", "no_pitch"] };
    expect(buildAuditInput({ sessionId: "s2", messageLength: 10, servedBy: "prop-0", decision: d })?.action).toBe("escalation.to_human");
  });

  it("end to end: 'delete everything you have on me' writes that row, with no raw message in it", async () => {
    const store = new InMemoryRuntimeStore();
    const app = await buildServer({ store });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "dsar-1", message: "delete everything you have on me", signals: {} },
    });
    expect(res.statusCode).toBe(200);

    const audit = await store.readAudit(SERVING);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("data_rights.erasure_requested");
    expect(JSON.stringify(audit[0])).not.toContain("delete everything"); // PII-safe, as every other row
    expect((await store.verifyAudit(SERVING)).ok).toBe(true);

    // And the reply the shopper sees claims exactly that record and nothing more.
    expect(res.json().reply).toMatch(/I'?ve recorded your request/i);
    expect(res.json().reply).not.toMatch(/copy of your data/i);
    await app.close();
  });
});
