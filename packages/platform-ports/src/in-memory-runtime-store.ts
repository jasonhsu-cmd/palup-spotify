import { createHash } from "node:crypto";
import {
  AUDIT_GENESIS_HASH,
  type AuditInput,
  type AuditRecord,
  type RuntimeStateCtx,
  type RuntimeStatePort,
  type RuntimeStateTx,
} from "./runtime-state-port.js";

// In-memory reference adapter for RuntimeStatePort. It is the DEV/TEST implementation and the
// behavioral oracle for the contract suite — the Postgres adapter must match it. It is single-process
// (a Map), so it does NOT provide cross-instance durability; that is the Postgres adapter's job. All
// values are deep-cloned in and out so callers can't mutate stored state by reference.

/** Stable, key-sorted JSON so the audit hash is deterministic regardless of insertion order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {} as Record<string, unknown>);
    }
    return v;
  });
}

function hashRecord(r: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(canonical(r)).digest("hex");
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

interface TenantData {
  kv: Map<string, Map<string, unknown>>; // collection -> key -> value
  streams: Map<string, unknown[]>; // stream -> entries
  audit: AuditRecord[];
}

function emptyTenant(): TenantData {
  return { kv: new Map(), streams: new Map(), audit: [] };
}

function snapshot(t: TenantData): TenantData {
  return {
    kv: new Map(Array.from(t.kv, ([c, m]) => [c, new Map(m)])),
    streams: new Map(Array.from(t.streams, ([s, a]) => [s, [...a]])),
    audit: [...t.audit],
  };
}

export class InMemoryRuntimeStore implements RuntimeStatePort {
  private tenants = new Map<string, TenantData>();

  private data(tenantId: string): TenantData {
    if (!tenantId) throw new Error("RuntimeStatePort: tenantId is required (tenant isolation)");
    let t = this.tenants.get(tenantId);
    if (!t) {
      t = emptyTenant();
      this.tenants.set(tenantId, t);
    }
    return t;
  }

  async get<T>(ctx: RuntimeStateCtx, collection: string, key: string): Promise<T | null> {
    const v = this.data(ctx.tenantId).kv.get(collection)?.get(key);
    return v === undefined ? null : clone(v as T);
  }

  async put<T>(ctx: RuntimeStateCtx, collection: string, key: string, value: T): Promise<void> {
    const t = this.data(ctx.tenantId);
    let m = t.kv.get(collection);
    if (!m) {
      m = new Map();
      t.kv.set(collection, m);
    }
    m.set(key, clone(value));
  }

  async delete(ctx: RuntimeStateCtx, collection: string, key: string): Promise<void> {
    this.data(ctx.tenantId).kv.get(collection)?.delete(key);
  }

  async list<T>(ctx: RuntimeStateCtx, collection: string): Promise<Array<{ key: string; value: T }>> {
    const m = this.data(ctx.tenantId).kv.get(collection);
    if (!m) return [];
    return Array.from(m, ([key, value]) => ({ key, value: clone(value as T) }));
  }

  async append<T>(ctx: RuntimeStateCtx, stream: string, entry: T): Promise<number> {
    const t = this.data(ctx.tenantId);
    let s = t.streams.get(stream);
    if (!s) {
      s = [];
      t.streams.set(stream, s);
    }
    s.push(clone(entry));
    return s.length;
  }

  async readStream<T>(ctx: RuntimeStateCtx, stream: string, opts?: { limit?: number }): Promise<T[]> {
    const s = this.data(ctx.tenantId).streams.get(stream) ?? [];
    const out = opts?.limit != null ? s.slice(Math.max(0, s.length - opts.limit)) : s;
    return out.map((e) => clone(e as T));
  }

  private commitAudit(t: TenantData, entry: AuditInput, at: string): AuditRecord {
    const prevHash = t.audit.length ? t.audit[t.audit.length - 1].hash : AUDIT_GENESIS_HASH;
    const base: Omit<AuditRecord, "hash"> = {
      seq: t.audit.length + 1,
      at,
      actor: entry.actor,
      action: entry.action,
      input: entry.input,
      decision: entry.decision,
      reversalPath: entry.reversalPath,
      prevHash,
    };
    const rec: AuditRecord = { ...base, hash: hashRecord(base) };
    t.audit.push(rec);
    return clone(rec);
  }

  async audit(ctx: RuntimeStateCtx, entry: AuditInput, at = new Date().toISOString()): Promise<AuditRecord> {
    return this.commitAudit(this.data(ctx.tenantId), entry, at);
  }

  async readAudit(ctx: RuntimeStateCtx, opts?: { limit?: number }): Promise<AuditRecord[]> {
    const a = this.data(ctx.tenantId).audit;
    const out = opts?.limit != null ? a.slice(Math.max(0, a.length - opts.limit)) : a;
    return out.map((r) => clone(r));
  }

  async verifyAudit(ctx: RuntimeStateCtx): Promise<{ ok: boolean; brokenAt?: number }> {
    const a = this.data(ctx.tenantId).audit;
    let prev = AUDIT_GENESIS_HASH;
    for (const r of a) {
      const { hash, ...base } = r;
      if (r.prevHash !== prev || hashRecord(base) !== hash) return { ok: false, brokenAt: r.seq };
      prev = hash;
    }
    return { ok: true };
  }

  async tx<T>(ctx: RuntimeStateCtx, fn: (t: RuntimeStateTx) => Promise<T>): Promise<T> {
    const t = this.data(ctx.tenantId);
    const backup = snapshot(t);
    const handle: RuntimeStateTx = {
      put: (collection, key, value) => this.put(ctx, collection, key, value),
      delete: (collection, key) => this.delete(ctx, collection, key),
      append: (stream, entry) => this.append(ctx, stream, entry),
      audit: (entry, at = new Date().toISOString()) => Promise.resolve(this.commitAudit(t, entry, at)),
    };
    try {
      return await fn(handle);
    } catch (e) {
      // Roll back every mutation made in this tx (atomicity for action + its audit record).
      t.kv = backup.kv;
      t.streams = backup.streams;
      t.audit = backup.audit;
      throw e;
    }
  }
}
