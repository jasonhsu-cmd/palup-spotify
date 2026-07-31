import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import type { ModelPort, ModelRequest } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

const SERVING = { tenantId: "demo" }; // RUNTIME_TENANT

// Spy model injected via the buildServer test seam (mirrors the injectable `store`) so we can assert the
// server threads the client transcript through the brain into the model context. In prod the model port
// is the redaction-wrapped adapter; here a raw spy just observes the message array.
function spyModel() {
  const spy = vi.fn<ModelPort["complete"]>(async () => ({ text: "ok", model: "spy" }));
  return { modelPort: { complete: spy } as ModelPort, spy };
}
const lastMessages = (spy: ReturnType<typeof vi.fn>) =>
  (spy.mock.calls.at(-1)![0] as ModelRequest).messages;

describe("/chat threads a bounded client transcript into the model context (in-session memory)", () => {
  it("passes prior turns as [system, ...history, currentUser] in order", async () => {
    const store = new InMemoryRuntimeStore();
    const { modelPort, spy } = spyModel();
    const app = await buildServer({ store, modelPort });
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "h1",
        message: "what about the other one?",
        signals: { cart: "has_items" },
        history: [
          { role: "user", content: "tell me about the vitamin-C serum" },
          { role: "agent", content: "The vitamin-C serum is fragrance-free." },
        ],
      },
    });
    const msgs = lastMessages(spy);
    expect(msgs[0].role).toBe("system");
    expect(msgs.slice(1)).toEqual([
      { role: "user", content: "tell me about the vitamin-C serum" },
      { role: "assistant", content: "The vitamin-C serum is fragrance-free." },
      { role: "user", content: "what about the other one?" },
    ]);
    await app.close();
  });

  it("bounds an over-long history to the cap and keeps only the most recent turns", async () => {
    const store = new InMemoryRuntimeStore();
    const { modelPort, spy } = spyModel();
    const app = await buildServer({ store, modelPort });
    const history = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "agent",
      content: `turn-${i}`,
    }));
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "h2", message: "and now?", signals: { cart: "has_items" }, history },
    });
    expect(res.statusCode).toBe(200); // oversize is truncated, never rejected
    const threaded = lastMessages(spy).filter((m) => m.role !== "system").slice(0, -1); // drop current turn
    expect(threaded.length).toBeLessThanOrEqual(8); // HISTORY_MAX_TURNS
    const contents = threaded.map((m) => m.content);
    expect(contents).toContain("turn-39"); // most recent survives
    expect(contents).not.toContain("turn-0"); // oldest dropped
    await app.close();
  });

  it("does NOT persist the transcript server-side — SessionState stays control-only", async () => {
    const store = new InMemoryRuntimeStore();
    const { modelPort } = spyModel();
    const app = await buildServer({ store, modelPort });
    const MARKER = "UNIQUE-antecedent-marker-zzz";
    await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        sessionId: "h3",
        message: "what about the other one?",
        signals: { cart: "has_items" },
        history: [{ role: "user", content: MARKER }, { role: "agent", content: "sure" }],
      },
    });
    const persisted = await store.get(SERVING, "session", "h3");
    expect(persisted).toBeTruthy(); // control state WAS persisted
    expect(JSON.stringify(persisted)).not.toContain(MARKER); // ...but the transcript was NOT
    expect(JSON.stringify(persisted)).not.toContain("transcript");
    await app.close();
  });

  it("ignores a malformed history without error (defensive) and falls back to [system, currentUser]", async () => {
    const store = new InMemoryRuntimeStore();
    const { modelPort, spy } = spyModel();
    const app = await buildServer({ store, modelPort });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "h4", message: "hi", signals: { cart: "has_items" }, history: "not-an-array" },
    });
    expect(res.statusCode).toBe(200);
    const msgs = lastMessages(spy);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
    await app.close();
  });
});
