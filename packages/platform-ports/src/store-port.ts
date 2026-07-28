// Store port (ADR-0001): durable state for the self-improvement loop — champion, candidates, the
// audit log, and the improvement timeline. A file-backed adapter backs it now; Postgres later, behind
// the same port. Feature code never touches the filesystem/DB directly.

export interface StorePort {
  /** Read a JSON document by key, or null if absent. */
  read<T>(key: string): Promise<T | null>;
  /** Write (overwrite) a JSON document by key. */
  write<T>(key: string, value: T): Promise<void>;
  /** Append one entry to an append-only log (creates it if absent). Returns the new length. */
  append<T>(key: string, entry: T): Promise<number>;
  /** Read the full append-only log (empty array if absent). */
  readLog<T>(key: string): Promise<T[]>;
}
