import { describe, it, expect, vi } from "vitest";
import { InMemoryRuntimeStore } from "@palup/platform-ports";
import type { VectorPort } from "@palup/platform-ports";
import { buildServer } from "../src/server.js";

// ADR-0015 T12 — server/signals wiring for cross-visit memory. As of 2026-08-17 the ADR is Accepted for
// INTERNAL STAGING (flag.ts: MEMORY_ADR_ACCEPTED=true), so the operator flag MEMORY_ENABLED now governs.
// This file proves the two invariants that survive the flip: (1) memory stays fully INERT wherever
// MEMORY_ENABLED is unset — the server never touches the vector port (production is deployed nowhere and
// its MEMORY_ENABLED is unset); and (2) once the flag DOES engage memory, the structural auth coupling
// refuses to boot unless WIDGET_AUTH_REQUIRED=true, so /consent + /forget are never reachable unauthed.

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

describe("/chat memory path — INERT when MEMORY_ENABLED unset; enabling it requires enforced widget auth", () => {
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

      // The headline inertness assertion: a spy vector port injected into the server is NEVER touched.
      // With MEMORY_ENABLED unset, isMemoryEnabled() is false regardless of the (now-Accepted) ADR const,
      // so the server never even constructs a MemoryService.
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

  it("MEMORY_ENABLED=true now ENGAGES memory (ADR Accepted) → buildServer REFUSES to boot unless WIDGET_AUTH_REQUIRED=true", async () => {
    const prevMem = process.env.MEMORY_ENABLED;
    const prevAuth = process.env.WIDGET_AUTH_REQUIRED;
    process.env.MEMORY_ENABLED = "true";
    delete process.env.WIDGET_AUTH_REQUIRED; // the unsafe combination the coupling guard exists to reject
    try {
      const store = new InMemoryRuntimeStore();
      const vector = spyVector();
      // With the ADR now Accepted (flag.ts), the operator flag alone DOES engage memory — so the
      // structural coupling (assertMemoryAuthCoupling, server.ts) fails the boot FAST rather than serving
      // POST /consent + POST /forget unauthenticated. This is the hard guard that replaced the spent const
      // gate: config can enable memory, but never with the destructive endpoints reachable anonymously.
      await expect(buildServer({ store, vectorPort: vector })).rejects.toThrow(/WIDGET_AUTH_REQUIRED/);
    } finally {
      if (prevMem === undefined) delete process.env.MEMORY_ENABLED;
      else process.env.MEMORY_ENABLED = prevMem;
      if (prevAuth === undefined) delete process.env.WIDGET_AUTH_REQUIRED;
      else process.env.WIDGET_AUTH_REQUIRED = prevAuth;
    }
  });
});
