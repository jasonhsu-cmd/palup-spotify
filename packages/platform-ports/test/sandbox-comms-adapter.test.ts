import { describe, it, expect } from "vitest";
import { SandboxCommsAdapter } from "../src/comms-port.js";

// SandboxCommsAdapter (WB win-back agent, task 1): a batch-send recorder for run-time campaign
// agents that RECORDS sends and NEVER delivers — deterministic ids, no Math.random/Date.now, so a
// staging deploy of a campaign agent sends nothing to a real shopper. Deliberately a SEPARATE,
// additively-named capability from `CommsPort`/`createInMemoryComms` above (the fail-closed
// consent/suppression/DLP gate already in this file, with no production consumer yet per
// widget-brain/src/brain.ts) — see that class's own header for why the names don't collide.
describe("SandboxCommsAdapter", () => {
  it("records messages and returns a count + ids without delivering", async () => {
    const c = new SandboxCommsAdapter();
    const r = await c.send([{ channel: "email", to: "a@x.com", subject: "come back", body: "hi" }], { tenantId: "t1" });
    expect(r.sent).toBe(1);
    expect(r.ids).toHaveLength(1);
    expect(c.recorded[0]?.to).toBe("a@x.com");
  });

  it("mints deterministic ids (no Math.random) and records every message across calls", async () => {
    const c = new SandboxCommsAdapter();
    const r1 = await c.send([{ channel: "email", to: "a@x.com", body: "hi" }], { tenantId: "t1" });
    const r2 = await c.send([{ channel: "sms", to: "+15550001111", body: "hey" }], { tenantId: "t1" });
    expect(r1.ids).toEqual(["sandbox:0"]);
    expect(r2.ids).toEqual(["sandbox:1"]);
    expect(c.recorded).toHaveLength(2);
    expect(c.recorded[1]?.tenantId).toBe("t1");
  });

  it("never delivers — recording a batch for one tenant does not leak into another tenant's ctx", async () => {
    const c = new SandboxCommsAdapter();
    await c.send([{ channel: "email", to: "shopper@x.com", body: "hi" }], { tenantId: "merchant-a" });
    expect(c.recorded[0]?.tenantId).toBe("merchant-a");
  });
});
