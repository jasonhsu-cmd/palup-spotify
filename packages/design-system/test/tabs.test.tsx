import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../src/components/tabs";

describe("Tabs", () => {
  it("shows the default tab's content and marks its trigger active", () => {
    render(
      <Tabs defaultValue="customers">
        <TabsList>
          <TabsTrigger value="customers">Customers</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
        </TabsList>
        <TabsContent value="customers">Customer insights</TabsContent>
        <TabsContent value="products">Product insights</TabsContent>
      </Tabs>
    );
    expect(screen.getByText("Customer insights")).toBeTruthy();
    expect(screen.queryByText("Product insights")).toBeNull();
    const active = screen.getByRole("tab", { name: "Customers" });
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(active.classList.contains("bg-surface")).toBe(true);
  });

  it("switches content and active state on click", async () => {
    render(
      <Tabs defaultValue="customers">
        <TabsList>
          <TabsTrigger value="customers">Customers</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
        </TabsList>
        <TabsContent value="customers">Customer insights</TabsContent>
        <TabsContent value="products">Product insights</TabsContent>
      </Tabs>
    );
    await userEvent.click(screen.getByRole("tab", { name: "Products" }));
    expect(screen.getByText("Product insights")).toBeTruthy();
    expect(screen.queryByText("Customer insights")).toBeNull();
  });
});
