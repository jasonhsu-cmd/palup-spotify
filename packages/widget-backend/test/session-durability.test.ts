import { describe, it, expect } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// Proves the durable-session blocker fix: conversation state now lives in the SHARED store, so a
// follow-up turn served by a DIFFERENT instance (restart / scale-to-zero / no session affinity) still
// sees the latch + open issues. A single shared InMemoryRuntimeStore stands in for the shared Cloud SQL
// (two buildServer() instances = two Cloud Run instances pointed at the same DATABASE_URL).

describe("durable session state across instances (shared store)", () => {
  it("INV-A: the safety latch survives an instance restart", async () => {
    const store = new InMemoryRuntimeStore();
    const app1 = await buildServer({ store });
    const r1 = await app1.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sess-A", message: "my face is burning after using it", signals: {} },
    });
    expect(r1.json().mode).toBe("safety");
    await app1.close();

    const app2 = await buildServer({ store }); // different instance, same shared store
    const r2 = await app2.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sess-A", message: "anyway, add the serum to my cart", signals: { cart: "has_items" } },
    });
    const b2 = r2.json();
    expect(b2.mode).toBe("safety"); // latch restored from the store — not reset by the new instance
    expect(b2.pitch).toBe("none");
    await app2.close();
  });

  it("INV-B: an open support issue persists across instances (sales stays suppressed)", async () => {
    const store = new InMemoryRuntimeStore();
    const app1 = await buildServer({ store });
    await app1.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sess-B", message: "where's my order #1050?", signals: {} },
    });
    await app1.close();

    const app2 = await buildServer({ store });
    const r2 = await app2.inject({
      method: "POST",
      url: "/chat",
      payload: { sessionId: "sess-B", message: "ok add the serum too", signals: { cart: "has_items" } },
    });
    const b2 = r2.json();
    expect(b2.mode).toBe("support"); // open issue restored → sales suppressed
    expect(b2.pitch).toBe("none");
    await app2.close();
  });
});
