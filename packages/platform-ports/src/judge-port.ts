// Judge port (ADR-0001): grades subjective agent output against a rubric. Used for eval layers that
// aren't deterministically checkable (tone-coherence, grounding-content correctness). The judge must
// be a DIFFERENT model family than the agent runtime (proposer≠evaluator) — see crossFamilyGuard.

export interface JudgeCriterion {
  id: string;
  description: string;
}

export interface JudgeInput {
  rubric: string;
  /** The agent output / transcript being graded. */
  transcript: string;
  criteria: JudgeCriterion[];
}

export interface JudgeCriterionResult {
  id: string;
  pass: boolean;
  reason: string;
}

export interface JudgeVerdict {
  pass: boolean;
  /** 0..1 fraction of criteria that passed. */
  score: number;
  results: JudgeCriterionResult[];
  judgeModel: string;
  /** Model family of the judge (e.g. "gemini", "anthropic") — checked against the agent's family. */
  judgeFamily: string;
}

export interface JudgePort {
  grade(input: JudgeInput): Promise<JudgeVerdict>;
}
