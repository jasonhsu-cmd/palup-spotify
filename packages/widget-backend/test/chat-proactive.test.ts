import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import type { ModelPort } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";
import { deriveServingSignals } from "../src/signals.js";

// The /chat path must carry the agent-initiated exit-intent trigger through to the brain and back, with
// every cap intact (docs/design/shopper-widget.md §4/§5). A spy model returns a benign, discount-free
// nudge so the reply-integrity backstop doesn't fire on the fixture.
function spyModel() {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "Want a hand finishing up? Free US shipping over $75, and easy returns if it's not right.", model: "spy" }));
  return { modelPort: { complete: spy } as ModelPort, spy };
}

describe("deriveServingSignals — proactiveTrigger passthrough (agent-initiated UI signal, validated enum)", () => {
  const ctx = { tenantId: "demo", kill: false, region: "us" as const, groundingMode: "full" as const };
  it("passes the known enum value through", () => {
    expect(deriveServingSignals({ proactiveTrigger: "exit_intent" }, ctx).proactiveTrigger).toBe("exit_intent");
  });
  it("drops an unknown proactiveTrigger value (only the known enum is honored)", () => {
    expect(deriveServingSignals({ proactiveTrigger: "make_me_buy" } as never, ctx).proactiveTrigger).toBeUndefined();
    expect(deriveServingSignals(undefined, ctx).proactiveTrigger).toBeUndefined();
  });
});

describe("/chat proactive exit-intent → capped cart_recovery, clearly labeled (INV-E budget holds end-to-end)", () => {
  it("exit-intent + cart has_items → response pitch cart_recovery + flag proactive:exit_intent", async () => {
    const store = new InMemoryRuntimeStore();
    const { modelPort } = spyModel();
    const app = await buildServer({ store, modelPort });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "px1", message: "", signals: { cart: "has_items", mood: "neutral", proactiveTrigger: "exit_intent" } },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.pitch).toBe("cart_recovery");
    expect(d.flags).toContain("proactive:exit_intent");
    expect(d.reply.length).toBeGreaterThan(0);
    await app.close();
  });

  it("a proactive trigger with NO cart → none, EMPTY reply (no nag)", async () => {
    const store = new InMemoryRuntimeStore();
    const { modelPort } = spyModel();
    const app = await buildServer({ store, modelPort });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "px2", message: "", signals: { cart: "empty", mood: "neutral", proactiveTrigger: "exit_intent" } },
    });
    const d = res.json();
    expect(d.pitch).toBe("none");
    expect(d.reply).toBe("");
    await app.close();
  });

  it("the ONE INV-E budget holds across the /chat path: exit-intent after the budget is spent → none, nothing surfaced", async () => {
    const store = new InMemoryRuntimeStore();
    const { modelPort } = spyModel();
    const app = await buildServer({ store, modelPort });
    const send = (message: string, signals: Record<string, unknown>, i: number) =>
      app.inject({ method: "POST", url: "/chat", payload: { sessionId: "px3", message, signals, idempotencyKey: "k" + i } });
    // Server session level defaults to balanced (budget = 2): spend it on two reactive pitched turns.
    await send("tell me about the serum", { cart: "has_items", mood: "neutral" }, 1);
    await send("what about the moisturizer", { cart: "has_items", mood: "neutral" }, 2);
    // Now a proactive exit-intent is over budget → suppressed entirely (pitch none, empty reply).
    const d = (await send("", { cart: "has_items", mood: "neutral", proactiveTrigger: "exit_intent" }, 3)).json();
    expect(d.pitch).toBe("none");
    expect(d.flags).toContain("budget_capped");
    expect(d.reply).toBe("");
    await app.close();
  });
});
