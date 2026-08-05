import { describe, it, expect, vi } from "vitest";
import { runModelPortContract } from "@palup/platform-ports/contract";
import {
  DEFAULT_EMBED_TASK_TYPES,
  VertexModelAdapter,
  type EmbedContentFn,
  type GenerateFn,
  type GenRequest,
} from "../src/vertex-adapter.js";

// A deterministic fake Gemini call — lets us test the adapter's mapping/parsing logic with NO creds.
const fakeGenerate: GenerateFn = async () => ({
  text: "Sure — the vitamin-C serum is fragrance-free.",
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
});

// A deterministic fake embedContent call. Content-derived (same text => same vector) so the contract
// suite's cosine ORDER check is meaningful, and pinned to maxBatch=1 to match the real
// gemini-embedding-001 cap — so the contract exercises the adapter's CHUNKING path, not a fake shortcut.
const EMBED_DIM = 16;
const fakeEmbedContent: EmbedContentFn = async (req) => ({
  embeddings: req.contents.map((t) => {
    const v = new Array<number>(EMBED_DIM).fill(0);
    for (let i = 0; i < t.length; i++) v[(t.charCodeAt(i) * 31 + i) % EMBED_DIM]! += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return { values: v.map((x) => x / norm), statistics: { truncated: false, tokenCount: t.length } };
  }),
});

// Contract compliance (ADR-0001): the real adapter satisfies the same port contract as the mock.
// B3: the adapter is now built WITH an embedContent transport, so #188's `describe.skipIf(!declaresEmbed)`
// embed block RUNS here instead of skipping (the "capability ABSENT" block skips instead). The absence
// case still has a home — vertex-embed.test.ts constructs the adapter without a transport.
runModelPortContract(
  () =>
    new VertexModelAdapter(fakeGenerate, { model: "gemini-test" }, {
      call: fakeEmbedContent,
      cfg: { model: "embed-test-1", taskTypes: DEFAULT_EMBED_TASK_TYPES, maxBatch: 1 },
    }),
);

describe("VertexModelAdapter mapping", () => {
  it("splits system messages into systemInstruction and maps assistant->model", async () => {
    const spy = vi.fn<GenerateFn>(async () => ({ text: "ok" }));
    const adapter = new VertexModelAdapter(spy, { model: "gemini-test" });
    await adapter.complete({
      messages: [
        { role: "system", content: "be honest" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "recommend a serum" },
      ],
      temperature: 0,
      maxTokens: 256,
    });
    const req = spy.mock.calls[0]![0] as GenRequest;
    expect(req.config?.systemInstruction).toBe("be honest");
    expect(req.config?.temperature).toBe(0);
    expect(req.config?.maxOutputTokens).toBe(256);
    expect(req.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: "recommend a serum" }] },
    ]);
  });

  it("returns text + token usage", async () => {
    const adapter = new VertexModelAdapter(fakeGenerate, { model: "gemini-test" });
    const res = await adapter.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("vitamin-C serum");
    expect(res.model).toBe("gemini-test");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  it("throws on an empty completion (never returns a blank reply)", async () => {
    const adapter = new VertexModelAdapter(async () => ({ text: "" }), { model: "gemini-test" });
    await expect(adapter.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /empty/,
    );
  });
});
