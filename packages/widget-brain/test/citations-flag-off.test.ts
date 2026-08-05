import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { MockCommerceAdapter, StaticGroundingAdapter, createBrain } from "../src/index.js";
import type { CatalogRetrieverPort } from "../src/types.js";
import { FLAG_OFF_PROBES, captureFlagOff, type Probe, type ProbeCapture } from "./helpers/flag-off-probes.js";

// E2's MERGE BAR, made machine-checkable, on E1's harness and E1's golden — deliberately NOT a new one.
//
// `fixtures/flag-off-golden.json` was captured on the commit BEFORE E1's implementation existed (see
// helpers/flag-off-probes.ts), through a RECORDING ModelPort, so the SYSTEM PROMPT itself is inside the
// assertion — not just the graded `Decision`. Reusing it here means this file proves something stronger
// than "E2 changed nothing since E1": it proves the prompt, every `Decision`, and every reply are still
// byte-identical to the tree BEFORE either flag existed. If E2 renders one citation tag, adds one word
// of prompt rule, or attaches one `recommendedProducts` field while PRODUCT_CITATIONS is off, this fails.
//
// ⚠️ The golden must NOT be regenerated to make this pass — see the warning in helpers/flag-off-probes.ts.
const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "fixtures", "flag-off-golden.json"), "utf8")) as ProbeCapture[];

/** Fails the test if anything calls it — retrieval must stay unconsulted whatever E2 does. */
function explodingRetriever(): CatalogRetrieverPort {
  return {
    async retrieve() {
      throw new Error("retriever was consulted while CATALOG_RETRIEVAL is OFF");
    },
  };
}

describe("E2 — flag OFF is byte-identical to the commit before E1 and E2 existed", () => {
  it("the golden still covers every rung of the ladder and every prompt-shaping branch", () => {
    expect(golden.map((g) => g.id)).toEqual(FLAG_OFF_PROBES.map((p) => p.id));
    expect(golden.filter((g) => g.requests.length > 0).length).toBeGreaterThan(15);
  });

  it("today's call site (nothing extra passed) reproduces the golden decision AND prompt, byte for byte", async () => {
    expect(await captureFlagOff()).toEqual(golden);
  });

  it("the PRODUCT_CITATIONS flag left at its default changes nothing", async () => {
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false, // subscriptionSelfServeEnabled
        false, // dispositionStyleEnabled
        false, // dispositionBehavioralEnabled
        false, // dispositionClassifierEnabled
        explodingRetriever(),
        false, // catalogRetrievalEnabled
        undefined, // catalogRetrievalK
        // productCitationsEnabled is DELIBERATELY not passed — the default must be off.
      );
    expect(await captureFlagOff(build)).toEqual(golden);
  });

  it("passing PRODUCT_CITATIONS explicitly false is the same thing", async () => {
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false, false, false, false,
        explodingRetriever(),
        false,
        undefined,
        false,
      );
    expect(await captureFlagOff(build)).toEqual(golden);
  });

  it("PRODUCT_CITATIONS ON with retrieval OFF still never mints a tag on a guardrail rung", async () => {
    // The flag ON is a behaviour change on the SALES path by design — that is what needs a promotion.
    // What must hold even then: no guardrail rung's prompt or reply gains a tag, because none of them
    // renders a catalog through the citation path. Asserted against the golden for the guardrail probes
    // only; the sales probes are expected to differ and are excluded.
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false, false, false, false,
        undefined,
        false,
        undefined,
        true, // productCitationsEnabled ON
      );
    const captured = await captureFlagOff(build);
    for (const cap of captured) {
      for (const req of cap.requests) {
        const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
        if (cap.id.startsWith("sales-")) continue; // the sales path is where E2 deliberately acts
        expect(sys, `${cap.id} minted a citation tag off the sales path`).not.toMatch(/\[P\d+-[0-9a-f]{8}\]/);
      }
    }
  });
});
