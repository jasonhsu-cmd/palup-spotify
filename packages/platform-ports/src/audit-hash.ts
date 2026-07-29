import { createHash } from "node:crypto";
import type { AuditRecord } from "./runtime-state-port.js";

// Shared audit-hash logic so EVERY RuntimeStatePort adapter (in-memory, Postgres, …) produces the
// identical sha256 for the same record. This keeps a tenant's audit chain verifiable even if its
// backing engine is migrated (ADR-0004), and is the behavioral oracle the contract relies on.

/** Stable, recursively key-sorted JSON so the hash is independent of object key insertion order. */
export function canonicalize(value: unknown): string {
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

/** sha256 over the canonicalized record body (everything except the `hash` field itself). */
export function hashAuditBase(base: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(canonicalize(base)).digest("hex");
}
