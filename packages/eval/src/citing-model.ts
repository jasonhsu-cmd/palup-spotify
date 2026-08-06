import type { ModelPort, ModelRequest, ModelResponse } from "@palup/platform-ports";
import { MockModelAdapter } from "@palup/widget-brain";

// A model double that CITES, so the eval gate can actually see E2 (product citations).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. Running the blocking gate against a brain with `productCitationsEnabled` and
// `cartLineItemsEnabled` turned ON produced this, measured:
//
//   incumbent : 69/69 blocked=false
//   E2+E4 on  : 69/69 blocked=false floorFails=[] regressions=[]
//   cases whose verdict changed: NONE
//   replies identical: true
//
// A green gate that saw nothing. `MockModelAdapter` builds its reply from the last USER message and never
// emits a citation tag, so E2's extract → resolve → strip path never ran; and no corpus case supplies
// `signals.cartItems`, so E4's path never ran either. Promoting on that green would be promoting on a
// silence — the same shape as SW-9 hand-injecting the state it claimed to test.
//
// WHAT MAKES THIS DOUBLE FAITHFUL rather than a rubber stamp: it does what a real model does — it reads
// the citation tags out of the prompt IT WAS GIVEN and cites them. It cannot know a nonce it was not
// shown, which is exactly the property E2 relies on. So the tags it emits resolve through the real
// `CitationMap` for the real reason, not because the fixture and the code agreed on a constant.
//
// It deliberately does NOT always cite: `forge` and `silent` modes exist so the gate can also see the
// paths that matter most — a tag the prompt never contained (the forged-citation case), and a reply that
// recommends in prose without citing (the under-reporting case E2 documents as a lower bound).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The tag shape E2 mints: `[P<1-based position>-<8 lowercase hex>]` (citations.ts). */
const TAG = /\[P\d{1,4}-[0-9a-f]{8}\]/g;

export type CitingMode =
  /** Cite the first tag the prompt offered — the ordinary path. */
  | "cite"
  /** Cite a well-formed tag the prompt NEVER contained: must resolve to nothing and be stripped. */
  | "forge"
  /** Recommend in prose, cite nothing — the honest under-report E2 warns about. */
  | "silent";

/**
 * Wraps `MockModelAdapter` so every non-citation behaviour the corpus already depends on is unchanged —
 * this only appends a citation, never rewrites the reply. That matters: the corpus's `contains:` and mode
 * assertions were calibrated against the mock, and a double that answered differently would move cases for
 * reasons unrelated to E2.
 */
export class CitingModelAdapter implements ModelPort {
  private readonly inner = new MockModelAdapter();
  constructor(private readonly mode: CitingMode = "cite") {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const base = await this.inner.complete(req);
    if (this.mode === "silent") return base;

    const system = req.messages.find((m) => m.role === "system")?.content ?? "";
    const offered = system.match(TAG) ?? [];

    let tag: string | undefined;
    if (this.mode === "cite") {
      tag = offered[0];
      // No tags in the prompt means retrieval/citations produced none this turn — nothing to cite, and
      // inventing one here would be the `forge` mode, not this one.
      if (!tag) return base;
    } else {
      // A syntactically perfect tag whose nonce was never minted. Fixed value on purpose: it must not
      // collide with a real nonce, and `deadbeef` is not something `newNonce()` can produce twice.
      tag = "[P1-deadbeef]";
    }

    return {
      ...base,
      text: `${base.text} I'd suggest ${tag} for that.`,
      model: `citing-${this.mode}`,
    };
  }
}

/** Tags the prompt actually offered — used by tests to assert the double cited a REAL one. */
export function tagsOfferedIn(systemPrompt: string): string[] {
  return systemPrompt.match(TAG) ?? [];
}
