import { describe, it, expect } from "vitest";
import { createBrain, createSession, MockModelAdapter } from "../src/index.js";

// §6A conversation-state model: active_intent, open_issues (real text, not issue@N), escalation_pending,
// transient mood (§4), and browsing_context + a single non-pushy resume (INV-D). Companion to
// session.test.ts (INV-A/B/E); this suite covers the newly-persisted state fields.
const brain = () => createBrain(new MockModelAdapter());

describe("§6A conversation-state model", () => {
  it("stores the REAL issue summary in open_issues, not an issue@N placeholder", async () => {
    const s = await createSession(brain());
    await s.send("where's my order #1042?");
    expect(s.state.openIssues).toHaveLength(1);
    expect(s.state.openIssues[0]).not.toMatch(/issue@/); // no synthetic placeholder
    expect(s.state.openIssues[0]).toMatch(/order_status/); // the classified intent
    expect(s.state.openIssues[0]).toContain("1042"); // the actual order id carried from the message
  });

  it("active_intent tracks the arbitrated mode each turn (re-classified, not sticky)", async () => {
    const s = await createSession(brain());
    const d1 = await s.send("tell me about the serum", { cart: "has_items" });
    expect(d1.mode).toBe("sales");
    expect(s.state.activeIntent).toBe("sales");
    const d2 = await s.send("where's my order #1042?");
    expect(d2.mode).toBe("support");
    expect(s.state.activeIntent).toBe("support"); // overwritten to the new turn's mode
  });

  it("escalation_pending is set when a turn escalates and cleared on human handoff", async () => {
    const s = await createSession(brain());
    const d = await s.send("my face is burning after using it");
    expect(d.escalateToHuman).toBe(true);
    expect(s.state.escalationPending).toBe(true);
    // A handoff clears it even though the latched safety turn would otherwise re-escalate.
    await s.send("ok", { handoff: true });
    expect(s.state.escalationPending).toBe(false);
  });

  it("INV-D: browsing_context survives a support detour and the resume is offered at most once", async () => {
    const s = await createSession(brain());
    await s.send("tell me about the serum", { cart: "has_items" }); // sales → captures browsing context
    expect(s.state.browsingContext).toContain("serum");
    await s.send("wait, where's my order #1042?"); // detour into support
    expect(s.state.openIssues.length).toBeGreaterThan(0);
    expect(s.resumeOffer()).toBeUndefined(); // INV-B: an open issue gates the resume
    await s.send("thanks, all set"); // resolution closes the issue
    const offer = s.resumeOffer();
    expect(offer).toBeTruthy();
    expect(offer).toContain("serum"); // resumes the preserved context, not a re-pitch
    expect(s.resumeOffer()).toBeUndefined(); // INV-D: offered once, never repeated
  });

  it("§4: mood is transient — the current-turn value only, never accumulated", async () => {
    const s = await createSession(brain());
    await s.send("this is so frustrating", { mood: "frustrated", cart: "has_items" });
    expect(s.state.mood).toBe("frustrated");
    await s.send("ok tell me about the serum", { mood: "neutral", cart: "has_items" });
    expect(s.state.mood).toBe("neutral"); // overwritten, not merged with the prior mood
    expect(typeof s.state.mood).toBe("string");
    expect(Array.isArray(s.state.mood)).toBe(false); // no accumulated mood history/profile
  });
});
