export interface CrossFamilyResult {
  crossFamily: boolean;
  agentFamily: string;
  judgeFamily: string;
}

// proposer≠evaluator: the judge must be a different model family than the agent runtime, so the
// same model doesn't grade its own family's output. Strict mode fails closed.
export function crossFamilyGuard(
  agentFamily: string,
  judgeFamily: string,
  opts: { strict?: boolean } = {},
): CrossFamilyResult {
  const crossFamily = agentFamily.trim().toLowerCase() !== judgeFamily.trim().toLowerCase();
  if (!crossFamily && opts.strict) {
    throw new Error(
      `cross-family guard: judge family "${judgeFamily}" must differ from agent family "${agentFamily}". ` +
        `Configure a different-family judge, or run advisory (non-strict) only.`,
    );
  }
  return { crossFamily, agentFamily, judgeFamily };
}
