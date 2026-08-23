import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// Radii: the mockup's .btn uses an untokenized 10px; rounded to the nearest defined radius
// token (rounded = 12px) per this plan's "Global Constraints" rounding rule.
export const buttonVariants = cva(
  "inline-flex items-center gap-2 whitespace-nowrap rounded font-semibold text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ever-tint",
  {
    variants: {
      variant: {
        primary: "bg-ever text-white hover:bg-ever-2 hover:shadow",
        dark: "bg-ink text-white hover:bg-ink-2",
        outline: "bg-surface border border-line text-ink hover:border-ink-4",
        ghost: "bg-transparent text-ink-2 hover:bg-surface-3",
        coral: "bg-coral text-white hover:brightness-95",
        danger: "bg-dang text-white hover:brightness-95",
      },
      size: {
        default: "px-[15px] py-[9px]",
        sm: "rounded-sm px-[11px] py-[6px] text-[12.5px]",
      },
      block: {
        true: "w-full justify-center",
        false: "",
      },
    },
    defaultVariants: { variant: "primary", size: "default", block: false },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render as the child element instead of a <button> (Radix Slot pattern). */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, block, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, block }), className)}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";
