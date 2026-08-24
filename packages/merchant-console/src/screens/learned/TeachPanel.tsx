import { useState } from "react";
import { Button, Field, Input, Note, Select, Textarea } from "@palup/design-system";
import type { ApiClient, LearnedCategory, LearnedInsight } from "../../app/api";
import { ApiError } from "../../app/api";

// W3 Task 8 — "Teach your agent" (matches palup-merchant-app.html #learned's side card copy: "Add
// a fact or rule. Pinned facts always override inferred ones."). Every teach is a real POST
// through `teachLearned` — no local echo pretends to be a stored insight; the parent re-fetches
// (`onTaught`) so the list always reflects the server's own record.
//
// Safety floor (spec §10, `isSafetyFloorViolation` in @palup/platform-ports): a policy teaching
// may TIGHTEN a safety-critical guardrail but never loosen one — the backend enforces this and
// returns a 400, which the real ApiClient surfaces as a typed `ApiError` (never one of the
// 409/423 special cases). This panel renders that message inline and keeps the merchant's typed
// text in place — a rejection is not a crash and not a silent data loss.

const CATEGORY_OPTIONS: Array<{ value: LearnedCategory; label: string }> = [
  { value: "customers", label: "Customers" },
  { value: "products", label: "Products" },
  { value: "voice", label: "Voice" },
  { value: "policies", label: "Policies" },
];

export interface TeachPanelProps {
  api: Pick<ApiClient, "teachLearned">;
  onTaught?: (insight: LearnedInsight) => void;
}

export function TeachPanel({ api, onTaught }: TeachPanelProps) {
  const [category, setCategory] = useState<LearnedCategory>("customers");
  const [text, setText] = useState("");
  const [guardrailKey, setGuardrailKey] = useState("");
  const [stance, setStance] = useState<"tighten" | "loosen">("tighten");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isPolicy = category === "policies";
  const canSubmit = text.trim().length > 0 && !busy;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const { insight } = await api.teachLearned({
        category,
        text: text.trim(),
        ...(isPolicy && guardrailKey.trim() ? { guardrailKey: guardrailKey.trim() } : {}),
        ...(isPolicy ? { stance } : {}),
      });
      setText("");
      setGuardrailKey("");
      setSuccess(true);
      onTaught?.(insight);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't add this to memory — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-line bg-surface p-[18px] shadow-sm">
      <h3 className="mb-[6px] text-[15px] font-semibold text-ink">Teach your agent</h3>
      <p className="mb-3 text-[12.5px] text-ink-3">
        Add a fact or rule. Pinned facts always override inferred ones.
      </p>

      <Field label="Category" htmlFor="teach-category">
        <Select
          id="teach-category"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value as LearnedCategory);
            setError(null);
          }}
        >
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>

      {isPolicy && (
        <>
          <Field label="Guardrail (optional)" htmlFor="teach-guardrail" help="e.g. refund_cap, discount_depth">
            <Input
              id="teach-guardrail"
              value={guardrailKey}
              onChange={(e) => setGuardrailKey(e.target.value)}
              placeholder="refund_cap"
            />
          </Field>
          <Field label="Stance" htmlFor="teach-stance">
            <Select id="teach-stance" value={stance} onChange={(e) => setStance(e.target.value as "tighten" | "loosen")}>
              <option value="tighten">Tighten</option>
              <option value="loosen">Loosen</option>
            </Select>
          </Field>
        </>
      )}

      <Field label="Teach your agent" htmlFor="teach-text">
        <Textarea
          id="teach-text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSuccess(false);
          }}
          placeholder="e.g. We never discount the Pro Serum — position the bundle instead."
        />
      </Field>

      {error && (
        <Note variant="dang" className="mb-3">
          {error}
        </Note>
      )}
      {success && !error && (
        <Note variant="ever" className="mb-3">
          Added to memory.
        </Note>
      )}

      <Button type="submit" variant="primary" block disabled={!canSubmit}>
        {busy ? "Adding…" : "Add to memory"}
      </Button>
    </form>
  );
}
