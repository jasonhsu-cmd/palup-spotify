import * as React from "react";
import { cn } from "../lib/cn";

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse", className)} {...props} />;
}

export function TableHead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn(className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn(className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn("transition-colors hover:bg-surface-2 [&:last-child>td]:border-b-0", className)}
      {...props}
    />
  );
}

export function TableHeaderCell({
  className,
  scope = "col",
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement>) {
  // Governance data tables (Approval Center, Audit Log, Eval Dashboard) need every header cell
  // programmatically associated with its column for screen readers; scope="col" is the common
  // case, so it's the default here, still overridable (e.g. scope="row" on a row-header cell).
  return (
    <th
      scope={scope}
      className={cn(
        "border-b border-line px-[14px] py-[11px] text-left text-[11px] font-bold uppercase tracking-[.06em] text-ink-4",
        className
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("border-b border-line-2 px-[14px] py-[13px] align-middle text-[13.5px]", className)} {...props} />
  );
}
