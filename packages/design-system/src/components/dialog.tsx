import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* bg-ink/40 mirrors the mockup's .cust-scrim rgba(22,32,27,.4) via Tailwind's opacity
        modifier on the `ink` token color, rather than a new raw rgba() value. */}
    <DialogPrimitive.Overlay className="fixed inset-0 z-[200] bg-ink/40" />
    <DialogPrimitive.Content
      ref={ref}
      // The installed @radix-ui/react-dialog (1.1.23) traps focus (FocusScope trapFocus=true)
      // and closes on Escape (DismissableLayer) by default, but does not itself stamp
      // aria-modal on the content node — set it explicitly so screen readers announce this as
      // a true modal, per the governance-surfaces a11y requirement (Kill Switch / approve-deny
      // confirms must be unambiguous).
      aria-modal="true"
      className={cn(
        "fixed left-1/2 top-1/2 z-[210] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-5 shadow-lg",
        className
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-3", className)} {...props} />;
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-[15.5px] font-semibold", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-4 flex justify-end gap-2", className)} {...props} />;
}
