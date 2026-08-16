import { describe, expect, it } from "vitest";
import type { GroundingContext, GroundingPort, ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";
import { MockCommerceAdapter, createBrain } from "../src/index.js";
import type { Signals } from "../src/types.js";

// 3b — the semantic outgoing-offer check, wired into the brain's reply-integrity rung. These drive the
// clean sales path to the check and pin: flag-on catches a PARAPHRASED invented offer the keyword floor
// misses; flag-off is byte-identical (floor only); a check error fails safe to the floor's verdict.

const grounding: GroundingPort = {
  async getContext(): Promise<GroundingContext> {
    return {
      tenantId: "acme",
      brandName: "Acme",
      products: [{ id: "serum", title: "Serum", price: "$34", description: "A serum.", availableForSale: true }],
      policy: { returns: "30 days", shipping: "free over $75" },
    };
  },
  async getShell() {
    return { tenantId: "acme", brandName: "Acme", policy: { returns: "30 days", shipping: "free over $75" } };
  },
};

/** A generation model that always replies with the same text (so we control what the checker sees). */
class ReplyModel implements ModelPort {
  constructor(private readonly reply: string) {}
  async complete(): Promise<ModelResponse> {
    return { text: this.reply, model: "gen" } as ModelResponse;
  }
}

/** The offer checker's model: emits a fixed verdict JSON, or throws. */
class VerdictModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly verdict: "yes" | "no" | Error) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    if (this.verdict instanceof Error) throw this.verdict;
    return { text: `{"inventsOffer":${this.verdict === "yes"}}`, model: "check" } as ModelResponse;
  }
}

// A reply that INVENTS an offer by PARAPHRASE — no "%", no "off", no "code", so the keyword floor
// (replyOffersUngroundedDiscount) does NOT catch it, but its meaning is an ungrounded arrangement.
const SNEAKY = "Yes, that special arrangement is all set for you — enjoy!";

function brain(genReply: string, checker: ModelPort | undefined, enabled: boolean) {
  return createBrain(
    new ReplyModel(genReply), grounding, undefined, new MockCommerceAdapter(), undefined, undefined,
    false, false, false, false,
    undefined, false, undefined,
    false, false, false, false,
    undefined, false,
    checker, enabled,
  );
}

const SALES: Signals = { tenantId: "acme" };
const ASK = "what do you recommend for dull skin?";

describe("3b — outgoing-offer check in the reply-integrity rung (flag ON)", () => {
  it("routes a PARAPHRASED invented offer (missed by the keyword floor) to the discount guardrail", async () => {
    const checker = new VerdictModel("yes");
    const d = await brain(SNEAKY, checker, true).decide(SALES, ASK);
    expect(d.model).toBe("guardrail");
    expect(d.flags).toContain("reply_integrity:ungrounded_discount");
    expect(d.escalateToHuman).toBe(true);
    expect(checker.requests).toHaveLength(1); // the checker actually ran on the reply
  });

  it("serves a clean reply the checker clears (verdict no)", async () => {
    const d = await brain("Our Serum is $34 and pairs well with a daily SPF.", new VerdictModel("no"), true).decide(SALES, ASK);
    expect(d.model).not.toBe("guardrail");
    expect(d.reply).toContain("Serum");
  });

  it("fails SAFE: a checker error serves the reply the keyword floor already passed (no block)", async () => {
    const d = await brain(SNEAKY, new VerdictModel(new Error("timeout")), true).decide(SALES, ASK);
    expect(d.model).not.toBe("guardrail"); // floor didn't catch it, checker errored → baseline (served)
    expect(d.reply).toBe(SNEAKY);
  });
});

describe("3b — flag OFF is inert", () => {
  it("does NOT run the checker and serves the paraphrased reply (byte-identical to pre-3b)", async () => {
    const checker = new VerdictModel("yes");
    const d = await brain(SNEAKY, checker, false).decide(SALES, ASK);
    expect(checker.requests).toHaveLength(0); // never consulted
    expect(d.model).not.toBe("guardrail");
    expect(d.reply).toBe(SNEAKY);
  });

  it("the deterministic keyword floor still fires with the checker absent (a real '% off' is caught)", async () => {
    const d = await brain("Sure — here's 30% off your order!", undefined, false).decide(SALES, ASK);
    expect(d.model).toBe("guardrail"); // floor is independent of 3b
    expect(d.flags).toContain("reply_integrity:ungrounded_discount");
  });
});
