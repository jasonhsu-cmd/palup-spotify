import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JudgePort, ModelPort } from "@palup/platform-ports";
import { createBrain, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { CRITERIA } from "./scenarios.js";

// The control-plane half of shadow/canary. Reads the real traffic the backend logs, shadow-grades a
// canary policy against the champion on that real traffic, and (auto-)rolls the canary back on
// regression by writing the shared canary-config the backend reads. Local/staging uses a shared file;
// production swaps a shared StorePort behind the same calls (ADR-0004).

const DIR = ".palup-state";
const CONFIG = join(DIR, "canary-config.json");
const LOG = join(DIR, "traffic-log.jsonl");
const GENERAL = ["warm", "needs-first", "grounded", "concise", "no-pressure"]; // general sales-quality rubric

export interface Interaction { ts: string; servedBy: string; sessionId: string; message: string; reply: string; mode: string; escalate: boolean }
export interface CanaryConfig { enabled: boolean; pct: number; policy: Policy }

export const DEFAULT_CANARY: Policy = {
  id: "canary-warm",
  label: "Canary: warm, needs-first",
  styleDirective: "Open with a brief, genuine acknowledgement of the shopper's need, then recommend from the catalog in 2-3 sentences tied to that need. Warm and honest; never pushy.",
  proactivityDefault: "balanced",
};

export function readTrafficLog(): Interaction[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as Interaction; } catch { return null; } })
    .filter((x): x is Interaction => x !== null);
}
export function canaryConfig(): CanaryConfig | null {
  try { return existsSync(CONFIG) ? (JSON.parse(readFileSync(CONFIG, "utf8")) as CanaryConfig) : null; } catch { return null; }
}
function write(cfg: CanaryConfig): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}
export function startCanary(policy: Policy, pct: number): CanaryConfig {
  const cfg = { enabled: true, pct: Math.max(0, Math.min(100, pct)), policy };
  write(cfg);
  return cfg;
}
export function stopCanary(): CanaryConfig {
  const cfg = { enabled: false, pct: 0, policy: canaryConfig()?.policy ?? DEFAULT_CANARY };
  write(cfg);
  return cfg;
}

/** Per-policy live counts + escalation rate from the real traffic log. */
export function canaryStats(): Record<string, { count: number; escalationRate: number }> {
  const by: Record<string, { count: number; esc: number }> = {};
  for (const e of readTrafficLog()) {
    const b = (by[e.servedBy] ??= { count: 0, esc: 0 });
    b.count++;
    if (e.escalate) b.esc++;
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { count: v.count, escalationRate: v.count ? v.esc / v.count : 0 }]));
}

/**
 * Shadow-evaluate the canary on REAL champion-served traffic: replay each sampled shopper message
 * through the canary policy and judge both the champion's actual logged reply and the canary's new
 * reply on general sales-quality criteria; compare. This is a real signal from real conversations —
 * no synthetic corpus.
 */
export async function shadowEvaluate(model: ModelPort, judge: JudgePort, canaryPolicy: Policy, sampleN = 8) {
  const champ = readTrafficLog().filter((e) => e.servedBy === DEFAULT_POLICY.id && e.message.trim().length > 2);
  const sample = champ.slice(-sampleN);
  const grounding = new StaticGroundingAdapter();
  const canaryBrain = createBrain(model, grounding, canaryPolicy, new MockCommerceAdapter(), "shopper-demo");
  const rubric = "Judge this skincare store's sales reply per criterion (pass/fail):\n" + GENERAL.map((c) => `- ${c}: ${CRITERIA[c]}`).join("\n");
  const grade = async (reply: string, message: string) =>
    (await judge.grade({ rubric, transcript: `Shopper: ${message}\nAssistant: ${reply}`, criteria: GENERAL.map((c) => ({ id: c, description: c })) })).score;

  let champSum = 0, canSum = 0, n = 0;
  await Promise.all(sample.map(async (e) => {
    const [cq, kq] = await Promise.all([
      grade(e.reply, e.message),
      canaryBrain.decide({} as never, e.message).then((d) => grade(d.reply, e.message)),
    ]);
    champSum += cq; canSum += kq; n++;
  }));
  const championQ = n ? champSum / n : 0;
  const canaryQ = n ? canSum / n : 0;
  const delta = canaryQ - championQ;
  return { n, championQ, canaryQ, delta, verdict: verdictFor(n, delta) };
}

// Pure decision from the shadow result — tolerant of live-judge noise (±5pts is a "hold").
export type CanaryVerdict = "promote" | "rollback" | "hold" | "no-traffic";
export function verdictFor(n: number, delta: number): CanaryVerdict {
  if (n === 0) return "no-traffic";
  if (delta >= 0.05) return "promote";
  if (delta <= -0.05) return "rollback";
  return "hold";
}
