import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../lib/cn";

// Tracks the active tab value in a plain React context (in parallel with Radix's own internal
// context) so TabsTrigger can apply a literal `bg-surface` class for the active trigger — not
// just a `data-[state=active]:` compound Tailwind class. Radix does set data-state on the DOM
// node, and a real Tailwind build would style it correctly either way, but this design system's
// component tests assert on the *raw* class list (see test/tabs.test.tsx), which only ever
// contains literal, unprefixed class tokens elsewhere in this package (see Switch/Badge). Mirrors
// that convention instead of asserting on data-state alone, since the mockup's segmented control
// needs the active pill to be visually unmistakable, not just CSS-selector-correct.
const TabsActiveValueContext = React.createContext<string | undefined>(undefined);

export const TabsContent = TabsPrimitive.Content;

export const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ value, defaultValue, onValueChange, children, ...props }, ref) => {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
  const activeValue = value ?? uncontrolledValue;

  return (
    <TabsPrimitive.Root
      ref={ref}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        setUncontrolledValue(next);
        onValueChange?.(next);
      }}
      {...props}
    >
      <TabsActiveValueContext.Provider value={activeValue}>{children}</TabsActiveValueContext.Provider>
    </TabsPrimitive.Root>
  );
});
Tabs.displayName = "Tabs";

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex w-fit gap-1 rounded bg-surface-3 p-1", className)}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, value, ...props }, ref) => {
  const activeValue = React.useContext(TabsActiveValueContext);
  const isActive = activeValue === value;

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      className={cn(
        "rounded-sm px-[14px] py-[7px] text-[13px] font-semibold transition-colors",
        isActive ? "bg-surface text-ink shadow-sm" : "text-ink-3",
        className
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = "TabsTrigger";
