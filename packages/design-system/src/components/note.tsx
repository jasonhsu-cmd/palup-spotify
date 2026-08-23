import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// The original substitution here ("use the base saturated token instead of the mockup's
// hand-written on-tint hexes") fails WCAG AA on the soft backgrounds: text-info/warn/dang on
// their *-soft backgrounds measure ~4.39:1 / ~2.80:1 / ~3.98:1 — all below the 4.5:1 AA-normal
// bar, on copy like "Kill switch engaged." Accessibility overrides that substitution: the
// mockup's own on-tint inks (#1B4596/#8A5A06/#9E261A) are now real, named, AA-compliant tokens
// (`note-info-ink`/`note-warn-ink`/`note-dang-ink` in tokens.css, ~7.7:1 / ~5.2:1 / ~6.4:1) —
// see docs/DESIGN-SYSTEM.md. `ever` already uses the base `ever` token, which clears AA on
// `ever-soft` (~8.75:1), so it is unchanged.
export const noteVariants = cva("flex gap-[11px] rounded px-[15px] py-[13px] text-[13px] leading-[1.5]", {
  variants: {
    variant: {
      info: "bg-info-soft text-note-info-ink",
      warn: "bg-warn-soft text-note-warn-ink",
      ever: "bg-ever-soft text-ever",
      dang: "bg-dang-soft text-note-dang-ink",
    },
  },
  defaultVariants: { variant: "info" },
});

export interface NoteProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof noteVariants> {
  icon?: React.ReactNode;
}

export function Note({ className, variant, icon, children, ...props }: NoteProps) {
  return (
    <div className={cn(noteVariants({ variant }), className)} {...props}>
      {icon && <span className="mt-[1px] h-[18px] w-[18px] shrink-0">{icon}</span>}
      <div>{children}</div>
    </div>
  );
}
