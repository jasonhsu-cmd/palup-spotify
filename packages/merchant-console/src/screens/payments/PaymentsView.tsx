import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Note,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@palup/design-system";
import type { ApiClient, PaymentsView } from "../../app/api";

// W5 Task 12 — Payments & Payouts screen (spec §9 W5): the TRUST ANCHOR. Shopify payouts are
// read-through (PalUp never touches this money — payouts flow merchant<->Shopify, this screen
// only reads them); the PalUp fee line is COMPUTED and clearly labeled NOT CHARGED — real billing
// is a separate, later, human-gated W6 path through Shopify Billing (packages/platform-ports's
// FeeLine.chargeable is always `false` in W5; honored here, never overridden). No fabricated
// numbers: when attribution is underpowered (`fee.reason === "attribution_underpowered"`) we show
// an honest "not yet" line, never a $0 fee. Loading/error/empty states mirror OrdersView.tsx.

type LoadState = "loading" | "ready" | "error";

function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export interface PaymentsScreenProps {
  api: Pick<ApiClient, "getPayments">;
}

export function PaymentsScreen({ api }: PaymentsScreenProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [view, setView] = useState<PaymentsView | null>(null);

  const load = useCallback(() => {
    setState("loading");
    api.getPayments().then(
      (v) => {
        setView(v);
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
        Loading payments…
      </div>
    );
  }

  if (state === "error" || view === null) {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn&apos;t load payments.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </Note>
    );
  }

  const feeValue = view.fee.reason === "computed" && view.fee.computedFeeUsd !== null ? fmtUsd(view.fee.computedFeeUsd) : "Not yet";
  const feeFootnote =
    view.fee.reason === "computed"
      ? `${view.fee.ratePct}% of proven incremental — computed, not charged. Billed through Shopify (see Billing).`
      : "Not yet — we only bill once we've proven incremental lift against your holdout. Computed, not charged.";

  return (
    <div className="flex flex-col gap-4">
      <Note variant="ever">
        <b>{view.trustNote}</b> Payouts come straight from Shopify to your bank — PalUp is never in
        that path.
      </Note>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <StatTile
          label="Shopify payouts (this period)"
          value={view.payouts.length === 0 ? "—" : fmtUsd(view.payoutTotalUsd)}
          mono
          footnote={
            view.payouts.length === 0
              ? "No payouts yet this period"
              : `${view.period} · straight from Shopify to your bank`
          }
        />
        <StatTile
          label="PalUp fee (illustrative)"
          value={feeValue}
          mono={view.fee.reason === "computed"}
          footnote={feeFootnote}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payouts</CardTitle>
          <a href={view.payoutsAdminPath} target="_blank" rel="noreferrer" className="text-brand text-sm underline">
            View in Shopify
          </a>
        </CardHeader>
        <CardBody>
          {view.payouts.length === 0 ? (
            <Note variant="info">
              No payouts to show yet. Payouts appear here once your Shopify Payments payouts are connected.
            </Note>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Date</TableHeaderCell>
                  <TableHeaderCell>Amount</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {view.payouts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{new Date(p.issuedAt).toLocaleDateString("en-US")}</TableCell>
                    <TableCell>{fmtUsd(p.amountUsd)}</TableCell>
                    <TableCell>
                      <Badge variant="gray" dot={false}>
                        {p.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
