import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Proposal } from "@palup/platform-ports";
import type { ApiClient, ConsoleEvent } from "../../app/api";
import { useApprovalsLive } from "./useApprovalsLive";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    tenantId: "t1",
    agentId: "agent-winback",
    agentType: "win_back",
    action: { type: "send_campaign", params: {} },
    category: "campaign",
    rationale: "Win back 210 lapsed VIPs",
    boundaryReasons: [],
    estimatedImpact: { amountUsd: 4200, reach: 210 },
    reversalPlan: { reversible: false, plan: "Cannot un-send" },
    preconditions: {},
    status: "pending",
    version: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

type Deps = Pick<ApiClient, "listApprovals" | "getKill" | "openEvents">;

function fakeApi(overrides: Partial<Deps> = {}): Deps & { emit: (e: ConsoleEvent) => void } {
  let listener: ((e: ConsoleEvent) => void) | undefined;
  return {
    listApprovals: vi.fn(async () => ({ items: [] })),
    getKill: vi.fn(async () => ({ killed: false })),
    openEvents: vi.fn((onEvent) => {
      listener = onEvent;
      return () => {
        listener = undefined;
      };
    }),
    emit: (e: ConsoleEvent) => listener?.(e),
    ...overrides,
  };
}

describe("useApprovalsLive", () => {
  it("loads the pending queue and kill state on mount", async () => {
    const p = proposal();
    const api = fakeApi({ listApprovals: vi.fn(async () => ({ items: [p] })), getKill: vi.fn(async () => ({ killed: true })) });
    const { result } = renderHook(() => useApprovalsLive(api));

    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    expect(result.current.items).toEqual([p]);
    expect(result.current.killed).toBe(true);
  });

  it("re-fetches listApprovals + getKill when a proposal.created SSE event arrives — not on a timer", async () => {
    let call = 0;
    const listApprovals = vi.fn(async () => {
      call += 1;
      return { items: call === 1 ? [] : [proposal({ id: "new-1" })] };
    });
    const api = fakeApi({ listApprovals });
    const { result } = renderHook(() => useApprovalsLive(api));

    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    expect(listApprovals).toHaveBeenCalledTimes(1);
    expect(result.current.items).toEqual([]);

    api.emit({ type: "proposal.created", id: "new-1" });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(result.current.items[0]?.id).toBe("new-1");
  });

  it("re-fetches on a proposal.decided event and on a kill.changed event", async () => {
    let killed = false;
    const getKill = vi.fn(async () => ({ killed }));
    const api = fakeApi({ getKill });
    const { result } = renderHook(() => useApprovalsLive(api));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));

    killed = true;
    api.emit({ type: "kill.changed", killed: true });
    await waitFor(() => expect(result.current.killed).toBe(true));
    expect(getKill).toHaveBeenCalledTimes(2);

    api.emit({ type: "proposal.decided", id: "p1", status: "approved" });
    await waitFor(() => expect(getKill).toHaveBeenCalledTimes(3));
  });

  it("passes an onStreamError callback to openEvents that triggers a full re-fetch", async () => {
    const listApprovals = vi.fn(async () => ({ items: [] }));
    const api = fakeApi({ listApprovals });
    renderHook(() => useApprovalsLive(api));
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(1));

    const openEventsMock = api.openEvents as unknown as ReturnType<typeof vi.fn>;
    const onStreamError = openEventsMock.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(typeof onStreamError).toBe("function");
    onStreamError?.();

    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(2));
  });

  it("exposes a manual reload() the caller can invoke after its own decision (approve/reject)", async () => {
    const listApprovals = vi.fn(async () => ({ items: [] }));
    const api = fakeApi({ listApprovals });
    const { result } = renderHook(() => useApprovalsLive(api));
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(1));

    result.current.reload();
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(2));
  });

  it("exposes a `revision` counter that increments on every successful reload (mount, event, or manual) — for a caller (e.g. ApprovalsQueue's refreshKey) to force ITS OWN re-fetch off of", async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useApprovalsLive(api));
    await waitFor(() => expect(result.current.loadState).toBe("ready"));
    const afterMount = result.current.revision;

    api.emit({ type: "proposal.created", id: "new-1" });
    await waitFor(() => expect(result.current.revision).toBeGreaterThan(afterMount));
    const afterEvent = result.current.revision;

    result.current.reload();
    await waitFor(() => expect(result.current.revision).toBeGreaterThan(afterEvent));
  });

  it("unsubscribes from openEvents on unmount", async () => {
    const unsubscribe = vi.fn();
    const api = fakeApi({ openEvents: vi.fn(() => unsubscribe) });
    const { unmount } = renderHook(() => useApprovalsLive(api));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
