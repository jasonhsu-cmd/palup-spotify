import type { ModelPort } from "@palup/platform-ports";
import type { Policy } from "@palup/widget-brain";
import type { Proposer, Weakness } from "@palup/evolution";
import { CRITERIA } from "./scenarios.js";

// A REAL proposer: an LLM authors new style directives aimed at the champion's measured weak criteria.
// It may only change VOICE + PROACTIVITY (the guardrails are code-enforced and out of its reach), so a
// proposal can never be unsafe — only better or worse on value, which the gate then judges.
export class ModelProposer implements Proposer {
  constructor(
    private readonly model: ModelPort,
    private readonly count = 2,
    private readonly log: (m: string) => void = () => {},
  ) {}

  async propose(champion: Policy, weaknesses: Weakness[]): Promise<Policy[]> {
    const weakList = weaknesses
      .map((w) => `- ${w.criterion} (pass ${(w.passRate * 100).toFixed(0)}%): ${CRITERIA[w.criterion] ?? w.criterion}`)
      .join("\n");
    const system =
      "You tune ONLY the voice and proactivity of a Shopify skincare store's sales assistant. You may not " +
      "change product facts, prices, or safety behavior — those are fixed in code. Output only the JSON object.";
    const user =
      `The assistant's current style directive is:\n"${champion.styleDirective}"\n\n` +
      `Across real shopper conversations it underperforms on these criteria:\n${weakList}\n\n` +
      `Propose ${this.count} DIFFERENT improved style directives (2-3 sentences each), each explicitly written ` +
      `to raise those weak criteria while staying concise, honest, catalog-grounded, and never pushy or ` +
      `manipulative. For each, pick proactivityDefault: "cautious", "balanced", or "confident".`;

    const responseSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              styleDirective: { type: "string" },
              proactivityDefault: { type: "string", enum: ["cautious", "balanced", "confident"] },
            },
            required: ["label", "styleDirective", "proactivityDefault"],
          },
        },
      },
      required: ["candidates"],
    } as const;

    const res = await this.model.complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 1024,
      responseSchema: responseSchema as unknown as Record<string, unknown>,
    });

    let parsed: { candidates?: Array<{ label?: string; styleDirective?: string; proactivityDefault?: string }> };
    try {
      const start = res.text.indexOf("{");
      const end = res.text.lastIndexOf("}");
      parsed = JSON.parse(res.text.slice(start, end + 1));
    } catch {
      this.log(`    proposer: unparseable response, proposing nothing`);
      return [];
    }
    const out = (parsed.candidates ?? [])
      .filter((c) => c.styleDirective)
      .slice(0, this.count)
      .map((c, i): Policy => ({
        id: `prop-${i}`,
        label: c.label ?? `proposal ${i + 1}`,
        styleDirective: c.styleDirective!,
        proactivityDefault: (["cautious", "balanced", "confident"].includes(c.proactivityDefault ?? "")
          ? c.proactivityDefault
          : "balanced") as Policy["proactivityDefault"],
      }));
    this.log(`    proposer authored ${out.length}: ${out.map((p) => p.label).join(" | ")}`);
    return out;
  }
}
