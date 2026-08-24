import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// The mockup's .bdg uses a 20px pill radius; rounded-full is the token-free, semantically
// correct way to express "fully rounded" rather than inventing a fifth radius value.
export const badgeVariants = cva(
  "inline-flex items-center gap-[5px] rounded-full px-[9px] py-[3px] text-[11.5px] font-bold tracking-[.01em]",
  {
    variants: {
      variant: {
        ever: "bg-ever-soft text-ever",
        pos: "bg-pos-soft text-pos",
        warn: "bg-warn-soft text-warn",
        dang: "bg-dang-soft text-dang",
        info: "bg-info-soft text-info",
        gold: "bg-gold-soft text-gold",
        gray: "bg-surface-3 text-ink-2",
        coral: "bg-coral-soft text-coral",
      },
    },
    defaultVariants: { variant: "gray" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Shows the small status dot before the label. Defaults to true, matching the mockup. */
  dot?: boolean;
}

export function Badge({ className, variant, dot = true, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
