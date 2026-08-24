import { Card, CardBody, CardHeader, CardHint, CardTitle, Field, Input, Note, Select, Switch } from "@palup/design-system";
import type { CategoryRuleEnvelope, PalupFloor, ProposalCategory, SubscriptionSubAction } from "@palup/platform-ports";
import { cappedWarnings, categoryLabel, describeAutoGrant, floorCeilingText } from "./format";

// Task 9 — one category's three-layer editor (task-9-brief.md). Renders, top to bottom:
//  1. the inviolable PalUp ceiling (read-only, `floorCeilingText`)
//  2. the editable merchant envelope (controlled inputs — every value comes from `envelope`, no
//     fabricated defaults) with a capped-flag `Note` for any field the merchant set above the floor
//  3. the derived effective auto-grant sentence (`describeAutoGrant`), which always reflects the
//     CLAMPED value, never the raw merchant number alone.
// `onChange` reports a partial patch up to the screen; this component never calls the API itself.

export interface CategoryRuleCardProps {
  category: ProposalCategory;
  envelope: CategoryRuleEnvelope;
  floor: PalupFloor;
  onChange: (patch: Partial<CategoryRuleEnvelope>) => void;
}

type FieldKey =
  | "maxPct" | "maxUsd" | "stackable" | "periodBudgetUsd" | "roiFloor"
  | "priceMatchMaxUsd" | "subscriptionSelfServe" | "frequencyCapPerWeek" | "quietHours";

const CATEGORY_FIELDS: Record<ProposalCategory, FieldKey[]> = {
  discount: ["maxPct", "stackable"],
  ad_spend: ["maxUsd", "periodBudgetUsd", "roiFloor"],
  refund: ["maxUsd", "priceMatchMaxUsd"],
  subscription: ["subscriptionSelfServe"],
  campaign: ["frequencyCapPerWeek", "quietHours"],
  autonomy_scope: [],
};

const SUBSCRIPTION_ACTIONS: Array<{ value: SubscriptionSubAction; label: string }> = [
  { value: "pause", label: "Pause" },
  { value: "skip", label: "Skip a shipment" },
  { value: "cancel", label: "Cancel" },
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function numOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function CategoryRuleCard({ category, envelope, floor, onChange }: CategoryRuleCardProps) {
  const fields = CATEGORY_FIELDS[category];
  const has = (k: FieldKey) => fields.includes(k);
  const warnings = cappedWarnings(category, envelope, floor);
  const idFor = (field: string) => `rules-${category}-${field}`;

  function toggleSelfServe(action: SubscriptionSubAction, on: boolean) {
    const current = new Set(envelope.subscriptionSelfServe ?? []);
    if (on) current.add(action);
    else current.delete(action);
    onChange({ subscriptionSelfServe: Array.from(current) });
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{categoryLabel(category)}</CardTitle>
          <CardHint className="mt-1 block">{floorCeilingText(category, floor)}</CardHint>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={idFor("allowedAuto")} className="text-[12.5px] font-semibold text-ink-2">
            Auto-approve
          </label>
          <Switch
            id={idFor("allowedAuto")}
            checked={envelope.allowedAuto}
            onCheckedChange={(checked) => onChange({ allowedAuto: checked })}
          />
        </div>
      </CardHeader>
      <CardBody>
        {has("maxPct") && (
          <Field label="Max % off (auto-approved)" htmlFor={idFor("maxPct")} help="Percent off, per order.">
            <Input
              id={idFor("maxPct")}
              type="number"
              min={0}
              max={100}
              value={envelope.maxPct ?? ""}
              onChange={(e) => onChange({ maxPct: numOrUndefined(e.target.value) })}
            />
          </Field>
        )}
        {has("maxUsd") && (
          <Field
            label={category === "refund" ? "Max auto-refund ($)" : "Max auto-spend per action ($)"}
            htmlFor={idFor("maxUsd")}
          >
            <Input
              id={idFor("maxUsd")}
              type="number"
              min={0}
              value={envelope.maxUsd ?? ""}
              onChange={(e) => onChange({ maxUsd: numOrUndefined(e.target.value) })}
            />
          </Field>
        )}
        {has("stackable") && (
          <div className="mb-[15px] flex items-center justify-between">
            <label htmlFor={idFor("stackable")} className="text-[12.5px] font-semibold text-ink-2">
              Allow stacking with another active promo
            </label>
            <Switch
              id={idFor("stackable")}
              checked={envelope.stackable ?? false}
              onCheckedChange={(checked) => onChange({ stackable: checked })}
            />
          </div>
        )}
        {has("periodBudgetUsd") && (
          <Field label="Rolling-period spend budget ($)" htmlFor={idFor("periodBudgetUsd")} help="e.g. per week.">
            <Input
              id={idFor("periodBudgetUsd")}
              type="number"
              min={0}
              value={envelope.periodBudgetUsd ?? ""}
              onChange={(e) => onChange({ periodBudgetUsd: numOrUndefined(e.target.value) })}
            />
          </Field>
        )}
        {has("roiFloor") && (
          <Field label="Minimum ROI to auto-buy (×)" htmlFor={idFor("roiFloor")}>
            <Input
              id={idFor("roiFloor")}
              type="number"
              min={0}
              step="0.1"
              value={envelope.roiFloor ?? ""}
              onChange={(e) => onChange({ roiFloor: numOrUndefined(e.target.value) })}
            />
          </Field>
        )}
        {has("priceMatchMaxUsd") && (
          <Field label="Max auto price-match ($)" htmlFor={idFor("priceMatchMaxUsd")}>
            <Input
              id={idFor("priceMatchMaxUsd")}
              type="number"
              min={0}
              value={envelope.priceMatchMaxUsd ?? ""}
              onChange={(e) => onChange({ priceMatchMaxUsd: numOrUndefined(e.target.value) })}
            />
          </Field>
        )}
        {has("frequencyCapPerWeek") && (
          <Field label="Max auto-sends per shopper / week" htmlFor={idFor("frequencyCapPerWeek")}>
            <Input
              id={idFor("frequencyCapPerWeek")}
              type="number"
              min={0}
              value={envelope.frequencyCapPerWeek ?? ""}
              onChange={(e) => onChange({ frequencyCapPerWeek: numOrUndefined(e.target.value) })}
            />
          </Field>
        )}
        {has("quietHours") && (
          <div className="mb-[15px]">
            <div className="mb-[6px] flex items-center justify-between">
              <span className="text-[12.5px] font-semibold text-ink-2">Quiet hours (no auto-sends)</span>
              <Switch
                id={idFor("quietHoursEnabled")}
                checked={envelope.quietHours !== undefined}
                onCheckedChange={(checked) =>
                  onChange({ quietHours: checked ? { startHour: 21, endHour: 9 } : undefined })
                }
              />
            </div>
            {envelope.quietHours && (
              <div className="flex items-center gap-2">
                <Select
                  aria-label="Quiet hours start"
                  value={envelope.quietHours.startHour}
                  onChange={(e) =>
                    onChange({ quietHours: { ...envelope.quietHours!, startHour: Number(e.target.value) } })
                  }
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>{h}:00</option>
                  ))}
                </Select>
                <span className="text-[12.5px] text-ink-3">to</span>
                <Select
                  aria-label="Quiet hours end"
                  value={envelope.quietHours.endHour}
                  onChange={(e) =>
                    onChange({ quietHours: { ...envelope.quietHours!, endHour: Number(e.target.value) } })
                  }
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>{h}:00</option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        )}
        {has("subscriptionSelfServe") && (
          <div className="mb-[15px]">
            <span className="mb-[6px] block text-[12.5px] font-semibold text-ink-2">
              Self-serve actions the agent may take unattended
            </span>
            <div className="flex flex-col gap-2">
              {SUBSCRIPTION_ACTIONS.map((a) => (
                <div key={a.value} className="flex items-center justify-between">
                  <label htmlFor={idFor(`selfServe-${a.value}`)} className="text-[13px] text-ink-2">
                    {a.label}
                  </label>
                  <Switch
                    id={idFor(`selfServe-${a.value}`)}
                    checked={(envelope.subscriptionSelfServe ?? []).includes(a.value)}
                    onCheckedChange={(checked) => toggleSelfServe(a.value, checked)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {warnings.map((w) => (
          <Note key={w} variant="warn" className="mb-[10px]">
            {w}
          </Note>
        ))}

        <Note variant="info">{describeAutoGrant(category, envelope, floor)}</Note>
      </CardBody>
    </Card>
  );
}
