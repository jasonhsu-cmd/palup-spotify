import type { Policy } from "@palup/widget-brain";
import type { Grader, PolicyMetrics } from "./types.js";

/** Deterministic grader for tests + the offline demo (no model calls). Real grading runs the eval+judge. */
export class MockGrader implements Grader {
  constructor(private readonly scores: Record<string, PolicyMetrics>) {}
  async grade(policy: Policy): Promise<PolicyMetrics> {
    const m = this.scores[policy.id];
    if (!m) throw new Error(`MockGrader: no score configured for policy ${policy.id}`);
    return { ...m, policyId: policy.id };
  }
}
