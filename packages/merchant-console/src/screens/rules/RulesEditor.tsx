import { useCallback, useEffect, useState } from "react";
import { Button, Note } from "@palup/design-system";
import type { ApiClient } from "../../app/api";
import { KilledError } from "../../app/api";
import type { CategoryRuleEnvelope, MerchantRuleSet, PalupFloor, ProposalCategory } from "@palup/platform-ports";
import { BigJumpConfirmDialog } from "./BigJumpConfirmDialog";
import { CategoryRuleCard } from "./CategoryRuleCard";
import { PresetPicker } from "./PresetPicker";
import { categoryLabel, describeAutoGrant } from "./format";

// Task 9 — the Automation Rules editor screen, replacing the `/rules` stub (App.tsx). Matches the
// ApprovalCenter/LearnedView idiom: takes `{ api }`, loads on mount, holds loading/error state,
// never fabricates a number — everything rendered comes from `getRules`/`getFloors`.
//
// m2 (plan/skeleton mismatch, reconciled per task-9-brief.md): the plan prose mentions
// `Promise.all([getRules, getFloors, listRulePresets])`, but this screen only needs the first two —
// the preset PICKER is Task 10's UI (mounted in the marked slot below). Calling `listRulePresets`
// here would fetch data this screen never renders, so it does not.
//
// autonomy_scope is intentionally omitted (never merchant-editable — see PALUP_FLOORS' own comment:
// it is the unmapped-action fallback bucket, pinned to 0 by floor, not a real rule surface).
const EDITABLE: ProposalCategory[] = ["discount", "ad_spend", "refund", "subscription", "campaign"];

export interface RulesEditorProps {
  api: Pick<
    ApiClient,
    "getRules" | "getFloors" | "putRules" | "previewRules" | "listRulePresets" | "applyRulePreset"
  >;
}

type LoadState = "loading" | "ready" | "error";

/** An in-flight big-jump confirm for the "Save changes" path — `previewRules(dirty)` flagged this
 *  patch, so `putRules` is held until the merchant explicitly confirms in `BigJumpConfirmDialog`. */
type PendingSave = { after: MerchantRuleSet; changed: ProposalCategory[] };

/** Honest error mapping shared by every mutating call this screen makes (`putRules`): a
 *  `KilledError` is not a generic failure — the halt is real system state (CLAUDE.md §3.4) and
 *  says so plainly, never dressed up as a transient "try again". Everything else falls back to
 *  the thrown message (`ApiError`/`ConflictError` already carry an honest one) or a generic note. */
function describeSaveError(e: unknown): string {
  if (e instanceof KilledError) {
    return "Agents are halted (Kill Switch armed) — rules were not changed";
  }
  return e instanceof Error ? e.message : "Couldn't save your rules — try again.";
}

export function RulesEditor({ api }: RulesEditorProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [envelope, setEnvelope] = useState<MerchantRuleSet | null>(null);
  const [floors, setFloors] = useState<Record<ProposalCategory, PalupFloor> | null>(null);
  const [dirty, setDirty] = useState<MerchantRuleSet>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  // Task 10 — the big-jump confirm dialog for the "Save changes" path (the preset picker owns its
  // own instance of the same dialog for its own flow, see PresetPicker.tsx).
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState("loading");
    setSaveError(null);
    setSaveNote(null);
    Promise.all([api.getRules(), api.getFloors()]).then(
      ([r, f]) => {
        setEnvelope(r.envelope);
        setFloors(f.floors);
        setDirty({});
        setState("ready");
      },
      () => setState("error"),
    );
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  function onChange(cat: ProposalCategory, patch: Partial<CategoryRuleEnvelope>) {
    setSaveNote(null);
    setDirty((d) => ({
      ...d,
      [cat]: { ...(envelope![cat] ?? { allowedAuto: false }), ...(d[cat] ?? {}), ...patch },
    }));
  }

  /** The actual mutating save — only ever reached directly (non-big-jump) or after an explicit
   *  confirm (big-jump). Never called speculatively from `onSave` itself. */
  async function commitSave(patch: MerchantRuleSet) {
    const res = await api.putRules(patch);
    const changed = Object.keys(patch) as ProposalCategory[];
    const summary = changed
      .map((cat) => {
        const eff = res.envelope[cat] ?? { allowedAuto: false };
        return `${categoryLabel(cat)} — ${describeAutoGrant(cat, eff, floors![cat])}`;
      })
      .join(" ");
    setEnvelope(res.envelope);
    setDirty({});
    setSaveNote(`Saved. ${summary}`);
  }

  // Task 10 — the sovereign-but-confirmed save (task-10-brief.md): `previewRules(dirty)` runs
  // read-only first. A `bigJump` verdict opens `BigJumpConfirmDialog` (stating the EFFECTIVE
  // values from `preview.after`) and `putRules` is held until the merchant explicitly confirms.
  // A non-big-jump change applies immediately — sovereign + instant, no dialog in the way.
  async function onSave() {
    if (Object.keys(dirty).length === 0 || !floors) return;
    setSaving(true);
    setSaveError(null);
    setSaveNote(null);
    try {
      const preview = await api.previewRules(dirty);
      if (preview.bigJump) {
        setPendingSave({ after: preview.after, changed: Object.keys(dirty) as ProposalCategory[] });
      } else {
        await commitSave(dirty);
      }
    } catch (e) {
      setSaveError(describeSaveError(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmSave() {
    if (!pendingSave) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await commitSave(dirty);
      setPendingSave(null);
    } catch (e) {
      setConfirmError(describeSaveError(e));
    } finally {
      setConfirmBusy(false);
    }
  }

  function handleCancelSave() {
    setPendingSave(null);
    setConfirmError(null);
  }

  if (state === "error") {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>We couldn&apos;t load your rules. Please retry.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </Note>
    );
  }

  if (state === "loading" || !envelope || !floors) {
    return (
      <div role="status" className="p-6 text-[13px] text-ink-3">
        Loading your rules…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-xl font-semibold text-ink">Automation Rules</h1>
        <p className="mt-1 text-sm text-ink-3">
          Pre-authorize routine actions so your agent can move fast without pinging you — but only inside
          limits you set. Creating a rule is itself logged for audit.
        </p>
      </div>
      <Note variant="ever">
        Rules let you trade some control for speed — safely. Anything above a rule&apos;s limit still comes
        to your Approval Center. You can pause any rule instantly.
      </Note>

      {saveNote && <Note variant="ever">{saveNote}</Note>}
      {saveError && <Note variant="dang">{saveError}</Note>}

      {EDITABLE.map((cat) => (
        <CategoryRuleCard
          key={cat}
          category={cat}
          envelope={{ ...(envelope[cat] ?? { allowedAuto: false }), ...(dirty[cat] ?? {}) }}
          floor={floors[cat]}
          onChange={(patch) => onChange(cat, patch)}
        />
      ))}

      <PresetPicker
        api={api}
        floors={floors}
        onApplied={(appliedEnvelope) => {
          setEnvelope(appliedEnvelope);
          setDirty({});
          setSaveError(null);
          setSaveNote("Preset applied.");
        }}
      />

      <Button variant="primary" onClick={onSave} disabled={Object.keys(dirty).length === 0 || saving}>
        {saving ? "Saving…" : "Save changes"}
      </Button>

      {pendingSave && (
        <BigJumpConfirmDialog
          open
          after={pendingSave.after}
          floors={floors}
          changed={pendingSave.changed}
          busy={confirmBusy}
          error={confirmError}
          onConfirm={handleConfirmSave}
          onCancel={handleCancelSave}
        />
      )}
    </div>
  );
}
