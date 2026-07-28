import type {
  JudgePort,
  JudgeInput,
  JudgeVerdict,
  JudgeCriterionResult,
  ModelPort,
} from "@palup/platform-ports";

function extractJson(text: string): { results?: Array<{ id?: unknown; pass?: unknown; reason?: unknown }> } {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("judge: no JSON object in response");
  return JSON.parse(raw.slice(start, end + 1));
}

// A judge backed by any ModelPort. Family is declared so the cross-family guard can enforce
// proposer≠evaluator. Grading is objective-per-criterion (pass/fail + reason), returned as JSON.
export class ModelJudge implements JudgePort {
  constructor(
    private readonly model: ModelPort,
    private readonly family: string,
  ) {}

  async grade(input: JudgeInput): Promise<JudgeVerdict> {
    const system =
      "You are an impartial, strict evaluator. Judge each CRITERION as pass/fail against the RUBRIC " +
      "and TRANSCRIPT. Respond ONLY with JSON: " +
      '{"results":[{"id":"<criterion id>","pass":true|false,"reason":"<one line>"}]}. No prose.';
    const user =
      `RUBRIC:\n${input.rubric}\n\nCRITERIA:\n` +
      input.criteria.map((c) => `- ${c.id}: ${c.description}`).join("\n") +
      `\n\nTRANSCRIPT:\n${input.transcript}`;

    const res = await this.model.complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
    });

    const parsed = extractJson(res.text);
    const byId = new Map((parsed.results ?? []).map((r) => [String(r.id), r]));
    const results: JudgeCriterionResult[] = input.criteria.map((c) => {
      const r = byId.get(c.id);
      return {
        id: c.id,
        pass: Boolean(r?.pass),
        reason: String(r?.reason ?? "no verdict returned for this criterion"),
      };
    });
    const passed = results.filter((r) => r.pass).length;
    return {
      pass: passed === results.length,
      score: results.length ? passed / results.length : 0,
      results,
      judgeModel: res.model,
      judgeFamily: this.family,
    };
  }
}
