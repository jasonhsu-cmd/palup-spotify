import { Card, CardBody, CardHeader, CardTitle, Note } from "@palup/design-system";
import type { ActivityEntry } from "../../app/api";
import { activityLabel } from "./format";

// W2 T7: "What your agent did" (mockup #dashboard activity card) — a pure render of GET /activity's
// audit-derived feed. Every row IS an audit record (allowlisted server-side); nothing is inferred,
// aggregated, or invented, and an unknown action renders its raw slug rather than being dropped.
// The mockup's rolled-up counts ("Recovered 11 abandoned carts · $1,840") need per-order touchpoint
// data that W5 builds — until then the honest feed is the individual audited actions (D6/D8).

export interface ActivityTodayProps {
  items: ActivityEntry[];
}

const timeFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function formatAt(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : timeFormatter.format(parsed);
}

export function ActivityToday({ items }: ActivityTodayProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What your agent did</CardTitle>
      </CardHeader>
      <CardBody className="pt-[6px]">
        {items.length === 0 ? (
          <Note variant="info">No agent activity recorded yet — everything your agent does will appear here, from its audit log.</Note>
        ) : (
          items.map((entry, i) => (
            <div
              key={entry.seq}
              className={`flex items-start justify-between gap-3 py-[11px] ${i < items.length - 1 ? "border-b border-line-2" : ""}`}
            >
              <div>
                <b className="text-[13px]">{activityLabel(entry.action)}</b>
                <div className="text-[12.5px] text-ink-3">{entry.actor}</div>
              </div>
              <span className="whitespace-nowrap text-[12px] text-ink-4">{formatAt(entry.at)}</span>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}
