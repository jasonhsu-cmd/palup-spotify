import { Note } from "@palup/design-system";
import type { OnboardingHandoff } from "../../app/api";

// W2 T7: the signup→console handoff card (mockup #onboard-handoff). Rendered ONLY when the API
// returned a real handoff object written by onboarding (D7) — never fabricated. The sourceNote is
// the cross-plane transparency line ("from your signup conversation… kept separate from your
// customers' data") and always renders with the card.

export interface HandoffCardProps {
  handoff: OnboardingHandoff;
  onDismiss: () => void;
}

export function HandoffCard({ handoff, onDismiss }: HandoffCardProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-ever bg-surface shadow-sm">
      <div className="flex items-center justify-between gap-3 bg-ever px-[18px] py-[13px] text-white">
        <b className="text-[14px]">{handoff.headline}</b>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="cursor-pointer text-[20px] leading-none opacity-85"
        >
          ×
        </button>
      </div>
      <div className="px-[18px] py-4">
        <div className="mb-[15px] flex flex-col gap-[10px]">
          {handoff.items.map((item) => (
            <div key={item.label} className="flex items-start gap-[10px]">
              <span
                aria-hidden="true"
                className="mt-[1px] grid h-[22px] w-[22px] flex-shrink-0 place-items-center rounded-full bg-ever-soft text-ever"
              >
                ✓
              </span>
              <div>
                <b className="text-[13px]">{item.label}</b>
                <div className="text-[12.5px] text-ink-3">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
        <Note variant="info" className="text-[11.5px]">
          {handoff.sourceNote}
        </Note>
      </div>
    </div>
  );
}
