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
  Field,
  Note,
  Textarea,
} from "@palup/design-system";
import type { ApiClient } from "../../app/api";
import { ConflictError } from "../../app/api";

// T5 (Reject — reason required): rejecting is a smaller-blast-radius decision than approving (it
// only transitions the proposal to `rejected` — `rejectProposal`, agent-runtime/loop.ts, never
// executes), so it doesn't need the Kill-Switch handling `ApproveDialog` carries. It still gets
// its own explicit, focus-trapped confirm (never a same-click reject in the queue) and — the one
// requirement unique to this action — a REQUIRED reason: the merchant's "no" is written to the
// audit log next to the decision (`decisionNote`, server-side) and is what lets the agent learn a
// preference, so an empty rationale defeats the point of the field. Confirm stays disabled until a
// non-whitespace reason is typed; the server enforces the same rule (400 without one), so this is
// a UX guard, not the only guard.

export interface RejectDialogProps {
  api: Pick<ApiClient, "reject">;
  proposal: Proposal;
  /** Called with the server's updated proposal after a successful reject — the caller reconciles
   *  (e.g. re-fetches the queue). */
  onRejected?: (updated: Proposal) => void;
  /** Called on a 409 — "someone else already decided this" — so the caller re-fetches the
   *  list/detail rather than trust this component's own (now-stale) view. */
  onConflict?: () => void;
  notify?: (message: string) => void;
}

type ErrorState = { kind: "conflict" | "other"; message: string } | null;

export function RejectDialog({ api, proposal, onRejected, onConflict, notify }: RejectDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState>(null);

  const trimmedReason = reason.trim();
  const canSubmit = trimmedReason.length > 0 && !busy;

  async function handleConfirm() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const updated = await api.reject(proposal.id, trimmedReason);
      setBusy(false);
      setOpen(false);
      setError(null);
      setReason("");
      notify?.("Rejected — Aria drops it and learns your preference.");
      onRejected?.(updated);
    } catch (e) {
      setBusy(false);
      if (e instanceof ConflictError) {
        setError({ kind: "conflict", message: e.message });
        onConflict?.();
      } else {
        setError({ kind: "other", message: "Reject failed — try again." });
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setError(null); // a fresh open doesn't show a stale conflict banner
        } else {
          setReason(""); // closing without submitting never leaves a typed reason behind
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">Reject</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject this action?</DialogTitle>
        </DialogHeader>
        <p className="text-[13px] text-ink-2">{proposal.rationale}</p>
        <Field
          label="Reason"
          htmlFor="reject-reason"
          className="mt-3"
          help="Required — logged to the audit trail and helps Aria learn your preference."
        >
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you rejecting this?"
          />
        </Field>
        {error && (
          <Note variant="warn" className="mt-1">
            {error.message}
          </Note>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button variant="danger" onClick={handleConfirm} disabled={!canSubmit}>
            {busy ? "Rejecting…" : "Confirm reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
