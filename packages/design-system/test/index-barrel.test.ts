import { describe, it, expect } from "vitest";
import * as DesignSystem from "../src/index";

describe("design-system barrel exports", () => {
  it("exposes every component and utility the v1 console screens need", () => {
    const expectedExports = [
      "cn",
      "theme",
      "Button",
      "buttonVariants",
      "Badge",
      "badgeVariants",
      "Card",
      "CardHeader",
      "CardTitle",
      "CardHint",
      "CardBody",
      "StatTile",
      "Field",
      "Input",
      "Select",
      "Textarea",
      "Switch",
      "Note",
      "noteVariants",
      "Tabs",
      "TabsList",
      "TabsTrigger",
      "TabsContent",
      "Table",
      "TableHead",
      "TableBody",
      "TableRow",
      "TableHeaderCell",
      "TableCell",
      "Toaster",
      "useToast",
      "Dialog",
      "DialogTrigger",
      "DialogClose",
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "DialogFooter",
      "AppShell",
      "Sidebar",
    ] as const;

    for (const name of expectedExports) {
      expect(Object.prototype.hasOwnProperty.call(DesignSystem, name)).toBe(true);
    }
  });
});
