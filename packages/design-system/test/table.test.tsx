import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../src/components/table";

describe("Table", () => {
  it("renders uppercase header cells and body rows with the right cell count", () => {
    render(
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Insight</TableHeaderCell>
            <TableHeaderCell>Confidence</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>First-time buyers convert 2x with a sample add-on</TableCell>
            <TableCell>High</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    const headerCell = screen.getByText("Insight");
    expect(headerCell.tagName).toBe("TH");
    expect(headerCell.classList.contains("uppercase")).toBe(true);
    const bodyCell = screen.getByText("High");
    expect(bodyCell.tagName).toBe("TD");
    expect(document.querySelectorAll("td").length).toBe(2);
  });
});
