import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StorePort } from "@palup/platform-ports";

// Durable JSON-file store. One file per key under `dir` (default .palup-state/). Real disk writes —
// state survives process restarts, which is what makes the improvement timeline a real record and not
// an in-memory demo. Swap for a Postgres adapter later behind the same StorePort.
export class FileStore implements StorePort {
  constructor(private readonly dir = ".palup-state") {}

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  }
  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
  }

  async read<T>(key: string): Promise<T | null> {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    return JSON.parse(await readFile(p, "utf8")) as T;
  }
  async write<T>(key: string, value: T): Promise<void> {
    await this.ensureDir();
    await writeFile(this.path(key), JSON.stringify(value, null, 2));
  }
  async append<T>(key: string, entry: T): Promise<number> {
    const log = await this.readLog<T>(key);
    log.push(entry);
    await this.write(key, log);
    return log.length;
  }
  async readLog<T>(key: string): Promise<T[]> {
    return (await this.read<T[]>(key)) ?? [];
  }
}

// In-memory store for tests (same contract, no disk).
export class MemoryStore implements StorePort {
  private readonly docs = new Map<string, unknown>();
  async read<T>(key: string): Promise<T | null> {
    return (this.docs.get(key) as T) ?? null;
  }
  async write<T>(key: string, value: T): Promise<void> {
    this.docs.set(key, structuredClone(value));
  }
  async append<T>(key: string, entry: T): Promise<number> {
    const log = (await this.read<T[]>(key)) ?? [];
    log.push(entry);
    await this.write(key, log);
    return log.length;
  }
  async readLog<T>(key: string): Promise<T[]> {
    return (await this.read<T[]>(key)) ?? [];
  }
}
