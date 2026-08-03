import type { JudgePort, ModelPort, RuntimeStatePort } from "@palup/platform-ports";
import { createBrain, StaticGroundingAdapter, MockCommerceAdapter, DEFAULT_POLICY, type Policy } from "@palup/widget-brain";
import { CRITERIA } from "./scenarios.js";

// The control-plane half of shadow/canary, on the SHARED RuntimeStatePort. Reads the real traffic the
// backend logs, shadow-grades a canary policy against the champion on that real traffic, and
// (auto-)rolls the canary back on regression by writing the shared canary-config the backend reads
// per request — so a rollback propagates across instances (was a per-instance local file). The canary
// config is keyed PER SERVING TENANT: start/stop take a tenantId and write/clear ONLY that merchant's
// config, so a canary can never bucket another merchant's shoppers (ADR-0014 blast-radius fix). Keep
// the collection/key names in sync with widget-backend/canary.ts.

const CANARY = "canary"; // KV collection (rollout config), keyed per SERVING tenant
const CONFIG_KEY = "config";
// Traffic (shopper messages/replies) lives in the SERVING tenant's own partition. The shadow/stats
// reads below take the tenantId and read ONLY that merchant's traffic (ADR-0014 #4 blast-radius): a
// shadow-eval or stats read for one merchant can never see another's conversations.
const TRAFFIC = "traffic"; // append stream
const GENERAL = ["warm", "needs-first", "grounded", "concise", "no-pressure"]; // general sales-quality rubric

// Evolution-pipeline canary stage is 1–5% of traffic (docs/AGENT-GOVERNANCE §2); a ramp to full is the
// separate human-approved promote step, not the canary. Clamp here so a mis-set pct can't over-expose.
export const MAX_CANARY_PCT = 5;

export interface Interaction { ts: string; servedBy: string; sessionId: string; message: string; reply: string; mode: string; escalate: boolean }
export interface CanaryConfig { enabled: boolean; pct: number; policy: Policy }

export const DEFAULT_CANARY: Policy = {
  id: "canary-warm",
  label: "Canary: warm, needs-first",
  styleDirective: "Open with a brief, genuine acknowledgement of the shopper's need, then recommend from the catalog in 2-3 sentences tied to that need. Warm and honest; never pushy.",
  proactivityDefault: "balanced",
};

export async function readTrafficLog(store: RuntimeStatePort, tenantId: string): Promise<Interaction[]> {
  return store.readStream<Interaction>({ tenantId }, TRAFFIC);
}
export async function canaryConfig(store: RuntimeStatePort, tenantId: string): Promise<CanaryConfig | null> {
  return (await store.get<CanaryConfig>({ tenantId }, CANARY, CONFIG_KEY)) ?? null;
}
export async function startCanary(store: RuntimeStatePort, tenantId: string, policy: Policy, pct: number): Promise<CanaryConfig> {
  const clamped = Math.max(0, Math.min(MAX_CANARY_PCT, pct));
  const cfg: CanaryConfig = { enabled: true, pct: clamped, policy };
  // Write + audit under THIS tenant's partition/chain, so the start affects only this merchant.
  await store.tx({ tenantId }, async (t) => {
    await t.put(CANARY, CONFIG_KEY, cfg);
    await t.audit({
      actor: "operator",
      action: "canary.start",
      input: { tenantId, policyId: policy.id, requestedPct: pct, appliedPct: clamped },
      decision: clamped < pct ? `clamped to ${MAX_CANARY_PCT}% (canary cap)` : "started",
      reversalPath: "POST /api/canary/stop",
    });
  });
  return cfg;
}
export async function stopCanary(store: RuntimeStatePort, tenantId: string): Promise<CanaryConfig> {
  const cfg: CanaryConfig = { enabled: false, pct: 0, policy: (await canaryConfig(store, tenantId))?.policy ?? DEFAULT_CANARY };
  // Clear + audit under THIS tenant only — a rollback for one merchant never touches another's canary.
  await store.tx({ tenantId }, async (t) => {
    await t.put(CANARY, CONFIG_KEY, cfg);
    await t.audit({ actor: "operator", action: "canary.stop", input: { tenantId }, decision: "rolled back to champion", reversalPath: "POST /api/canary/start" });
  });
  return cfg;
}

/** Per-policy live counts + escalation rate from THIS tenant's real traffic log. */
export async function canaryStats(store: RuntimeStatePort, tenantId: string): Promise<Record<string, { count: number; escalationRate: number }>> {
  const by: Record<string, { count: number; esc: number }> = {};
  for (const e of await readTrafficLog(store, tenantId)) {
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
export async function shadowEvaluate(store: RuntimeStatePort, model: ModelPort, judge: JudgePort, tenantId: string, canaryPolicy: Policy, sampleN = 8) {
  const champ = (await readTrafficLog(store, tenantId)).filter((e) => e.servedBy === DEFAULT_POLICY.id && e.message.trim().length > 2);
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
