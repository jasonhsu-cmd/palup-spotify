import { describe, it, expect, vi } from "vitest";
import { runModelPortContract } from "@palup/platform-ports/contract";
import {
  VertexModelAdapter,
  type GenerateFn,
  type GenRequest,
} from "../src/vertex-adapter.js";

// A deterministic fake Gemini call — lets us test the adapter's mapping/parsing logic with NO creds.
const fakeGenerate: GenerateFn = async () => ({
  text: "Sure — the vitamin-C serum is fragrance-free.",
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
});

// Contract compliance (ADR-0001): the real adapter satisfies the same port contract as the mock.
runModelPortContract(() => new VertexModelAdapter(fakeGenerate, { model: "gemini-test" }));

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
