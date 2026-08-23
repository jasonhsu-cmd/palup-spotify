import type { Proposal, ProposalCategory, ProposalStatus } from "@palup/platform-ports";

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
  /** Subscribes to the tenant's SSE `/events` stream; returns an unsubscribe function. Best-effort
   *  live nudge only (events.ts's own contract) — a dropped/never-opened stream never loses data,
   *  because the store (`listApprovals`/`getKill`) stays the source of truth (see the plan's
   *  Task 7 `useApprovalsLive`, which re-fetches on every event rather than trusting its payload).
   *
   *  KNOWN LIMITATION (not fabricated as working): the browser's native `EventSource` cannot set an
   *  `Authorization` header, and W1-API's `bearer()` (identity-shopify/fastify-plugin.ts) reads ONLY
   *  that header — it has no query-param fallback. This passes the current token as a `token` query
   *  param as a forward-compatible best effort; against the ACTUAL deployed W1-API today that still
   *  401s (no data loss — the store re-fetch is what actually reconciles). Wiring a real
   *  query-param/ticket auth path for this route is a W1-API-side decision for whoever wires Task 7,
   *  not made here. */
  openEvents(onEvent: (e: ConsoleEvent) => void): () => void;
}

export interface MakeApiClientArgs {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetch: typeof fetch;
  /** Injectable for tests (jsdom has no global `EventSource`); defaults to `globalThis.EventSource`,
   *  resolved lazily inside `openEvents` — never referenced at `makeApiClient()` call time, so
   *  constructing a client never throws in a test/SSR environment that has no `EventSource`. */
  EventSourceImpl?: typeof EventSource;
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
  const { baseUrl, getToken, fetch: fetchFn, EventSourceImpl } = args;

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
    openEvents(onEvent) {
      let source: InstanceType<typeof EventSource> | undefined;
      let closed = false;
      getToken()
        .then((token) => {
          if (closed) return;
          const Ctor = EventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
          if (!Ctor) return; // no EventSource in this environment (e.g. SSR/tests) — best-effort, never throws
          const query = toQuery({ token });
          source = new Ctor(`${baseUrl}/events${query}`);
          source.onmessage = (ev: MessageEvent<string>) => {
            try {
              onEvent(JSON.parse(ev.data) as ConsoleEvent);
            } catch {
              // a malformed SSE payload is dropped, never crashes the subscriber — the store
              // re-fetch remains authoritative regardless of what this stream carries.
            }
          };
        })
        .catch(() => {
          // a failed token fetch just means no live updates this session; the store stays
          // authoritative (events.ts's own module contract).
        });
      return () => {
        closed = true;
        source?.close();
      };
    },
  };
}
