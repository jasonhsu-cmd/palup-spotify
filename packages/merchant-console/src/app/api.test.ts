import { describe, it, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { makeApiClient, ConflictError, KilledError, AuthError, ApiError, type ConsoleEvent } from "./api.js";

// Typed helper so `.mock.calls[n]` is a real `[string, RequestInit]` tuple (not `[]`) under this
// repo's `noUncheckedIndexedAccess` — matches the `vi.fn<typeof fetch>(...)` idiom already used
// elsewhere (e.g. packages/model-vertex/test/vertex-embed.test.ts's `call.mock.calls[0]![0]`).
function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>((url, init) => Promise.resolve(impl(String(url), (init ?? {}) as RequestInit)));
}

/** `RequestInit["headers"]` is the `HeadersInit` union (`Headers | Record<string,string> |
 *  [string,string][]`); every request this client builds sends a plain `Record<string,string>`
 *  (api.ts never uses the array/Headers-object forms), so this narrows for the assertions below. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  return init!.headers as Record<string, string>;
}

describe("makeApiClient", () => {
  it("sends the App Bridge session token as a bearer", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "sess-123", fetch: fetchSpy });
    await api.listApprovals({ status: "pending" });
    expect(headersOf(fetchSpy.mock.calls[0]![1]).Authorization).toBe("Bearer sess-123");
  });

  it("hits the tenant-scoped listApprovals endpoint with the status filter", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await api.listApprovals({ status: "pending" });
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/approvals?status=pending");
  });

  it("refreshes the token once on a 401 and retries", async () => {
    let calls = 0;
    const fetchSpy = mockFetch(() => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const getToken = vi.fn(async () => `tok-${getToken.mock.calls.length}`);
    const api = makeApiClient({ baseUrl: "/api", getToken, fetch: fetchSpy });
    const result = await api.listApprovals({});
    expect(result.items).toEqual([]);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchSpy.mock.calls[1]![1]).Authorization).toBe("Bearer tok-2");
  });

  it("throws AuthError when a refreshed retry still 401s (never a silent success)", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await expect(api.listApprovals({})).rejects.toBeInstanceOf(AuthError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("maps a 409 to a typed ConflictError carrying the current version", async () => {
    const fetchSpy = mockFetch(
      () => new Response(JSON.stringify({ error: "version conflict", currentVersion: 7 }), { status: 409 }),
    );
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const err = await api.approve("prop-1", 6).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).currentVersion).toBe(7);
  });

  it("maps a 423 to a typed KilledError carrying the reason", async () => {
    const fetchSpy = mockFetch(
      () => new Response(JSON.stringify({ error: "kill switch armed", reason: "safety" }), { status: 423 }),
    );
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const err = await api.approve("prop-1", 1).catch((e) => e);
    expect(err).toBeInstanceOf(KilledError);
    expect((err as KilledError).reason).toBe("safety");
  });

  it("approve POSTs the version so the server can optimistic-lock", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ id: "p1", version: 2 }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await api.approve("p1", 1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/approvals/p1/approve");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ version: 1 });
  });

  it("reject POSTs the reason", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ id: "p1", version: 2 }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await api.reject("p1", "not aligned with brand voice");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/approvals/p1/reject");
    expect(JSON.parse(String(init!.body))).toEqual({ reason: "not aligned with brand voice" });
  });

  it("getKill / kill / unkill hit the kill-switch routes", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ killed: true }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    expect(await api.getKill()).toEqual({ killed: true });
    await api.kill("emergency halt");
    await api.unkill();
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/kill");
    expect(fetchSpy.mock.calls[1]![0]).toBe("/api/kill");
    expect(fetchSpy.mock.calls[1]![1]!.method).toBe("POST");
    expect(fetchSpy.mock.calls[2]![0]).toBe("/api/unkill");
  });

  it("openEvents opens a fetch-based SSE stream authorized by the bearer HEADER, never a URL token", async () => {
    const events: ConsoleEvent[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"proposal.created","id":"p1"}\n\n'));
        controller.close();
      },
    });
    const fetchSpy = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("/api/events");
      expect(String(url)).not.toContain("token=");
      expect(headersOf(init).Authorization).toBe("Bearer sess-tok");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "sess-tok", fetch: fetchSpy });

    const unsubscribe = api.openEvents((e) => events.push(e));
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ type: "proposal.created", id: "p1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("openEvents parses multiple SSE frames delivered across separate chunks", async () => {
    const events: ConsoleEvent[] = [];
    const encoder = new TextEncoder();
    let pushSecond: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"kill.changed","killed":true}\n\n'));
        pushSecond = () => {
          controller.enqueue(encoder.encode('data: {"type":"proposal.decided","id":"p2","status":"approved"}\n\n'));
          controller.close();
        };
      },
    });
    const fetchSpy = vi.fn<typeof fetch>(
      async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });

    const unsubscribe = api.openEvents((e) => events.push(e));
    await waitFor(() => expect(events).toHaveLength(1));
    pushSecond?.();
    await waitFor(() => expect(events).toHaveLength(2));
    expect(events).toEqual([
      { type: "kill.changed", killed: true },
      { type: "proposal.decided", id: "p2", status: "approved" },
    ]);
    unsubscribe();
  });

  it("openEvents retries the stream on error/end and reports it via the onStreamError callback", async () => {
    let calls = 0;
    const fetchSpy = vi.fn<typeof fetch>(async () => {
      calls += 1;
      throw new Error("network down");
    });
    const onStreamError = vi.fn();
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy, sseRetryMs: 5 });

    const unsubscribe = api.openEvents(() => {}, onStreamError);
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    expect(onStreamError).toHaveBeenCalled();
    unsubscribe();
  });

  it("openEvents' unsubscribe stops further reconnect attempts", async () => {
    let calls = 0;
    const fetchSpy = vi.fn<typeof fetch>(async () => {
      calls += 1;
      throw new Error("network down");
    });
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy, sseRetryMs: 5 });

    const unsubscribe = api.openEvents(() => {});
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));
    unsubscribe();
    const callsAtUnsubscribe = calls;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(callsAtUnsubscribe);
  });

  it("listAudit returns the safe audit entries", async () => {
    const entry = { seq: 1, at: "2026-08-24T00:00:00Z", actor: "owner", action: "approve", hash: "abc" };
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [entry] }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const result = await api.listAudit();
    expect(result.items).toEqual([entry]);
  });
});

describe("Revenue Home methods (W2 T6)", () => {
  const emptySummary = {
    period: "2026-08",
    goal: null,
    attributed: { totalUsd: 0, entryCount: 0, plays: [], underpowered: true },
    cost: { metered: false, totalUsd: 0, fullyPriced: true, unpricedModels: [], events: 0 },
    net: { value: null, reason: "attribution_underpowered" },
    handoff: null,
  };

  it("getHomeSummary GETs /home/summary with the bearer", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify(emptySummary), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "sess-1", fetch: fetchSpy });
    const summary = await api.getHomeSummary();
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/home/summary");
    expect(headersOf(fetchSpy.mock.calls[0]![1]).Authorization).toBe("Bearer sess-1");
    expect(summary.net.reason).toBe("attribution_underpowered");
  });

  it("getActivity GETs /activity, forwarding an optional cursor", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await api.getActivity();
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/activity");
    await api.getActivity("c1");
    expect(fetchSpy.mock.calls[1]![0]).toBe("/api/activity?cursor=c1");
  });

  it("setPrimaryGoal PUTs /home/goal with kind (and note only when given)", async () => {
    const goal = { kind: "recover_carts", setBy: "u1", setAt: "2026-08-24T00:00:00.000Z" };
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ goal }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });

    await api.setPrimaryGoal("recover_carts");
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/home/goal");
    expect(fetchSpy.mock.calls[0]![1]!.method).toBe("PUT");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ kind: "recover_carts" });

    await api.setPrimaryGoal("increase_aov", "Q3 push");
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body))).toEqual({ kind: "increase_aov", note: "Q3 push" });
  });
});

describe("Learned methods (W3 T7)", () => {
  const insight = {
    id: "li-1",
    category: "voice" as const,
    tier: "private" as const,
    origin: "merchant_taught" as const,
    text: "Prefer a warm, casual tone",
    source: "merchant_taught",
    sampleSize: 0,
    confidence: "high" as const,
    pinned: false,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };

  it("listLearned GETs /learned with the category filter and the bearer header", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [insight] }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "sess-1", fetch: fetchSpy });
    const result = await api.listLearned({ category: "voice" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/learned?category=voice");
    expect(headersOf(init).Authorization).toBe("Bearer sess-1");
    expect(result.items).toEqual([insight]);
  });

  it("listLearned GETs /learned with no query when category is omitted", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    await api.listLearned({});
    expect(fetchSpy.mock.calls[0]![0]).toBe("/api/learned");
  });

  it("teachLearned POSTs the JSON body to /learned", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ insight }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const req = { category: "voice" as const, text: "Prefer a warm, casual tone" };
    const result = await api.teachLearned(req);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/learned");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual(req);
    expect(result.insight).toEqual(insight);
  });

  it("pinLearned POSTs /learned/<id>/pin with the pinned flag", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ ...insight, pinned: true }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const result = await api.pinLearned("li-1", true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/learned/li-1/pin");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ pinned: true });
    expect(result.pinned).toBe(true);
  });

  it("deleteLearned DELETEs /learned/<id>", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ removed: true }), { status: 200 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const result = await api.deleteLearned("li-1");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/learned/li-1");
    expect(init!.method).toBe("DELETE");
    expect(result).toEqual({ removed: true });
  });

  it("maps a 403 on teachLearned to a typed ApiError", async () => {
    const fetchSpy = mockFetch(() => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    const api = makeApiClient({ baseUrl: "/api", getToken: async () => "t", fetch: fetchSpy });
    const err = await api.teachLearned({ category: "voice", text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});
