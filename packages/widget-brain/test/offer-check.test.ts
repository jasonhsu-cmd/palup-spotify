import { describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";
import { classifyOutgoingOffer } from "../src/offer-check.js";

// 3b — the semantic outgoing-offer checker. See offer-check.ts for the contract; these pin it.

class StubModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly reply: string | Error) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    if (this.reply instanceof Error) throw this.reply;
    return { text: this.reply, model: "stub" } as ModelResponse;
  }
}

const check = (modelReply: string | Error, textToCheck = "Sure, I gave you 30% off!") =>
  classifyOutgoingOffer(new StubModel(modelReply), textToCheck, "acme");

describe("3b — classifyOutgoingOffer", () => {
  it("returns true when the model verdict says the reply invents an offer", async () => {
    expect(await check('{"inventsOffer":true}')).toBe(true);
  });

  it("returns false when the model verdict says it does not", async () => {
    expect(await check('{"inventsOffer":false}')).toBe(false);
  });

  it("tolerates a markdown-fenced verdict", async () => {
    expect(await check('```json\n{"inventsOffer":true}\n```')).toBe(true);
  });

  it("fails SAFE (false = do not block) on a model/network error", async () => {
    expect(await check(new Error("timeout"))).toBe(false);
  });

  it("fails SAFE on unparseable prose (never treats prose as a verdict)", async () => {
    expect(await check("I think maybe it does offer something?")).toBe(false);
  });

  it("only an explicit boolean true blocks — a non-boolean field does not", async () => {
    expect(await check('{"inventsOffer":"true"}')).toBe(false); // string, not boolean
    expect(await check('{"inventsOffer":1}')).toBe(false);
    expect(await check("{}")).toBe(false);
  });

  it("sends the reply as the content to check, at temperature 0, with the tenant + a strict schema", async () => {
    const model = new StubModel('{"inventsOffer":false}');
    await classifyOutgoingOffer(model, "your promo code SAVE20 is active", "acme");
    const req = model.requests[0]!;
    expect(req.temperature).toBe(0);
    expect(req.tenantId).toBe("acme");
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "your promo code SAVE20 is active" });
    expect((req.responseSchema as { required?: string[] }).required).toEqual(["inventsOffer"]);
  });
});
