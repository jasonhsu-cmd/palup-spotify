import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryVectorStore, InMemoryRuntimeStore, type ModelPort, type EmbedRequest, type EmbedResponse } from "@palup/platform-ports";
import { createMemoryService } from "../src/service.js";
import type { MemoryCtx } from "../src/types.js";
import type { FactDistiller } from "../src/distiller.js";

// semantic-memory-v1, PR2 (write path), T9 — dark-ship flag. STANDING GOLDEN, not a new red: with
// MEMORY_SEMANTIC_RECALL unset (today's and every deployment's default), embed is NEVER called and
// recall returns the list-all golden — this is true TODAY (there is no embed integration at all yet) and
// MUST remain true once T4's embed integration ships. Kept as its own file (per the task's naming) so a
// future PR cannot accidentally delete/weaken it while touching T4's own test file.

const SEMANTIC_FLAG = "MEMORY_SEMANTIC_RECALL";

beforeEach(() => {
  delete process.env[SEMANTIC_FLAG];
});
afterEach(() => {
  delete process.env[SEMANTIC_FLAG];
});

function spyEmbedModel(): ModelPort & { calls: EmbedRequest[] } {
  const calls: EmbedRequest[] = [];
  return {
    calls,
    async complete() {
      throw new Error("spyEmbedModel: complete() should never be called — this test injects `distiller` directly");
    },
    async embed(req: EmbedRequest): Promise<EmbedResponse> {
      calls.push(req);
      return { vectors: req.texts.map(() => [1, 0, 0, 0]), dimension: 4, model: "spy", purpose: req.purpose };
    },
  };
}

function fixedDistiller(facts: string[]): FactDistiller {
  return { distill: vi.fn(async () => facts.map((text) => ({ text }))) };
}

describe("createMemoryService — MEMORY_SEMANTIC_RECALL unset (dark-ship default): the baseline is untouched", () => {
  it("remember() performs NO embed call with the flag unset", async () => {
    expect(process.env[SEMANTIC_FLAG]).toBeUndefined();
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const embedModel = spyEmbedModel();
    const distiller = fixedDistiller(["prefers fragrance-free products"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, model: embedModel, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-dark", anonId: "guest-dark", region: "us", consent1: "in", consent2: "unknown" };

    await service.remember(ctx, { message: "m", reply: "r" });
    expect(embedModel.calls).toHaveLength(0);
  });

  it("recall() returns the list-all golden shape — byte-identical to the pre-semantic-recall behavior", async () => {
    const vector = createInMemoryVectorStore();
    const runtimeStore = new InMemoryRuntimeStore();
    const embedModel = spyEmbedModel();
    const distiller = fixedDistiller(["prefers fragrance-free products"]);
    const service = createMemoryService({ vector, audit: runtimeStore, distiller, model: embedModel, enabled: true });
    const ctx: MemoryCtx = { tenantId: "acme-dark-recall", anonId: "guest-dark-recall", region: "us", consent1: "in", consent2: "unknown" };

    await service.remember(ctx, { message: "m", reply: "r" });
    const recalled = await service.recall(ctx);
    expect(recalled).toEqual([{ text: "prefers fragrance-free products", class: "ordinary" }]);
    expect(embedModel.calls).toHaveLength(0); // recall never embeds a query either, with the flag off
  });
});

describe("flag.ts (the ADR-0015 double gate) is NOT the home for MEMORY_SEMANTIC_RECALL", () => {
  it("packages/widget-memory/src/flag.ts's source does not reference MEMORY_SEMANTIC_RECALL — the new gate must live in its own, separately-reviewed place, never folded into the double gate", () => {
    const flagPath = fileURLToPath(new URL("../src/flag.ts", import.meta.url));
    const source = readFileSync(flagPath, "utf8");
    expect(source).not.toContain("MEMORY_SEMANTIC_RECALL");
  });
});
