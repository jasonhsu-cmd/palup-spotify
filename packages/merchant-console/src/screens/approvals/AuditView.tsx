import { useCallback, useEffect, useState } from "react";
import { Button, Note, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "@palup/design-system";
import type { ApiClient, AuditEntry } from "../../app/api";

// T7 (Audit view): a read-only render of `GET /audit` (W1-API's append-only, hash-chained log —
// `routes/audit.ts`'s `SafeAuditEntry`) — every autonomous action AND every human decision on this
// tenant, per governance non-negotiable #5 ("every autonomous action is logged... no silent
// actions"). This view never fabricates or infers an entry — it renders exactly what the store
// returns, honestly showing "no reversal path recorded" rather than inventing one when
// `reversalPath` is absent.

export interface AuditViewProps {
  api: Pick<ApiClient, "listAudit">;
}

type LoadState = "loading" | "ready" | "error";

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function formatAt(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : dateFormatter.format(parsed);
}

export function AuditView({ api }: AuditViewProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<AuditEntry[]>([]);

  const load = useCallback(() => {
    setState("loading");
    api.listAudit().then(
      (res) => {
        setItems(res.items);
        setState("ready");
      },
      () => {
        setState("error");
      },
    );
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === "loading") {
    return (
      <div role="status" className="p-6 text-[13px] text-ink-3">
        Loading audit log…
      </div>
    );
  }

  if (state === "error") {
    return (
      <Note variant="dang">
        <div className="flex items-center gap-3">
          <span>Couldn&apos;t load the audit log.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      </Note>
    );
  }

  if (items.length === 0) {
    return <Note variant="info">No audit entries yet.</Note>;
  }

  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>When</TableHeaderCell>
          <TableHeaderCell>Actor</TableHeaderCell>
          <TableHeaderCell>Action</TableHeaderCell>
          <TableHeaderCell>Reversal path</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map((entry) => (
          <TableRow key={entry.seq}>
            <TableCell>{formatAt(entry.at)}</TableCell>
            <TableCell>{entry.actor}</TableCell>
            <TableCell>{entry.action}</TableCell>
            <TableCell>{entry.reversalPath ?? "no reversal path recorded"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
