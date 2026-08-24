import { useCallback, useEffect, useState } from "react";
import type { Proposal } from "@palup/platform-ports";
import { Badge, Button, Card, CardBody, Note } from "@palup/design-system";
import type { ApiClient } from "../../app/api";
import { CATEGORY_LABEL, formatImpact, isIrreversible } from "./format";

// T2 (Approvals queue): the merchant's landing view on the Approval Center — every PENDING
// proposal, one row per item, matching palup-merchant-app.html's #approvals list (`apprUniCard`):
// a category badge, the rationale, the estimated impact, and — since this is a governance
// surface — a hard-to-miss "Irreversible" marker rather than only surfacing it once the merchant
// opens the detail (Task 3). Approving itself happens in the detail view (Task 4's
// `ApproveDialog`); this screen's own action is "Review" -> `onSelect(id)`, never a same-click
// approve, so a misclick here can never execute a money/irreversible action.

export interface ApprovalsQueueProps {
  api: Pick<ApiClient, "listApprovals">;
  /** Called with the proposal id when the merchant asks to review one. Wires to navigation
   *  (e.g. react-router) at the call site — this component has no routing opinion of its own. */
  onSelect?: (id: string) => void;
  /** T7: bump to force a re-fetch (e.g. after an approve/reject reconciles, or the Approval Center
   *  screen's `useApprovalsLive` observed a live SSE nudge) — this component still owns and fetches
   *  its own list; this is just an extra effect dependency, never a second data source. */
  refreshKey?: number;
}

type LoadState = "loading" | "ready" | "error";

export function ApprovalsQueue({ api, onSelect, refreshKey }: ApprovalsQueueProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<Proposal[]>([]);

  const load = useCallback(() => {
    setState("loading");
    api.listApprovals({ status: "pending" }).then(
      (res) => {
        setItems(res.items);
        setState("ready");
      },
      () => {
        setState("error");
      },
    );
  }, [api]);

  useEffect(() => {
    load();
    // `refreshKey` is intentionally an extra dependency with no use inside the effect body — it
    // exists purely to force this re-fetch when the caller bumps it (T7).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  if (state === "loading") {
    return (
      <div role="status" className="p-6 text-[13px] text-ink-3">
        Loading approvals…
      </div>
    );
  }

  if (state === "error") {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn't load the approval queue.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </Note>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardBody className="py-10 text-center">
          <p className="text-[15.5px] font-semibold text-ink">You&apos;re all caught up</p>
          <p className="mt-1 text-[13px] text-ink-3">
            No pending approvals right now — Aria is handling everything else inside your limits.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((p) => (
        <Card key={p.id}>
          <CardBody className="flex items-start gap-3 py-3">
            <Badge variant="gray">{CATEGORY_LABEL[p.category]}</Badge>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-semibold text-ink">{p.rationale}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
                <span>{formatImpact(p)}</span>
                {isIrreversible(p) && <Badge variant="dang">Irreversible</Badge>}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onSelect?.(p.id)}>
              Review
            </Button>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
