import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "@palup/widget-brain";

// Canary traffic split + traffic logging (the run-time half of shadow/canary). The control plane
// WRITES .palup-state/canary-config.json (start a canary / roll it back) and READS the traffic log;
// the backend READS the config per request (so a rollback takes effect live) and appends every served
// interaction to the log. Shared-file coordination is fine for local/staging; production would put
// both behind a shared StorePort (Postgres) — the same interface, a different adapter (ADR-0004).

const STATE_DIR = ".palup-state";
const CONFIG = join(STATE_DIR, "canary-config.json");
const LOG = join(STATE_DIR, "traffic-log.jsonl");

export interface CanaryConfig {
  enabled: boolean;
  pct: number; // 0..100 of sessions served by the canary policy
  policy: Policy;
}

// Stable per-session bucket 0..99 — a session always lands the same side of the split (sticky), so a
// shopper never flips policy mid-conversation.
export function bucket(sessionId: string): number {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

let cache: { at: number; cfg: CanaryConfig | null } = { at: 0, cfg: null };
export function readCanaryConfig(now = Date.now()): CanaryConfig | null {
  if (now - cache.at < 3000) return cache.cfg; // 3s cache — control plane can flip it (rollback) live
  let cfg: CanaryConfig | null = null;
  try {
    if (existsSync(CONFIG)) cfg = JSON.parse(readFileSync(CONFIG, "utf8")) as CanaryConfig;
  } catch {
    cfg = null;
  }
  cache = { at: now, cfg };
  return cfg;
}

/** The canary config if this session should be served by the canary, else null (→ champion). */
export function assignCanary(sessionId: string): CanaryConfig | null {
  const cfg = readCanaryConfig();
  if (!cfg?.enabled || cfg.pct <= 0) return null;
  return bucket(sessionId) < cfg.pct ? cfg : null;
}

export function logTraffic(entry: Record<string, unknown>): void {
  // Logging must never break serving.
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* ignore */
  }
}
