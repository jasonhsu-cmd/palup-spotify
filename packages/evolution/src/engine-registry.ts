import { EvolutionEngine } from "./engine.js";

// Per-tenant EvolutionEngine binding (ADR-0014 #4). The engine holds a tenant's in-memory evolution
// state — champion, candidates, hash-chained audit. The auto-optimize orchestrator (T4) and the
// promote→serving bridge (champion-promoter.ts, precondition H3) must operate on the engine that
// governs THIS tenant; a mismatched (engine, tenant) pair would write one merchant's policy into
// another's serving slot. A single global engine bound to one demo tenant left H3 as a comment.
//
// This registry makes the binding structural: exactly one engine per tenant, created once via an
// injected factory and cached, so a proposal/promotion on tenant A's engine can never touch tenant B's
// state. It holds no state of its own beyond the map; per-tenant durability still lives in the engine's
// own store. Fail-closed on a missing tenantId — there is no ambient/default tenant.
export class EngineRegistry {
  private readonly engines = new Map<string, EvolutionEngine>();

  /** `factory(tenantId)` builds the engine for a tenant on first use (e.g. seeded from that tenant's
   * serving champion). It is called at most once per tenant. */
  constructor(private readonly factory: (tenantId: string) => EvolutionEngine) {}

  /** The engine governing `tenantId`, created on first access and stable thereafter. */
  engineFor(tenantId: string): EvolutionEngine {
    if (!tenantId) throw new Error("engineFor requires a non-empty tenantId (no ambient/default tenant)");
    let engine = this.engines.get(tenantId);
    if (!engine) {
      engine = this.factory(tenantId);
      this.engines.set(tenantId, engine);
    }
    return engine;
  }

  /** Whether an engine has already been bound for `tenantId` (does not create one). */
  has(tenantId: string): boolean {
    return this.engines.has(tenantId);
  }
}
