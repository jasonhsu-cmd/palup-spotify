import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Note,
} from "@palup/design-system";
import type { MerchantRuleSet, PalupFloor, ProposalCategory } from "@palup/platform-ports";
import { categoryLabel, describeAutoGrant } from "./format";

// Task 10 — the big-jump CONFIRM dialog (spec's big-jump-confirm requirement): before a save or
// preset-adopt that `previewRules` flags as a meaningfully larger grant of autonomy actually
// takes effect, the merchant sees plainly what it means — the EFFECTIVE "your agent can act up to
// X" sentence per changed category, run through the SAME `describeAutoGrant`/`localClampToFloor`
// path Task 9 built (format.ts), never a second, independently-computed copy of the clamp math.
// `after` is the previewed, merged-but-UNCLAMPED envelope (`previewRules().after`) —
// `describeAutoGrant` itself clamps to the floor, so passing an already-clamped value here would
// double-clamp (harmless but wrong layering); passing the raw merchant proposal would be the
// actual honesty bug this dialog exists to prevent.
//
// Fully controlled by the caller (`open`/`onConfirm`/`onCancel`) — this component owns no
// async/API state of its own. `Dialog` is composed as a FAMILY (m3: Dialog, DialogClose,
// DialogContent, DialogFooter, DialogHeader, DialogTitle), matching the ApproveDialog/RejectDialog
// idiom, not written as one monolithic component. Any way of leaving without clicking Confirm —
// Cancel, overlay click, Escape — routes through `onOpenChange(false)` to `onCancel`, so a
// mutating call (`putRules`/`applyRulePreset`) only ever follows an explicit Confirm click.

export interface BigJumpConfirmDialogProps {
  open: boolean;
  /** The previewed, merged-but-unclamped envelope (`previewRules().after`). */
  after: MerchantRuleSet;
  floors: Record<ProposalCategory, PalupFloor>;
  /** Which categories changed (e.g. `Object.keys(dirty)` or a preset's own category keys) — only
   *  these get a sentence; untouched categories stay out of the confirm. */
  changed: ProposalCategory[];
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BigJumpConfirmDialog({
  open,
  after,
  floors,
  changed,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: BigJumpConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>You&apos;re giving your agent more room:</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-2 text-[13px] text-ink-2">
          {changed.map((cat) => {
            const env = after[cat] ?? { allowedAuto: false };
            return (
              <li key={cat}>
                <span className="font-semibold text-ink">{categoryLabel(cat)}</span> —{" "}
                {describeAutoGrant(cat, env, floors[cat])}
              </li>
            );
          })}
        </ul>
        {error && (
          <Note variant="dang" className="mt-3">
            {error}
          </Note>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>
            {busy ? "Applying…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
