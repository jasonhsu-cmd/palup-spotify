import { describe, it, expect } from "vitest";
import { createInMemoryComms, CommsRejection } from "../src/comms-port.js";
import type { CommsDenyReason, CommsMessage } from "../src/comms-port.js";

// Contract for the `comms` port (port-interfaces.md; comms-and-messaging.md §1): a FAIL-CLOSED pre-send
// gate — consent -> suppression -> frequency -> quiet-hours -> rate -> DLP. A failure at any step
// REJECTS (never silently sends) with a structured reason. The in-memory adapter is the behavioral
// oracle a provider adapter must match.

/** Capture the structured deny reasons from a rejected send. */
async function reasonsOf(p: Promise<unknown>): Promise<CommsDenyReason[]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CommsRejection) return e.reasons;
    throw e;
  }
  throw new Error("expected send() to reject, but it resolved");
}

// A Luhn-valid card embedded in a body — the DLP guardrail must catch it.
const CARD = "your code is 4111 1111 1111 1111 thanks";

describe("createInMemoryComms — CommsPort fail-closed pre-send gate", () => {
  it("resolves and records a sent message ONLY when every gate passes", async () => {
    const comms = createInMemoryComms({ consent: { m1: { email: ["a@shop.com"] } } });
    const rec = await comms.send({
      tenantId: "m1",
      channel: "email",
      to: "a@shop.com",
      body: "hi there",
      consent: true,
    });
    expect(rec).toMatchObject({ tenantId: "m1", channel: "email", to: "a@shop.com", body: "hi there" });
    expect(comms.sent("m1")).toHaveLength(1);
    expect(comms.sent("m1")[0]?.body).toBe("hi there");
  });

  it("blocks a send with no consent record — a caller cannot self-assert consent (fail closed)", async () => {
    const comms = createInMemoryComms(); // empty registry
    // The message asserts consent:true, but the source-of-truth registry has no grant => denied.
    expect(
      await reasonsOf(
        comms.send({ tenantId: "m1", channel: "email", to: "a@shop.com", body: "hi", consent: true }),
      ),
    ).toContain("consent");
    expect(comms.sent()).toHaveLength(0);
  });

  it("blocks when the caller withholds consent even if the registry granted it", async () => {
    const comms = createInMemoryComms({ consent: { m1: { sms: ["+15550100"] } } });
    expect(
      await reasonsOf(
        comms.send({ tenantId: "m1", channel: "sms", to: "+15550100", body: "hi", consent: false }),
      ),
    ).toContain("consent");
  });

  it("blocks a suppressed recipient", async () => {
    const comms = createInMemoryComms({
      consent: { m1: { email: ["x@shop.com"] } },
      suppression: { m1: ["x@shop.com"] },
    });
    expect(
      await reasonsOf(
        comms.send({ tenantId: "m1", channel: "email", to: "x@shop.com", body: "hi", consent: true }),
      ),
    ).toContain("suppression");
    expect(comms.sent()).toHaveLength(0);
  });

  it("suppresses BEFORE the next send (opt-out is effective immediately)", async () => {
    const comms = createInMemoryComms({ consent: { m1: { sms: ["+15550100"] } } });
    await comms.send({ tenantId: "m1", channel: "sms", to: "+15550100", body: "hi", consent: true });
    comms.suppress("m1", "+15550100"); // STOP / unsubscribe
    expect(
      await reasonsOf(
        comms.send({ tenantId: "m1", channel: "sms", to: "+15550100", body: "again", consent: true }),
      ),
    ).toContain("suppression");
    expect(comms.sent("m1")).toHaveLength(1);
  });

  it("blocks over the per-recipient frequency cap", async () => {
    const comms = createInMemoryComms({ consent: { m1: { email: ["a@shop.com"] } }, frequencyCap: 1 });
    await comms.send({ tenantId: "m1", channel: "email", to: "a@shop.com", body: "one", consent: true });
    expect(
      await reasonsOf(
        comms.send({ tenantId: "m1", channel: "email", to: "a@shop.com", body: "two", consent: true }),
      ),
    ).toContain("frequency");
    expect(comms.sent("m1")).toHaveLength(1);
  });

  it("blocks within quiet-hours (recipient-clock window)", async () => {
    const comms = createInMemoryComms({
      consent: { m1: { sms: ["+15550100"] } },
      quietHours: { startHour: 22, endHour: 6 }, // overnight window (wraps midnight)
    });
    // 23:00 UTC is inside the quiet window => blocked.
    expect(
      await reasonsOf(
        comms.send({
          tenantId: "m1",
          channel: "sms",
          to: "+15550100",
          body: "late night",
          consent: true,
          at: new Date("2026-07-30T23:00:00Z"),
        }),
      ),
    ).toContain("quiet-hours");
    // Midday is outside the window => allowed.
    const rec = await comms.send({
      tenantId: "m1",
      channel: "sms",
      to: "+15550100",
      body: "midday",
      consent: true,
      at: new Date("2026-07-30T12:00:00Z"),
    });
    expect(rec.body).toBe("midday");
  });

  it("blocks over the tenant rate limit", async () => {
    const comms = createInMemoryComms({
      consent: { m1: { email: ["a@shop.com", "b@shop.com"] } },
      rateLimit: { max: 1, windowMs: 60_000 },
    });
    await comms.send({ tenantId: "m1", channel: "email", to: "a@shop.com", body: "one", consent: true });
    expect(
      await reasonsOf(
        comms.send({ tenantId: "m1", channel: "email", to: "b@shop.com", body: "two", consent: true }),
      ),
    ).toContain("rate");
  });

  it("blocks an un-redacted PII leak by default (DLP fail-closed)", async () => {
    const comms = createInMemoryComms({ consent: { m1: { email: ["a@shop.com"] } } });
    expect(
      await reasonsOf(
        comms.send({ tenantId: "m1", channel: "email", to: "a@shop.com", body: CARD, consent: true }),
      ),
    ).toContain("dlp");
    expect(comms.sent()).toHaveLength(0);
  });

  it("in redact mode masks PII instead of sending it raw", async () => {
    const comms = createInMemoryComms({ consent: { m1: { email: ["a@shop.com"] } }, dlp: "redact" });
    const rec = await comms.send({
      tenantId: "m1",
      channel: "email",
      to: "a@shop.com",
      body: CARD,
      consent: true,
    });
    expect(rec.body).toBe("your code is [redacted-card] thanks");
    expect(rec.body).not.toContain("4111");
    expect(comms.sent("m1")[0]?.body).not.toContain("4111");
  });

  it("reports ALL failing gates at once in the structured rejection", async () => {
    const comms = createInMemoryComms({ suppression: { m1: ["a@shop.com"] } }); // no consent + suppressed + PII
    const reasons = await reasonsOf(
      comms.send({ tenantId: "m1", channel: "email", to: "a@shop.com", body: CARD, consent: true }),
    );
    expect(reasons).toEqual(expect.arrayContaining(["consent", "suppression", "dlp"]));
  });

  it("check() previews allow/deny with reasons and has NO side effects", async () => {
    const comms = createInMemoryComms({ consent: { m1: { email: ["a@shop.com"] } }, frequencyCap: 1 });
    const ok = await comms.check({ tenantId: "m1", channel: "email", to: "a@shop.com", body: "hi", consent: true });
    expect(ok).toMatchObject({ allow: true, reasons: [] });

    const denied = await comms.check({ tenantId: "m1", channel: "email", to: "a@shop.com", body: "hi", consent: false });
    expect(denied.allow).toBe(false);
    expect(denied.reasons).toContain("consent");

    // preview surfaces the compliance-safe (redacted) body.
    const preview = await comms.check({ tenantId: "m1", channel: "email", to: "a@shop.com", body: CARD, consent: true });
    expect(preview.preview).toBe("your code is [redacted-card] thanks");

    // No send was recorded and no frequency budget was consumed by check() — a real send still passes.
    expect(comms.sent()).toHaveLength(0);
    await comms.send({ tenantId: "m1", channel: "email", to: "a@shop.com", body: "hi", consent: true });
    expect(comms.sent("m1")).toHaveLength(1);
  });

  it("is tenant-isolated on suppression", async () => {
    const comms = createInMemoryComms({
      consent: { A: { email: ["e@x.com"] }, B: { email: ["e@x.com"] } },
      suppression: { A: ["e@x.com"] },
    });
    // Tenant A suppressed this recipient...
    expect(
      await reasonsOf(comms.send({ tenantId: "A", channel: "email", to: "e@x.com", body: "hi", consent: true })),
    ).toContain("suppression");
    // ...but tenant B's suppression list is independent.
    const rec = await comms.send({ tenantId: "B", channel: "email", to: "e@x.com", body: "hi", consent: true });
    expect(rec.tenantId).toBe("B");
  });

  it("is tenant-isolated on frequency counts", async () => {
    const comms = createInMemoryComms({
      consent: { A: { email: ["e@x.com"] }, B: { email: ["e@x.com"] } },
      frequencyCap: 1,
    });
    await comms.send({ tenantId: "A", channel: "email", to: "e@x.com", body: "hi", consent: true });
    expect(
      await reasonsOf(comms.send({ tenantId: "A", channel: "email", to: "e@x.com", body: "hi", consent: true })),
    ).toContain("frequency"); // A is over its cap
    // B's per-recipient counter is independent of A's.
    const rec = await comms.send({ tenantId: "B", channel: "email", to: "e@x.com", body: "hi", consent: true });
    expect(rec.tenantId).toBe("B");
  });

  it("liveChat take-over: open then close a human-agent session", async () => {
    const comms = createInMemoryComms();
    const s = await comms.openLiveChat("m1");
    expect(s.tenantId).toBe("m1");
    expect(s.isOpen()).toBe(true);
    await s.close();
    expect(s.isOpen()).toBe(false);
  });

  it("rejects invalid input (blank tenant / recipient / bad channel)", async () => {
    const comms = createInMemoryComms();
    await expect(
      comms.send({ tenantId: "", channel: "email", to: "a@x.com", body: "hi", consent: true }),
    ).rejects.toThrow(/tenantId/i);
    await expect(
      comms.send({ tenantId: "m1", channel: "email", to: "  ", body: "hi", consent: true }),
    ).rejects.toThrow(/to/i);
    await expect(
      comms.send({
        tenantId: "m1",
        channel: "voice" as unknown as CommsMessage["channel"],
        to: "a@x.com",
        body: "hi",
        consent: true,
      }),
    ).rejects.toThrow(/channel/i);
  });
});
