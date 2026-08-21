import { afterEach, describe, expect, it } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// WS-A (2026-08-21, owner-authorized staging enablement) — the ADR-0018 disposition axes
// (DISPOSITION_STYLE / DISPOSITION_BEHAVIORAL / DISPOSITION_CLASSIFIER) had a consumer already built in
// widget-brain/brain.ts (createBrain positions 8-10) but NO `process.env` read anywhere in server.ts —
// the three were hardcoded `false` literals, so nothing a deploy set could ever reach them. This proves
// the env-read half server.ts now supplies: that `process.env.DISPOSITION_STYLE` /
// `process.env.DISPOSITION_CLASSIFIER` actually reach `createBrain` and change a wire-visible field.
//
// SEAM CHOSEN, and why an earlier draft of this test (passing `signals.personaRole: "b2b"` in the /chat
// body) was WRONG and replaced: `deriveServingSignals` (signals.ts) is an explicit ALLOW-list of
// non-trust-bearing client fields (mood/cart/proactiveTrigger/pageContext) — `personaRole` and
// `personaStyle` are not on it, so a client-supplied value is silently dropped before ever reaching
// `decide()`. Verified by grep: neither appears anywhere in signals.ts. So the ONLY flag-gated
// disposition path server.ts can currently exercise end-to-end through the real /chat wire via THIS
// test is DISPOSITION_STYLE + DISPOSITION_CLASSIFIER together, via `classifyPersonaStyle`
// (brain.ts:1956-1959) — it classifies from the MESSAGE TEXT itself using the model port `buildServer`
// already exposes as an injectable test seam (`opts.modelPort`), not from any client-supplied signal.
// A classification of "ready" pushes the flag `persona:ready` onto the wire response's own `flags`
// array (brain.ts:1977, server.ts's `response.flags = d.flags`) — this is the assertion below.
//
// STALE as of WS-B3a (2026-08-21): `behavioral` no longer belongs in the "nothing behind the flag" list
// above — deriveServingSignals now accepts + enum-validates a client-supplied `behavioral` array, but
// ONLY the three TIMING events (signals.ts's CLIENT_BEHAVIORAL_EVENTS: dwell/hesitation/
// idle_then_return, fix round 1) — `rage`/`pitch_declined`/`repeat_question` stay server-owned because
// DISPOSITION_BEHAVIORAL is default-on on staging and a client-supplied `rage` would set brain.ts's
// escalateToHuman unconditionally with no server corroboration. server.ts passes `body.signals` straight
// into deriveServingSignals, so DISPOSITION_BEHAVIORAL now HAS a real client→signals→brain seam for the
// three timing events (pinned by signals-safety-trust.test.ts's WS-B3a block, unit-level only — and
// those three currently have no brain.ts consumer either, so the seam is presently a dead capability).
// End-to-end /chat coverage for that seam is not added here — out of this test's and WS-B3a's scope —
// so the deploy-guard test (deploy-staging-env.test.ts) remains the only coverage of the flag itself at
// this wire.

const ENV_KEYS = ["DISPOSITION_STYLE", "DISPOSITION_CLASSIFIER"];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

const CLASSIFIER_MARKER = "Classify the shopper's message into EXACTLY ONE service/guidance style";

/** A model that answers the persona-style classifier call with a fixed valid enum value, and answers any
 * other call (the sales-generation call) with plain text — while recording every request it saw. */
function personaSpyModel(): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async complete(req: ModelRequest) {
      calls.push(req);
      const sawClassifierPrompt = req.messages.some((m) => m.content.includes(CLASSIFIER_MARKER));
      if (sawClassifierPrompt) return { text: JSON.stringify({ personaStyle: "ready" }), model: "spy-persona-classifier" };
      return { text: "Here's a great option for you.", model: "spy-sales" };
    },
  };
}

const SALES_MESSAGE = "What's your best moisturizer for dry skin?"; // no B2B/support/injection keyword — reaches the clean sales path

async function postChat(model: ModelPort) {
  const store = new InMemoryRuntimeStore();
  const app = await buildServer({ store, modelPort: model });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "disposition-style", message: SALES_MESSAGE, signals: {} },
    });
    return res.json() as { flags: string[] };
  } finally {
    await app.close();
  }
}

describe("WS-A — DISPOSITION_STYLE + DISPOSITION_CLASSIFIER env vars reach createBrain and change the wire", () => {
  it("both unset (default false) — the classifier is never called and no persona:* flag is emitted", async () => {
    delete process.env.DISPOSITION_STYLE;
    delete process.env.DISPOSITION_CLASSIFIER;
    const model = personaSpyModel();
    const body = await postChat(model);
    expect(model.calls.length).toBe(1); // only the sales-generation call — no classifier round trip
    expect(body.flags.some((f) => f.startsWith("persona:"))).toBe(false);
  });

  it("DISPOSITION_STYLE='true' + DISPOSITION_CLASSIFIER='true' — the classifier runs and 'persona:ready' reaches the wire", async () => {
    process.env.DISPOSITION_STYLE = "true";
    process.env.DISPOSITION_CLASSIFIER = "true";
    const model = personaSpyModel();
    const body = await postChat(model);
    expect(model.calls.length).toBe(2); // classifier call + sales-generation call — the cost/margin note's extra spend, made visible
    expect(body.flags).toContain("persona:ready");
  });
});
