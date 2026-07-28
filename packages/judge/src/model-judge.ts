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
      "and TRANSCRIPT. Output ONLY the JSON object and nothing else — no preamble, no markdown fences: " +
      '{"results":[{"id":"<criterion id>","pass":true|false,"reason":"<one line>"}]}';
    const user =
      `RUBRIC:\n${input.rubric}\n\nCRITERIA:\n` +
      input.criteria.map((c) => `- ${c.id}: ${c.description}`).join("\n") +
      `\n\nTRANSCRIPT:\n${input.transcript}`;
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];
    // Structured-outputs schema: adapters that support it (Anthropic `output_config.format`) force
    // schema-valid JSON at the provider so a verdict can't come back as prose. Adapters that don't
    // just ignore it. `additionalProperties: false` + `required` per the structured-outputs contract.
    const responseSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              pass: { type: "boolean" },
              reason: { type: "string" },
            },
            required: ["id", "pass", "reason"],
          },
        },
      },
      required: ["results"],
    } as const;

    // Resilient: attempt 0 asks for structured output; attempt 1 drops the schema (fallback if a
    // provider rejects it or an edge case — refusal / max_tokens — slips through). Then FAIL CLOSED
    // rather than throwing — a single unparseable verdict must never crash a whole corpus run.
    let res: Awaited<ReturnType<ModelPort["complete"]>> | undefined;
    let parsed: { results?: Array<{ id?: unknown; pass?: unknown; reason?: unknown }> } | undefined;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        res = await this.model.complete({
          messages,
          temperature: 0,
          responseSchema: attempt === 0 ? (responseSchema as unknown as Record<string, unknown>) : undefined,
        });
        parsed = extractJson(res.text);
      } catch {
        parsed = undefined;
      }
    }
    if (!parsed) {
      const results = input.criteria.map((c) => ({
        id: c.id,
        pass: false,
        reason: "judge response not parseable as JSON",
      }));
      return { pass: false, score: 0, results, judgeModel: res?.model ?? "judge", judgeFamily: this.family };
    }
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
      judgeModel: res?.model ?? "judge",
      judgeFamily: this.family,
    };
  }
}
