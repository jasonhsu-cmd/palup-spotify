import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// §6 INV-D — "Context continuity, offered not pushed. The browsing/cart context is preserved across the
// detour, so resuming is *help* — offered ONCE, non-pushy — not a re-pitch."
// (docs/design/shopper-widget.md:158-159)
//
// THE DEFECT: `session.resumeOffer()` HAS NO PRODUCTION CALLER. It is defined at
// widget-brain/src/session.ts:212, exercised by two unit test files, and `server.ts` never calls it — so
// the offer INV-D specifies has never once reached a shopper. Searched all of packages/ and e2e/ for
// `resumeOffer` outside tests: the only non-test hits are its own definition, its interface declaration,
// and the `resumeOffered` state field.
//
// This is the seventh instance of one shape in this programme: correct, tested code with nothing calling
// it — after `rollbackServing`, `recordKnownGood`, `withdrawConsent`, `mergeGuestIntoAccount`, `armKill`,
// the retention sweep, and the proactivity dial. Unit tests cannot catch it, because the unit under test
// works perfectly; only a route-level test can assert "the server actually asks".
//
// The gating logic in resumeOffer() is deliberately conservative and must survive being wired up: at most
// once per conversation, and never while an issue is open, safety is latched, an escalation is pending, or
// the mood is negative. Wiring it must not loosen any of that.

const chat = (
  app: Awaited<ReturnType<typeof buildServer>>,
  message: string,
  signals: Record<string, unknown> = {},
  n = 0,
) =>
  app.inject({
    method: "POST",
    url: "/chat",
    payload: { sessionId: "s-resume", message, idempotencyKey: `k-${n}`, signals },
  });

/**
 * Turn 1 records the browsing topic (a sales turn); turn 2 is the detour. The offer is evaluated on the
 * detour turn itself, which is correct: the shopper has left the topic by then.
 *
 * THE DETOUR IS DELIBERATELY NON-ESCALATING. A *support* detour sets `escalationPending`, which
 * `resumeOffer()` gates on — correctly: while a human is owed a reply, offering to resume shopping is
 * exactly the pushiness INV-D forbids. But `escalationPending` is cleared only by `signals.handoff`, which
 * has NO PRODUCTION PRODUCER (established separately, and pinned by
 * widget-brain/test/session-open-issues.test.ts). So in production the offer is permanently suppressed
 * after any escalating turn. That is fail-safe and I am not loosening it here; it does mean the offer's
 * real-world reachability is narrower than INV-D implies, and closing that needs a genuine handoff
 * producer, not a weaker gate.
 */
async function detourThenReturn(app: Awaited<ReturnType<typeof buildServer>>, detour: string) {
  await chat(app, "do you have a vitamin C serum?", { cart: "has_items" }, 1);
  return (await chat(app, detour, { cart: "has_items" }, 2)).json();
}

describe("INV-D — the resume offer actually reaches the shopper", () => {
  it("THE DEFECT: after a resolved detour, the response carries a resume offer", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const body = await detourThenReturn(app, "are you a real person?");
      expect(body.resumeOffer, "the server never asked session.resumeOffer()").toBeTruthy();
      expect(String(body.resumeOffer)).toMatch(/pick up where you left off/i);
      // It names the preserved browsing context, which is the whole point of INV-D.
      expect(String(body.resumeOffer)).toMatch(/vitamin c/i);
    } finally {
      await app.close();
    }
  });

  it("is offered at most ONCE per conversation (offered, not pushed)", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const first = await detourThenReturn(app, "are you a real person?");
      expect(first.resumeOffer).toBeTruthy();
      const second = (await chat(app, "anything else you'd suggest?", { cart: "has_items" }, 3)).json();
      expect(second.resumeOffer, "the offer repeated — INV-D says once").toBeFalsy();
    } finally {
      await app.close();
    }
  });

  it("is NOT offered while a safety latch is in force", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      await chat(app, "do you have a vitamin C serum?", { cart: "has_items" }, 1);
      const body = (await chat(app, "my face is burning and swelling", { cart: "has_items" }, 2)).json();
      expect(body.resumeOffer, "a latched session was offered a resume").toBeFalsy();
    } finally {
      await app.close();
    }
  });

  it("is NOT offered while an issue is still open", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const body = await detourThenReturn(app, "the bottle arrived cracked and leaking");
      expect(body.resumeOffer, "an open complaint was interrupted with a resume offer").toBeFalsy();
    } finally {
      await app.close();
    }
  });

  it("is NOT offered on a negative mood (INV-C, resume slow)", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      await chat(app, "do you have a vitamin C serum?", { cart: "has_items" }, 1);
      const body = (await chat(app, "are you a real person?", { cart: "has_items", mood: "frustrated" }, 2)).json();
      expect(body.resumeOffer).toBeFalsy();
    } finally {
      await app.close();
    }
  });

  it("is absent — not null, not empty-string — when there is nothing to resume", async () => {
    // A first-turn shopper has no browsing context. The field must be omitted so the widget's
    // `if (body.resumeOffer)` cannot render an empty bubble.
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const body = (await chat(app, "hello", {}, 1)).json();
      expect(body.resumeOffer).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("is a SEPARATE field from `reply` — it is an offer, never spliced into the answer", async () => {
    // INV-D calls it "offered, not pushed": the shopper's actual answer must not be diluted, and the
    // widget must be able to render the offer as a distinct, ignorable affordance.
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const body = await detourThenReturn(app, "are you a real person?");
      expect(body.reply).not.toContain(String(body.resumeOffer));
    } finally {
      await app.close();
    }
  });

  it("the offer is not a pitch — it spends no proactivity budget and sets no pitch", async () => {
    const app = await buildServer({ store: new InMemoryRuntimeStore() });
    try {
      const body = await detourThenReturn(app, "are you a real person?");
      expect(body.resumeOffer).toBeTruthy();
      expect(body.pitch).toBe("none");
      expect(body.outbound).toBe(false);
    } finally {
      await app.close();
    }
  });
});
