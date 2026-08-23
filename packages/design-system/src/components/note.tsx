import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// The mockup hand-writes bespoke on-tint text hexes for .note (#1B4596/#8A5A06/#9E261A) that
// are not in tokens.css. Per this plan's "Global Constraints", the base saturated token color
// is used instead of hand-copying those hexes.
export const noteVariants = cva("flex gap-[11px] rounded px-[15px] py-[13px] text-[13px] leading-[1.5]", {
  variants: {
    variant: {
      info: "bg-info-soft text-info",
      warn: "bg-warn-soft text-warn",
      ever: "bg-ever-soft text-ever",
      dang: "bg-dang-soft text-dang",
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
