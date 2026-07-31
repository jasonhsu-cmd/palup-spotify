import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import type { VectorPort } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// ADR-0015 T12 — server/signals wiring for cross-visit memory, STILL INERT on the live path:
// MEMORY_ADR_ACCEPTED is hardcoded false (flag.ts), so no env var can turn this on. This file proves the
// server genuinely never touches the memory subsystem while the flag is off — the headline inertness
// property the whole ADR-0015 rollout depends on ahead of a later, separately-governed flip.

function spyVector(): VectorPort & {
  upsert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  deleteById: ReturnType<typeof vi.fn>;
  deleteNamespace: ReturnType<typeof vi.fn>;
} {
  return {
    upsert: vi.fn(async () => {}),
    query: vi.fn(async () => []),
    deleteById: vi.fn(async () => {}),
    deleteNamespace: vi.fn(async () => {}),
  };
}

describe("/chat is INERT on the memory path while MEMORY_ENABLED is unset (ADR-0015 double gate)", () => {
  it("produces the same response shape as today and NEVER calls the vector port (memory service never constructed)", async () => {
    const prevEnv = process.env.MEMORY_ENABLED;
    delete process.env.MEMORY_ENABLED;
    try {
      const store = new InMemoryRuntimeStore();
      const vector = spyVector();
      const app = await buildServer({ store, vectorPort: vector });
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: {
          sessionId: "mem-inert-1",
          message: "what do you recommend for dry skin?",
          signals: { cart: "empty" },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Same response shape as every other /chat test in this suite (server.ts's response object).
      expect(body).toEqual(
        expect.objectContaining({
          reply: expect.any(String),
          mode: expect.any(String),
          pitch: expect.any(String),
          escalate: expect.any(Boolean),
          outbound: expect.any(Boolean),
          flags: expect.any(Array),
          servedBy: expect.any(String),
        }),
      );
      expect(body.flags).not.toContain("memory:recalled");

      // The headline inertness assertion: a spy vector port injected into the server is NEVER touched —
      // the double gate (isMemoryEnabled() false) means the server never even constructs a MemoryService.
      expect(vector.upsert).not.toHaveBeenCalled();
      expect(vector.query).not.toHaveBeenCalled();
      expect(vector.deleteById).not.toHaveBeenCalled();
      expect(vector.deleteNamespace).not.toHaveBeenCalled();
      await app.close();
    } finally {
      if (prevEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = prevEnv;
    }
  });

  it("even with MEMORY_ENABLED=true (the operator flag alone), the ADR gate keeps it inert (NN#1: no config-only flip)", async () => {
    const prevEnv = process.env.MEMORY_ENABLED;
    process.env.MEMORY_ENABLED = "true";
    try {
      const store = new InMemoryRuntimeStore();
      const vector = spyVector();
      const app = await buildServer({ store, vectorPort: vector });
      const res = await app.inject({
        method: "POST",
        url: "/chat",
        payload: {
          sessionId: "mem-inert-2",
          message: "what do you recommend for dry skin?",
          signals: { cart: "empty" },
        },
      });
      expect(res.statusCode).toBe(200);
      // MEMORY_ADR_ACCEPTED is hardcoded false in flag.ts, so isMemoryEnabled() is still false — the
      // operator env var alone can never flip this on (governance NN#1).
      expect(vector.upsert).not.toHaveBeenCalled();
      expect(vector.query).not.toHaveBeenCalled();
      await app.close();
    } finally {
      if (prevEnv === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = prevEnv;
    }
  });
});
