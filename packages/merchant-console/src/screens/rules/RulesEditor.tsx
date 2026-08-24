import { useCallback, useEffect, useState } from "react";
import { Button, Note } from "@palup/design-system";
import type { ApiClient } from "../../app/api";
import type { CategoryRuleEnvelope, MerchantRuleSet, PalupFloor, ProposalCategory } from "@palup/platform-ports";
import { CategoryRuleCard } from "./CategoryRuleCard";
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
  api: Pick<ApiClient, "getRules" | "getFloors" | "putRules">;
}

type LoadState = "loading" | "ready" | "error";

export function RulesEditor({ api }: RulesEditorProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [envelope, setEnvelope] = useState<MerchantRuleSet | null>(null);
  const [floors, setFloors] = useState<Record<ProposalCategory, PalupFloor> | null>(null);
  const [dirty, setDirty] = useState<MerchantRuleSet>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

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

  async function onSave() {
    if (Object.keys(dirty).length === 0 || !floors) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.putRules(dirty);
      const changed = Object.keys(dirty) as ProposalCategory[];
      const summary = changed
        .map((cat) => {
          const eff = res.envelope[cat] ?? { allowedAuto: false };
          return `${categoryLabel(cat)} — ${describeAutoGrant(cat, eff, floors[cat])}`;
        })
        .join(" ");
      setEnvelope(res.envelope);
      setDirty({});
      setSaveNote(res.bigJump ? `Saved — this is a bigger jump in autonomy. ${summary}` : `Saved. ${summary}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't save your rules — try again.");
    } finally {
      setSaving(false);
    }
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

      {/* Task 10: preset picker mounts here, alongside the big-jump confirm dialog before this Save
          call — this screen's onSave already exists so Task 10 wires a confirm step in front of it
          rather than reshaping this file. */}
      <Button variant="primary" onClick={onSave} disabled={Object.keys(dirty).length === 0 || saving}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
