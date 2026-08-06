import { createBrain, MockModelAdapter, StaticGroundingAdapter, type Brain } from "@palup/widget-brain";
import { CitingModelAdapter } from "./citing-model.js";

export interface Candidate {
  id: string;
  note: string;
  brain: Brain;
}

// The current shipping brain — the baseline / incumbent.
export const incumbent: Candidate = {
  id: "incumbent",
  note: "current shipping brain (guardrails in code)",
  brain: createBrain(new MockModelAdapter()),
};

// A deliberately-broken candidate: chases conversion by pitching in EVERY turn and never
// escalating. It exists to prove the gate BLOCKS an unsafe self-improvement (it should fail the
// safety floor). This is a test fixture, never a shippable brain.
export const rogueCandidate: Candidate = {
  id: "rogue-max-conversion",
  note: "always pitches, never escalates — must be blocked by the gate",
  brain: {
    async decide() {
      return {
        mode: "sales",
        reply: "You should definitely buy the serum right now — add it to your cart!",
        pitch: "cross_sell",
        escalateToHuman: false,
        outbound: false,
        safetyClass: "none",
        flags: ["pitch:cross_sell"],
        model: "rogue-1",
      };
    },
  },
};

// ── The Wave 4 flag-ON posture, so the gate can SEE what promotion would ship ────────────────────────
//
// WHY THIS CANDIDATE EXISTS. NN#2 requires a blocking eval gate to pass before promotion. Run against a
// brain with `productCitationsEnabled` + `cartLineItemsEnabled` ON, the gate previously returned:
//
//   E2+E4 on : 69/69 blocked=false floorFails=[] regressions=[]
//   cases whose verdict changed: NONE          replies identical: true
//
// Green, having executed neither feature: no corpus case supplied `cartItems`, and `MockModelAdapter`
// never emits a citation tag. Promoting on that is promoting on a silence. This candidate makes the
// flag-on posture something the gate actually evaluates, held to the SAME floors as the incumbent — so a
// Wave 4 flag that broke restraint, safety or compliance would BLOCK rather than pass unseen.
//
// TWO HONEST CAVEATS, because this is not a clean A/B on the flags alone:
//
//  1. It is GROUNDED and the incumbent is NOT. `incumbent` is `createBrain(new MockModelAdapter())` with
//     no grounding adapter, so no products ever reach its prompt — which is also why citations could never
//     be minted under the gate. Production always passes grounding (server.ts), so the ungrounded
//     incumbent is the unrepresentative one; that is a pre-existing harness property, not something this
//     candidate introduces, and it is worth its own look because every catalog-dependent behaviour the
//     accuracy suite claims to measure is unexercised by it.
//  2. `CitingModelAdapter` wraps the same `MockModelAdapter`, appending a citation rather than rewriting
//     the reply, so every `contains:`/mode assertion the corpus calibrated against the mock still holds.
//     It cites tags it PARSED OUT OF THE PROMPT — it cannot know a nonce it was not shown, which is the
//     property E2 depends on, so a resolved id proves the real mechanism rather than fixture agreement.
export const wave4Candidate: Candidate = {
  id: "wave4-flags-on",
  note: "E2 product citations + E4 cart line items ON, grounded, cited by a prompt-parsing double",
  brain: createBrain(
    new CitingModelAdapter("cite"),
    new StaticGroundingAdapter(),
    undefined, // policy -> DEFAULT_POLICY
    undefined, // commerce
    undefined, // shopperId -> default
    undefined, // memory
    false, // subscriptionSelfServe
    false, // dispositionStyle
    false, // dispositionBehavioral
    false, // dispositionClassifier
    undefined, // catalogRetriever — E1 stays OFF; E2 keys to the RENDERED set, so it works without it
    false, // catalogRetrievalEnabled
    undefined, // catalogRetrievalK
    true, // productCitationsEnabled   (E2)
    false, // productCardsEnabled      (E3 — surfacing is a separate promotion)
    true, // cartLineItemsEnabled      (E4)
  ),
};
