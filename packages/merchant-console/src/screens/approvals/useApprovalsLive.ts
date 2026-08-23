import { useCallback, useEffect, useRef, useState } from "react";
import type { Proposal } from "@palup/platform-ports";
import type { ApiClient } from "../../app/api";

// T7 (live updates): the Approval Center's single fetch loop for the pending queue + Kill Switch
// state. `openEvents`'s SSE stream is treated purely as a NUDGE — this hook never trusts an
// event's own payload, it re-fetches `listApprovals`/`getKill` (the real store) on every event, on
// a reported stream error, and whenever the caller invokes `reload()` itself (e.g. right after its
// own approve/reject reconciles). That is the whole "store is the source of truth" contract: a
// dropped, delayed, or entirely-never-opened SSE connection can never cause this hook to show stale
// data forever, because nothing here is derived from the stream's content — only from the fact that
// *something* happened, which is enough reason to ask the store again.

export type ApprovalsLiveLoadState = "loading" | "ready" | "error";

export interface UseApprovalsLiveResult {
  items: Proposal[];
  killed: boolean;
  loadState: ApprovalsLiveLoadState;
  /** Increments on every successful `reload()` (mount, an SSE event, a reported stream error, or a
   *  caller's own manual call) — a stable, monotonically-increasing "something real changed"
   *  signal a caller can pass straight through as another component's `refreshKey` (e.g.
   *  `ApprovalsQueue`'s own self-fetch) without this hook needing to own that component's data. */
  revision: number;
  /** Force a full re-fetch of the queue + kill state — e.g. right after this screen's own
   *  approve/reject/kill/unkill action commits, so the UI reconciles against the real store
   *  immediately rather than waiting on the next SSE nudge. */
  reload: () => void;
}

export function useApprovalsLive(
  api: Pick<ApiClient, "listApprovals" | "getKill" | "openEvents">,
): UseApprovalsLiveResult {
  const [items, setItems] = useState<Proposal[]>([]);
  const [killed, setKilled] = useState(false);
  const [loadState, setLoadState] = useState<ApprovalsLiveLoadState>("loading");
  const [revision, setRevision] = useState(0);
  const loadedOnce = useRef(false);

  const reload = useCallback(() => {
    if (!loadedOnce.current) setLoadState("loading");
    Promise.all([api.listApprovals({ status: "pending" }), api.getKill()]).then(
      ([approvals, kill]) => {
        loadedOnce.current = true;
        setItems(approvals.items);
        setKilled(kill.killed);
        setLoadState("ready");
        setRevision((r) => r + 1);
      },
      () => {
        // a re-fetch failure after an already-successful load just means "still showing the last
        // known-good state" — never flip a ready screen to a scary full-page error over one blip.
        setLoadState((current) => (loadedOnce.current ? current : "error"));
      },
    );
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const unsubscribe = api.openEvents(
      () => reload(), // any event (proposal.created/decided, kill.changed) — re-fetch, don't trust the payload
      () => reload(), // a reported stream error/reconnect — the same full re-fetch as a safety net
    );
    return unsubscribe;
  }, [api, reload]);

  return { items, killed, loadState, revision, reload };
}
