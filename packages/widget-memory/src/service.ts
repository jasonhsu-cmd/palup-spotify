import { randomUUID } from "node:crypto";
import type { RuntimeStatePort, VectorPort, VectorRecord, ModelPort, CryptoPort, SecretsPort } from "@palup/platform-ports";
import { createAesGcmCrypto, createEnvSecrets } from "@palup/platform-ports";
import { isMemoryEnabled } from "./flag.js";
import { subjectNamespace } from "./identity.js";
import { decideMemoryWrite } from "./consent.js";
import { classifyFact, type FactClass } from "./classifier.js";
import { sanitizeFact, createStubDistiller, createModelDistiller, isValidDisposition, type FactDistiller } from "./distiller.js";
import type { Disposition } from "./disposition.js";
import { buildMemoryAudit } from "./audit.js";
import { ttlForClass, RENEW_MIN_GAP_MS } from "./retention.js";
import type { MemoryCtx, MemoryService, MemoryTurn, RecalledFact, FactMetadata } from "./types.js";

// ADR-0015 PR A (T7): wires flag -> consent -> classifier -> distiller -> VectorPort + audit. The
// double gate (flag.ts) is the outermost check on BOTH methods — when off, neither method touches the
// vector port or the audit log at all (not even a read), so shipping this package changes NOTHING on
// the /chat path until a later, explicitly-gated PR wires it in and flips the flag.

// ADR-0015 Inv 4/9 TTL day-counts (ORDINARY_TTL_DAYS / SPECIAL_TTL_DAYS) now live in retention.ts (T8) —
// the single source of truth, so this module and the retention/sweep module can never drift apart.

// GO-LIVE #2 — ENCRYPTION AT REST FOR SPECIAL-CATEGORY FACTS (ADR-0015 Inv 9). Encryption happens HERE,
// at the SERVICE layer, not inside any one `VectorPort` adapter — so ciphertext is the ONLY thing any
// adapter (the in-memory dev store, the durable Postgres adapter, a future cloud vector DB) ever sees.
// This is adapter-agnostic defense in depth: swapping the vector port never changes what protection a
// special-category fact gets, and it closes the durable Postgres adapter's tracked plaintext gap (see
// its own file header) WITHOUT that adapter needing to know anything about sensitivity classes at all.
//
// FAIL-CLOSED vs BEST-EFFORT (a deliberate, asymmetric trade-off — see `encryptOrRefuse` below):
//   - SPECIAL-CATEGORY candidates are encrypted FAIL-CLOSED: if no key is configured for this tenant
//     (`crypto.encrypt` throws), the candidate is REFUSED — dropped exactly like any other gate above it
//     (`mayWrite`/`shouldRemember`/disposition validation) — NEVER persisted in the clear. This is the
//     Inv 9 requirement: "special-category facts... stricter storage (encryption...)".
//   - ORDINARY candidates are encrypted BEST-EFFORT: the SAME encryption is attempted (defense in depth
//     costs nothing extra once a key exists), but if no key is configured the candidate falls back to
//     PLAINTEXT rather than being refused. Inv 9 only mandates encryption for special-category data;
//     making ordinary memory depend on a key too would be a new, unrequired operational dependency —
//     today ordinary memory needs zero configuration to work, and this preserves that. The trade-off is
//     explicit: an unconfigured deployment gets ordinary memory in the clear (identical to before this
//     PR) and NO special-category memory at all (refused, not degraded) until a key is provisioned.
//
// SIMILARITY-SEARCH TRADE-OFF (also deliberate, matching the durable Postgres adapter's own honesty
// note): encrypting `VectorRecord.text` (the port's own top-level field, not just `metadata.text`) means
// a GENUINE non-empty-text similarity query against an encrypted record can no longer score it
// meaningfully (`scoreRecord`'s lexical Jaccard operates on whatever string is in `text` — ciphertext
// tokens never overlap a plaintext query's tokens). This is ACCEPTABLE and already true of this system
// today: the ONLY real caller pattern is `query(namespace, {text: "", k: RECALL_LIMIT})` — the
// "list everything for this subject" idiom (see `RECALL_LIMIT`'s own note below) — and an EMPTY query
// string ties every record at score 0 regardless of whether `text` is plaintext or ciphertext (Jaccard
// over an empty token set is 0 either way), so list-all recall is byte-for-byte unaffected. A future
// genuinely-semantic similarity search over special-category facts would need to embed BEFORE encrypting
// (a `vector` field, scored separately from `text`) — out of scope here, not silently precluded.
//
// `encrypted` (types.ts `FactMetadata.encrypted`) records exactly which outcome happened for THIS
// record, so `recall` never has to guess from the string's shape whether to decrypt.

// A generous per-subject cap on how many facts `recall` retrieves in one call. The vector port has no
// native "list all" op; querying with an empty text scores every record 0 (tie) and returns them in
// stable id order up to `k`, which is exactly "give me everything for this subject" for the modest
// per-subject fact counts this system deals in.
const RECALL_LIMIT = 500;

interface EncryptedField {
  value: string;
  encrypted: boolean;
}

/**
 * Encrypts one piece of shopper-authored text with the asymmetric contract documented in the module
 * header: FAIL CLOSED for special-category text (a missing/unconfigured key means `undefined` — the
 * caller MUST refuse/drop the whole candidate, never persist a partial value) and BEST EFFORT for
 * ordinary text (falls back to the plaintext input unchanged). Never throws — any `crypto.encrypt`
 * failure (no key configured, or any other adapter error) is caught here so a candidate is refused
 * cleanly rather than the whole `remember()` call blowing up mid-batch.
 */
async function encryptOrRefuse(
  crypto: CryptoPort,
  tenantId: string,
  factClass: FactClass,
  plaintext: string,
): Promise<EncryptedField | undefined> {
  try {
    return { value: await crypto.encrypt(tenantId, plaintext), encrypted: true };
  } catch {
    if (factClass === "special") return undefined; // fail closed (Inv 9) — refuse rather than persist plaintext
    return { value: plaintext, encrypted: false }; // ordinary best-effort fallback — see module header
  }
}

export interface MemoryServiceDeps {
  vector: VectorPort;
  /** The RuntimeStatePort's audit surface (ADR-0015 Inv 6) — reused as-is, no new audit mechanism. */
  audit: RuntimeStatePort;
  /** The extractor to use. Optional: if omitted, one is derived from `model` (a governed, model-backed
   * `createModelDistiller` — ADR-0015 Inv 11, PR-6) or, failing that, `createStubDistiller()` (the
   * offline passthrough placeholder). Supplying `distiller` directly always wins over `model`. */
  distiller?: FactDistiller;
  /** `ModelPort` backing a real extractor when `distiller` isn't supplied directly (ADR-0001: feature
   * code never touches a provider SDK). Threaded here so a caller can hand the service a model instead
   * of constructing `createModelDistiller` itself. Still fully inert: unreachable while the flag.ts
   * double gate is off — `remember()` returns before `distiller.distill()` (hence `model.complete()`)
   * ever runs. */
  model?: ModelPort;
  /** Override for tests; defaults to the real `classifyFact`. */
  classifier?: typeof classifyFact;
  /** Override for deterministic TTL tests; defaults to `() => new Date()`. */
  clock?: () => Date;
  /** TEST SEAM ONLY — honored solely under the test runner (see createMemoryService). In production the
   * flag.ts double gate is authoritative and this field is IGNORED, so no caller can enable memory by
   * config (NN#1). Defaults to `isMemoryEnabled()`. */
  enabled?: boolean;
  /** `SecretsPort` backing the DEFAULT `CryptoPort` (ADR-0015 Inv 9 — encryption-at-rest). Optional:
   * defaults to `createEnvSecrets()` (reads `PALUP_SECRETS`), mirroring how `distiller` is derived from
   * `model` when omitted. Ignored entirely when `crypto` is supplied directly. */
  secrets?: SecretsPort;
  /** `CryptoPort` used to encrypt/decrypt fact text + `disposition[].sourceQuote` at rest (ADR-0015 Inv
   * 9). Optional: defaults to `createAesGcmCrypto(secrets)`. Overriding this directly is the test seam
   * for exercising specific key-present/absent scenarios without touching env vars — supplying it always
   * wins over `secrets`. */
  crypto?: CryptoPort;
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const classify = deps.classifier ?? classifyFact;
  const clock = deps.clock ?? (() => new Date());
  const distiller = deps.distiller ?? (deps.model ? createModelDistiller({ model: deps.model }) : createStubDistiller());
  // ADR-0015 Inv 9 — encryption-at-rest. Mirrors `distiller`'s own derivation pattern: an explicit
  // `crypto` always wins; otherwise derive one from `secrets` (defaulting THAT to `createEnvSecrets()`,
  // i.e. `PALUP_SECRETS`) via the local AES-256-GCM adapter. A cloud-KMS adapter swaps in later by
  // passing `crypto` directly — this module never constructs a vendor SDK itself (ADR-0001).
  const secrets = deps.secrets ?? createEnvSecrets();
  const crypto = deps.crypto ?? createAesGcmCrypto(secrets);
  // The `deps.enabled` override is a test seam so the live path can be exercised without flipping
  // MEMORY_ADR_ACCEPTED. It is honored ONLY under a test runner; in production the double gate
  // (isMemoryEnabled) is authoritative, so a config value can never turn this package on (NN#1 — this
  // preserves flag.ts's "no caller can flip this on by config alone" guarantee by construction).
  const underTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const enabled = underTest ? (deps.enabled ?? isMemoryEnabled()) : isMemoryEnabled();

  async function remember(ctx: MemoryCtx, turn: MemoryTurn): Promise<{ written: FactClass[] }> {
    if (!enabled) return { written: [] }; // INERT — no vector call, no audit, nothing touched

    const capability = decideMemoryWrite({ region: ctx.region, consent1: ctx.consent1, consent2: ctx.consent2 });
    const candidates = await distiller.distill(turn);
    const namespace = subjectNamespace(ctx.tenantId, ctx.anonId);
    const now = clock().getTime();

    const written: FactClass[] = [];
    const ordinaryRecords: VectorRecord[] = [];
    const specialRecords: VectorRecord[] = [];

    for (const rawCandidate of candidates) {
      const sanitized = sanitizeFact(rawCandidate.text);
      if (!sanitized) continue; // Inv 1: never a raw transcript / un-redacted PII

      const { class: factClass, remember: shouldRemember } = classify(sanitized, ctx.tenantPolicy);
      if (!shouldRemember) continue; // tenant policy narrowed this category out (Inv 11)

      const mayWrite = factClass === "special" ? capability.mayWriteSpecial : capability.mayWriteOrdinary;
      if (!mayWrite) continue; // consent gate (Inv 3 / Inv 9)

      // PR-8 — surface the validated disposition alongside the fact (previously discarded by the
      // distiller). Re-validated HERE with the SAME `isValidDisposition` (reject-in-full, no "inferred"
      // provenance) regardless of which `FactDistiller` produced it — defense-in-depth at the actual
      // persistence boundary, not just inside `createModelDistiller`: an invalid disposition rejects the
      // WHOLE candidate (mirrors createModelDistiller's own reject-in-full rule), not just the
      // disposition field, so a distiller that skipped its own validation can never smuggle a tainted
      // disposition through by attaching it to an otherwise-fine fact.
      const rawDisposition = rawCandidate.disposition;
      if (rawDisposition !== undefined && !isValidDisposition(rawDisposition)) continue;

      // ADR-0015 Inv 9 — encrypt (or, for special-category with no key, REFUSE) before this fact ever
      // reaches a VectorRecord — see the module-header note for the full fail-closed/best-effort
      // contract. This must happen BEFORE building `metadata`/`record` below: nothing downstream of this
      // line may ever see the plaintext of a special-category fact whose encryption was refused, because
      // refusal means `continue` — the candidate never becomes a record at all.
      const encryptedFact = await encryptOrRefuse(crypto, ctx.tenantId, factClass, sanitized);
      if (!encryptedFact) continue; // special-category write refused — no key configured for this tenant

      // `sourceQuote` is a short span of the shopper's OWN words, so it gets the SAME redaction+cap
      // treatment as the fact text itself (`sanitizeFact`) rather than being trusted as distinct from any
      // other free text; a bad/blank quote is simply dropped (undefined), never rejects the candidate.
      // It then gets the SAME protection level the fact text itself just received (`encryptedFact.
      // encrypted`) — covering every place health-adjacent shopper text can land, not just `text`.
      const sanitizedQuote = rawDisposition?.sourceQuote ? sanitizeFact(rawDisposition.sourceQuote) : null;
      const disposition: Disposition[] | undefined = rawDisposition
        ? [{
            ...rawDisposition,
            sourceQuote: sanitizedQuote
              ? (encryptedFact.encrypted ? await crypto.encrypt(ctx.tenantId, sanitizedQuote) : sanitizedQuote)
              : undefined,
          }]
        : undefined;

      const metadata: FactMetadata = {
        text: encryptedFact.value,
        class: factClass,
        expiresAt: new Date(now + ttlForClass(factClass)).toISOString(),
        disposition,
        encrypted: encryptedFact.encrypted,
      };
      // The vector record's OWN `text` field is encrypted identically to `metadata.text` (same value) —
      // see the module-header "similarity-search trade-off" note for what this costs and why it's fine.
      const record: VectorRecord = { id: randomUUID(), text: encryptedFact.value, metadata };
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
    const renewed: VectorRecord[] = []; // sliding-retention re-stamps (ADR-0015 Inv 4 amendment, 2026-08-04)
    for (const match of matches) {
      const meta = match.metadata as Partial<FactMetadata> | undefined;
      if (!meta?.text || !meta.class) continue;
      const expiresMs = meta.expiresAt ? new Date(meta.expiresAt).getTime() : undefined;
      if (expiresMs !== undefined && expiresMs <= now) continue; // TTL-on-read (Inv 4): expired ⇒ not served, never renewed

      // ADR-0015 Inv 9 — decrypt on read. `meta.encrypted` is set precisely at WRITE time (never
      // inferred from the string's shape — types.ts's `FactMetadata.encrypted` doc), so a plaintext
      // record (the ordinary no-key fallback, or one seeded directly at the vector-port layer, bypassing
      // `remember()`) is served exactly as stored. A record marked encrypted that fails to decrypt
      // (wrong/rotated/missing key, or genuine corruption) is DROPPED HERE — never surfaced as
      // ciphertext "garbage", and `crypto.decrypt` never throws, so a bad record can never crash the turn.
      let text = meta.text;
      if (meta.encrypted) {
        const decrypted = await crypto.decrypt(ctx.tenantId, meta.text);
        if (decrypted === undefined) continue; // undecryptable — drop the WHOLE record, do not slide its TTL either
        text = decrypted;
      }
      // Each disposition's `sourceQuote` decrypts independently: an undecryptable QUOTE drops just the
      // quote (the fact's own `text` above already decrypted fine, so the fact itself is still safe and
      // useful to serve) — it does not drop the whole record the way an undecryptable fact `text` does.
      let disposition = meta.disposition;
      if (meta.encrypted && disposition) {
        disposition = await Promise.all(
          disposition.map(async (d) => (d.sourceQuote ? { ...d, sourceQuote: await crypto.decrypt(ctx.tenantId, d.sourceQuote) } : d)),
        );
      }
      // PR-8 — surface the persisted disposition (previously never written, so never read back either).
      facts.push({ text, class: meta.class, disposition });

      // Sliding retention (ADR-0015 Inv 4: "expire … since last activity"; amendment 2026-08-04). The shopper
      // has RETURNED (this recall), so re-stamp the 30-day window from `now` for facts we may still lawfully
      // hold. Consent-gated per tier EXACTLY like the brain's read-time gate (special⇒consent2, ordinary⇒
      // consent1; only literal "in" renews), so a WITHDRAWN/absent-consent fact is NEVER extended — it keeps
      // its expiry and ages out (or is erased). Throttled to at most once per RENEW_MIN_GAP since the last
      // stamp (a same-session burst neither churns the store nor floods the audit log), and only ever FORWARD.
      const consentIn = meta.class === "special" ? ctx.consent2 === "in" : ctx.consent1 === "in";
      const lastStampedMs = expiresMs !== undefined ? expiresMs - ttlForClass(meta.class) : now;
      if (consentIn && now - lastStampedMs >= RENEW_MIN_GAP_MS) {
        renewed.push({ id: match.id, text: meta.text, metadata: { ...(meta as FactMetadata), expiresAt: new Date(now + ttlForClass(meta.class)).toISOString() } });
      }
    }

    // The retention-EXTENDING write is not silent (ADR-0015 Inv 6): it carries its OWN `ttl_renew` audit
    // (count of facts slid forward), distinct from the read's `recall` audit — whose reversalPath therefore
    // stays truthfully "read-only". So the immutable log shows exactly when, and how many, facts had their
    // retention extended, and by which subject.
    if (renewed.length > 0) {
      await deps.vector.upsert(namespace, renewed);
      await deps.audit.audit(
        { tenantId: ctx.tenantId },
        buildMemoryAudit({ action: "ttl_renew", tenantId: ctx.tenantId, anonId: ctx.anonId, count: renewed.length }),
      );
    }

    await deps.audit.audit(
      { tenantId: ctx.tenantId },
      buildMemoryAudit({ action: "recall", tenantId: ctx.tenantId, anonId: ctx.anonId, count: facts.length }),
    );

    return facts;
  }

  return { remember, recall };
}
