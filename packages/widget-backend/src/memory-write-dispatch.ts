import type { QueuePort } from "@palup/platform-ports";
import type { MemoryCtx, MemoryTurn } from "@palup/widget-memory";
import { MEMORY_WRITE_TOPIC, memoryWriteMessage } from "./memory-write-queue.js";

// #126 — enqueue-or-inline dispatch for the memory write. Dark by construction: every existing call
// site keeps calling `remember()` directly, so this only activates once a future, separately governed
// change passes a real `queue` in. No flag flip here (widget-memory's own double gate is untouched).

export interface DispatchMemoryWriteOpts {
  /** Undefined = today's inline behavior (dark default). A real QueuePort hands the write off async. */
  queue: QueuePort | undefined;
  /** The existing synchronous write path — same as what every caller does today. */
  remember: (ctx: MemoryCtx, turn: MemoryTurn) => Promise<unknown>;
  ctx: MemoryCtx;
  turn: MemoryTurn;
  nowMs: number;
  /** Optional diagnostic hook for the publish-failed fallback; never throws, never required. */
  log?: (msg: string) => void;
}

/**
 * `queue` undefined -> call `remember` inline (today's behavior, unchanged).
 * `queue` present -> publish the memory-write message; on ANY publish failure, fall back to the same
 * inline `remember` so a fact is never silently lost to a queue outage.
 *
 * Deliberately NOT wrapped in its own try/catch around the inline `remember` calls — a `remember` throw
 * (both the dark-default path and the publish-failure fallback) propagates to the caller, which owns its
 * own fail-open try/catch around this whole call (mirrors how `remember()` is called inline today).
 */
export async function dispatchMemoryWrite(opts: DispatchMemoryWriteOpts): Promise<void> {
  const { queue, remember, ctx, turn, nowMs, log } = opts;
  if (!queue) {
    await remember(ctx, turn);
    return;
  }
  const msg = memoryWriteMessage(ctx, turn, nowMs);
  try {
    await queue.publish(MEMORY_WRITE_TOPIC, msg);
  } catch (e) {
    log?.(`dispatchMemoryWrite: publish failed, falling back to inline write: ${e instanceof Error ? e.message : String(e)}`);
    await remember(ctx, turn);
  }
}
