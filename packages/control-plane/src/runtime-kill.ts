import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Operator WRITE side of the RUN-TIME Kill Switch (governance non-negotiable #4). The widget backend
// READS this registry per request (packages/widget-backend/src/kill-switch.ts) and halts the live
// shopper agent for any armed scope — KEEP THE JSON SHAPE IN SYNC with that module.
//
// This is the RUN-TIME plane (halts the live agent). It is distinct from engine.kill() / the
// /api/kill route, which halt build-time candidate PROMOTIONS. The two must not be conflated: an
// operator can pause the live product without touching the evolution pipeline, and vice-versa.
//
// Shared-file coordination (.palup-state) matches the canary controller; production swaps in a shared
// StorePort (ADR-0004) behind the same shape.

const DIR = ".palup-state";
const REGISTRY = join(DIR, "kill-switch.json");

export type KillScope = "global" | `tenant:${string}` | `agent:${string}`;
export interface KillEntry {
  scope: KillScope;
  reason: string;
  at: string;
}
export interface KillRegistry {
  scopes: KillEntry[];
}

function read(): KillRegistry {
  try {
    if (existsSync(REGISTRY)) {
      const r = JSON.parse(readFileSync(REGISTRY, "utf8")) as KillRegistry;
      if (r && Array.isArray(r.scopes)) return r;
    }
  } catch {
    /* ignore — rebuilt on next write */
  }
  return { scopes: [] };
}

function write(reg: KillRegistry): KillRegistry {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  return reg;
}

/** Current armed scopes (operator dashboard reads this). */
export function killStatus(): KillRegistry {
  return read();
}

/** Operator action: arm the run-time kill for a scope (idempotent). */
export function armRuntimeKill(scope: KillScope, reason = "operator"): KillRegistry {
  const reg = read();
  return write({
    scopes: [...reg.scopes.filter((s) => s.scope !== scope), { scope, reason, at: new Date().toISOString() }],
  });
}

/** Operator action: disarm one scope, or clear all when scope is omitted. */
export function disarmRuntimeKill(scope?: KillScope): KillRegistry {
  const reg = read();
  return write({ scopes: scope ? reg.scopes.filter((s) => s.scope !== scope) : [] });
}
