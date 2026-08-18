import { describe, it, expect } from "vitest";
import type { MemoryCtx, MemoryTurn } from "@palup/widget-memory";
import { MEMORY_WRITE_TOPIC, memoryWriteMessage } from "../src/memory-write-queue.js";

// #126 — the async memory-write queue's message builder. Pure: no I/O, no QueuePort instance needed.
// Mirrors catalog-webhook-queue.ts's `catalogReconcileMessage` pattern (see its own doc comment).

const ctx: MemoryCtx = {
  tenantId: "acme",
  anonId: "anon-1",
  region: "us",
  consent1: "in",
  consent2: "out",
};
const turn: MemoryTurn = { message: "I love running shoes", reply: "Great, here are some picks" };

describe("memoryWriteMessage", () => {
  it("builds a QueueMessage keyed by anonId (per-subject ordering), typed memory.write", () => {
    const m = memoryWriteMessage(ctx, turn, 1_700_000_000_000);
    expect(m.type).toBe("memory.write");
    expect(m.tenantKey).toBe(ctx.anonId);
    expect(m.payload).toEqual({
      tenantId: "acme",
      anonId: "anon-1",
      region: "us",
      consent1: "in",
      consent2: "out",
      message: turn.message,
      reply: turn.reply,
    });
  });

  it("has a stable deterministic id: identical turns produce identical ids", () => {
    const m1 = memoryWriteMessage(ctx, turn, 1);
    const m2 = memoryWriteMessage(ctx, turn, 999_999); // nowMs must NOT affect the idempotency key
    expect(m1.id).toBe(m2.id);
  });

  it("produces a different id when the message differs", () => {
    const m1 = memoryWriteMessage(ctx, turn, 1);
    const m2 = memoryWriteMessage(ctx, { ...turn, message: "different message" }, 1);
    expect(m1.id).not.toBe(m2.id);
  });

  it("produces a different id when the reply differs", () => {
    const m1 = memoryWriteMessage(ctx, turn, 1);
    const m2 = memoryWriteMessage(ctx, { ...turn, reply: "different reply" }, 1);
    expect(m1.id).not.toBe(m2.id);
  });

  it("MEMORY_WRITE_TOPIC is the stable topic name", () => {
    expect(MEMORY_WRITE_TOPIC).toBe("memory.write");
  });
});
