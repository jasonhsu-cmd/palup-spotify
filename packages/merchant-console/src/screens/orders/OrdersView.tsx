import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Note,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@palup/design-system";
import type { ApiClient, OrderView } from "../../app/api";

// W5 Task 11 — Orders screen (spec §9 W5), replacing the /orders stub. READ-THROUGH ONLY: Shopify
// is the system of record for orders; every row's money action ("Manage in Shopify", from
// `adminPath`) is a deep-link out, never an in-app button — refunds/edits/fulfilment happen in
// Shopify. Each row is annotated with per-order agent TOUCHPOINTS (factual: what the agent did),
// never incremental/attributed $ (that is aggregate/billed territory — Revenue Home W2 / billing
// W6 — and is deliberately absent from this screen by governance rule, not by omission). Honest
// loading/ready/error states mirror RevenueHome.tsx; when the read-through port reports
// `source: "unavailable"` we show the real `sourceNote`, never fabricated rows.

export interface OrdersViewProps {
  api: Pick<ApiClient, "getOrders">;
}

type LoadState = "loading" | "ready" | "error";

function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function touchpointLabel(count: number): string {
  if (count === 0) return "No agent activity yet";
  if (count === 1) return "1 agent action";
  return `${count} agent actions`;
}

export function OrdersView({ api }: OrdersViewProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<OrderView[]>([]);
  const [source, setSource] = useState<"live" | "unavailable">("live");
  const [sourceNote, setSourceNote] = useState("");

  const load = useCallback(() => {
    setState("loading");
    api.getOrders().then(
      (res) => {
        setItems(res.items);
        setSource(res.source);
        setSourceNote(res.sourceNote);
        setState("ready");
      },
      () => setState("error"),
    );
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === "loading") {
    return (
      <div role="status" className="p-6 text-[13px] text-ink-3">
        Loading orders…
      </div>
    );
  }

  if (state === "error") {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn&apos;t load orders.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </Note>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Note variant="info">
        Shopify is the system of record for your orders. PalUp shows what your agent did — refunds,
        edits and fulfilment happen in Shopify.
      </Note>

      {source === "unavailable" ? (
        <Note variant="warn">{sourceNote}</Note>
      ) : items.length === 0 ? (
        <Note variant="info">No orders yet.</Note>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Recent orders</CardTitle>
          </CardHeader>
          <CardBody>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Order</TableHeaderCell>
                  <TableHeaderCell>Total</TableHeaderCell>
                  <TableHeaderCell>Payment</TableHeaderCell>
                  <TableHeaderCell>Fulfilment</TableHeaderCell>
                  <TableHeaderCell>Agent activity</TableHeaderCell>
                  <TableHeaderCell>Manage</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{o.orderNumber}</TableCell>
                    <TableCell>{fmtUsd(o.totalUsd)}</TableCell>
                    <TableCell>
                      <Badge variant="gray" dot={false}>
                        {o.financialStatus}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="gray" dot={false}>
                        {o.fulfillmentStatus}
                      </Badge>
                    </TableCell>
                    <TableCell>{touchpointLabel(o.touchpoints.length)}</TableCell>
                    <TableCell>
                      <a href={o.adminPath} target="_blank" rel="noreferrer" className="text-brand underline">
                        Manage in Shopify
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
