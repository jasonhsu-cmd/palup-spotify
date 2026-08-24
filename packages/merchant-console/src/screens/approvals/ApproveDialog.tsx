import { useState } from "react";
import type { Proposal } from "@palup/platform-ports";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Note,
} from "@palup/design-system";
import type { ApiClient } from "../../app/api";
import { ConflictError, KilledError } from "../../app/api";
import { formatImpact } from "./format";

// T4 (Approve — confirm dialog): approving a proposal is money/irreversible-adjacent — nothing
// here auto-applies (CLAUDE.md §3) — so it is gated behind an explicit, FOCUS-TRAPPED confirm
// (F1's `Dialog`, Radix underneath — verified in design-system/test/dialog.test.tsx to trap focus
// and stamp aria-modal) rather than a single click anywhere in the queue/detail. The version
// passed to `approve()` is ALWAYS `proposal.version` at click time — never a value the merchant
// could have gone stale on — so a real optimistic-lock conflict on the server (another
// operator/webhook already decided this) surfaces honestly as a 409 instead of silently
// overwriting someone else's decision.
//
// A 423 (Kill Switch armed) is NOT a transient error to retry: once seen, approving stays
// disabled for the lifetime of this component instance — reflecting real system state, never a
// code path an operator's halt fails to stop (CLAUDE.md §3.4).

export interface ApproveDialogProps {
  api: Pick<ApiClient, "approve">;
  proposal: Proposal;
  /** Called with the server's updated proposal after a successful approve — the caller
   *  reconciles (e.g. re-fetches the queue, updates the pending-count pill). */
  onApproved?: (updated: Proposal) => void;
  /** Called on a 409 — "someone else already decided this" — so the caller re-fetches the
   *  list/detail rather than trust this component's own (now-stale) view. */
  onConflict?: () => void;
  /** Optional success notification hook (e.g. the app-level `useToast().toast`); this component
   *  has no opinion on HOW a toast is shown, only that it fires on a real, committed approve. */
  notify?: (message: string) => void;
  /** T6/T7: the GLOBAL Kill Switch state (from `useApprovalsLive`'s `getKill()`-sourced value, not
   *  a per-component guess) — when true, Approve is disabled regardless of whether THIS instance
   *  has ever itself seen a 423. Reflects real system state (CLAUDE.md §3.4: never a code path an
   *  operator's halt fails to stop) even for a proposal this component hasn't tried to approve yet.
   *  Defaults to `false` so existing callers that don't know about the Kill Switch are unaffected. */
  killed?: boolean;
}

type ErrorState = { kind: "conflict" | "killed" | "other"; message: string } | null;

export function ApproveDialog({
  api,
  proposal,
  onApproved,
  onConflict,
  notify,
  killed: killedProp = false,
}: ApproveDialogProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState>(null);
  const killed = killedProp || error?.kind === "killed";

  async function handleConfirm() {
    setBusy(true);
    try {
      const updated = await api.approve(proposal.id, proposal.version);
      setBusy(false);
      setOpen(false);
      setError(null);
      notify?.("Approved — Aria proceeds now.");
      onApproved?.(updated);
    } catch (e) {
      setBusy(false);
      if (e instanceof ConflictError) {
        setError({ kind: "conflict", message: e.message });
        onConflict?.();
      } else if (e instanceof KilledError) {
        setError({
          kind: "killed",
          message: e.reason
            ? `Agents are halted (Kill Switch armed) — ${e.reason}`
            : "Agents are halted (Kill Switch armed).",
        });
      } else {
        setError({ kind: "other", message: "Approve failed — try again." });
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !killed) setError(null); // a fresh open doesn't show a stale conflict banner
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary" disabled={killed}>
          Approve
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve this action?</DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-ink-2">{proposal.rationale}</p>
        <p className="mt-1 text-[12.5px] text-ink-3">{formatImpact(proposal)}</p>
        {error && (
          <Note variant={error.kind === "killed" ? "dang" : "warn"} className="mt-3">
            {error.message}
          </Note>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={handleConfirm} disabled={busy || killed}>
            {busy ? "Approving…" : "Confirm approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
