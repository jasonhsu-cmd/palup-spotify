import { createBrain, MockModelAdapter, type Brain } from "@palup/widget-brain";

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
