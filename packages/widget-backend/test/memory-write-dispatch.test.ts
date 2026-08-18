import { describe, it, expect, vi } from "vitest";
import type { QueuePort, QueueMessage } from "@palup/platform-ports";
import type { MemoryCtx, MemoryTurn } from "@palup/widget-memory";
import { dispatchMemoryWrite } from "../src/memory-write-dispatch.js";
import { memoryWriteMessage } from "../src/memory-write-queue.js";

// #126 — enqueue-or-inline dispatch. Dark by construction: only reachable once a caller passes a real
// `queue`, which nothing does yet.

const ctx: MemoryCtx = { tenantId: "acme", anonId: "anon-1", region: "us", consent1: "in", consent2: "out" };
const turn: MemoryTurn = { message: "hello", reply: "hi there" };
const nowMs = 1_700_000_000_000;

function fakeQueue(publish: QueuePort["publish"]): QueuePort {
  return {
    publish,
    subscribe: vi.fn(),
    deadLettered: () => [],
  };
}

describe("dispatchMemoryWrite", () => {
  it("queue undefined -> calls remember inline once, never touches publish (dark == today)", async () => {
    const remember = vi.fn().mockResolvedValue({ written: [] });
    await dispatchMemoryWrite({ queue: undefined, remember, ctx, turn, nowMs });
    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember).toHaveBeenCalledWith(ctx, turn);
  });

  it("publish resolves -> publish called once with memoryWriteMessage, remember NOT called", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const queue = fakeQueue(publish);
    const remember = vi.fn().mockResolvedValue({ written: [] });
    await dispatchMemoryWrite({ queue, remember, ctx, turn, nowMs });
    expect(publish).toHaveBeenCalledTimes(1);
    const [topic, msg] = publish.mock.calls[0] as [string, QueueMessage];
    expect(topic).toBe("memory.write");
    expect(msg).toEqual(memoryWriteMessage(ctx, turn, nowMs));
    expect(remember).not.toHaveBeenCalled();
  });

  it("publish rejects -> falls back to remember inline once (fact not lost)", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("queue down"));
    const queue = fakeQueue(publish);
    const remember = vi.fn().mockResolvedValue({ written: [] });
    const log = vi.fn();
    await dispatchMemoryWrite({ queue, remember, ctx, turn, nowMs, log });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember).toHaveBeenCalledWith(ctx, turn);
    expect(log).toHaveBeenCalled();
  });

  it("a throwing remember (queue undefined path) propagates -- caller's own try/catch is responsible", async () => {
    const remember = vi.fn().mockRejectedValue(new Error("write failed"));
    await expect(dispatchMemoryWrite({ queue: undefined, remember, ctx, turn, nowMs })).rejects.toThrow("write failed");
  });
});
