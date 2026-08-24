import { useCallback, useState } from "react";
import type { Proposal } from "@palup/platform-ports";
import { Button } from "@palup/design-system";
import type { ApiClient } from "../../app/api";
import { ApprovalsQueue } from "./ApprovalsQueue";
import { ProposalDetail } from "./ProposalDetail";
import { RejectDialog } from "./RejectDialog";
import { KillSwitch } from "./KillSwitch";
import { AuditView } from "./AuditView";
import { useApprovalsLive } from "./useApprovalsLive";

// The Approval Center screen (W1-UI Tasks 2-7, assembled): composes every governance surface this
// plan built — the pending queue, a proposal's full detail (reversal plan + boundary reasons),
// approve/reject confirms, the Kill Switch + halted banner, and the audit log — behind ONE shared
// live-state hook (`useApprovalsLive`) so `killed` can never disagree between the banner and the
// Approve button, and so a decision (approve/reject) or a conflict ALWAYS triggers a real re-fetch
// of the store rather than a component quietly trusting its own now-stale view (the T2-4 review's
// "Important" gap this batch closes).

export interface ApprovalCenterProps {
  api: ApiClient;
}

export function ApprovalCenter({ api }: ApprovalCenterProps) {
  const live = useApprovalsLive(api);
  const [selected, setSelected] = useState<Proposal | null>(null);

  const openDetail = useCallback(
    (id: string) => {
      api.getApproval(id).then(
        (proposal) => setSelected(proposal),
        () => setSelected(null),
      );
    },
    [api],
  );

  const closeDetail = useCallback(() => setSelected(null), []);

  // Both a successful decision AND a 409 conflict mean this component's OWN view of `selected` is
  // no longer trustworthy — in either case, drop back to the queue and force the real re-fetch
  // (`live.reload`) rather than leaving a stale detail on screen or silently trusting local state.
  const handleReconcile = useCallback(() => {
    live.reload();
    closeDetail();
  }, [live, closeDetail]);

  return (
    <div className="flex flex-col gap-5">
      <KillSwitch api={api} killed={live.killed} onChanged={live.reload} />

      {selected ? (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="self-start" onClick={closeDetail}>
            ‹ Back to queue
          </Button>
          <ProposalDetail
            proposal={selected}
            api={{ approve: api.approve }}
            killed={live.killed}
            onApproved={handleReconcile}
            onConflict={handleReconcile}
            actions={
              <RejectDialog
                api={{ reject: api.reject }}
                proposal={selected}
                onRejected={handleReconcile}
                onConflict={handleReconcile}
              />
            }
          />
        </div>
      ) : (
        <ApprovalsQueue api={api} onSelect={openDetail} refreshKey={live.revision} />
      )}

      <div>
        <h2 className="mb-2 font-display text-[15.5px] font-semibold text-ink">Audit log</h2>
        <AuditView api={api} />
      </div>
    </div>
  );
}
