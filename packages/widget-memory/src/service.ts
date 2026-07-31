import { randomUUID } from "node:crypto";
import type { RuntimeStatePort, VectorPort, VectorRecord } from "@palup/platform-ports";
import { isMemoryEnabled } from "./flag.js";
import { subjectNamespace } from "./identity.js";
import { decideMemoryWrite } from "./consent.js";
import { classifyFact, type FactClass } from "./classifier.js";
import { sanitizeFact, type FactDistiller } from "./distiller.js";
import { buildMemoryAudit } from "./audit.js";
import { ttlForClass } from "./retention.js";
import type { MemoryCtx, MemoryService, MemoryTurn, RecalledFact, FactMetadata } from "./types.js";

// ADR-0015 PR A (T7): wires flag -> consent -> classifier -> distiller -> VectorPort + audit. The
// double gate (flag.ts) is the outermost check on BOTH methods — when off, neither method touches the
// vector port or the audit log at all (not even a read), so shipping this package changes NOTHING on
// the /chat path until a later, explicitly-gated PR wires it in and flips the flag.

// ADR-0015 Inv 4/9 TTL day-counts (ORDINARY_TTL_DAYS / SPECIAL_TTL_DAYS) now live in retention.ts (T8) —
// the single source of truth, so this module and the retention/sweep module can never drift apart.

// A generous per-subject cap on how many facts `recall` retrieves in one call. The vector port has no
// native "list all" op; querying with an empty text scores every record 0 (tie) and returns them in
// stable id order up to `k`, which is exactly "give me everything for this subject" for the modest
// per-subject fact counts this system deals in.
const RECALL_LIMIT = 500;

export interface MemoryServiceDeps {
  vector: VectorPort;
  /** The RuntimeStatePort's audit surface (ADR-0015 Inv 6) — reused as-is, no new audit mechanism. */
  audit: RuntimeStatePort;
  distiller: FactDistiller;
  /** Override for tests; defaults to the real `classifyFact`. */
  classifier?: typeof classifyFact;
  /** Override for deterministic TTL tests; defaults to `() => new Date()`. */
  clock?: () => Date;
  /** TEST SEAM ONLY — honored solely under the test runner (see createMemoryService). In production the
   * flag.ts double gate is authoritative and this field is IGNORED, so no caller can enable memory by
   * config (NN#1). Defaults to `isMemoryEnabled()`. */
  enabled?: boolean;
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const classify = deps.classifier ?? classifyFact;
  const clock = deps.clock ?? (() => new Date());
  // The `deps.enabled` override is a test seam so the live path can be exercised without flipping
  // MEMORY_ADR_ACCEPTED. It is honored ONLY under a test runner; in production the double gate
  // (isMemoryEnabled) is authoritative, so a config value can never turn this package on (NN#1 — this
  // preserves flag.ts's "no caller can flip this on by config alone" guarantee by construction).
  const underTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const enabled = underTest ? (deps.enabled ?? isMemoryEnabled()) : isMemoryEnabled();

  async function remember(ctx: MemoryCtx, turn: MemoryTurn): Promise<{ written: FactClass[] }> {
    if (!enabled) return { written: [] }; // INERT — no vector call, no audit, nothing touched

    const capability = decideMemoryWrite({ region: ctx.region, consent1: ctx.consent1, consent2: ctx.consent2 });
    const candidates = await deps.distiller.distill(turn);
    const namespace = subjectNamespace(ctx.tenantId, ctx.anonId);
    const now = clock().getTime();

    const written: FactClass[] = [];
    const ordinaryRecords: VectorRecord[] = [];
    const specialRecords: VectorRecord[] = [];

    for (const rawCandidate of candidates) {
      const sanitized = sanitizeFact(rawCandidate);
      if (!sanitized) continue; // Inv 1: never a raw transcript / un-redacted PII

      const { class: factClass, remember: shouldRemember } = classify(sanitized, ctx.tenantPolicy);
      if (!shouldRemember) continue; // tenant policy narrowed this category out (Inv 11)

      const mayWrite = factClass === "special" ? capability.mayWriteSpecial : capability.mayWriteOrdinary;
      if (!mayWrite) continue; // consent gate (Inv 3 / Inv 9)

      const metadata: FactMetadata = {
        text: sanitized,
        class: factClass,
        expiresAt: new Date(now + ttlForClass(factClass)).toISOString(),
      };
      const record: VectorRecord = { id: randomUUID(), text: sanitized, metadata };
      written.push(factClass);
      (factClass === "special" ? specialRecords : ordinaryRecords).push(record);
    }

    if (ordinaryRecords.length > 0) {
      await deps.vector.upsert(namespace, ordinaryRecords);
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({
          action: "write.ordinary",
          tenantId: ctx.tenantId,
          anonId: ctx.anonId,
          factClass: "ordinary",
          count: ordinaryRecords.length,
        }),
      );
    }
    if (specialRecords.length > 0) {
      await deps.vector.upsert(namespace, specialRecords);
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({
          action: "write.special",
          tenantId: ctx.tenantId,
          anonId: ctx.anonId,
          factClass: "special",
          count: specialRecords.length,
        }),
      );
    }

    return { written };
  }

  async function recall(ctx: MemoryCtx): Promise<RecalledFact[]> {
    if (!enabled) return []; // INERT — no vector call, no audit, nothing touched

    const namespace = subjectNamespace(ctx.tenantId, ctx.anonId);
    const now = clock().getTime();
    const matches = await deps.vector.query(namespace, { text: "", k: RECALL_LIMIT });

    const facts: RecalledFact[] = [];
    for (const match of matches) {
      const meta = match.metadata as Partial<FactMetadata> | undefined;
      if (!meta?.text || !meta.class) continue;
      if (meta.expiresAt && new Date(meta.expiresAt).getTime() <= now) continue; // TTL-on-read (Inv 4)
      facts.push({ text: meta.text, class: meta.class });
    }

    await deps.audit.audit(
      { tenantId: ctx.tenantId },
      buildMemoryAudit({ action: "recall", tenantId: ctx.tenantId, anonId: ctx.anonId, count: facts.length }),
    );

    return facts;
  }

  return { remember, recall };
}
