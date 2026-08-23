import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardHeader, CardTitle, CardHint, CardBody } from "../src/components/card";

describe("Card", () => {
  it("renders the surface/border/shadow classes on the outer card", () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>What it has learned</CardTitle>
          <CardHint>your store</CardHint>
        </CardHeader>
        <CardBody>Body content</CardBody>
      </Card>
    );
    const card = screen.getByTestId("card");
    expect(card.classList.contains("bg-surface")).toBe(true);
    expect(card.classList.contains("border-line")).toBe(true);
    expect(card.classList.contains("shadow-sm")).toBe(true);
    expect(screen.getByText("What it has learned").tagName).toBe("H3");
    expect(screen.getByText("your store")).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
  });
});
