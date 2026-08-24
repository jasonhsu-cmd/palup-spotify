import * as React from "react";
import { cn } from "../lib/cn";

const controlClass =
  "w-full rounded border border-line bg-surface px-3 py-[10px] text-[13.5px] text-ink outline-none transition-colors focus:border-ever focus:ring-2 focus:ring-ever-tint";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(controlClass, className)} {...props} />
);
Input.displayName = "Input";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(controlClass, className)} {...props} />
));
Select.displayName = "Select";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(controlClass, "min-h-[84px] resize-y", className)} {...props} />
));
Textarea.displayName = "Textarea";

export interface FieldProps {
  label: string;
  help?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}

export function Field({ label, help, htmlFor, children, className }: FieldProps) {
  return (
    <div className={cn("mb-[15px]", className)}>
      <label htmlFor={htmlFor} className="mb-[6px] block text-[12.5px] font-semibold text-ink-2">
        {label}
      </label>
      {children}
      {help && <p className="mt-[5px] text-[11.5px] text-ink-4">{help}</p>}
    </div>
  );
}
