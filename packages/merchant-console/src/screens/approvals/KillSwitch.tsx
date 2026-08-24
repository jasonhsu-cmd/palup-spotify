import { useEffect, useState } from "react";
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
import { ApiError } from "../../app/api";

// T6 (Kill Switch control): the merchant's own instance of governance non-negotiable #4 — "any
// agent, at any scope, can be halted instantly, and an operator can never be blocked from stopping
// it." This component is a CONTROLLED view over the real kill state (`killed` prop): it never
// invents/caches its own boolean across renders — the caller (the Approval Center screen, via
// `useApprovalsLive`'s `getKill()`-sourced value) is the single fetch loop for that state, so
// KillSwitch and `ApproveDialog`'s `killed` prop (T4/T7) can never disagree about whether agents
// are actually halted.
//
// Halting requires a REQUIRED reason (mirrors the server's own 400-without-one guard in
// `routes/kill.ts`) — logged to the audit trail, so a later reviewer knows why. RESUMING is the
// more dangerous direction (re-enabling live autonomous execution) and is gated server-side at
// manager+ (`requireRole("manager")`, `routes/kill.ts`); a caller without that role gets a real
// 403, surfaced here as an honest, specific message rather than a generic failure or — worse — a
// banner that silently clears as if the resume had worked.

export interface KillSwitchProps {
  api: Pick<ApiClient, "kill" | "unkill">;
  /** The real, current kill state — never derived locally. */
  killed: boolean;
  /** Called once a kill/unkill call has actually committed server-side — the caller re-fetches
   *  `getKill()` (the source of truth) rather than this component optimistically flipping a bit. */
  onChanged?: () => void;
  notify?: (message: string) => void;
}

type DialogMode = "halt" | "resume" | null;
type ActionError = { message: string } | null;

export function KillSwitch({ api, killed, onChanged, notify }: KillSwitchProps) {
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [haltReason, setHaltReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [haltError, setHaltError] = useState<ActionError>(null);
  const [resumeError, setResumeError] = useState<ActionError>(null);
  const [lastReason, setLastReason] = useState<string | undefined>(undefined);

  // The server's `GET /kill` carries no reason (routes/kill.ts) — this session's own halt reason
  // is a local nicety for the banner text, never a source of truth; it clears the instant the real
  // state (the `killed` prop) reports resumed, rather than persisting a stale reason.
  useEffect(() => {
    if (!killed) setLastReason(undefined);
  }, [killed]);

  async function confirmHalt() {
    const trimmed = haltReason.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.kill(trimmed);
      setLastReason(trimmed);
      setBusy(false);
      setDialog(null);
      setHaltReason("");
      setHaltError(null);
      notify?.("Agents halted.");
      onChanged?.();
    } catch (e) {
      setBusy(false);
      setHaltError({
        message:
          e instanceof ApiError && e.status === 403
            ? "you don't have permission to halt agents"
            : "Halt failed — try again.",
      });
    }
  }

  async function confirmResume() {
    setBusy(true);
    try {
      await api.unkill();
      setBusy(false);
      setDialog(null);
      setResumeError(null);
      notify?.("Agents resumed.");
      onChanged?.();
    } catch (e) {
      setBusy(false);
      setResumeError({
        message:
          e instanceof ApiError && e.status === 403
            ? "you don't have permission to resume"
            : "Resume failed — try again.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {killed && (
        <Note variant="dang" role="alert" aria-live="assertive">
          <p className="font-semibold">Agents halted</p>
          <p className="mt-1">
            {lastReason ? lastReason : "All outbound agent actions and autonomous execution are stopped."}
          </p>
        </Note>
      )}

      {!killed ? (
        <Dialog
          open={dialog === "halt"}
          onOpenChange={(next) => {
            setDialog(next ? "halt" : null);
            if (next) setHaltError(null);
            else setHaltReason("");
          }}
        >
          <DialogTrigger asChild>
            <Button variant="danger">Halt all agents</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Halt all agents?</DialogTitle>
            </DialogHeader>
            <p className="text-[13px] text-ink-2">
              Instantly stops every outbound agent action and autonomous execution — messages,
              sends, offers, payments. In-progress work pauses. You can resume anytime.
            </p>
            <Field
              label="Reason"
              htmlFor="kill-reason"
              className="mt-3"
              help="Required — logged to the audit trail."
            >
              <Textarea
                id="kill-reason"
                value={haltReason}
                onChange={(e) => setHaltReason(e.target.value)}
                placeholder="Why are you halting agents?"
              />
            </Field>
            {haltError && (
              <Note variant="warn" className="mt-1">
                {haltError.message}
              </Note>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                onClick={confirmHalt}
                disabled={busy || haltReason.trim().length === 0}
              >
                {busy ? "Halting…" : "Confirm halt"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : (
        <Dialog
          open={dialog === "resume"}
          onOpenChange={(next) => {
            setDialog(next ? "resume" : null);
            if (next) setResumeError(null);
          }}
        >
          <DialogTrigger asChild>
            <Button variant="primary">Resume agents</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Resume agents?</DialogTitle>
            </DialogHeader>
            <p className="text-[13px] text-ink-2">
              This re-enables autonomous execution for every agent on your store.
            </p>
            {resumeError && (
              <Note variant="warn" className="mt-2">
                {resumeError.message}
              </Note>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button variant="primary" onClick={confirmResume} disabled={busy}>
                {busy ? "Resuming…" : "Confirm resume"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
