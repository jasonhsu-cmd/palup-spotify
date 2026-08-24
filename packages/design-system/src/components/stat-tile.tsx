import * as React from "react";
import { cn } from "../lib/cn";

export interface StatTileProps {
  label: string;
  value: string;
  icon?: React.ReactNode;
  delta?: { direction: "up" | "down"; label: string };
  footnote?: string;
  mono?: boolean;
  className?: string;
}

export function StatTile({ label, value, icon, delta, footnote, mono, className }: StatTileProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border border-line bg-surface p-[18px] shadow-sm",
        className
      )}
    >
      <div className="flex items-center gap-[7px] text-[12px] font-semibold text-ink-3">
        {icon && (
          <span className="grid h-[26px] w-[26px] place-items-center rounded-sm bg-ever-soft text-ever">
            {icon}
          </span>
        )}
        {label}
      </div>
      <div
        className={cn(
          "mt-[11px] font-display text-[30px] font-extrabold leading-none tracking-[-.02em]",
          mono && "font-mono text-[27px] font-semibold"
        )}
      >
        {value}
      </div>
      {delta && (
        <span
          className={cn(
            "mt-[9px] inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[12px] font-bold",
            delta.direction === "up" ? "bg-pos-soft text-pos" : "bg-dang-soft text-dang"
          )}
        >
          {delta.direction === "up" ? "↑" : "↓"} {delta.label}
        </span>
      )}
      {footnote && <div className="mt-[9px] text-[11.5px] text-ink-4">{footnote}</div>}
    </div>
  );
}
