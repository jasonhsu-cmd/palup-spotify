import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Run-time operator Kill Switch (governance non-negotiable #4: "the Kill Switch must always work").
//
// This is the RUN-TIME plane control — it halts the live shopper agent. It is DISTINCT from the
// build-time evolution kill switch (packages/evolution/src/engine.ts + control-plane /api/kill), which
// only halts candidate promotions. A scope may be global, one tenant, or one agent-type (NN #4).
//
// TRUST BOUNDARY (the whole point of this module): the armed state is sourced HERE, server-side, from
// an operator-written registry — NEVER from the shopper's request. The widget backend strips any
// client-supplied `kill` and consults this registry instead, so a shopper can neither arm nor bypass
// the operator kill. The control plane WRITES the registry (operator action, see
// control-plane/src/runtime-kill.ts — keep the JSON shape in sync); the backend READS it per request
// so an operator halt takes effect live. Shared-file coordination matches the canary pattern; a
// production deployment puts this behind a shared StorePort (Postgres) — same shape, different adapter
// (ADR-0004).

const STATE_DIR = ".palup-state";
const REGISTRY = join(STATE_DIR, "kill-switch.json");

/** A kill scope: everything, one tenant, or one agent-type. Global outranks the narrower scopes. */
export type KillScope = "global" | `tenant:${string}` | `agent:${string}`;
export interface KillEntry {
  scope: KillScope;
  reason: string;
  /** ISO timestamp the kill was armed. */
  at: string;
}
export interface KillRegistry {
  scopes: KillEntry[];
}

function readFromDisk(): KillRegistry {
  try {
    if (existsSync(REGISTRY)) {
      const reg = JSON.parse(readFileSync(REGISTRY, "utf8")) as KillRegistry;
      if (reg && Array.isArray(reg.scopes)) return reg;
    }
  } catch {
    /* a malformed/absent registry must fail OPEN to "not killed" for reads, but writes rebuild it */
  }
  return { scopes: [] };
}

let cache: { at: number; reg: KillRegistry } = { at: 0, reg: { scopes: [] } };

/** Read the registry with a short TTL cache so an operator kill in ANOTHER process is seen within ~2s. */
export function readKillRegistry(now = Date.now()): KillRegistry {
  if (cache.at !== 0 && now - cache.at < 2000) return cache.reg;
  const reg = readFromDisk();
  cache = { at: now, reg };
  return reg;
}

/**
 * The matching kill entry for this agent, or null if it is not halted. Precedence: global > tenant >
 * agent-type — a global kill halts everything regardless of the narrower scopes.
 */
export function matchedKill(
  id: { tenantId?: string; agentType?: string },
  now = Date.now(),
): KillEntry | null {
  const reg = readKillRegistry(now);
  const wants: KillScope[] = ["global"];
  if (id.tenantId) wants.push(`tenant:${id.tenantId}`);
  if (id.agentType) wants.push(`agent:${id.agentType}`);
  for (const w of wants) {
    const hit = reg.scopes.find((s) => s.scope === w);
    if (hit) return hit;
  }
  return null;
}

function write(reg: KillRegistry): KillRegistry {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  cache = { at: 0, reg }; // at:0 forces the next read to re-hit disk (same-process bust; cross-process uses the TTL)
  return reg;
}

/** Operator action: arm the kill for a scope (idempotent — refreshes reason/at if already armed). */
export function armKill(scope: KillScope, reason = "operator", at = new Date().toISOString()): KillRegistry {
  const reg = readFromDisk();
  return write({ scopes: [...reg.scopes.filter((s) => s.scope !== scope), { scope, reason, at }] });
}

/** Operator action: disarm one scope, or clear the whole registry when scope is omitted. */
export function disarmKill(scope?: KillScope): KillRegistry {
  const reg = readFromDisk();
  return write({ scopes: scope ? reg.scopes.filter((s) => s.scope !== scope) : [] });
}
