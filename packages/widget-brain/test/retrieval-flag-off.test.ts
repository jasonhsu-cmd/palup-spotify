import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelPort } from "@palup/platform-ports";
import { MockCommerceAdapter, StaticGroundingAdapter, createBrain } from "../src/index.js";
import type { CatalogRetrieverPort } from "../src/types.js";
import { FLAG_OFF_PROBES, captureFlagOff, type Probe, type ProbeCapture } from "./helpers/flag-off-probes.js";

// E1's MERGE BAR, made machine-checkable: with the CATALOG_RETRIEVAL posture flag off, this PR changes
// NOTHING a shopper sees. See helpers/flag-off-probes.ts for how the golden was produced (captured on the
// commit BEFORE the implementation, so it is a genuine before/after comparison and not a snapshot of the
// code asserting itself).
const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "fixtures", "flag-off-golden.json"), "utf8")) as ProbeCapture[];

/** A retriever that FAILS THE TEST if anything calls it. Proves "off" means never consulted, not
 *  "consulted and its result discarded" (which would still spend an embedding call per turn). */
function explodingRetriever(): CatalogRetrieverPort {
  return {
    async retrieve() {
      throw new Error("retriever was consulted while CATALOG_RETRIEVAL is OFF");
    },
  };
}

describe("E1 — flag OFF is byte-identical to the previous commit", () => {
  it("the golden covers every rung of the ladder and every prompt-shaping branch", () => {
    expect(golden.map((g) => g.id)).toEqual(FLAG_OFF_PROBES.map((p) => p.id));
    // Sanity: a golden with no captured prompts could never detect a prompt change.
    expect(golden.filter((g) => g.requests.length > 0).length).toBeGreaterThan(15);
  });

  it("today's call site (no retriever passed) reproduces the golden decision AND prompt, byte for byte", async () => {
    expect(await captureFlagOff()).toEqual(golden);
  });

  it("a retriever WIRED but the flag left at its default changes nothing and is never consulted", async () => {
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
        // catalogRetrievalEnabled is DELIBERATELY not passed — the default must be off.
      );
    expect(await captureFlagOff(build)).toEqual(golden);
  });

  it("passing the flag explicitly false is the same thing", async () => {
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false,
        false,
        false,
        false,
        explodingRetriever(),
        false,
      );
    expect(await captureFlagOff(build)).toEqual(golden);
  });

  it("the flag ON with NO retriever wired is also unchanged (a flag alone can never move behaviour)", async () => {
    const build = (model: ModelPort, probe: Probe) =>
      createBrain(
        model,
        new StaticGroundingAdapter(),
        undefined,
        probe.noCommerce ? undefined : new MockCommerceAdapter(),
        undefined,
        probe.recalled ? { async recall() { return probe.recalled!; } } : undefined,
        false,
        false,
        false,
        false,
        undefined,
        true,
      );
    expect(await captureFlagOff(build)).toEqual(golden);
  });
});
