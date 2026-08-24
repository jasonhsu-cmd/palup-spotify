import type { MerchantRuleSet, PalupFloor, Proposal, ProposalCategory, ProposalStatus, RulePreset } from "@palup/platform-ports";

// The Approval Center's typed API client (W1-UI Task 1). Mirrors W1-API's wire contract exactly
// (packages/merchant-backend/src/routes/{approvals,kill,audit,events}.ts) — `Proposal` is
// imported directly from `@palup/platform-ports` (a pure, dependency-free port package) to avoid
// drift on the one large shared shape; `AuditEntry`/`ConsoleEvent` are mirrored as local types
// below because W1-API doesn't barrel-export them from a package root a frontend can safely
// depend on (`@palup/merchant-backend`'s only entry point is `src/server.ts`, a Fastify service,
// not a types barrel) — importing THOSE would pull a backend service package into this frontend's
// dependency graph for no reason. Every field here is a plain mirror of the backend's actual
// response shape (routes/audit.ts's `SafeAuditEntry`, events.ts's `ConsoleEvent`), not invented.
//
// Session token: every request calls the injected `getToken()` (App Bridge's `shopify.idToken()`,
// see session.tsx) fresh and sends it as `Authorization: Bearer <token>` — never cached beyond a
// single request, never written to localStorage (a stolen token would be a stolen embedded
// session). A 401 is treated as "the token may have expired between mint and send" and gets
// exactly ONE refresh + retry (a second 401 is a real auth failure, not a transient race — thrown
// as `AuthError` rather than silently retried forever). 409/423 are mapped to typed errors so a
// screen can render the exact governance-honest message the plan requires ("someone else just
// decided this" / the kill banner) instead of a generic failure.

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  reversalPath?: string;
  hash: string;
}

export type ConsoleEvent =
  | { type: "proposal.created"; id: string }
  | { type: "proposal.decided"; id: string; status: string }
  | { type: "kill.changed"; killed: boolean };

// W2 (Revenue Home) — mirrors of merchant-backend's home/activity wire contract
// (src/home/read-model.ts's HomeSummary, src/routes/activity.ts's ActivityEntry,
// @palup/platform-ports' PrimaryGoal). Plain mirrors, not invented; same rationale as AuditEntry.

export type PrimaryGoalKind =
  | "recover_carts"
  | "close_more_chat_sales"
  | "grow_repeat_purchases"
  | "increase_aov"
  | "win_back_lapsed";

export interface PrimaryGoal {
  kind: PrimaryGoalKind;
  note?: string;
  setBy: string;
  setAt: string;
}

export interface PlayMeasurement {
  play: string;
  incrementalLiftUsd: number;
  relativeLift: number;
  confidence: number;
  underpowered: boolean;
  method: string;
}

export interface OnboardingHandoff {
  headline: string;
  items: Array<{ label: string; detail: string }>;
  sourceNote: string;
}

export type NetReason = "ok" | "attribution_underpowered" | "cost_not_metered" | "cost_not_fully_priced";

export interface HomeSummary {
  period: string;
  goal: PrimaryGoal | null;
  attributed: { totalUsd: number; entryCount: number; plays: PlayMeasurement[]; underpowered: boolean };
  cost: { metered: boolean; totalUsd: number; fullyPriced: boolean; unpricedModels: string[]; events: number };
  net: { value: number | null; reason: NetReason };
  handoff: OnboardingHandoff | null;
}

export interface ActivityEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
}

/** Thrown on a 409 (`ProposalStore.transition`'s optimistic-lock conflict, or a terminal-state
 *  reject). `currentVersion` is `-1` when the server didn't echo one (e.g. the reject route's
 *  409s, which W1-API never attaches a version to) — callers should re-`getApproval` rather than
 *  trust a `-1` as real. */
export class ConflictError extends Error {
  constructor(
    public readonly currentVersion: number,
    message = "someone else already decided this",
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Thrown on a 423 (the tenant's Kill Switch is armed — `KillSwitchError`, kill.ts). `reason` is
 *  the operator-supplied halt reason when the server sent one. */
export class KilledError extends Error {
  constructor(
    public readonly reason: string | undefined,
    message = "agents are halted (Kill Switch armed)",
  ) {
    super(message);
    this.name = "KilledError";
  }
}

/** Thrown when a fresh (refreshed) session token STILL 401s — a real, non-transient auth failure.
 *  The console must re-run the App Bridge auth flow, never retry again. */
export class AuthError extends Error {
  constructor(message = "session expired — re-authenticate") {
    super(message);
    this.name = "AuthError";
  }
}

/** A non-2xx response that isn't one of the three typed cases above (e.g. 400/403/404/500). Carries
 *  the HTTP status and the server's fixed `error` string (never a raw message/stack — W1-API's own
 *  error handler already redacts those server-side). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// W3 (Learned/Memory & Voice) — mirrors of merchant-backend's `/learned` wire contract
// (src/routes/learned.ts's `SafeLearnedInsight`/`TeachBody`/`PinBody`). `LearnedCategory` mirrors
// @palup/platform-ports' own type (a plain string union, safe to duplicate rather than import,
// same call as AuditEntry above: routes/learned.ts is behind a Fastify service, not a types
// barrel this frontend package should depend on).

export type LearnedCategory = "customers" | "products" | "voice" | "policies";

export interface LearnedInsight {
  id: string;
  category: LearnedCategory;
  tier: "private" | "aggregate";
  origin: "synthesized" | "merchant_taught";
  text: string;
  source: string;
  sampleSize: number;
  confidence: "medium" | "high";
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeachRequest {
  category: LearnedCategory;
  text: string;
  guardrailKey?: string;
  stance?: "tighten" | "loosen";
}

/** Mirrors `GET /learned/export`'s response envelope (routes/learned.ts) — deliberately NOT a bare
 *  `LearnedInsight[]`: the merchant-owns-their-brain promise (spec §10) needs `portabilityNote`
 *  stated honestly alongside the data (the export mechanism is real today; the signed, portable,
 *  legally-reviewed FORMAT is still legal-deferred — this type carries that caveat verbatim rather
 *  than letting a screen imply more than the backend actually guarantees). */
export interface LearnedExport {
  tenantId: string;
  exportedAt: string;
  insights: LearnedInsight[];
  portabilityNote: string;
}

// W4-broaden (Task 8) — mirrors merchant-backend's `/rules*` wire contract
// (src/routes/rules.ts's `GET/PUT /rules`, `GET /rules/floors`, `GET /rules/presets`,
// `POST /rules/preview`, `POST /rules/apply-preset`). Unlike `AuditEntry`/`ConsoleEvent` above,
// the payload types here (`MerchantRuleSet`, `PalupFloor`, `RulePreset`) are imported directly
// from `@palup/platform-ports` rather than hand-mirrored: merchant-console already depends on
// that package (it is a pure, dependency-free port package — the same package `Proposal`/
// `ProposalCategory` already come from above), and these three shapes are large/evolving enough
// that a local copy would drift. `previewRules`'s response type mirrors the route's actual return
// (`{ before, after, bigJump }` plus the floor-clamp preview fields `effective`/`capped` the route
// also sends — see rules.ts's `POST /rules/preview` handler) so the console can render what a
// PalUp floor would actually clamp before the merchant commits via `putRules`.

export interface ApiClient {
  listApprovals(q: {
    status?: ProposalStatus | string;
    category?: ProposalCategory | string;
    cursor?: string;
  }): Promise<{ items: Proposal[]; cursor?: string }>;
  getApproval(id: string): Promise<Proposal>;
  approve(id: string, version: number, note?: string): Promise<Proposal>;
  reject(id: string, reason: string): Promise<Proposal>;
  getKill(): Promise<{ killed: boolean }>;
  kill(reason: string): Promise<void>;
  unkill(): Promise<void>;
  listAudit(cursor?: string): Promise<{ items: AuditEntry[]; cursor?: string }>;
  getHomeSummary(): Promise<HomeSummary>;
  getActivity(cursor?: string): Promise<{ items: ActivityEntry[] }>;
  setPrimaryGoal(kind: PrimaryGoalKind, note?: string): Promise<{ goal: PrimaryGoal }>;
  listLearned(q: { category?: LearnedCategory }): Promise<{ items: LearnedInsight[] }>;
  teachLearned(req: TeachRequest): Promise<{ insight: LearnedInsight }>;
  pinLearned(id: string, pinned: boolean): Promise<LearnedInsight>;
  deleteLearned(id: string): Promise<{ removed: boolean }>;
  exportLearned(): Promise<LearnedExport>;
  getRules(): Promise<{ envelope: MerchantRuleSet }>;
  getFloors(): Promise<{ floors: Record<ProposalCategory, PalupFloor> }>;
  listRulePresets(): Promise<{ presets: RulePreset[] }>;
  putRules(patch: MerchantRuleSet): Promise<{ envelope: MerchantRuleSet; bigJump: boolean }>;
  previewRules(patch: MerchantRuleSet): Promise<{
    before: MerchantRuleSet;
    after: MerchantRuleSet;
    bigJump: boolean;
    effective: MerchantRuleSet;
    capped: Partial<Record<ProposalCategory, string[]>>;
  }>;
  applyRulePreset(presetId: string): Promise<{ envelope: MerchantRuleSet; bigJump: boolean }>;
  /** Subscribes to the tenant's SSE `/events` stream; returns an unsubscribe function. Best-effort
   *  live nudge only (events.ts's own contract) — a dropped/never-opened stream never loses data,
   *  because the store (`listApprovals`/`getKill`) stays the source of truth (see
   *  `useApprovalsLive`, which re-fetches on every event rather than trusting its payload).
   *
   *  T7 SSE-AUTH FIX: the browser's native `EventSource` cannot set an `Authorization` header, and
   *  W1-API's `bearer()` (identity-shopify/fastify-plugin.ts) reads ONLY that header — no
   *  query-param fallback. A `?token=` in the URL would ALSO be unsafe regardless (logged by
   *  proxies, visible in `Referer`, cached in browser history) — so this is not "EventSource plus a
   *  workaround," it's a hand-rolled fetch-based SSE reader: `fetch(GET /events, {headers:
   *  {Authorization: Bearer <token>}})`, reading `response.body` as a stream and parsing `data: <json>
   *  \n\n` frames itself. The token is NEVER placed in the URL. On a stream error/end, `onStreamError`
   *  fires (if provided) and the reader reconnects on its own after `sseRetryMs` — `onStreamError` is
   *  the hook for a caller (`useApprovalsLive`) to trigger its own full re-fetch as a safety net for
   *  whatever was missed while disconnected; the automatic reconnect is otherwise invisible plumbing. */
  openEvents(onEvent: (e: ConsoleEvent) => void, onStreamError?: () => void): () => void;
}

export interface MakeApiClientArgs {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetch: typeof fetch;
  /** Delay (ms) before `openEvents` retries a dropped/failed SSE connection. Defaults to 3000;
   *  overridable so tests don't have to wait out a real multi-second backoff. */
  sseRetryMs?: number;
}

function toQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "");
  if (entries.length === 0) return "";
  return `?${new URLSearchParams(entries).toString()}`;
}

async function safeJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function makeApiClient(args: MakeApiClientArgs): ApiClient {
  const { baseUrl, getToken, fetch: fetchFn, sseRetryMs = 3000 } = args;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const attempt = async (): Promise<Response> => {
      const token = await getToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      return fetchFn(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    };

    let res = await attempt();
    if (res.status === 401) {
      // Exactly one refresh + retry (global constraint) — never a silent infinite retry loop.
      res = await attempt();
      if (res.status === 401) throw new AuthError();
    }

    if (res.status === 409) {
      const body = await safeJson(res);
      const currentVersion = typeof body?.currentVersion === "number" ? body.currentVersion : -1;
      const message = typeof body?.error === "string" ? body.error : undefined;
      throw new ConflictError(currentVersion, message);
    }
    if (res.status === 423) {
      const body = await safeJson(res);
      const reason = typeof body?.reason === "string" ? body.reason : undefined;
      throw new KilledError(reason);
    }
    if (!res.ok) {
      const body = await safeJson(res);
      const message = typeof body?.error === "string" ? body.error : `request failed (${res.status})`;
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as T;
  }

  return {
    async listApprovals(q) {
      const query = toQuery({ status: q.status, category: q.category, cursor: q.cursor });
      return request<{ items: Proposal[]; cursor?: string }>(`/approvals${query}`);
    },
    async getApproval(id) {
      return request<Proposal>(`/approvals/${encodeURIComponent(id)}`);
    },
    async approve(id, version, note) {
      return request<Proposal>(`/approvals/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify(note === undefined ? { version } : { version, note }),
      });
    },
    async reject(id, reason) {
      return request<Proposal>(`/approvals/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
    },
    async getKill() {
      return request<{ killed: boolean }>(`/kill`);
    },
    async kill(reason) {
      await request<{ killed: boolean }>(`/kill`, { method: "POST", body: JSON.stringify({ reason }) });
    },
    async unkill() {
      await request<{ killed: boolean }>(`/unkill`, { method: "POST" });
    },
    async listAudit(cursor) {
      const query = toQuery({ cursor });
      return request<{ items: AuditEntry[]; cursor?: string }>(`/audit${query}`);
    },
    async getHomeSummary() {
      return request<HomeSummary>(`/home/summary`);
    },
    async getActivity(cursor) {
      return request<{ items: ActivityEntry[] }>(`/activity${toQuery({ cursor })}`);
    },
    async setPrimaryGoal(kind, note) {
      return request<{ goal: PrimaryGoal }>(`/home/goal`, {
        method: "PUT",
        body: JSON.stringify(note === undefined ? { kind } : { kind, note }),
      });
    },
    async listLearned(q) {
      return request<{ items: LearnedInsight[] }>(`/learned${toQuery({ category: q.category })}`);
    },
    async teachLearned(req) {
      return request<{ insight: LearnedInsight }>(`/learned`, { method: "POST", body: JSON.stringify(req) });
    },
    async pinLearned(id, pinned) {
      return request<LearnedInsight>(`/learned/${encodeURIComponent(id)}/pin`, {
        method: "POST",
        body: JSON.stringify({ pinned }),
      });
    },
    async deleteLearned(id) {
      return request<{ removed: boolean }>(`/learned/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async exportLearned() {
      return request<LearnedExport>(`/learned/export`);
    },
    async getRules() {
      return request<{ envelope: MerchantRuleSet }>("/rules");
    },
    async getFloors() {
      return request<{ floors: Record<ProposalCategory, PalupFloor> }>("/rules/floors");
    },
    async listRulePresets() {
      return request<{ presets: RulePreset[] }>("/rules/presets");
    },
    async putRules(patch) {
      return request<{ envelope: MerchantRuleSet; bigJump: boolean }>("/rules", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
    },
    async previewRules(patch) {
      return request<{
        before: MerchantRuleSet;
        after: MerchantRuleSet;
        bigJump: boolean;
        effective: MerchantRuleSet;
        capped: Partial<Record<ProposalCategory, string[]>>;
      }>("/rules/preview", { method: "POST", body: JSON.stringify(patch) });
    },
    async applyRulePreset(presetId) {
      return request<{ envelope: MerchantRuleSet; bigJump: boolean }>("/rules/apply-preset", {
        method: "POST",
        body: JSON.stringify({ presetId }),
      });
    },
    openEvents(onEvent, onStreamError) {
      let closed = false;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();

      function scheduleReconnect() {
        if (closed) return;
        onStreamError?.();
        retryTimer = setTimeout(() => {
          void connectOnce();
        }, sseRetryMs);
      }

      async function connectOnce(): Promise<void> {
        if (closed) return;
        let token: string;
        try {
          token = await getToken();
        } catch {
          scheduleReconnect(); // a failed token fetch is treated the same as a dropped connection
          return;
        }
        if (closed) return;

        let res: Response;
        try {
          res = await fetchFn(`${baseUrl}/events`, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, accept: "text/event-stream" },
            signal: controller.signal,
          });
        } catch {
          scheduleReconnect();
          return;
        }
        if (closed) return;
        if (!res.ok || !res.body) {
          scheduleReconnect();
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!closed) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
              if (dataLine === undefined) continue;
              try {
                onEvent(JSON.parse(dataLine.slice(5).trim()) as ConsoleEvent);
              } catch {
                // a malformed SSE frame is dropped, never crashes the subscriber — the store
                // re-fetch remains authoritative regardless of what this stream carries.
              }
            }
          }
        } catch {
          // a stream read error falls through to the same reconnect path as a clean end-of-stream.
        }
        if (!closed) scheduleReconnect();
      }

      void connectOnce();

      return () => {
        closed = true;
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        controller.abort();
      };
    },
  };
}
