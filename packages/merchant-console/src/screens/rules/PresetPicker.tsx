import { useEffect, useState } from "react";
import { Button, Card, CardBody, CardHeader, CardHint, CardTitle, Field, Note, Select } from "@palup/design-system";
import type { MerchantRuleSet, PalupFloor, ProposalCategory, RulePreset } from "@palup/platform-ports";
import type { ApiClient } from "../../app/api";
import { KilledError } from "../../app/api";
import { BigJumpConfirmDialog } from "./BigJumpConfirmDialog";

// Task 10 — adopt a vertical/Day-1 preset from the rules editor. Every preset ships
// `allowedAuto:false` on every money category (rule-presets.ts), so adopting one never
// auto-enables spend on its own — but a preset can still raise a merchant-only dimension (e.g.
// `frequencyCapPerWeek`) past their current setting, so it goes through the exact same
// preview → (maybe) big-jump-confirm → apply flow as a manual save, never a silent bypass.
//
// Self-contained: owns its own preset list, selection, preview, and confirm-dialog state — it
// doesn't touch the parent's `dirty`/`envelope` state directly, only reports the server's saved
// envelope up via `onApplied` once a real `applyRulePreset` call has actually landed.

export interface PresetPickerProps {
  api: Pick<ApiClient, "listRulePresets" | "previewRules" | "applyRulePreset">;
  floors: Record<ProposalCategory, PalupFloor>;
  /** Called with the server's saved envelope after a real, committed adopt (immediate or
   *  confirmed) — never a local echo. */
  onApplied: (envelope: MerchantRuleSet) => void;
}

type LoadState = "loading" | "ready" | "error";

type Pending = { after: MerchantRuleSet; changed: ProposalCategory[]; presetId: string };

function describePresetError(e: unknown): string {
  if (e instanceof KilledError) {
    return "Agents are halted (Kill Switch armed) — rules were not changed";
  }
  return e instanceof Error ? e.message : "Couldn't apply this preset — try again.";
}

export function PresetPicker({ api, floors, onApplied }: PresetPickerProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [presets, setPresets] = useState<RulePreset[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    api.listRulePresets().then(
      (res) => {
        setPresets(res.presets);
        setState("ready");
      },
      () => setState("error"),
    );
  }, [api]);

  const selected = presets.find((p) => p.id === selectedId);

  async function handleApply() {
    if (!selected) return; // nothing selected — never preview/apply a null preset
    setBusy(true);
    setError(null);
    try {
      const preview = await api.previewRules(selected.envelope);
      const changed = Object.keys(selected.envelope) as ProposalCategory[];
      if (preview.bigJump) {
        setPending({ after: preview.after, changed, presetId: selected.id });
      } else {
        const res = await api.applyRulePreset(selected.id);
        onApplied(res.envelope);
      }
    } catch (e) {
      setError(describePresetError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!pending) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      const res = await api.applyRulePreset(pending.presetId);
      onApplied(res.envelope);
      setPending(null);
    } catch (e) {
      setConfirmError(describePresetError(e));
    } finally {
      setConfirmBusy(false);
    }
  }

  function handleCancel() {
    setPending(null);
    setConfirmError(null);
  }

  if (state === "error") {
    return <Note variant="dang">We couldn&apos;t load starting presets — try reloading the page.</Note>;
  }

  // Empty preset list (or still loading) → hide the picker entirely — honest, no placeholder.
  if (state === "loading" || presets.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Start from a preset</CardTitle>
          <CardHint className="mt-1 block">
            Adopt a conservative starting point for your business — you can still edit anything above.
          </CardHint>
        </div>
      </CardHeader>
      <CardBody>
        <Field label="Preset" htmlFor="rules-preset-select">
          <Select id="rules-preset-select" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
            <option value="">Choose a preset…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        {selected && <p className="mb-3 text-[12.5px] text-ink-3">{selected.description}</p>}
        {error && (
          <Note variant="dang" className="mb-3">
            {error}
          </Note>
        )}
        <Button variant="outline" onClick={handleApply} disabled={!selected || busy}>
          {busy ? "Checking…" : "Apply preset"}
        </Button>
      </CardBody>

      {pending && (
        <BigJumpConfirmDialog
          open
          after={pending.after}
          floors={floors}
          changed={pending.changed}
          busy={confirmBusy}
          error={confirmError}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </Card>
  );
}
