import { ADMIN_API_VERSION } from "./shopify-install-identity.js";

// Task 3 (durable catalog sync, spec §13.3): the ONLY module that knows Shopify's Admin GraphQL
// rate-limit wire format and the Bulk Operations wire format. This is the sync-plane client the
// catalog backfill job uses — it never crosses a GroundingPort (that stays the Storefront API,
// shopify-grounding.ts); this is a separate, lower-privilege-boundary-but-higher-scope surface used
// ONLY by the offline sync job, never the /chat request path.
//
// Patterns mirrored from shopify-grounding.ts (ADR-0012's established shape for a Shopify adapter):
//   • injectable `fetchFn` defaulting to `globalThis.fetch` (shopify-grounding.ts:356-357)
//   • the `SHOP_HOST` host-allowlist regex, re-declared here (NOT imported — it is a private const
//     in shopify-grounding.ts) and enforced BEFORE the token is ever attached (shopify-grounding.ts:377)
//   • a structured, token-free egress log line, never carrying the credential (shopify-grounding.ts:282-298)
//
// VERIFIED 2026-08-23 (spec Appendix A, cited in task-3-brief.md): the Admin GraphQL cost/throttle
// envelope is reported at `extensions.cost.throttleStatus = { maximumAvailable, currentlyAvailable,
// restoreRate }` on every Admin API response, and a throttled request's `errors[].extensions.code`
// reads `"THROTTLED"`.
//
// NOT LIVE-VERIFIED (see the "Implementation note" in task-3-brief.md, spec §13.3): the exact
// `currentBulkOperation` / `node(id:)` poll field set, the `url` field's expiry window, and the real
// CDN host Shopify serves a completed bulk operation's JSONL result from have NOT been exercised
// against a live bulk run from this repo. `SHOPIFY_BULK_RESULT_HOST` below is pinned CONSERVATIVELY
// (Shopify's own CDN domain plus GCS, since Shopify bulk results have historically been observed
// served from a Google Cloud Storage-backed CDN) and MUST be confirmed against a live bulk operation
// before this client is trusted in production. A host that fails this allowlist is REJECTED, never
// silently dropped — see the `log` call in `downloadJsonl`.

/** Non-secret shop domain + SECRET Admin API access token. Kept local (not `ShopifyStoreCreds` from
 *  merchant-store.ts) because that type names a *Storefront* token; conflating the two credential
 *  kinds under one name would be misleading about scope even though the shape is identical. */
export interface ShopifyAdminCreds {
  /** e.g. "acme-store.myshopify.com" — not a secret. */
  shopDomain: string;
  /** Admin API access token — SECRET, resolved via the SecretsPort by the caller. */
  accessToken: string;
}

/** `extensions.cost.throttleStatus` on every Admin GraphQL response (verified shape, see file banner). */
export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface AdminGraphQLError {
  message?: string;
  extensions?: { code?: string };
}

/** The raw, parsed Admin GraphQL response body. `graphql()` returns this UNWRAPPED (not just `.data`)
 *  so a caller can inspect `errors`/`extensions` itself when it needs to (e.g. `runBulkQuery`). */
export interface AdminResponse<T = unknown> {
  data?: T;
  errors?: AdminGraphQLError[];
  extensions?: { cost?: { throttleStatus?: ThrottleStatus } };
}

export interface BulkStatus {
  /** e.g. "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" (BulkOperationStatus, NOT
   *  live-verified — see file banner). Left as `string` rather than a union so an unfamiliar/future
   *  enum value flows through rather than being rejected at the type level. */
  status?: string;
  /** Present once COMPLETED — the pre-signed result-download URL. NOT live-verified expiry window. */
  url?: string;
  objectCount?: number;
  errorCode?: string;
}

// ── Typed errors (no infinite loop; a caller can branch on `instanceof`) ───────────────────────────

export class ShopifyClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyClientError";
  }
}

/** Thrown when the attempt cap is exhausted while still throttled/5xx — never an infinite retry loop. */
export class ShopifyThrottleError extends ShopifyClientError {
  constructor(
    message: string,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "ShopifyThrottleError";
  }
}

/** Thrown by the SSRF/egress host guards (admin host or bulk-result host). */
export class ShopifySsrfError extends ShopifyClientError {
  constructor(message: string) {
    super(message);
    this.name = "ShopifySsrfError";
  }
}

// The Admin token is sent in a header to `shopDomain`, so refuse any host that isn't a Shopify store
// host BEFORE attaching it — a misconfigured/typo'd domain must never leak the token to an arbitrary
// server (SSRF / credential-exfil defense-in-depth). Re-declared literal (NOT imported) per task
// brief — this module owns its own copy rather than reaching into shopify-grounding.ts's private const.
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

// A completed bulk operation's JSONL result is served from a pre-signed CDN URL, NOT `shopDomain` —
// so it needs its OWN allowlist. Pinned conservatively (see file banner: NOT live-verified) to
// Shopify's own CDN domain plus Google Cloud Storage. `downloadJsonl` requires https AND this host
// match, and logs (never silently drops) a rejected host.
export const SHOPIFY_BULK_RESULT_HOST = /(^|\.)shopifycloud\.com$|(^|\.)storage\.googleapis\.com$/i;

const DEFAULT_MAX_ATTEMPTS = 5;

/** Structured egress log line (token-free by construction — the token is never a field here),
 *  mirroring `StorefrontEgressLog` (shopify-grounding.ts:283-298). */
export interface ShopifyAdminEgressLog {
  host: string;
  status: number;
  ok: boolean;
  ms: number;
  attempt: number;
  /** Set when this attempt was throttled (THROTTLED error code or 429/5xx) and will be retried
   *  (or, on the final attempt, is about to fail). */
  throttled?: boolean;
}

/** Egress log line for a bulk-result download. Token-free (the download never carries a token). */
export interface ShopifyBulkDownloadEgressLog {
  host: string;
  status: number;
  ok: boolean;
  ms: number;
  /** Set ONLY when the host failed the allowlist — `status: 0` = a local decision, no HTTP made. */
  rejectedHost?: boolean;
}

export interface CreateShopifyAdminClientOpts {
  /** Injectable for tests; defaults to global fetch (mirrors `storefrontFetch`, shopify-grounding.ts:356-357). */
  fetchFn?: typeof globalThis.fetch;
  creds: ShopifyAdminCreds;
  /** Admin API version; defaults to the version already pinned for the Admin surface (`ADMIN_API_VERSION`,
   *  shopify-install-identity.ts:120), so both Admin call sites move together. */
  version?: string;
  /** Injectable sleep for tests (`async () => {}` skips the real delay). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Max attempts before throwing `ShopifyThrottleError`. Default 5 — no infinite retry loop. */
  maxAttempts?: number;
  log?: (info: ShopifyAdminEgressLog) => void;
  downloadLog?: (info: ShopifyBulkDownloadEgressLog) => void;
}

export interface ShopifyAdminClient {
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<AdminResponse<T>>;
  runBulkQuery(query: string): Promise<{ id: string }>;
  pollBulk(id: string): Promise<BulkStatus>;
  downloadJsonl(url: string): Promise<string>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True when this response counts as "throttled" for retry purposes: an explicit `THROTTLED` GraphQL
 *  error code, or an HTTP 429/5xx. A non-throttle GraphQL error (bad query, auth failure, etc.) is
 *  NOT retried — retrying a permanent error would just burn the attempt budget on a request that can
 *  never succeed. */
function isThrottled(status: number, body: AdminResponse | undefined): boolean {
  if (status === 429 || status >= 500) return true;
  return Boolean(body?.errors?.some((e) => e.extensions?.code === "THROTTLED"));
}

// Heuristic backoff: `extensions.cost.throttleStatus` gives us `restoreRate` (points/sec) and
// `currentlyAvailable`, but a THROTTLED response does NOT tell us the actual query's point cost. We
// conservatively assume a modest query costs ~50 points (a common ballpark for a simple Admin query
// per shopify.dev's cost documentation — NOT verified this session) and wait long enough to have
// accumulated at least that much back. When no throttleStatus is present (e.g. a bare 429/5xx with no
// GraphQL body), fall back to capped exponential backoff so a retry never fires immediately in a hot loop.
const ASSUMED_QUERY_COST = 50;
const EXP_BACKOFF_BASE_MS = 250;
const EXP_BACKOFF_CAP_MS = 8000;

function computeBackoffMs(throttleStatus: ThrottleStatus | undefined, attempt: number): number {
  if (throttleStatus && throttleStatus.restoreRate > 0) {
    const deficit = Math.max(0, ASSUMED_QUERY_COST - throttleStatus.currentlyAvailable);
    return Math.max(EXP_BACKOFF_BASE_MS, Math.ceil((deficit / throttleStatus.restoreRate) * 1000));
  }
  return Math.min(EXP_BACKOFF_CAP_MS, EXP_BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

/** `bulkOperationRunQuery` wraps the caller's bulk query STRING as a GraphQL string-literal argument.
 *  `JSON.stringify` produces valid escaping here: the GraphQL `StringValue` grammar escapes the same
 *  character set JSON does (`\"`, `\\`, `\n`, `\r`, `\t`, `\uXXXX`, …), so a JSON-escaped string is a
 *  valid GraphQL string literal body. */
function bulkOperationRunQueryMutation(query: string): string {
  return `mutation { bulkOperationRunQuery(query: ${JSON.stringify(query)}) { bulkOperation { id status } userErrors { field message } } }`;
}

/** `node(id:)` on a `BulkOperation` id — field set NOT live-verified (file banner); confirm against a
 *  live bulk run before relying on `errorCode`/`objectCount`/`url` in production. */
const POLL_BULK_QUERY = `query PalUpPollBulk($id: ID!) {
  node(id: $id) {
    ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
  }
}`;

export function createShopifyAdminClient(opts: CreateShopifyAdminClientOpts): ShopifyAdminClient {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const { creds } = opts;
  const version = opts.version ?? ADMIN_API_VERSION;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const log = opts.log ?? ((info: ShopifyAdminEgressLog) => console.log("[shopify-client.admin] " + JSON.stringify(info)));
  const downloadLog =
    opts.downloadLog ?? ((info: ShopifyBulkDownloadEgressLog) => console.log("[shopify-client.download] " + JSON.stringify(info)));

  const emit = (info: ShopifyAdminEgressLog): void => {
    try {
      log(info);
    } catch {
      /* observability must never break the caller */
    }
  };
  const emitDownload = (info: ShopifyBulkDownloadEgressLog): void => {
    try {
      downloadLog(info);
    } catch {
      /* observability must never break the caller */
    }
  };

  async function graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<AdminResponse<T>> {
    // SSRF guard BEFORE any fetch / before the token is ever attached (mirrors shopify-grounding.ts:377).
    if (!SHOP_HOST.test(creds.shopDomain)) {
      throw new ShopifySsrfError("refusing Shopify Admin fetch: shopDomain is not a *.myshopify.com host");
    }
    const url = `https://${creds.shopDomain}/admin/api/${version}/graphql.json`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const start = Date.now();
      let status = 0;
      let ok = false;
      let body: AdminResponse<T> | undefined;
      let parseFailed = false;
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Shopify-Access-Token": creds.accessToken },
          body: JSON.stringify({ query, variables }),
        });
        status = res.status;
        ok = res.ok;
        try {
          body = (await res.json()) as AdminResponse<T>;
        } catch {
          // An unparseable body (malformed JSON, an upstream proxy error page, or a body stream that
          // was already read) leaves us unable to tell success from failure — treated as a transient,
          // retryable condition (bounded by maxAttempts, same as an explicit THROTTLED) rather than
          // silently returning an empty/undefined result to the caller as if the call had succeeded.
          parseFailed = true;
        }
      } catch (e) {
        // A network-level failure (fetch rejects) is not retried here — it is not a throttle signal,
        // and retrying blind against an unreachable host would just burn the attempt budget.
        emit({ host: creds.shopDomain, status: 0, ok: false, ms: Date.now() - start, attempt, throttled: false });
        throw e instanceof Error ? e : new ShopifyClientError("Shopify Admin API request failed");
      }

      const throttled = parseFailed || isThrottled(status, body);
      emit({ host: creds.shopDomain, status, ok, ms: Date.now() - start, attempt, throttled });

      if (throttled) {
        if (attempt >= maxAttempts) {
          throw new ShopifyThrottleError(`Shopify Admin API throttled after ${attempt} attempts`, attempt);
        }
        await sleep(computeBackoffMs(body?.extensions?.cost?.throttleStatus, attempt));
        continue;
      }

      if (!ok) {
        throw new ShopifyClientError(`Shopify Admin API request failed (status ${status})`); // static (F1)
      }
      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        throw new ShopifyClientError("Shopify Admin GraphQL error");
      }
      return body ?? {};
    }
    // Unreachable (the loop always returns or throws), but keeps the function's return type total.
    throw new ShopifyThrottleError("Shopify Admin API throttled: attempt cap exhausted", maxAttempts);
  }

  async function runBulkQuery(query: string): Promise<{ id: string }> {
    const res = await graphql<{
      bulkOperationRunQuery?: { bulkOperation?: { id?: string; status?: string }; userErrors?: { field?: string[]; message?: string }[] };
    }>(bulkOperationRunQueryMutation(query));
    const payload = res.data?.bulkOperationRunQuery;
    if (payload?.userErrors && payload.userErrors.length > 0) {
      throw new ShopifyClientError("Shopify bulkOperationRunQuery returned userErrors");
    }
    const id = payload?.bulkOperation?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ShopifyClientError("Shopify bulkOperationRunQuery returned no bulk operation id");
    }
    return { id };
  }

  async function pollBulk(id: string): Promise<BulkStatus> {
    const res = await graphql<{ node?: { id?: string; status?: string; errorCode?: string; objectCount?: string | number; url?: string; partialDataUrl?: string } }>(
      POLL_BULK_QUERY,
      { id },
    );
    const node = res.data?.node;
    const objectCount =
      typeof node?.objectCount === "string"
        ? Number(node.objectCount)
        : typeof node?.objectCount === "number"
          ? node.objectCount
          : undefined;
    return {
      status: node?.status,
      url: node?.url ?? node?.partialDataUrl,
      objectCount: Number.isFinite(objectCount) ? objectCount : undefined,
      errorCode: node?.errorCode,
    };
  }

  async function downloadJsonl(url: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ShopifySsrfError("refusing Shopify bulk download: not a valid URL");
    }
    const start = Date.now();
    if (parsed.protocol !== "https:" || !SHOPIFY_BULK_RESULT_HOST.test(parsed.hostname)) {
      // Logged, not silently dropped (implementation note, spec §13.3).
      emitDownload({ host: parsed.hostname, status: 0, ok: false, ms: 0, rejectedHost: true });
      throw new ShopifySsrfError(`refusing Shopify bulk download: host "${parsed.hostname}" is not allowlisted`);
    }
    let status = 0;
    let ok = false;
    try {
      // NEVER attach X-Shopify-Access-Token here: this is a pre-signed URL, and the admin token has
      // no business leaving this process toward a third-party CDN host.
      const res = await fetchFn(url, { method: "GET" });
      status = res.status;
      ok = res.ok;
      if (!ok) throw new ShopifyClientError(`Shopify bulk download failed (status ${status})`); // static (F1)
      return await res.text();
    } finally {
      emitDownload({ host: parsed.hostname, status, ok, ms: Date.now() - start });
    }
  }

  return { graphql, runBulkQuery, pollBulk, downloadJsonl };
}
