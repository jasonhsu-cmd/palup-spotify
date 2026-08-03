import { createHash } from "node:crypto";
import type { Scenario } from "./scenarios.js";

// ADR-0014 #7 — a SECRET, ROTATED holdout the proposer never sees, so a candidate policy cannot overfit /
// game the eval. The self-improvement loop shows the proposer the champion's WEAK criteria (from the
// VISIBLE set) and asks it to author a fix; if the gate then scored the candidate on that SAME set, a
// proposer could tune to those exact criteria and look "improved" while generalizing worse. The gate
// instead ALSO scores an unseen holdout: a candidate that improves the visible set but regresses the
// holdout is overfitting and is blocked (engine.gate: "holdout-regressed").
//
// The partition is deterministic given a rotation SEED but UNPREDICTABLE without it — the seed is a
// server secret (HOLDOUT_ROTATION_SECRET) the proposer's context never contains. "Rotated" = change the
// seed to reshuffle which scenarios are held out, so a proposer can't learn the split over many rounds.
const HOLDOUT_FRACTION = 0.3;

export interface Partition {
  /** Scenarios the proposer's weakness report is derived from — its optimization target. */
  visible: Scenario[];
  /** Scenarios the proposer NEVER sees — the gate's anti-overfit check. */
  holdout: Scenario[];
}

/** Map a string to a stable unit interval [0,1) via sha256 — no Math.random, so the split is reproducible. */
function hashToUnit(s: string): number {
  return parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0x1_0000_0000;
}

/**
 * Partition scenarios into visible + holdout, deterministically per (scenario id, seed). A scenario is
 * HELD OUT when hash(id::seed) falls in the bottom `fraction`. Changing `seed` reshuffles the split
 * (rotation); without the seed the split is unpredictable (secrecy). Guarantees at least one scenario on
 * each side so both the proposer and the holdout check always have signal.
 */
export function partitionScenarios(scenarios: Scenario[], seed: string, fraction = HOLDOUT_FRACTION): Partition {
  const scored = scenarios.map((s) => ({ s, h: hashToUnit(`${s.id}::${seed}`) }));
  const holdout = scored.filter((x) => x.h < fraction).map((x) => x.s);
  const visible = scored.filter((x) => x.h >= fraction).map((x) => x.s);
  if (scenarios.length < 2) return { visible: scenarios, holdout: [] }; // too few to hold out
  if (holdout.length === 0) return { visible: scored.slice(1).map((x) => x.s), holdout: [scored[0]!.s] };
  if (visible.length === 0) return { visible: [scored[0]!.s], holdout: scored.slice(1).map((x) => x.s) };
  return { visible, holdout };
}

/** The rotation seed — a server SECRET in prod (the proposer never receives it), a fixed default for the
 * offline demo/tests. Rotating it re-randomizes the holdout so a proposer can't memorize the split. */
export function holdoutSeed(): string {
  return process.env.HOLDOUT_ROTATION_SECRET ?? "palup-holdout-default-seed";
}
