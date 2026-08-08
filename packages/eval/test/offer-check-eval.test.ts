import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";
import { classifyOutgoingOffer } from "@palup/widget-brain";
import { gradeOfferCheck, type OfferCase } from "../src/offer-check-harness.js";

// 3b eval — grader + plumbing, gate-tested WITHOUT creds. A scripted model returns canned checker JSON so
// we prove classifyOutgoingOffer's parse path (the runner's) end-to-end and that the grader scores it. The
// real-model classifier-quality run is `pnpm eval:offer-check` (needs Vertex creds).

/** Returns whatever verdict JSON it's constructed with — stands in for the real semantic checker. */
class ScriptedChecker implements ModelPort {
  constructor(private readonly raw: string) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    return { text: this.raw, model: "scripted" };
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(join(here, "..", "cases", "offer-check.json"), "utf8")) as { cases: OfferCase[] };

describe("3b offer-check — grader", () => {
  it("passes when the verdict matches", () => {
    expect(gradeOfferCheck(true, true).pass).toBe(true);
    expect(gradeOfferCheck(false, false).pass).toBe(true);
  });
  it("fails a false negative (missed invent) and a false positive (blocked legit) with distinct reasons", () => {
    expect(gradeOfferCheck(true, false)).toMatchObject({ pass: false });
    expect(gradeOfferCheck(true, false).fail).toMatch(/MISSED/);
    expect(gradeOfferCheck(false, true).fail).toMatch(/FALSE-flagged/);
  });
});

describe("3b offer-check — plumbing (classifyOutgoingOffer parse path used by the runner)", () => {
  it("a {\"inventsOffer\":true} verdict ⇒ caught, graded as a correct catch", async () => {
    const actual = await classifyOutgoingOffer(new ScriptedChecker('{"inventsOffer":true}'), "I applied 20% off.", "t");
    expect(actual).toBe(true);
    expect(gradeOfferCheck(true, actual).pass).toBe(true);
  });
  it("a {\"inventsOffer\":false} verdict (even markdown-fenced) ⇒ allowed", async () => {
    const actual = await classifyOutgoingOffer(new ScriptedChecker('```json\n{"inventsOffer":false}\n```'), "I can't offer discounts.", "t");
    expect(actual).toBe(false);
  });
  it("unparseable output ⇒ false (fail-safe to the deterministic floor)", async () => {
    const actual = await classifyOutgoingOffer(new ScriptedChecker("sorry, I can't help with that"), "anything", "t");
    expect(actual).toBe(false);
  });
});

describe("3b offer-check — corpus is well-formed", () => {
  it("every case has a unique id, a non-empty message, and a boolean expect", () => {
    const ids = new Set<string>();
    for (const c of cases) {
      expect(c.id, JSON.stringify(c)).toBeTruthy();
      expect(ids.has(c.id), `duplicate id ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(typeof c.message).toBe("string");
      expect(c.message.length).toBeGreaterThan(0);
      expect(typeof c.expect).toBe("boolean");
    }
  });
  it("has both catch (expect:true) and allow (expect:false) gating cases", () => {
    const gating = cases.filter((c) => !c.advisory);
    expect(gating.some((c) => c.expect)).toBe(true);
    expect(gating.some((c) => !c.expect)).toBe(true);
  });
});
